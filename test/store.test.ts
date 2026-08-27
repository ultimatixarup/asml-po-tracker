import assert from "node:assert/strict";
import { test } from "node:test";
import { GENESIS_HASH, computeEventHash } from "../src/ledger.ts";
import { createMemoryStore } from "../src/store.ts";

test("history round-trips and honors the load limit", async () => {
  const store = createMemoryStore();
  await store.appendHistory("tg:1", [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ]);
  assert.deepEqual(await store.loadHistory("tg:1", 2), [
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ]);
  await store.clearHistory("tg:1");
  assert.deepEqual(await store.loadHistory("tg:1", 10), []);
});

test("contacts persist their active project", async () => {
  const store = createMemoryStore();
  const project = await store.createProject("MAPLE", "Maple St Renovation");
  await store.ensureContact("tg:1");
  await store.setActiveProject("tg:1", project.id);
  assert.equal((await store.ensureContact("tg:1")).activeProjectId, project.id);
});

test("duplicate project codes are rejected", async () => {
  const store = createMemoryStore();
  await store.createProject("MAPLE", "Maple St");
  await assert.rejects(() => store.createProject("MAPLE", "Other"));
});

test("events chain per project and dedupe by source message id", async () => {
  const store = createMemoryStore();
  const project = await store.createProject("MAPLE", "Maple St");

  const first = await store.appendEvent({
    projectId: project.id,
    type: "message.received",
    actor: "tg:1",
    payload: { text: "hello" },
    sourceMessageId: "tg:100",
  });
  assert.notEqual(first, "duplicate");
  if (first !== "duplicate") {
    assert.equal(first.hash, computeEventHash(GENESIS_HASH, { text: "hello" }));
  }

  const retry = await store.appendEvent({
    projectId: project.id,
    type: "message.received",
    actor: "tg:1",
    payload: { text: "hello" },
    sourceMessageId: "tg:100",
  });
  assert.equal(retry, "duplicate");

  const second = await store.appendEvent({
    projectId: project.id,
    type: "note.logged",
    actor: "tg:1",
    payload: { note: "next" },
  });
  if (first !== "duplicate" && second !== "duplicate") {
    assert.equal(second.hash, computeEventHash(first.hash, { note: "next" }));
  }

  // A project-less event starts from the global chain's genesis, not the project chain.
  const global = await store.appendEvent({
    type: "message.received",
    actor: "tg:2",
    payload: { text: "hi" },
    sourceMessageId: "tg:101",
  });
  if (global !== "duplicate") {
    assert.equal(global.hash, computeEventHash(GENESIS_HASH, { text: "hi" }));
  }
});
