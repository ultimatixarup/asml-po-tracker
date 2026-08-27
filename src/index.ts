import express from "express";
import { loadConfig } from "./config.ts";
import { createWebhookRouter } from "./routes/webhook.ts";
import { pollTelegram } from "./telegram.ts";

const config = loadConfig();

if (config.db) {
  const { createPool, runMigrations } = await import("./db.ts");
  const applied = await runMigrations(createPool(config.db));
  console.log(
    applied.length
      ? `[db] applied migrations: ${applied.join(", ")}`
      : "[db] schema up to date",
  );
} else {
  console.warn("[db] DATABASE_URL not set -- running with in-memory state");
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
  app.use(createWebhookRouter(config.whatsapp));
}

if (config.telegram) {
  pollTelegram(config.telegram).catch((error: unknown) => {
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
