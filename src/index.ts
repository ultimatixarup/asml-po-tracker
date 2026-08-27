import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { setAgentDeps } from "./agent.ts";
import { loadConfig } from "./config.ts";
import {
  createClaudeClassifier,
  createIngestor,
  type Ingestor,
} from "./ingest.ts";
import { createClaudeColumnMapper } from "./estimates.ts";
import { createWebhookRouter } from "./routes/webhook.ts";
import { createBlobStore } from "./storage.ts";
import { createMemoryStore, createPgStore, type Store } from "./store.ts";
import { pollTelegram } from "./telegram.ts";

const config = loadConfig();

let store: Store;
if (config.db) {
  const { createPool, runMigrations } = await import("./db.ts");
  const pool = createPool(config.db);
  const applied = await runMigrations(pool);
  console.log(
    applied.length
      ? `[db] applied migrations: ${applied.join(", ")}`
      : "[db] schema up to date",
  );
  store = createPgStore(pool);
} else {
  console.warn("[db] DATABASE_URL not set -- running with in-memory state");
  store = createMemoryStore();
}
const blobs = config.storage ? createBlobStore(config.storage) : null;
const anthropic = config.anthropicApiKey ? new Anthropic() : null;
setAgentDeps({
  store,
  blobs,
  mapper: anthropic ? createClaudeColumnMapper(anthropic) : null,
});

let ingestor: Ingestor | null = null;
if (blobs) {
  ingestor = createIngestor({
    store,
    blobs,
    classifier: anthropic ? createClaudeClassifier(anthropic) : null,
  });
} else {
  console.warn("[storage] not configured -- media will be declined");
}

const app = express();

// Keep the raw bytes around: the webhook signature is computed over them, and
// re-serializing the parsed body would change whitespace and break the HMAC.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

const channels: string[] = [];
if (config.whatsapp) channels.push("whatsapp");
if (config.telegram) channels.push("telegram");

app.get("/health", (_req, res) => {
  res.json({ status: "ok", agent: "hello-world", channels });
});

if (config.whatsapp) {
  app.use(createWebhookRouter(config.whatsapp, store, ingestor));
}

if (config.telegram) {
  pollTelegram(config.telegram, store, ingestor).catch((error: unknown) => {
    console.error("[telegram] polling loop died:", error);
    process.exitCode = 1;
  });
}

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} (channels: ${channels.join(", ")})`);
  if (!config.anthropicApiKey) {
    console.warn(
      "[server] ANTHROPIC_API_KEY is not set -- replying with a canned greeting",
    );
  }
});
