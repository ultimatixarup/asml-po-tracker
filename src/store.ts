import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "./db.ts";
import { computeEventHash, GENESIS_HASH, type EventType } from "./ledger.ts";

export type { EventType } from "./ledger.ts";

/**
 * Persistence behind one interface with two implementations: in-memory (the
 * default; preserves the original hello-world behavior and keeps tests
 * offline) and Postgres. Both hash-chain events identically -- the memory
 * store is the reference implementation the chain tests run against.
 */

export interface Project {
  id: string;
  code: string;
  name: string;
  address: string | null;
  status: string;
}

export interface Contact {
  contactId: string;
  displayName: string | null;
  activeProjectId: string | null;
}

export type ArtifactKind =
  | "photo"
  | "receipt"
  | "plan"
  | "estimate"
  | "design_note"
  | "document"
  | "other";

export interface Artifact {
  id: string;
  projectId: string | null;
  sha256: string;
  blobKey: string;
  mime: string;
  byteSize: number;
  kind: ArtifactKind;
  extraction: Record<string, unknown> | null;
}

export interface CreateArtifactInput {
  projectId?: string | null;
  sha256: string;
  blobKey: string;
  mime: string;
  byteSize: number;
  kind: ArtifactKind;
  sourceChannel: string;
  sourceMessageId?: string | null;
  uploadedBy: string;
}

export interface Estimate {
  id: string;
  projectId: string;
  version: number;
  status: "current" | "superseded";
  total: number;
}

export interface EstimateLine {
  id: string;
  lineNo: number;
  csiCode: string | null;
  description: string;
  qty: number | null;
  unit: string | null;
  unitCost: number | null;
  total: number;
}

export interface CreateEstimateInput {
  projectId: string;
  sourceArtifactId?: string | null;
  total: number;
  lines: Omit<EstimateLine, "id">[];
}

export type CoStatus = "pco" | "cor" | "approved" | "void";

export interface ChangeOrder {
  id: string;
  projectId: string;
  number: number;
  status: CoStatus;
  title: string;
  baseEstimateId: string;
  netAmount: number;
}

export interface CoLine {
  id: string;
  kind: "add" | "credit";
  csiCode: string | null;
  description: string;
  qty: number | null;
  unit: string | null;
  unitCost: number | null;
  total: number;
  affectsEstimateLineId: string | null;
  rationale: string | null;
  mathNote: string | null;
  evidenceEventIds: (number | string)[];
}

export interface CreateChangeOrderInput {
  projectId: string;
  title: string;
  baseEstimateId: string;
  sourceEventId?: number | string | null;
  netAmount: number;
  lines: Omit<CoLine, "id">[];
}

/** The only legal transitions; everything else is rejected. */
export const CO_TRANSITIONS: Record<CoStatus, CoStatus[]> = {
  pco: ["cor", "void"],
  cor: ["approved", "void"],
  approved: [],
  void: [],
};

export interface AppendEventInput {
  projectId?: string | null;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
  artifactId?: string | null;
  /** wamid / telegram update id; duplicates are silently rejected. */
  sourceMessageId?: string | null;
}

export interface EventRecord {
  id: number | string;
  projectId: string | null;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
  artifactId: string | null;
  createdAt: string;
}

export type AppendEventResult =
  | { id: number | string; hash: string }
  | "duplicate";

export interface Store {
  loadHistory(
    contactId: string,
    limit: number,
  ): Promise<Anthropic.MessageParam[]>;
  appendHistory(
    contactId: string,
    turns: Anthropic.MessageParam[],
  ): Promise<void>;
  clearHistory(contactId: string): Promise<void>;

  ensureContact(contactId: string): Promise<Contact>;
  setActiveProject(contactId: string, projectId: string | null): Promise<void>;

  listProjects(): Promise<Project[]>;
  createProject(code: string, name: string, address?: string): Promise<Project>;

