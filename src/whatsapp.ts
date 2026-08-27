import crypto from "node:crypto";
import type { WhatsAppConfig } from "./config.ts";

/** The subset of the Cloud API webhook payload this agent acts on. */
export interface InboundMessage {
  /** Message ID (wamid...), used to ignore Meta's retries. */
  id: string;
  /** Sender's WhatsApp ID -- the phone number in E.164 without the "+". */
  from: string;
  /** Message body; empty for non-text messages. */
  text: string;
  type: string;
  /** Phone number ID of the business number that received it. */
  phoneNumberId: string;
}

/**
 * Verify the X-Hub-Signature-256 header Meta signs every webhook POST with.
 * Must run against the exact raw bytes of the request body.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(received, "utf8");
  return (
    expectedBuf.length === receivedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, receivedBuf)
  );
}

/**
 * Pull inbound messages out of a webhook payload. Status callbacks (sent /
 * delivered / read) carry no `messages` array and yield nothing.
 */
export function extractMessages(payload: unknown): InboundMessage[] {
  const messages: InboundMessage[] = [];
  const body = payload as {
    entry?: {
      changes?: {
        value?: {
          metadata?: { phone_number_id?: string };
          messages?: {
            id?: string;
            from?: string;
            type?: string;
            text?: { body?: string };
          }[];
        };
      }[];
    }[];
  };

  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id ?? "";
      for (const message of value?.messages ?? []) {
        if (!message.id || !message.from) continue;
        messages.push({
          id: message.id,
          from: message.from,
          text: message.text?.body ?? "",
          type: message.type ?? "unknown",
          phoneNumberId,
        });
      }
    }
  }
  return messages;
}

/** WhatsApp rejects text bodies longer than this. */
const MAX_BODY_LENGTH = 4096;

async function callGraph(
  config: WhatsAppConfig,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Graph API ${response.status}: ${detail}`);
  }
}

/** Send a plain-text WhatsApp message to a contact. */
export async function sendText(
  config: WhatsAppConfig,
  to: string,
  text: string,
): Promise<void> {
  await callGraph(config, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: text.slice(0, MAX_BODY_LENGTH) },
  });
}

/** Show the blue ticks while the agent is thinking. Best-effort. */
export async function markAsRead(
  config: WhatsAppConfig,
  messageId: string,
): Promise<void> {
  await callGraph(config, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
}
