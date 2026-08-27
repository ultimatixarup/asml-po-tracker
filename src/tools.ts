import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { CSI_DIVISIONS } from "./domain/csi.ts";
import {
  buildLines,
  parseSpreadsheet,
  type ColumnMapper,
} from "./estimates.ts";
import type { BlobStore } from "./storage.ts";
import type { EventType, Store } from "./store.ts";

/**
 * The agent's tools: thin wrappers over the store, built per request so each
 * closure carries the contact's identity. Every mutation goes through
 * appendEvent, so anything the agent records is on the ledger.
 */

export interface ToolDeps {
  store: Store;
  /** Needed by import_estimate to re-read the uploaded spreadsheet. */
  blobs: BlobStore | null;
  /** Claude column mapper; null when no API key (import still errors clearly). */
  mapper: ColumnMapper | null;
}

function trace(contactId: string, tool: string, detail: string): void {
  console.log(`[trace] ${contactId} tool ${tool} ${detail}`);
}

export function buildTools(deps: ToolDeps, contactId: string) {
  const { store, blobs, mapper } = deps;

  const activeProject = async () => {
    const contact = await store.ensureContact(contactId);
    if (!contact.activeProjectId) return null;
    const projects = await store.listProjects();
    return projects.find((p) => p.id === contact.activeProjectId) ?? null;
  };

  const requireProject = async () => {
    const project = await activeProject();
    if (!project) {
      throw new Error(
        "No active project. Use list_projects and set_active_project first (or create_project).",
      );
    }
    return project;
  };

  return [
    betaZodTool({
      name: "list_projects",
      description:
        "List all projects with code, name, and status. Also shows which one is active for this contact.",
      inputSchema: z.object({}),
      run: async () => {
        trace(contactId, "list_projects", "");
        const [projects, active] = await Promise.all([
          store.listProjects(),
          activeProject(),
        ]);
        return JSON.stringify({
          projects,
          activeProjectCode: active?.code ?? null,
        });
      },
    }),

    betaZodTool({
      name: "create_project",
      description:
        "Create a new project. Use a short uppercase code the crew will recognize (e.g. MAPLE).",
      inputSchema: z.object({
        code: z.string().min(2).max(16),
        name: z.string(),
        address: z.string().optional(),
      }),
      run: async (input) => {
        trace(contactId, "create_project", input.code);
        const project = await store.createProject(
          input.code.toUpperCase(),
          input.name,
          input.address,
        );
        await store.setActiveProject(contactId, project.id);
        return JSON.stringify({ created: project, nowActive: true });
      },
    }),

    betaZodTool({
      name: "set_active_project",
      description:
        "Switch this contact's active project by project code. Subsequent messages file under it.",
      inputSchema: z.object({ code: z.string() }),
      run: async (input) => {
        trace(contactId, "set_active_project", input.code);
        const projects = await store.listProjects();
        const project = projects.find(
          (p) => p.code === input.code.toUpperCase(),
        );
        if (!project) {
          return `No project with code ${input.code}. Existing: ${projects.map((p) => p.code).join(", ") || "none"}`;
        }
        await store.setActiveProject(contactId, project.id);
        return JSON.stringify({ nowActive: project });
      },
    }),

    betaZodTool({
      name: "get_estimate",
      description:
        "Read the active project's current estimate: version, total, and line items. Optionally filter lines by CSI division (two digits, e.g. '09').",
      inputSchema: z.object({
        csi_division: z.string().length(2).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      run: async (input) => {
        const project = await requireProject();
        trace(contactId, "get_estimate", project.code);
        const estimate = await store.getCurrentEstimate(project.id);
        if (!estimate) {
          return `Project ${project.code} has no estimate yet. Upload the spreadsheet and use import_estimate.`;
        }
        let lines = await store.getEstimateLines(estimate.id);
        if (input.csi_division) {
          lines = lines.filter((l) =>
            l.csiCode?.startsWith(input.csi_division!),
          );
        }
        return JSON.stringify({
          version: estimate.version,
          total: estimate.total,
          lineCount: lines.length,
          lines: lines.slice(0, input.limit),
          csiDivisions: CSI_DIVISIONS,
        });
      },
    }),

    betaZodTool({
      name: "search_ledger",
      description:
        "Read recent ledger events for the active project. Types: message.received, artifact.ingested, estimate.imported, change.requested, co.drafted, co.status_changed, note.logged, daily_log.recorded.",
      inputSchema: z.object({
        type: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      run: async (input) => {
        const project = await requireProject();
        trace(contactId, "search_ledger", input.type ?? "all");
        const events = await store.listEvents(project.id, {
          ...(input.type ? { type: input.type as EventType } : {}),
          limit: input.limit,
        });
        return JSON.stringify(events);
      },
    }),

    betaZodTool({
      name: "get_artifact",
      description:
        "Fetch one artifact's metadata and extraction by artifact id (the id inside [photo art-...: ...] placeholders).",
      inputSchema: z.object({ artifact_id: z.string() }),
      run: async (input) => {
        trace(contactId, "get_artifact", input.artifact_id);
        const artifact = await store.getArtifact(input.artifact_id);
        return artifact ? JSON.stringify(artifact) : "No such artifact.";
      },
    }),

    betaZodTool({
      name: "record_note",
      description:
        "Record a note on the active project's ledger (decisions, verbal directives, site conditions).",
      inputSchema: z.object({ note: z.string().min(3) }),
      run: async (input) => {
        const project = await requireProject();
        trace(contactId, "record_note", "");
        const result = await store.appendEvent({
          projectId: project.id,
          type: "note.logged",
          actor: contactId,
          payload: { note: input.note },
        });
        return result === "duplicate" ? "Already recorded." : "Recorded on the ledger.";
      },
    }),

    betaZodTool({
      name: "record_daily_log",
      description:
        "Record a daily log entry: crew, weather, work performed, delays. Strong dispute evidence -- encourage these.",
      inputSchema: z.object({
        crew: z.string().optional(),
        weather: z.string().optional(),
        work_performed: z.string(),
        delays: z.string().optional(),
      }),
      run: async (input) => {
        const project = await requireProject();
        trace(contactId, "record_daily_log", "");
        await store.appendEvent({
          projectId: project.id,
          type: "daily_log.recorded",
          actor: contactId,
          payload: { ...input },
        });
        return "Daily log recorded.";
      },
    }),

    betaZodTool({
      name: "import_estimate",
      description:
        "Parse an uploaded estimate spreadsheet (artifact id of kind 'estimate'). ALWAYS call with confirm=false first and show the PM the line count, total, and flags; call again with confirm=true only after they explicitly confirm.",
      inputSchema: z.object({
        artifact_id: z.string(),
        confirm: z.boolean().default(false),
      }),
      run: async (input) => {
        const project = await requireProject();
        trace(
          contactId,
          "import_estimate",
          `${input.artifact_id} confirm=${input.confirm}`,
        );
        if (!blobs) return "Blob storage is not configured on this server.";
        if (!mapper) return "No model access for column mapping on this server.";

        const artifact = await store.getArtifact(input.artifact_id);
        if (!artifact) return "No such artifact.";
        const bytes = await blobs.get(artifact.blobKey);
        const sheet = await parseSpreadsheet(bytes, artifact.mime);
        if (!sheet.rows.length) return "That file parsed to zero data rows.";
        const mapping = await mapper(sheet);
        const built = buildLines(sheet, mapping);

        if (!input.confirm) {
          return JSON.stringify({
            preview: true,
            lineCount: built.lines.length,
            total: built.total,
            skipped: built.skipped,
            flagged: built.flagged,
            firstLines: built.lines.slice(0, 5),
          });
        }

        const estimate = await store.createEstimate({
          projectId: project.id,
          sourceArtifactId: artifact.id,
          total: built.total,
          lines: built.lines.map((l) => ({
            lineNo: l.lineNo,
            csiCode: l.csiCode,
            description: l.description,
            qty: l.qty,
            unit: l.unit,
            unitCost: l.unitCost,
            total: l.total,
          })),
        });
        await store.appendEvent({
          projectId: project.id,
          type: "estimate.imported",
          actor: contactId,
          payload: {
            estimateId: estimate.id,
            version: estimate.version,
            total: built.total,
            lineCount: built.lines.length,
            sourceArtifactId: artifact.id,
          },
          artifactId: artifact.id,
        });
        return JSON.stringify({
          imported: true,
          version: estimate.version,
          total: built.total,
          lineCount: built.lines.length,
        });
      },
    }),
  ];
}