  /** Append to the hash-chained ledger. Chain scope is the project (or a global chain for project-less events). */
  appendEvent(input: AppendEventInput): Promise<AppendEventResult>;

  /** New version supersedes the current one atomically. */
  createEstimate(input: CreateEstimateInput): Promise<Estimate>;
  getCurrentEstimate(projectId: string): Promise<Estimate | null>;
  getEstimateLines(estimateId: string): Promise<EstimateLine[]>;

  createChangeOrder(input: CreateChangeOrderInput): Promise<ChangeOrder>;
  listChangeOrders(projectId: string): Promise<ChangeOrder[]>;
  getChangeOrder(
    projectId: string,
    number: number,
  ): Promise<{ co: ChangeOrder; lines: CoLine[] } | null>;
  /** Validates the transition; the caller writes the co.status_changed event. */
  updateChangeOrderStatus(id: string, to: CoStatus): Promise<ChangeOrder>;

  listEvents(
    projectId: string | null,
    opts?: { type?: EventType; limit?: number },
  ): Promise<EventRecord[]>;

  getArtifact(id: string): Promise<Artifact | null>;
  findArtifactBySha(sha256: string): Promise<Artifact | null>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  updateArtifactExtraction(
    id: string,
    kind: ArtifactKind,
    extraction: Record<string, unknown>,
    model: string,
  ): Promise<void>;
}

const chainScope = (projectId: string | null | undefined): string =>
  projectId ?? "global";

// ---------------------------------------------------------------------------

