import Anthropic from "@anthropic-ai/sdk";
import { canonicalJson, sha256Hex } from "./ledger.ts";
import type { BlobStore } from "./storage.ts";
import type {
  ChangeOrder,
  Estimate,
  EstimateLine,
  EventRecord,
  Store,
} from "./store.ts";

/**
 * The reconciliation engine -- the core value of this agent. Given the current
 * estimate's lines and the evidence for a change request, one dedicated
 * high-effort model call produces ONLY the delta (extras + credits), with the
 * work shown by construction: every line carries its pricing basis, its math,
 * and the evidence events it derives from. Code -- not the model -- validates
 * all of it before anything is persisted.
 */

export interface DeltaLine {
  kind: "add" | "credit";
  csi_code: string | null;
  description: string;
  qty: number | null;
  unit: string | null;
  unit_cost: number | null;
  total: number;
  derived_from_estimate_line_id: string | null;
  evidence_event_ids: number[];
  math_note: string;
  pricing_basis: "base_estimate_unit_cost" | "needs_pricing";
}

export interface DeltaResult {
  touched_lines: {
    estimate_line_id: string;
    action: "modify" | "credit" | "unaffected";
    why: string;
  }[];
  delta_lines: DeltaLine[];
  summary: string;
  assumptions: string[];
  confidence: "high" | "medium" | "low";
}

export const DELTA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["touched_lines", "delta_lines", "summary", "assumptions", "confidence"],
  properties: {
    touched_lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["estimate_line_id", "action", "why"],
        properties: {
          estimate_line_id: { type: "string" },
          action: { type: "string", enum: ["modify", "credit", "unaffected"] },
          why: { type: "string" },
        },
      },
    },
    delta_lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind", "csi_code", "description", "qty", "unit", "unit_cost",
          "total", "derived_from_estimate_line_id", "evidence_event_ids",
          "math_note", "pricing_basis",
        ],
        properties: {
          kind: { type: "string", enum: ["add", "credit"] },
          csi_code: { type: ["string", "null"] },
          description: { type: "string" },
          qty: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          unit_cost: { type: ["number", "null"] },
          total: { type: "number", description: "Positive number; kind carries the sign" },
          derived_from_estimate_line_id: {
            type: ["string", "null"],
            description: "The base estimate line whose pricing this uses",
          },
          evidence_event_ids: {
            type: "array",
            items: { type: "integer" },
            minItems: 1,
            description: "Ledger event ids this line derives from. MUST cite.",
          },
          math_note: { type: "string", description: "e.g. '12 SF x $4.50/SF = $54.00'" },
          pricing_basis: {
            type: "string",
            enum: ["base_estimate_unit_cost", "needs_pricing"],
          },
        },
      },
    },
    summary: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
} as const;

export interface ValidationProblem {
  lineIndex: number;
  problem: string;
}

/**
 * Everything that makes an AI-drafted CO checkable, enforced in code:
 * arithmetic, evidence citations, derivation references, credit bounds.
 */
export function validateDelta(
  delta: DeltaResult,
  estimateLines: EstimateLine[],
  allowedEventIds: Set<number>,
): { problems: ValidationProblem[]; netAmount: number } {
  const problems: ValidationProblem[] = [];
  const lineById = new Map(estimateLines.map((l) => [l.id, l]));

  delta.delta_lines.forEach((line, index) => {
    if (line.total <= 0) {
      problems.push({ lineIndex: index, problem: `total must be positive (kind carries the sign), got ${line.total}` });
    }
    if (line.qty !== null && line.unit_cost !== null) {
      const computed = Math.round(line.qty * line.unit_cost * 100) / 100;
      if (Math.abs(computed - line.total) > 0.05) {
        problems.push({
          lineIndex: index,
          problem: `qty x unit_cost = ${computed} but total is ${line.total}`,
        });
      }
    }
    if (line.evidence_event_ids.length === 0) {
      problems.push({ lineIndex: index, problem: "no evidence cited" });
    }
    for (const eventId of line.evidence_event_ids) {
      if (!allowedEventIds.has(eventId)) {
        problems.push({
          lineIndex: index,
          problem: `evidence event ${eventId} is not in the provided evidence set`,
        });
      }
    }
    if (line.derived_from_estimate_line_id !== null) {
      const base = lineById.get(line.derived_from_estimate_line_id);
      if (!base) {
        problems.push({
          lineIndex: index,
          problem: `derived_from_estimate_line_id ${line.derived_from_estimate_line_id} does not exist`,
        });
      } else if (line.kind === "credit" && line.total > base.total + 0.005) {
        problems.push({
          lineIndex: index,
          problem: `credit ${line.total} exceeds base line total ${base.total}`,
        });
      }
    } else if (line.pricing_basis === "base_estimate_unit_cost") {
      problems.push({
        lineIndex: index,
        problem: "pricing_basis says base estimate but no derived_from line is named",
      });
    }
  });

  const netAmount =
    Math.round(
      delta.delta_lines.reduce(
        (sum, line) => sum + (line.kind === "add" ? line.total : -line.total),
        0,
      ) * 100,
    ) / 100;
  return { problems, netAmount };
}

