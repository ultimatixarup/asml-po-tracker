import Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { normalizeCsi } from "./domain/csi.ts";

/**
 * Estimate import: spreadsheet bytes -> rows (deterministic) -> column mapping
 * (one model call, judgment only) -> canonical lines (deterministic -- values
 * are copied from the parsed sheet, never retyped by the model).
 */

export interface ParsedSheet {
  headers: string[];
  rows: string[][];
}

export function parseCsv(bytes: Uint8Array): ParsedSheet {
  const text = new TextDecoder().decode(bytes);
  const result = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const [headers = [], ...rows] = result.data;
  return { headers: headers.map(String), rows: rows.map((r) => r.map(String)) };
}

export async function parseXlsx(bytes: Uint8Array): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // row.values is 1-indexed with a leading empty slot.
    const values = row.values as ExcelJS.CellValue[];
    for (let i = 1; i < values.length; i++) {
      cells.push(cellText(values[i]));
    }
    grid.push(cells);
  });
  const [headers = [], ...rows] = grid;
  return { headers, rows };
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("result" in value) return String(value.result ?? "");
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("text" in value) return String(value.text);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
  }
  return String(value);
}

export async function parseSpreadsheet(
  bytes: Uint8Array,
  mimeOrName: string,
): Promise<ParsedSheet> {
  const lower = mimeOrName.toLowerCase();
  if (lower.endsWith(".csv") || lower.includes("text/csv")) {
    return parseCsv(bytes);
  }
  return parseXlsx(bytes);
}

/** Column indices into the sheet; null when the sheet has no such column. */
export interface ColumnMapping {
  description: number;
  csi_code: number | null;
  qty: number | null;
  unit: number | null;
  unit_cost: number | null;
  total: number | null;
}

const MAPPING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "csi_code", "qty", "unit", "unit_cost", "total"],
  properties: {
    description: { type: "integer", description: "0-based column index" },
    csi_code: { type: ["integer", "null"] },
    qty: { type: ["integer", "null"] },
    unit: { type: ["integer", "null"] },
    unit_cost: { type: ["integer", "null"] },
    total: { type: ["integer", "null"] },
  },
} as const;

export type ColumnMapper = (sheet: ParsedSheet) => Promise<ColumnMapping>;

/** One structured-output call: judgment about which column is which, nothing else. */
export function createClaudeColumnMapper(client: Anthropic): ColumnMapper {
  return async (sheet) => {
    const sample = sheet.rows.slice(0, 8);
    const response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: MAPPING_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [
        {
          role: "user",
          content:
            "This is a construction cost estimate spreadsheet. Map its columns " +
            "to the canonical fields (0-based indices; null when absent).\n" +
            `Headers: ${JSON.stringify(sheet.headers)}\n` +
            `Sample rows: ${JSON.stringify(sample)}`,
        },
      ],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return JSON.parse(text) as ColumnMapping;
  };
}

export interface CanonicalLine {
  lineNo: number;
  csiCode: string | null;
  csiValid: boolean;
  description: string;
  qty: number | null;
  unit: string | null;
  unitCost: number | null;
  total: number;
  raw: string[];
}

export interface BuiltLines {
  lines: CanonicalLine[];
  total: number;
  /** Rows skipped (blank/subtotal) and lines with problems, for the PM to review. */
  skipped: { rowIndex: number; reason: string }[];
  flagged: { lineNo: number; reason: string }[];
}

function parseMoney(text: string | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

const SUMMARY_ROW = /^(sub\s?total|total|grand\s?total|section\s?total)\b/i;

/** Deterministic: every value comes from the sheet; the model chose only the columns. */
export function buildLines(sheet: ParsedSheet, mapping: ColumnMapping): BuiltLines {
  const lines: CanonicalLine[] = [];
  const skipped: BuiltLines["skipped"] = [];
  const flagged: BuiltLines["flagged"] = [];

  const cell = (row: string[], index: number | null): string | undefined =>
    index === null ? undefined : row[index]?.trim() || undefined;

  for (let i = 0; i < sheet.rows.length; i++) {
    const row = sheet.rows[i]!;
    const description = cell(row, mapping.description);
    if (!description) {
      skipped.push({ rowIndex: i, reason: "blank description" });
      continue;
    }
    if (SUMMARY_ROW.test(description)) {
      skipped.push({ rowIndex: i, reason: "summary row" });
      continue;
    }

    const qty = parseMoney(cell(row, mapping.qty));
    const unitCost = parseMoney(cell(row, mapping.unit_cost));
    let total = parseMoney(cell(row, mapping.total));
    if (total === null && qty !== null && unitCost !== null) {
      total = Math.round(qty * unitCost * 100) / 100;
    }
    const lineNo = lines.length + 1;
    if (total === null) {
      skipped.push({ rowIndex: i, reason: "no total and no qty x unit cost" });
      continue;
    }
    if (qty !== null && unitCost !== null) {
      const computed = Math.round(qty * unitCost * 100) / 100;
      if (Math.abs(computed - total) > 0.05) {
        flagged.push({
          lineNo,
          reason: `total ${total} != qty x unit cost = ${computed}`,
        });
      }
    }

    const rawCsi = cell(row, mapping.csi_code);
    const csi = rawCsi ? normalizeCsi(rawCsi) : null;
    if (csi && !csi.valid) {
      flagged.push({ lineNo, reason: `unrecognized CSI code "${rawCsi}"` });
    }

    lines.push({
      lineNo,
      csiCode: csi?.code ?? null,
      csiValid: csi?.valid ?? false,
      description,
      qty,
      unit: cell(row, mapping.unit) ?? null,
      unitCost,
      total,
      raw: row,
    });
  }

  const total =
    Math.round(lines.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
  return { lines, total, skipped, flagged };
}
