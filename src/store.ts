import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "./db.ts";
import { computeEventHash, GENESIS_HASH, type EventType } from "./ledger.ts";

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

export interface AppendEventInput {
  projectId?: string | null;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
  artifactId?: string | null;
  /** wamid / telegram update id; duplicates are silently rejected. */
  sourceMessageId?: string | null;
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
  let nextEventId = 1;
  let nextArtifactId = 1;

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
      return { id: nextEventId++, hash };
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