export interface ReconcileInput {
  changeDescription: string;
  estimate: Estimate;
  estimateLines: EstimateLine[];
  evidence: EventRecord[];
}

/** The model call, injectable so orchestration is testable offline. */
export type DeltaGenerator = (
  input: ReconcileInput,
  repairProblems: ValidationProblem[] | null,
  previous: DeltaResult | null,
) => Promise<DeltaResult>;

export function createClaudeDeltaGenerator(client: Anthropic): DeltaGenerator {
  return async (input, repairProblems, previous) => {
    const base = `A change request on a construction project must be reconciled against the CURRENT estimate. Produce ONLY the delta scope -- extra work and credits -- never a re-estimate of unchanged lines.

Change request:
${input.changeDescription}

Current estimate (version ${input.estimate.version}, total $${input.estimate.total}):
${canonicalJson(input.estimateLines)}

Evidence events (cite these ids in evidence_event_ids):
${canonicalJson(input.evidence.map((e) => ({ id: Number(e.id), type: e.type, payload: e.payload })))}

Rules:
- Price from the base estimate's unit costs wherever a comparable line exists (set derived_from_estimate_line_id and pricing_basis=base_estimate_unit_cost).
- Scope with no comparable base line gets pricing_basis=needs_pricing and null unit_cost; still quantify qty/unit when the evidence supports it.
- Credits for deleted work reference the line being credited and cannot exceed its total.
- Every delta line cites at least one evidence event id. Show the math in math_note.
- totals are positive; kind (add|credit) carries the sign.`;

    const repair = repairProblems
      ? `\n\nYour previous draft had validation problems. Fix ONLY these and return the full corrected result:\n${canonicalJson(repairProblems)}\n\nPrevious draft:\n${canonicalJson(previous)}`
      : "";

    const stream = client.beta.messages.stream({
      model: "claude-opus-5",
      max_tokens: 32000,
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          schema: DELTA_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: base + repair }],
    });
    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") {
      throw new Error("The model declined to draft this change order.");
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return JSON.parse(text) as DeltaResult;
  };
}

export interface DraftOutcome {
  co: ChangeOrder;
  delta: DeltaResult;
  netAmount: number;
  /** Problems that survived the repair round-trip; PM must review these lines. */
  unresolvedProblems: ValidationProblem[];
}

/**
 * Orchestration: generate -> validate -> at most one repair round-trip ->
 * persist the draft CO with evidence links -> ledger events, including
 * ai.call_recorded with the full input/output hashed (and blobbed when
 * storage is available) so the draft is defensible later.
 */
export async function draftChangeOrder(deps: {
  store: Store;
  blobs: BlobStore | null;
  generate: DeltaGenerator;
  projectId: string;
  actor: string;
  title: string;
  input: ReconcileInput;
  sourceEventId?: number | string | null;
}): Promise<DraftOutcome> {
  const { store, blobs, generate, projectId, actor, title, input } = deps;
  const allowedIds = new Set(input.evidence.map((e) => Number(e.id)));

  let delta = await generate(input, null, null);
  let { problems, netAmount } = validateDelta(delta, input.estimateLines, allowedIds);
  if (problems.length > 0) {
    const repaired = await generate(input, problems, delta);
    const revalidated = validateDelta(repaired, input.estimateLines, allowedIds);
    delta = repaired;
    problems = revalidated.problems;
    netAmount = revalidated.netAmount;
  }

  const co = await store.createChangeOrder({
    projectId,
    title,
    baseEstimateId: input.estimate.id,
    sourceEventId: deps.sourceEventId ?? null,
    netAmount,
    lines: delta.delta_lines.map((line) => ({
      kind: line.kind,
      csiCode: line.csi_code,
      description: line.description,
      qty: line.qty,
      unit: line.unit,
      unitCost: line.unit_cost,
      total: line.total,
      affectsEstimateLineId: line.derived_from_estimate_line_id,
      rationale: line.pricing_basis,
      mathNote: line.math_note,
      evidenceEventIds: line.evidence_event_ids,
    })),
  });

  // Record the full model exchange so the draft can be audited later.
  const record = canonicalJson({ input, delta });
  const recordSha = sha256Hex(new TextEncoder().encode(record));
  let recordBlobKey: string | null = null;
  if (blobs) {
    try {
      recordBlobKey = await blobs.put(
        recordSha,
        new TextEncoder().encode(record),
        "application/json",
      );
    } catch (error) {
      console.error("[reconcile] could not blob the AI record:", error);
    }
  }
  await store.appendEvent({
    projectId,
    type: "ai.call_recorded",
    actor: "reconcile-engine",
    payload: {
      purpose: "co.draft",
      coId: co.id,
      model: "claude-opus-5",
      recordSha256: recordSha,
      recordBlobKey,
      unresolvedProblems: problems,
    },
  });
  await store.appendEvent({
    projectId,
    type: "co.drafted",
    actor,
    payload: {
      coId: co.id,
      number: co.number,
      title,
      netAmount,
      lineCount: delta.delta_lines.length,
      confidence: delta.confidence,
      summary: delta.summary,
    },
  });

  return { co, delta, netAmount, unresolvedProblems: problems };
}