export function createMemoryStore(): Store {
  const histories = new Map<string, Anthropic.MessageParam[]>();
  const contacts = new Map<string, Contact>();
  const projects: Project[] = [];
  const heads = new Map<string, string>();
  const seenMessages = new Set<string>();
  const artifacts = new Map<string, Artifact>();
  const events: EventRecord[] = [];
  const changeOrders: ChangeOrder[] = [];
  const coLines = new Map<string, CoLine[]>();
  let nextCoLineId = 1;
  const estimates: Estimate[] = [];
  const estimateLines = new Map<string, EstimateLine[]>();
  let nextEventId = 1;
  let nextArtifactId = 1;
  let nextLineId = 1;

  return {
    async loadHistory(contactId, limit) {
      return (histories.get(contactId) ?? []).slice(-limit);
    },
    async appendHistory(contactId, turns) {
      histories.set(contactId, [...(histories.get(contactId) ?? []), ...turns]);
    },
    async clearHistory(contactId) {
      histories.delete(contactId);
    },

    async ensureContact(contactId) {
      let contact = contacts.get(contactId);
      if (!contact) {
        contact = { contactId, displayName: null, activeProjectId: null };
        contacts.set(contactId, contact);
      }
      return contact;
    },
    async setActiveProject(contactId, projectId) {
      const contact = await this.ensureContact(contactId);
      contact.activeProjectId = projectId;
    },

    async listProjects() {
      return [...projects];
    },
    async createProject(code, name, address) {
      if (projects.some((p) => p.code === code)) {
        throw new Error(`Project code ${code} already exists`);
      }
      const project: Project = {
        id: `mem-${projects.length + 1}`,
        code,
        name,
        address: address ?? null,
        status: "active",
      };
      projects.push(project);
      return project;
    },

    async appendEvent(input) {
      if (input.sourceMessageId) {
        if (seenMessages.has(input.sourceMessageId)) return "duplicate";
        seenMessages.add(input.sourceMessageId);
      }
      const scope = chainScope(input.projectId);
      const prev = heads.get(scope) ?? GENESIS_HASH;
      const hash = computeEventHash(prev, input.payload);
      heads.set(scope, hash);
      const id = nextEventId++;
      events.push({
        id,
        projectId: input.projectId ?? null,
        type: input.type,
        actor: input.actor,
        payload: input.payload,
        artifactId: input.artifactId ?? null,
        createdAt: new Date().toISOString(),
      });
      return { id, hash };
    },

    async createChangeOrder(input) {
      const number =
        changeOrders.filter((c) => c.projectId === input.projectId).length + 1;
      const co: ChangeOrder = {
        id: `co-${changeOrders.length + 1}`,
        projectId: input.projectId,
        number,
        status: "pco",
        title: input.title,
        baseEstimateId: input.baseEstimateId,
        netAmount: input.netAmount,
      };
      changeOrders.push(co);
      coLines.set(
        co.id,
        input.lines.map((line) => ({ ...line, id: `col-${nextCoLineId++}` })),
      );
      return co;
    },
    async listChangeOrders(projectId) {
      return changeOrders.filter((c) => c.projectId === projectId);
    },
    async getChangeOrder(projectId, number) {
      const co = changeOrders.find(
        (c) => c.projectId === projectId && c.number === number,
      );
      if (!co) return null;
      return { co, lines: [...(coLines.get(co.id) ?? [])] };
    },
    async updateChangeOrderStatus(id, to) {
      const co = changeOrders.find((c) => c.id === id);
      if (!co) throw new Error(`No change order ${id}`);
      if (!CO_TRANSITIONS[co.status].includes(to)) {
        throw new Error(`Illegal transition ${co.status} -> ${to}`);
      }
      co.status = to;
      return co;
    },

    async listEvents(projectId, opts = {}) {
      const limit = opts.limit ?? 20;
      return events
        .filter(
          (e) =>
            e.projectId === projectId && (!opts.type || e.type === opts.type),
        )
        .slice(-limit);
    },

    async getArtifact(id) {
      for (const artifact of artifacts.values()) {
        if (artifact.id === id) return artifact;
      }
      return null;
    },

    async createEstimate(input) {
      const prior = estimates.filter((e) => e.projectId === input.projectId);
      for (const e of prior) if (e.status === "current") e.status = "superseded";
      const estimate: Estimate = {
        id: `est-${estimates.length + 1}`,
        projectId: input.projectId,
        version: prior.length + 1,
        status: "current",
        total: input.total,
      };
      estimates.push(estimate);
      estimateLines.set(
        estimate.id,
        input.lines.map((line) => ({ ...line, id: `line-${nextLineId++}` })),
      );
      return estimate;
    },
    async getCurrentEstimate(projectId) {
      return (
        estimates.find(
          (e) => e.projectId === projectId && e.status === "current",
        ) ?? null
      );
    },
    async getEstimateLines(estimateId) {
      return [...(estimateLines.get(estimateId) ?? [])];
    },

    async findArtifactBySha(sha256) {
      return artifacts.get(sha256) ?? null;
    },
    async createArtifact(input) {
      const artifact: Artifact = {
        id: `art-${nextArtifactId++}`,
        projectId: input.projectId ?? null,
        sha256: input.sha256,
        blobKey: input.blobKey,
        mime: input.mime,
        byteSize: input.byteSize,
        kind: input.kind,
        extraction: null,
      };
      artifacts.set(input.sha256, artifact);
      return artifact;
    },
    async updateArtifactExtraction(id, kind, extraction) {
      for (const artifact of artifacts.values()) {
        if (artifact.id === id) {
          artifact.kind = kind;
          artifact.extraction = extraction;
          return;
        }
      }
      throw new Error(`Artifact ${id} not found`);
    },
  };
}

// ---------------------------------------------------------------------------

