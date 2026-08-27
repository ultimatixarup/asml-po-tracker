import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  computeEventHash,
  GENESIS_HASH,
  sha256Hex,
  verifyChain,
  type ChainedEvent,
} from "../src/ledger.ts";

test("canonical JSON is key-order independent and drops undefined", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [2, null], c: "x" } }),
    canonicalJson({ a: { c: "x", d: [2, null] }, b: 1 }),
  );
  assert.equal(canonicalJson({ a: 1, skip: undefined }), '{"a":1}');
  assert.equal(canonicalJson([1, "two", null]), '[1,"two",null]');
});

function chain(payloads: unknown[]): ChainedEvent[] {
  const events: ChainedEvent[] = [];
  let prev = GENESIS_HASH;
  for (const payload of payloads) {
    const hash = computeEventHash(prev, payload);
    events.push({ payload, prev_hash: prev, hash });
    prev = hash;
  }
  return events;
}

test("an intact chain verifies", () => {
  const events = chain([{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.deepEqual(verifyChain(events), { ok: true });
  assert.deepEqual(verifyChain([]), { ok: true });
});

test("tampering with any historical payload is detected at that index", () => {
  const events = chain([{ n: 1 }, { amount: 100 }, { n: 3 }]);
  (events[1] as { payload: unknown }).payload = { amount: 900 };
  const result = verifyChain(events);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.brokenAtIndex, 1);
});

test("deleting an event breaks the link that followed it", () => {
  const events = chain([{ n: 1 }, { n: 2 }, { n: 3 }]);
  const spliced = [events[0]!, events[2]!];
  const result = verifyChain(spliced);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.brokenAtIndex, 1);
});

test("sha256Hex matches a known vector", () => {
  assert.equal(
    sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
