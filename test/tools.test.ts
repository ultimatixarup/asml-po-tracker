import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlobStore } from "../src/storage.ts";
import { createMemoryStore } from "../src/store.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

type Tool = ReturnType<typeof buildTools>[number];

function tool(tools: Tool[], name: string): Tool {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} missing`);
  return found;
}

const run = async (t: Tool, input: unknown): Promise<string> =>
  String(await (t as { run: (i: unknown) => Promise<unknown> }).run(input));

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return { store: createMemoryStore(), blobs: null, mapper: null, ...overrides };
}

test("project lifecycle: create activates, switch by code, list shows active", async () => {
  const deps = makeDeps();
  const tools = buildTools(deps, "tg:1");

  await run(tool(tools, "create_project"), {
    code: "maple",
    name: "Maple St Renovation",
  });
  await run(tool(tools, "create_project"), { code: "OAK", name: "Oak Ave" });

  let listed = JSON.parse(await run(tool(tools, "list_projects"), {}));
  assert.equal(listed.activeProjectCode, "OAK");
  assert.equal(listed.projects.length, 2);

  const switched = JSON.parse(
    await run(tool(tools, "set_active_project"), { code: "MAPLE" }),
  );
  assert.equal(switched.nowActive.code, "MAPLE");

  const missing = await run(tool(tools, "set_active_project"), { code: "PINE" });
  assert.match(missing, /No project with code PINE/);
});

test("notes and daily logs land on the active project's ledger", async () => {
  const deps = makeDeps();
  const tools = buildTools(deps, "tg:1");
  await run(tool(tools, "create_project"), { code: "MAPLE", name: "Maple" });
  await run(tool(tools, "record_note"), {
    note: "Owner verbally approved tile upgrade",
  });
  await run(tool(tools, "record_daily_log"), {
    work_performed: "Framed north wall",
    crew: "4",
  });

  const project = (await deps.store.listProjects())[0]!;
  const notes = await deps.store.listEvents(project.id, { type: "note.logged" });
  const logs = await deps.store.listEvents(project.id, {
    type: "daily_log.recorded",
  });
  assert.equal(notes.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.payload.work_performed, "Framed north wall");
});

test("tools that need a project refuse politely without one", async () => {
  const tools = buildTools(makeDeps(), "tg:9");
  await assert.rejects(
    () => run(tool(tools, "record_note"), { note: "orphan note" }),
    /No active project/,
  );
});

test("import_estimate previews without committing, then commits on confirm", async () => {
  const store = createMemoryStore();
  const csv = [
    "Item,Qty,Rate,Amount",
    'Slab,120,"$54.00","$6,480.00"',
    'Drywall,4000,"$2.25","$9,000.00"',
  ].join("\n");
  const bytes = new TextEncoder().encode(csv);

  const blobs: BlobStore = {
    async put() {
      return "aa/bb";
    },
    async get() {
      return bytes;
    },
    async presignGet() {
      return "https://x";
    },
  };
  const deps = makeDeps({
    store,
    blobs,
    mapper: async () => ({
      csi_code: null,
      description: 0,
      qty: 1,
      unit: null,
      unit_cost: 2,
      total: 3,
    }),
  });
  const tools = buildTools(deps, "tg:1");
  await run(tool(tools, "create_project"), { code: "MAPLE", name: "Maple" });
  const project = (await store.listProjects())[0]!;

  const artifact = await store.createArtifact({
    projectId: project.id,
    sha256: "abc",
    blobKey: "aa/bb",
    mime: "text/csv",
    byteSize: bytes.byteLength,
    kind: "estimate",
    sourceChannel: "telegram",
    uploadedBy: "tg:1",
  });

  const previewResult = JSON.parse(
    await run(tool(tools, "import_estimate"), {
      artifact_id: artifact.id,
      confirm: false,
    }),
  );
  assert.equal(previewResult.preview, true);
  assert.equal(previewResult.lineCount, 2);
  assert.equal(previewResult.total, 15480);
  assert.equal(await store.getCurrentEstimate(project.id), null);

  const committed = JSON.parse(
    await run(tool(tools, "import_estimate"), {
      artifact_id: artifact.id,
      confirm: true,
    }),
  );
  assert.equal(committed.imported, true);
  assert.equal(committed.version, 1);

  const estimate = await store.getCurrentEstimate(project.id);
  assert.equal(estimate?.total, 15480);
  const events = await store.listEvents(project.id, {
    type: "estimate.imported",
  });
  assert.equal(events.length, 1);

  const readBack = JSON.parse(
    await run(tool(tools, "get_estimate"), { limit: 30 }),
  );
  assert.equal(readBack.version, 1);
  assert.equal(readBack.lines.length, 2);
});