export function createPgStore(db: Db): Store {
  const coFromRow = (row: {
    id: string;
    project_id: string;
    number: number;
    status: CoStatus;
    title: string;
    base_estimate_id: string;
    net_amount: string | number;
  }): ChangeOrder => ({
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    status: row.status,
    title: row.title,
    baseEstimateId: row.base_estimate_id,
    netAmount: Number(row.net_amount),
  });

  return {
    async loadHistory(contactId, limit) {
      const result = await db.query(
        `SELECT role, content FROM chat_messages
         WHERE contact_id = $1 ORDER BY id DESC LIMIT $2`,
        [contactId, limit],
      );
      return result.rows
        .reverse()
        .map((row) => ({ role: row.role, content: row.content }));
    },
    async appendHistory(contactId, turns) {
      for (const turn of turns) {
        await db.query(
          `INSERT INTO chat_messages (contact_id, role, content) VALUES ($1, $2, $3)`,
          [contactId, turn.role, JSON.stringify(turn.content)],
        );
      }
    },
    async clearHistory(contactId) {
      await db.query(`DELETE FROM chat_messages WHERE contact_id = $1`, [
        contactId,
      ]);
    },

    async ensureContact(contactId) {
      const result = await db.query(
        `INSERT INTO contacts (contact_id) VALUES ($1)
         ON CONFLICT (contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id
         RETURNING contact_id, display_name, active_project_id`,
        [contactId],
      );
      const row = result.rows[0];
      return {
        contactId: row.contact_id,
        displayName: row.display_name,
        activeProjectId: row.active_project_id,
      };
    },
    async setActiveProject(contactId, projectId) {
      await this.ensureContact(contactId);
      await db.query(
        `UPDATE contacts SET active_project_id = $2 WHERE contact_id = $1`,
        [contactId, projectId],
      );
    },

    async listProjects() {
      const result = await db.query(
        `SELECT id, code, name, address, status FROM projects ORDER BY created_at`,
      );
      return result.rows;
    },
    async createProject(code, name, address) {
      const result = await db.query(
        `INSERT INTO projects (code, name, address) VALUES ($1, $2, $3)
         RETURNING id, code, name, address, status`,
        [code, name, address ?? null],
      );
      return result.rows[0];
    },

    async appendEvent(input) {
      const scope = chainScope(input.projectId);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // Serialize appends per chain so prev_hash reads are race-free.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          scope,
        ]);
        const head = await client.query(
          `SELECT hash FROM events
           WHERE COALESCE(project_id::text, 'global') = $1
           ORDER BY id DESC LIMIT 1`,
          [scope],
        );
        const prevHash = head.rows[0]?.hash ?? GENESIS_HASH;
        const hash = computeEventHash(prevHash, input.payload);
        const inserted = await client.query(
          `INSERT INTO events
             (project_id, type, actor, payload, artifact_id, source_message_id, prev_hash, hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (source_message_id) WHERE source_message_id IS NOT NULL
           DO NOTHING
           RETURNING id`,
          [
            input.projectId ?? null,
            input.type,
            input.actor,
            JSON.stringify(input.payload),
            input.artifactId ?? null,
            input.sourceMessageId ?? null,
            prevHash,
            hash,
          ],
        );
        await client.query("COMMIT");
        if (inserted.rowCount === 0) return "duplicate";
        return { id: inserted.rows[0].id, hash };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async createEstimate(input) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `estimate:${input.projectId}`,
        ]);
        const prior = await client.query(
          `SELECT COALESCE(MAX(version), 0) AS max FROM estimates WHERE project_id = $1`,
          [input.projectId],
        );
        const version = Number(prior.rows[0].max) + 1;
        await client.query(
          `UPDATE estimates SET status = 'superseded'
           WHERE project_id = $1 AND status = 'current'`,
          [input.projectId],
        );
        const inserted = await client.query(
          `INSERT INTO estimates (project_id, version, source_artifact_id, status, total)
           VALUES ($1, $2, $3, 'current', $4) RETURNING id`,
          [input.projectId, version, input.sourceArtifactId ?? null, input.total],
        );
        const estimateId = inserted.rows[0].id;
        for (const line of input.lines) {
          await client.query(
            `INSERT INTO estimate_lines
               (estimate_id, line_no, csi_code, description, qty, unit, unit_cost, total, raw)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              estimateId,
              line.lineNo,
              line.csiCode,
              line.description,
              line.qty,
              line.unit,
              line.unitCost,
              line.total,
              null,
            ],
          );
        }
        await client.query("COMMIT");
        return {
          id: estimateId,
          projectId: input.projectId,
          version,
          status: "current" as const,
          total: input.total,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async getCurrentEstimate(projectId) {
      const result = await db.query(
        `SELECT id, project_id, version, status, total FROM estimates
         WHERE project_id = $1 AND status = 'current'`,
        [projectId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        projectId: row.project_id,
        version: row.version,
        status: row.status,
        total: Number(row.total),
      };
    },
    async getEstimateLines(estimateId) {
      const result = await db.query(
        `SELECT id, line_no, csi_code, description, qty, unit, unit_cost, total
         FROM estimate_lines WHERE estimate_id = $1 ORDER BY line_no`,
        [estimateId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        lineNo: row.line_no,
        csiCode: row.csi_code,
        description: row.description,
        qty: row.qty === null ? null : Number(row.qty),
        unit: row.unit,
        unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
        total: Number(row.total),
      }));
    },

    async createChangeOrder(input) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `co:${input.projectId}`,
        ]);
        const prior = await client.query(
          `SELECT COALESCE(MAX(number), 0) AS max FROM change_orders WHERE project_id = $1`,
          [input.projectId],
        );
        const number = Number(prior.rows[0].max) + 1;
        const inserted = await client.query(
          `INSERT INTO change_orders
             (project_id, number, status, title, base_estimate_id, source_event_id, net_amount)
           VALUES ($1, $2, 'pco', $3, $4, $5, $6) RETURNING id`,
          [
            input.projectId,
            number,
            input.title,
            input.baseEstimateId,
            input.sourceEventId ?? null,
            input.netAmount,
          ],
        );
        const coId = inserted.rows[0].id;
        for (const line of input.lines) {
          const lineRow = await client.query(
            `INSERT INTO co_lines
               (change_order_id, kind, csi_code, description, qty, unit,
                unit_cost, total, affects_estimate_line_id, rationale, math_note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [
              coId,
              line.kind,
              line.csiCode,
              line.description,
              line.qty,
              line.unit,
              line.unitCost,
              line.total,
              line.affectsEstimateLineId,
              line.rationale,
              line.mathNote,
            ],
          );
          for (const eventId of line.evidenceEventIds) {
            await client.query(
              `INSERT INTO co_line_evidence (co_line_id, event_id) VALUES ($1, $2)`,
              [lineRow.rows[0].id, eventId],
            );
          }
        }
        await client.query("COMMIT");
        return {
          id: coId,
          projectId: input.projectId,
          number,
          status: "pco" as const,
          title: input.title,
          baseEstimateId: input.baseEstimateId,
          netAmount: input.netAmount,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async listChangeOrders(projectId) {
      const result = await db.query(
        `SELECT id, project_id, number, status, title, base_estimate_id, net_amount
         FROM change_orders WHERE project_id = $1 ORDER BY number`,
        [projectId],
      );
      return result.rows.map(coFromRow);
    },
    async getChangeOrder(projectId, number) {
      const found = await db.query(
        `SELECT id, project_id, number, status, title, base_estimate_id, net_amount
         FROM change_orders WHERE project_id = $1 AND number = $2`,
        [projectId, number],
      );
      const row = found.rows[0];
      if (!row) return null;
      const lines = await db.query(
        `SELECT l.id, l.kind, l.csi_code, l.description, l.qty, l.unit,
                l.unit_cost, l.total, l.affects_estimate_line_id, l.rationale,
                l.math_note,
                COALESCE(json_agg(e.event_id) FILTER (WHERE e.event_id IS NOT NULL), '[]') AS evidence
         FROM co_lines l
         LEFT JOIN co_line_evidence e ON e.co_line_id = l.id
         WHERE l.change_order_id = $1
         GROUP BY l.id ORDER BY l.id`,
        [row.id],
      );
      return {
        co: coFromRow(row),
        lines: lines.rows.map((l) => ({
          id: l.id,
          kind: l.kind,
          csiCode: l.csi_code,
          description: l.description,
          qty: l.qty === null ? null : Number(l.qty),
          unit: l.unit,
          unitCost: l.unit_cost === null ? null : Number(l.unit_cost),
          total: Number(l.total),
          affectsEstimateLineId: l.affects_estimate_line_id,
          rationale: l.rationale,
          mathNote: l.math_note,
          evidenceEventIds: l.evidence.map(Number),
        })),
      };
    },
    async updateChangeOrderStatus(id, to) {
      const found = await db.query(
        `SELECT id, project_id, number, status, title, base_estimate_id, net_amount
         FROM change_orders WHERE id = $1`,
        [id],
      );
      const row = found.rows[0];
      if (!row) throw new Error(`No change order ${id}`);
      const from = row.status as CoStatus;
      if (!CO_TRANSITIONS[from].includes(to)) {
        throw new Error(`Illegal transition ${from} -> ${to}`);
      }
      await db.query(`UPDATE change_orders SET status = $2 WHERE id = $1`, [
        id,
        to,
      ]);
      return { ...coFromRow(row), status: to };
    },

    async listEvents(projectId, opts = {}) {
      const limit = opts.limit ?? 20;
      const result = await db.query(
        `SELECT id, project_id, type, actor, payload, artifact_id, created_at
         FROM events
         WHERE project_id IS NOT DISTINCT FROM $1
           AND ($2::text IS NULL OR type = $2)
         ORDER BY id DESC LIMIT $3`,
        [projectId, opts.type ?? null, limit],
      );
      return result.rows.reverse().map((row) => ({
        id: Number(row.id),
        projectId: row.project_id,
        type: row.type,
        actor: row.actor,
        payload: row.payload,
        artifactId: row.artifact_id,
        createdAt: row.created_at.toISOString(),
      }));
    },

    async getArtifact(id) {
      const result = await db.query(
        `SELECT id, project_id, sha256, blob_key, mime, byte_size, kind, extraction
         FROM artifacts WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        projectId: row.project_id,
        sha256: row.sha256,
        blobKey: row.blob_key,
        mime: row.mime,
        byteSize: row.byte_size,
        kind: row.kind,
        extraction: row.extraction,
      };
    },
    async findArtifactBySha(sha256) {
      const result = await db.query(
        `SELECT id, project_id, sha256, blob_key, mime, byte_size, kind, extraction
         FROM artifacts WHERE sha256 = $1`,
        [sha256],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        projectId: row.project_id,
        sha256: row.sha256,
        blobKey: row.blob_key,
        mime: row.mime,
        byteSize: row.byte_size,
        kind: row.kind,
        extraction: row.extraction,
      };
    },
    async createArtifact(input) {
      const result = await db.query(
        `INSERT INTO artifacts
           (project_id, sha256, blob_key, mime, byte_size, kind,
            source_channel, source_message_id, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          input.projectId ?? null,
          input.sha256,
          input.blobKey,
          input.mime,
          input.byteSize,
          input.kind,
          input.sourceChannel,
          input.sourceMessageId ?? null,
          input.uploadedBy,
        ],
      );
      return {
        id: result.rows[0].id,
        projectId: input.projectId ?? null,
        sha256: input.sha256,
        blobKey: input.blobKey,
        mime: input.mime,
        byteSize: input.byteSize,
        kind: input.kind,
        extraction: null,
      };
    },
    async updateArtifactExtraction(id, kind, extraction, model) {
      await db.query(
        `UPDATE artifacts SET kind = $2, extraction = $3, extraction_model = $4
         WHERE id = $1`,
        [id, kind, JSON.stringify(extraction), model],
      );
    },
  };
}
