import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { createAuditRouter } from "../src/routes/audit.ts";
import { createMemoryStore, type Store } from "../src/store.ts";

const TOKEN = "test-audit-token";
let server: Server;
let base: string;
let store: Store;
let projectId: string;

before(async () => {
  store = createMemoryStore();
  const project = await store.createProject("MAPLE", "Maple St Renovation");
  projectId = project.id;
  const estimate = await store.createEstimate({
    projectId,
    total: 15480,
    lines: [
      {
        lineNo: 1,
        csiCode: "09 29 00",
        description: "Drywall",
        qty: 4000,
        unit: "SF",
        unitCost: 2.25,
        total: 9000,
      },
    ],
  });
  const event = await store.appendEvent({
    projectId,
    type: "change.requested",
    actor: "tg:1",
    payload: { summary: "move wall" },
  });
  assert.notEqual(event, "duplicate");
  const eventId = event === "duplicate" ? 0 : Number(event.id);
  await store.createChangeOrder({
    projectId,
    title: "Wall move",
    baseEstimateId: estimate.id,
    netAmount: 180,
    lines: [
      {
        kind: "add",
        csiCode: "09 29 00",
        description: "Added drywall",
        qty: 120,
        unit: "SF",
        unitCost: 2.25,
        total: 270,
        affectsEstimateLineId: null,
        rationale: "base_estimate_unit_cost",
        mathNote: "120 SF x $2.25/SF = $270.00",
        evidenceEventIds: [eventId],
      },
    ],
  });

  const app = express();
  app.use(createAuditRouter(store, null, TOKEN));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === "object" && address) {
    base = `http://127.0.0.1:${address.port}`;
  }
});

after(() => {
  server?.close();
});

const get = (path: string, withToken = true) =>
  fetch(`${base}${path}`, {
    headers: withToken ? { Authorization: `Bearer ${TOKEN}` } : {},
    redirect: "manual",
  });

test("audit pages demand the token", async () => {
  const denied = await get("/audit", false);
  assert.equal(denied.status, 401);
});

test("project list shows the chain badge", async () => {
  const response = await get("/audit");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /MAPLE/);
  assert.match(html, /chain intact/);
});

test("project page renders estimates, COs, and the timeline", async () => {
  const response = await get(`/audit/p/${projectId}`);
  const html = await response.text();
  assert.match(html, /v1/);
  assert.match(html, /\$15,480\.00/);
  assert.match(html, /PCO #1/);
  assert.match(html, /change\.requested/);
});

test("CO page shows math notes and evidence ids", async () => {
  const response = await get(`/audit/p/${projectId}/co/1`);
  const html = await response.text();
  assert.match(html, /120 SF x \$2\.25\/SF = \$270\.00/);
  assert.match(html, /base_estimate_unit_cost/);
  assert.match(html, /Net: <b>\$180\.00/);
});

test("verify endpoint recomputes the chain as JSON", async () => {
  const response = await get(`/audit/verify/${projectId}`);
  const body = (await response.json()) as { ok: boolean; events: number };
  assert.equal(body.ok, true);
  assert.ok(body.events >= 1);
});

test("unknown project and CO 404 cleanly", async () => {
  assert.equal((await get("/audit/p/nope")).status, 404);
  assert.equal((await get(`/audit/p/${projectId}/co/99`)).status, 404);
});
