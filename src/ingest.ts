import Anthropic from "@anthropic-ai/sdk";
import { sha256Hex } from "./ledger.ts";
import type { BlobStore } from "./storage.ts";
import type { Artifact, ArtifactKind, Store } from "./store.ts";

/**
 * Ingestion pipeline: bytes from a chat channel -> content-addressed blob ->
 * artifact row -> classification/extraction -> ledger events -> a one-line
 * placeholder the conversation can carry instead of the media itself.
 */

/** Telegram caps bot downloads at ~20MB; keep one limit across channels. */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const VISION_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Result of classifying an artifact, from the model or from the MIME type. */
export interface Classification {
  kind: ArtifactKind;
  summary: string;
  isChangeSignal: boolean;
  extraction: Record<string, unknown>;
}

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "summary", "is_change_signal"],
  properties: {
    kind: {
      type: "string",
      enum: ["photo", "receipt", "plan", "design_note", "document"],
      description:
        "photo = site/progress photo; receipt = purchase receipt or invoice; " +
        "plan = architectural/engineering drawing; design_note = written design " +
        "direction or change description; document = anything else",
    },
    summary: {
      type: "string",
      description: "One line, under 120 characters, concrete and specific",
    },
    is_change_signal: {
      type: "boolean",
      description:
        "True if this indicates changed scope, design, or cost vs. what was planned",
    },
    receipt: {
      type: "object",
      additionalProperties: false,
      properties: {
        vendor: { type: "string" },
        date: { type: "string" },
        total: { type: "number" },
        items: { type: "array", items: { type: "string" } },
      },
    },
    photo: {
      type: "object",
      additionalProperties: false,
      properties: {
        work_observed: { type: "string" },
        location_hint: { type: "string" },
      },
    },
    plan_or_note: {
      type: "object",
      additionalProperties: false,
      properties: {
        discipline: { type: "string" },
        change_summary: { type: "string" },
      },
    },
  },
} as const;

/**
 * Deterministic fallback classification from MIME type and filename, used for
 * types vision cannot read and when no API key is configured.
 */
export function kindFromMime(mime: string, filename?: string): ArtifactKind {
  const name = (filename ?? "").toLowerCase();
  if (
    mime.includes("spreadsheet") ||
    mime === "text/csv" ||
    /\.(xlsx|xlsm|csv)$/.test(name)
  ) {
    return "estimate";
  }
  if (VISION_IMAGE_TYPES.has(mime)) return "photo";
  if (mime === "application/pdf") return "document";
  return "other";
}

export type Classifier = (
  bytes: Uint8Array,
  mime: string,
  caption: string,
) => Promise<Classification | null>;

/** Classifier backed by one Claude vision call with a strict output schema. */
export function createClaudeClassifier(client: Anthropic): Classifier {
  return async (bytes, mime, caption) => {
    const media_type = mime as "image/jpeg";
    const source = { type: "base64", media_type, data: Buffer.from(bytes).toString("base64") } as const;
    const block =
      mime === "application/pdf"
        ? ({ type: "document", source: { ...source, media_type: "application/pdf" } } as const)
        : VISION_IMAGE_TYPES.has(mime)
          ? ({ type: "image", source } as const)
          : null;
    if (!block) return null;

    const response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown> },
      },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [
        {
          role: "user",
          content: [
            block,
            {
              type: "text",
              text:
                "Classify this construction-project artifact and extract what the schema asks for." +
                (caption ? ` Sender's caption: "${caption}"` : ""),
            },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = JSON.parse(text) as {
      kind: Exclude<ArtifactKind, "estimate" | "other">;
      summary: string;
      is_change_signal: boolean;
    } & Record<string, unknown>;
    const { kind, summary, is_change_signal, ...rest } = parsed;
    return { kind, summary, isChangeSignal: is_change_signal, extraction: rest };
  };
}

export interface Ingestor {
  ingest(input: {
    bytes: Uint8Array;
    mime: string;
    caption: string;
    filename?: string;
    contactId: string;
    projectId: string | null;
    channel: string;
    sourceMessageId: string;
  }): Promise<{ artifact: Artifact; placeholder: string }>;
}

export function createIngestor(deps: {
  store: Store;
  blobs: BlobStore;
  classifier: Classifier | null;
}): Ingestor {
  const { store, blobs, classifier } = deps;

  return {
    async ingest(input) {
      if (input.bytes.byteLength > MAX_MEDIA_BYTES) {
        throw new Error(
          `File is ${Math.round(input.bytes.byteLength / 1e6)}MB; the limit is ${MAX_MEDIA_BYTES / 1e6}MB`,
        );
      }

      const sha256 = sha256Hex(input.bytes);
      const existing = await store.findArtifactBySha(sha256);
      if (existing) {
        return { artifact: existing, placeholder: placeholderFor(existing) };
      }

      const blobKey = await blobs.put(sha256, input.bytes, input.mime);
      let artifact = await store.createArtifact({
        projectId: input.projectId,
        sha256,
        blobKey,
        mime: input.mime,
        byteSize: input.bytes.byteLength,
        kind: kindFromMime(input.mime, input.filename),
        sourceChannel: input.channel,
        sourceMessageId: input.sourceMessageId,
        uploadedBy: input.contactId,
      });

      let classification: Classification | null = null;
      if (classifier) {
        try {
          classification = await classifier(input.bytes, input.mime, input.caption);
        } catch (error) {
          console.error(`[ingest] classification failed for ${artifact.id}:`, error);
        }
      }
      if (classification) {
        await store.updateArtifactExtraction(
          artifact.id,
          classification.kind,
          { summary: classification.summary, ...classification.extraction },
          "claude-opus-5",
        );
        artifact = {
          ...artifact,
          kind: classification.kind,
          extraction: { summary: classification.summary, ...classification.extraction },
        };
      }

      await store.appendEvent({
        projectId: input.projectId,
        type: "artifact.ingested",
        actor: input.contactId,
        payload: {
          artifactId: artifact.id,
          sha256,
          kind: artifact.kind,
          mime: input.mime,
          byteSize: input.bytes.byteLength,
          summary: classification?.summary ?? null,
          caption: input.caption || null,
        },
        artifactId: artifact.id,
      });

      if (classification?.isChangeSignal) {
        await store.appendEvent({
          projectId: input.projectId,
          type: "change.requested",
          actor: input.contactId,
          payload: {
            artifactId: artifact.id,
            summary: classification.summary,
          },
          artifactId: artifact.id,
        });
      }

      return { artifact, placeholder: placeholderFor(artifact) };
    },
  };
}

function placeholderFor(artifact: Artifact): string {
  const summary =
    (artifact.extraction?.summary as string | undefined) ??
    `${artifact.mime}, ${Math.round(artifact.byteSize / 1024)}KB`;
  return `[${artifact.kind} ${artifact.id}: ${summary}]`;
}
