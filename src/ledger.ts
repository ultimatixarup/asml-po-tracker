import crypto from "node:crypto";

/**
 * Pure primitives for the append-only, hash-chained event ledger. The chain
 * makes tampering evident: every event's hash covers its payload AND the
 * previous event's hash, so editing any historical row breaks every hash
 * after it. (Tamper-EVIDENT, not notarized -- see the plan's risk notes.)
 */

export const GENESIS_HASH = "0".repeat(64);

export type EventType =
  | "message.received"
  | "artifact.ingested"
  | "estimate.imported"
  | "change.requested"
  | "co.drafted"
  | "co.status_changed"
  | "note.logged"
  | "daily_log.recorded"
  | "ai.call_recorded";

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace. Two
 * semantically equal payloads always serialize to the same bytes, which the
 * hash chain depends on.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export function computeEventHash(prevHash: string, payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(prevHash)
    .update(canonicalJson(payload))
    .digest("hex");
}

export interface ChainedEvent {
  payload: unknown;
  prev_hash: string;
  hash: string;
}

/**
 * Recompute a project's chain and report the first broken link, if any.
 * Events must be supplied in insertion order.
 */
export function verifyChain(
  events: ChainedEvent[],
): { ok: true } | { ok: false; brokenAtIndex: number; reason: string } {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.prev_hash !== prev) {
      return {
        ok: false,
        brokenAtIndex: i,
        reason: `prev_hash mismatch: expected ${prev}, stored ${event.prev_hash}`,
      };
    }
    const expected = computeEventHash(event.prev_hash, event.payload);
    if (event.hash !== expected) {
      return {
        ok: false,
        brokenAtIndex: i,
        reason: `hash mismatch: expected ${expected}, stored ${event.hash}`,
      };
    }
    prev = event.hash;
  }
  return { ok: true };
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
