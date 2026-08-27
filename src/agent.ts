import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./domain/prompt.ts";
import type { ColumnMapper } from "./estimates.ts";
import type { BlobStore } from "./storage.ts";
import { createMemoryStore, type Store } from "./store.ts";
import { buildTools } from "./tools.ts";

/**
 * The construction manager agent: a tool-use loop on claude-opus-5. Chat runs
 * at low effort for latency; the reconciliation engine (src/reconcile.ts) is a
 * separate high-effort call.
 */

const MODEL = "claude-opus-5";

/**
 * WhatsApp rejects text bodies over 4096 characters, so there is no point
 * generating more than a couple of paragraphs.
 */
const MAX_TOKENS = 2048;

/** User+assistant messages retained per contact (10 turns). */
const HISTORY_LIMIT = 20;

/** Tool-call round trips per message before the runner stops. */
const MAX_ITERATIONS = 8;

const GREETING =
  "Hello! \u{1F477} I'm your construction manager agent. " +
  "Set ANTHROPIC_API_KEY on the server and I'll start working for real.";

interface AgentDeps {
  store: Store;
  blobs: BlobStore | null;
  mapper: ColumnMapper | null;
}

/** Defaults to in-memory; index.ts swaps in real deps at startup. */
let deps: AgentDeps = { store: createMemoryStore(), blobs: null, mapper: null };

export function setAgentDeps(next: Partial<AgentDeps>): void {
  deps = { ...deps, ...next };
}

/** Back-compat helper for the channels' store wiring. */
export function setStore(store: Store): void {
  setAgentDeps({ store });
}

/** Created lazily so dotenv has loaded regardless of module import order. */
let clientInstance: Anthropic | null | undefined;
function getClient(): Anthropic | null {
  if (clientInstance === undefined) {
    clientInstance = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  }
  return clientInstance;
}

/** One-line, quote-safe preview of a message for the trace log. */
export function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Drop a contact's conversation, e.g. when they say "reset". */
export async function forgetConversation(contactId: string): Promise<void> {
  await deps.store.clearHistory(contactId);
}

/** Volatile per-turn context. Lives in the user turn, never the cached system prompt. */
async function contextLine(contactId: string): Promise<string> {
  const contact = await deps.store.ensureContact(contactId);
  const projects = await deps.store.listProjects();
  const active = projects.find((p) => p.id === contact.activeProjectId);
  const today = new Date().toISOString().slice(0, 10);
  return `[context] date=${today} active_project=${active?.code ?? "none"} projects=${projects.map((p) => p.code).join(",") || "none"}`;
}

/**
 * Produce the agent's reply to one inbound message.
 *
 * @param contactId - the sender's channel key, used as the conversation key.
 * @param text - the inbound message body (or an artifact placeholder).
 */
export async function respond(contactId: string, text: string): Promise<string> {
  const client = getClient();
  if (!client) {
    return GREETING;
  }

  const history = await deps.store.loadHistory(contactId, HISTORY_LIMIT);
  const userTurn: Anthropic.MessageParam = { role: "user", content: text };
  const context = await contextLine(contactId);

  try {
    const startedAt = Date.now();
    const response = await client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      tools: buildTools(deps, contactId),
      max_iterations: MAX_ITERATIONS,
      messages: [
        ...history,
        { role: "user", content: `${context}\n${text}` },
      ],
    });

    console.log(
      `[trace] ${contactId} model ${response.model} ${Date.now() - startedAt}ms ` +
        `in=${response.usage.input_tokens} out=${response.usage.output_tokens} ` +
        `stop=${response.stop_reason}`,
    );

    if (response.stop_reason === "refusal") {
      return "Sorry, I can't help with that one. Ask me something else?";
    }

    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!reply) {
      return "Sorry, I came up empty on that. Try rephrasing?";
    }

    const assistantTurn: Anthropic.MessageParam = {
      role: "assistant",
      content: reply,
    };
    await deps.store.appendHistory(contactId, [userTurn, assistantTurn]);
    return reply;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("[agent] ANTHROPIC_API_KEY is invalid");
      return "My API credentials aren't working right now. Please tell my operator.";
    }
    if (error instanceof Anthropic.RateLimitError) {
      return "I'm being rate limited at the moment -- try me again in a minute.";
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`[agent] API error ${error.status}: ${error.message}`);
    } else {
      console.error("[agent] unexpected error", error);
    }
    return "Something went wrong on my side. Try again shortly.";
  }
}
