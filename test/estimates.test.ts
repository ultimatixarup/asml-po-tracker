import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCsi } from "../src/domain/csi.ts";
import {
  buildLines,
  parseCsv,
  parseSpreadsheet,
  type ColumnMapping,
} from "../src/estimates.ts";
import { createMemoryStore } from "../src/store.ts";

test("CSI normalization handles common formats and rejects junk", () => {
  assert.deepEqual(normalizeCsi("033000"), {
    code: "03 30 00",
    division: "Concrete",
    valid: true,
  });
  assert.equal(normalizeCsi("03-30-00").code, "03 30 00");
  assert.equal(normalizeCsi("26").division, "Electrical");
  assert.equal(normalizeCsi("99 99 99").valid, false);
  assert.equal(normalizeCsi("n/a").valid, false);
});

const CSV = [
  "Code,Item,Qty,Unit,Unit Price,Amount",
  '033000,Slab on grade,120,SY,"$54.00","$6,480.00"',
  ",Subtotal,,,,\"$6,480.00\"",
  '092900,Drywall install,4000,SF,"$2.25","$9,000.00"',
  ",,,,,",
  ',Misc allowance,,,,"$1,500.00"',
].join("\n");

const MAPPING: ColumnMapping = {
  csi_code: 0,
  description: 1,
  qty: 2,
  unit: 3,
  unit_cost: 4,
  total: 5,
};

test("buildLines copies values, skips summary/blank rows, sums the total", () => {
  const sheet = parseCsv(new TextEncoder().encode(CSV));
  assert.deepEqual(sheet.headers, [
    "Code",
    "Item",
    "Qty",
    "Unit",
    "Unit Price",
    "Amount",
  ]);

  const built = buildLines(sheet, MAPPING);
  assert.equal(built.lines.length, 3);
  assert.equal(built.total, 16980);

  const slab = built.lines[0]!;
  assert.equal(slab.csiCode, "03 30 00");
  assert.equal(slab.qty, 120);
  assert.equal(slab.unitCost, 54);
  assert.equal(slab.total, 6480);

  const reasons = built.skipped.map((s) => s.reason);
  assert.ok(reasons.includes("summary row"));
  assert.equal(built.flagged.length, 0);
});

test("mismatched math and bad CSI codes are flagged, not fixed", () => {
  const csv = [
    "Item,Qty,Rate,Amount",
    'Framing,100,"$10.00","$1,500.00"',
    "Cleanup (div XX),1,\"$500.00\",\"$500.00\"",
  ].join("\n");
  const sheet = parseCsv(new TextEncoder().encode(csv));
  const built = buildLines(sheet, {
    csi_code: null,
    description: 0,
    qty: 1,
    unit: null,
    unit_cost: 2,
    total: 3,
  });
  assert.equal(built.lines.length, 2);
  // The stated amount is kept -- flagged, never silently corrected.
  assert.equal(built.lines[0]!.total, 1500);
  assert.match(built.flagged[0]!.reason, /1500 != qty x unit cost = 1000/);
});

test("a missing total is computed from qty x unit cost", () => {
  const sheet = parseCsv(
    new TextEncoder().encode("Item,Qty,Rate\nPaint,50,\"$3.10\""),
  );
  const built = buildLines(sheet, {
    csi_code: null,
    description: 0,
    qty: 1,
    unit: null,
    unit_cost: 2,
    total: null,
  });
  assert.equal(built.lines[0]!.total, 155);
});

test("parseSpreadsheet routes .csv by name and mime", async () => {
  const bytes = new TextEncoder().encode("Item,Amount\nRebar,\"$100.00\"");
  const byName = await parseSpreadsheet(bytes, "estimate.csv");
  const byMime = await parseSpreadsheet(bytes, "text/csv");
  assert.deepEqual(byName, byMime);
  assert.equal(byName.rows.length, 1);
});

test("estimate versions supersede atomically in the store", async () => {
  const store = createMemoryStore();
  const project = await store.createProject("MAPLE", "Maple St");
  const line = {
    lineNo: 1,
    csiCode: "03 30 00",
    description: "Slab",
    qty: 1,
    unit: "LS",
    unitCost: 100,
    total: 100,
  };

  const v1 = await store.createEstimate({
    projectId: project.id,
    total: 100,
    lines: [line],
  });
  const v2 = await store.createEstimate({
    projectId: project.id,
    total: 200,
    lines: [line, { ...line, lineNo: 2, description: "Curb", total: 100 }],
  });

  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  const current = await store.getCurrentEstimate(project.id);
  assert.equal(current?.id, v2.id);
  assert.equal((await store.getEstimateLines(v2.id)).length, 2);
});
