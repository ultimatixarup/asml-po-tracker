import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftChangeOrder,
  validateDelta,
  type DeltaResult,
} from "../src/reconcile.ts";
import { createMemoryStore, type EstimateLine } from "../src/store.ts";

const LINES: EstimateLine[] = [
  {
    id: "L1",
    lineNo: 1,
    csiCode: "09 29 00",
    description: "Drywall install",
    qty: 4000,
    unit: "SF",
    unitCost: 2.25,
    total: 9000,
  },
  {
    id: "L2",
    lineNo: 2,
    csiCode: "03 30 00",
    description: "Slab on grade",
    qty: 120,
    unit: "SY",
    unitCost: 54,
    total: 6480,
  },
];

function goodDelta(): DeltaResult {
  return {
    touched_lines: [
      { estimate_line_id: "L1", action: "modify", why: "wall moved" },
    ],
    delta_lines: [
      {
        kind: "add",
        csi_code: "09 29 00",
        description: "Additional drywall, moved wall",
        qty: 120,
        unit: "SF",
        unit_cost: 2.25,
        total: 270,
        derived_from_estimate_line_id: "L1",
        evidence_event_ids: [7],
        math_note: "120 SF x $2.25/SF = $270.00",
        pricing_basis: "base_estimate_unit_cost",
      },
      {
        kind: "credit",
        csi_code: "09 29 00",
        description: "Deleted closet drywall",
        qty: 40,
        unit: "SF",
        unit_cost: 2.25,
        total: 90,
        derived_from_estimate_line_id: "L1",
        evidence_event_ids: [7],
        math_note: "40 SF x $2.25/SF = $90.00",
        pricing_basis: "base_estimate_unit_cost",
      },
    ],
    summary: "Wall relocation: net add $180.00",
    assumptions: [],
    confidence: "high",
  };
}

test("a clean delta validates and nets adds minus credits", () => {
  const { problems, netAmount } = validateDelta(goodDelta(), LINES, new Set([7]));
  assert.deepEqual(problems, []);
  assert.equal(netAmount, 180);
});

test("bad math, foreign evidence, unknown base lines, and oversized credits are all caught", () => {
  const delta = goodDelta();
  delta.delta_lines[0]!.total = 999; // math broken
  delta.delta_lines[1]!.evidence_event_ids = [42]; // not in evidence set
  delta.delta_lines.push({
    ...goodDelta().delta_lines[0]!,
    derived_from_estimate_line_id: "L9", // does not exist
  });
  delta.delta_lines.push({
    ...goodDelta().delta_lines[1]!,
    qty: null,
    unit_cost: null,
    total: 99999, // credit larger than base line
  });

  const { problems } = validateDelta(delta, LINES, new Set([7]));
  const text = problems.map((p) => p.problem).join(" | ");
  assert.match(text, /qty x unit_cost = 270 but total is 999/);
  assert.match(text, /evidence event 42 is not in the provided evidence set/);
  assert.match(text, /L9 does not exist/);
  assert.match(text, /credit 99999 exceeds base line total 9000/);
});

test("a line with no evidence or a phantom pricing basis is rejected", () => {
  const delta = goodDelta();
  delta.delta_lines[0]!.evidence_event_ids = [];
  delta.delta_lines[1]!.derived_from_estimate_line_id = null; // basis says base estimate
  const { problems } = validateDelta(delta, LINES, new Set([7]));
  const text = problems.map((p) => p.problem).join(" | ");
  assert.match(text, /no evidence cited/);
  assert.match(text, /no derived_from line is named/);
});

async function seededStore() {
  const store = createMemoryStore();
  const project = await store.createProject("MAPLE", "Maple St");
  const estimate = await store.createEstimate({
    projectId: project.id,
    total: 15480,
    lines: LINES.map(({ id: _id, ...line }) => line),
  });
  const lines = await store.getEstimateLines(estimate.id);
  const event = await store.appendEvent({
    projectId: project.id,
    type: "change.requested",
    actor: "tg:1",
    payload: { summary: "move kitchen wall 2ft" },
  });
  assert.notEqual(event, "duplicate");
  const evidence = await store.listEvents(project.id, { limit: 10 });
  return { store, project, estimate, lines, evidence };
}

