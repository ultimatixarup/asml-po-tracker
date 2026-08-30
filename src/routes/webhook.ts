import { Router } from "express";
import type { WhatsAppConfig } from "../config.ts";
import { forgetConversation, preview, respond } from "../agent.ts";
import { handleMenu } from "../menu.ts";
import type { Ingestor } from "../ingest.ts";
import type { Store } from "../store.ts";
import {
  downloadWhatsAppMedia,
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
  config: WhatsAppConfig,
  store: Store,
  ingestor: Ingestor | null,
  message: InboundMessage,
): Promise<void> {
  const contact = await store.ensureContact(message.from);
  const recorded = await store.appendEvent({
    projectId: contact.activeProjectId,
    type: "message.received",
    actor: message.from,
    payload: {
      channel: "whatsapp",
      messageId: message.id,
      type: message.type,
      text: message.text,
    },
    sourceMessageId: `wa:${message.id}`,
  });
  if (recorded === "duplicate") return;

  await markAsRead(config, message.id).catch((error: unknown) => {
    console.warn("[webhook] could not mark message as read:", error);
  });

  if (message.media) {
    if (!ingestor) {
      await sendText(
        config,
        message.from,
        "I received your file, but blob storage isn't configured on my server yet, so I can't keep it.",
      );
      return;
    }
    try {
      // Media URLs expire within minutes; download now, never from a queue.
      const { bytes, mime } = await downloadWhatsAppMedia(config, message.media.id);
      const { placeholder } = await ingestor.ingest({
        bytes,
        mime,
        caption: message.text,
        ...(message.media.filename ? { filename: message.media.filename } : {}),
        contactId: message.from,
        projectId: contact.activeProjectId,
        channel: "whatsapp",
        sourceMessageId: `wa:${message.id}`,
      });
      console.log(`[trace] ${message.from} ingested ${placeholder}`);
      const reply = await respond(
        message.from,
        `${placeholder}${message.text ? `\nSender's note: ${message.text}` : ""}`,
      );
      await sendText(config, message.from, reply);
    } catch (error) {
      console.error("[webhook] ingest failed:", error);
      await sendText(
        config,
        message.from,
        "I couldn't store that file. Try again, or send it a different way.",
      );
    }
    return;
  }

  if (message.type !== "text" || !message.text.trim()) {
    await sendText(
      config,
      message.from,
      "I can only read text and files right now -- send me a few words or a photo/document.",
    );
    return;
  }

  if (message.text.trim().toLowerCase() === "reset") {
    await forgetConversation(message.from);
    await sendText(config, message.from, "Forgotten. We're starting fresh.");
    return;
  }

  console.log(`[trace] ${message.from} -> "${preview(message.text)}"`);
  const menu = handleMenu(message.from, message.text);
  const reply = menu?.reply
    ? menu.reply
    : await respond(message.from, menu?.forward ?? message.text);
  await sendText(config, message.from, reply);
  console.log(`[trace] ${message.from} <- "${preview(reply)}"`);
}

export function createWebhookRouter(
  config: WhatsAppConfig,
  store: Store,
  ingestor: Ingestor | null,
): Router {
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
      handleMessage(config, store, ingestor, message).catch((error: unknown) => {
        console.error(`[webhook] failed to answer ${message.id}:`, error);
      });
    }
  });

  return router;
}
