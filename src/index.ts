import express from "express";
import { loadConfig } from "./config.ts";
import { createWebhookRouter } from "./routes/webhook.ts";

const config = loadConfig();
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", agent: "hello-world" });
});

app.use(createWebhookRouter(config));

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  if (!config.anthropicApiKey) {
    console.warn(
      "[server] ANTHROPIC_API_KEY is not set -- replying with a canned greeting",
    );
  }
});