function deltaFor(lines: EstimateLine[], eventId: number): DeltaResult {
  const delta = goodDelta();
  for (const line of delta.delta_lines) {
    line.derived_from_estimate_line_id = lines[0]!.id;
    line.evidence_event_ids = [eventId];
  }
  delta.touched_lines[0]!.estimate_line_id = lines[0]!.id;
  return delta;
}

test("draftChangeOrder persists a PCO with evidence links and ledger events", async () => {
  const { store, project, estimate, lines, evidence } = await seededStore();
  const eventId = Number(evidence[0]!.id);

  const outcome = await draftChangeOrder({
    store,
    blobs: null,
    generate: async () => deltaFor(lines, eventId),
    projectId: project.id,
    actor: "tg:1",
    title: "Kitchen wall move",
    input: {
      changeDescription: "move kitchen wall 2ft north",
      estimate,
      estimateLines: lines,
      evidence,
    },
  });

  assert.equal(outcome.co.status, "pco");
  assert.equal(outcome.co.number, 1);
  assert.equal(outcome.netAmount, 180);
  assert.deepEqual(outcome.unresolvedProblems, []);

  const stored = await store.getChangeOrder(project.id, 1);
  assert.equal(stored?.lines.length, 2);
  assert.deepEqual(stored?.lines[0]?.evidenceEventIds, [eventId]);

  const drafted = await store.listEvents(project.id, { type: "co.drafted" });
  const aiCalls = await store.listEvents(project.id, { type: "ai.call_recorded" });
  assert.equal(drafted.length, 1);
  assert.equal(aiCalls.length, 1);
  assert.match(String(aiCalls[0]!.payload.recordSha256), /^[0-9a-f]{64}$/);
});

test("one repair round-trip fixes a bad first draft", async () => {
  const { store, project, estimate, lines, evidence } = await seededStore();
  const eventId = Number(evidence[0]!.id);
  let calls = 0;

  const outcome = await draftChangeOrder({
    store,
    blobs: null,
    generate: async (_input, problems) => {
      calls++;
      const delta = deltaFor(lines, eventId);
      if (calls === 1) {
        delta.delta_lines[0]!.total = 999; // broken math on the first pass
      } else {
        assert.ok(problems && problems.length > 0, "repair pass should receive problems");
      }
      return delta;
    },
    projectId: project.id,
    actor: "tg:1",
    title: "Repair test",
    input: {
      changeDescription: "change",
      estimate,
      estimateLines: lines,
      evidence,
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(outcome.unresolvedProblems, []);
  assert.equal(outcome.netAmount, 180);
});

test("problems that survive the repair pass are flagged, not hidden", async () => {
  const { store, project, estimate, lines, evidence } = await seededStore();
  const eventId = Number(evidence[0]!.id);
  const broken = () => {
    const delta = deltaFor(lines, eventId);
    delta.delta_lines[0]!.total = 999;
    return delta;
  };

  const outcome = await draftChangeOrder({
    store,
    blobs: null,
    generate: async () => broken(),
    projectId: project.id,
    actor: "tg:1",
    title: "Still broken",
    input: { changeDescription: "x", estimate, estimateLines: lines, evidence },
  });
  assert.equal(outcome.unresolvedProblems.length, 1);
  const aiCalls = await store.listEvents(project.id, { type: "ai.call_recorded" });
  assert.equal(
    (aiCalls[0]!.payload.unresolvedProblems as unknown[]).length,
    1,
  );
});

test("CO status transitions enforce the workflow", async () => {
  const { store, project, estimate, lines, evidence } = await seededStore();
  const eventId = Number(evidence[0]!.id);
  const { co } = await draftChangeOrder({
    store,
    blobs: null,
    generate: async () => deltaFor(lines, eventId),
    projectId: project.id,
    actor: "tg:1",
    title: "Workflow",
    input: { changeDescription: "x", estimate, estimateLines: lines, evidence },
  });

  await assert.rejects(
    () => store.updateChangeOrderStatus(co.id, "approved"),
    /Illegal transition pco -> approved/,
  );
  await store.updateChangeOrderStatus(co.id, "cor");
  await store.updateChangeOrderStatus(co.id, "approved");
  await assert.rejects(
    () => store.updateChangeOrderStatus(co.id, "void"),
    /Illegal transition approved -> void/,
  );
});
