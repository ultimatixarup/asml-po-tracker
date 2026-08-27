import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createIngestor,
  kindFromMime,
  MAX_MEDIA_BYTES,
  type Classification,
} from "../src/ingest.ts";
import { sha256Hex } from "../src/ledger.ts";
import type { BlobStore } from "../src/storage.ts";
import { createMemoryStore } from "../src/store.ts";

function fakeBlobs(): BlobStore & { puts: string[] } {
  const blobs = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    puts,
    async put(sha256, bytes) {
      const key = `${sha256.slice(0, 2)}/${sha256}`;
      blobs.set(key, bytes);
      puts.push(key);
      return key;
    },
    async get(key) {
      const bytes = blobs.get(key);
      if (!bytes) throw new Error("missing");
      return bytes;
    },
    async presignGet(key) {
      return `https://blobs.test/${key}`;
    },
  };
}

test("kindFromMime routes spreadsheets, images, PDFs deterministically", () => {
  assert.equal(kindFromMime("text/csv"), "estimate");
  assert.equal(
    kindFromMime(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    "estimate",
  );
  assert.equal(kindFromMime("application/octet-stream", "bid.xlsx"), "estimate");
  assert.equal(kindFromMime("image/jpeg"), "photo");
  assert.equal(kindFromMime("application/pdf"), "document");
  assert.equal(kindFromMime("audio/ogg"), "other");
});

test("ingest stores the blob, creates the artifact, and appends the event", async () => {
  const store = createMemoryStore();
  const blobs = fakeBlobs();
  const ingestor = createIngestor({ store, blobs, classifier: null });
  const bytes = new TextEncoder().encode("fake image bytes");

  const { artifact, placeholder } = await ingestor.ingest({
    bytes,
    mime: "image/jpeg",
    caption: "slab crack",
    contactId: "tg:1",
    projectId: null,
    channel: "telegram",
    sourceMessageId: "tg:media:1",
  });

  assert.equal(artifact.sha256, sha256Hex(bytes));
  assert.equal(artifact.kind, "photo");
  assert.equal(blobs.puts.length, 1);
  assert.match(placeholder, /^\[photo art-1: image\/jpeg/);
});

test("re-sending identical bytes reuses the artifact and skips the blob write", async () => {
  const store = createMemoryStore();
  const blobs = fakeBlobs();
  const ingestor = createIngestor({ store, blobs, classifier: null });
  const bytes = new TextEncoder().encode("same bytes");
  const input = {
    bytes,
    mime: "image/jpeg",
    caption: "",
    contactId: "tg:1",
    projectId: null,
    channel: "telegram",
  };

  const first = await ingestor.ingest({ ...input, sourceMessageId: "tg:m:1" });
  const second = await ingestor.ingest({ ...input, sourceMessageId: "tg:m:2" });
  assert.equal(first.artifact.id, second.artifact.id);
  assert.equal(blobs.puts.length, 1);
});

test("a classifier upgrades the kind and flags change signals", async () => {
  const store = createMemoryStore();
  const classification: Classification = {
    kind: "design_note",
    summary: "Move kitchen wall 2ft north",
    isChangeSignal: true,
    extraction: { plan_or_note: { change_summary: "wall relocation" } },
  };
  const ingestor = createIngestor({
    store,
    blobs: fakeBlobs(),
    classifier: async () => classification,
  });

  const { artifact, placeholder } = await ingestor.ingest({
    bytes: new TextEncoder().encode("note"),
    mime: "image/png",
    caption: "",
    contactId: "tg:1",
    projectId: null,
    channel: "telegram",
    sourceMessageId: "tg:m:3",
  });
  assert.equal(artifact.kind, "design_note");
  assert.match(placeholder, /Move kitchen wall/);
});

test("oversized files are rejected before any storage", async () => {
  const store = createMemoryStore();
  const blobs = fakeBlobs();
  const ingestor = createIngestor({ store, blobs, classifier: null });
  await assert.rejects(
    () =>
      ingestor.ingest({
        bytes: new Uint8Array(MAX_MEDIA_BYTES + 1),
        mime: "image/jpeg",
        caption: "",
        contactId: "tg:1",
        projectId: null,
        channel: "telegram",
        sourceMessageId: "tg:m:4",
      }),
    /limit/,
  );
  assert.equal(blobs.puts.length, 0);
});
