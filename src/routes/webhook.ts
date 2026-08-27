import { Router } from "express";
import type { Config } from "../config.ts";
import { forgetConversation, respond } from "../agent.ts";
import {
  extractMessages,
  markAsRead,
  sendText,
  verifySignature,
  type InboundMessage,
} from "../whatsapp.ts";

/**
 * Message IDs already handled. Meta retries a webhook for up to 7 days if it
 * does not get a fast 200, and a retry must not produce a second reply.
 */
const seen = new Set<string>();
const SEEN_LIMIT = 1000;

function alreadyHandled(id: string): boolean {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > SEEN_LIMIT) {
    // Sets iterate in insertion order, so this drops the oldest entry.
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

async function handleMessage(
  config: Config,
  message: InboundMessage,
): Promise<void> {
  if (message.type !== "text" || !message.text.trim()) {
    await sendText(
      config,
      message.from,
      "I can only read text messages right now -- send me a few words.",
    );
    return;
  }

  await markAsRead(config, message.id).catch((error: unknown) => {
    console.warn("[webhook] could not mark message as read:", error);
  });

  if (message.text.trim().toLowerCase() === "reset") {
    forgetConversation(message.from);
    await sendText(config, message.from, "Forgotten. We're starting fresh.");
    return;
  }

  const reply = await respond(message.from, message.text);
  await sendText(config, message.from, reply);
}

export function createWebhookRouter(config: Config): Router {
  const router = Router();

  // Meta calls this once, when you save the callback URL in the app dashboard.
  router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === config.verifyToken) {
      console.log("[webhook] verified by Meta");
      res.status(200).send(String(challenge ?? ""));
      return;
    }
    res.sendStatus(403);
  });

  router.post("/webhook", (req, res) => {
    const rawBody = (req as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    if (!verifySignature(rawBody, req.get("x-hub-signature-256"), config.appSecret)) {
      console.warn("[webhook] rejected a payload with a bad signature");
      res.sendStatus(401);
      return;
    }

    // Acknowledge immediately; the model call takes longer than Meta will wait.
    res.sendStatus(200);

    for (const message of extractMessages(req.body)) {
      if (alreadyHandled(message.id)) continue;
      handleMessage(config, message).catch((error: unknown) => {
        console.error(`[webhook] failed to answer ${message.id}:`, error);
      });
    }
  });

  return router;
}
