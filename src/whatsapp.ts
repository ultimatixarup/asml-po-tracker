import crypto from "node:crypto";
import type { WhatsAppConfig } from "./config.ts";

/** Media attachment carried by an inbound message. */
export interface InboundMedia {
  /** Cloud API media ID; exchanged for a short-lived download URL. */
  id: string;
  mime: string;
  filename?: string;
}

/** The subset of the Cloud API webhook payload this agent acts on. */
export interface InboundMessage {
  /** Message ID (wamid...), used to ignore Meta's retries. */
  id: string;
  /** Sender's WhatsApp ID -- the phone number in E.164 without the "+". */
  from: string;
  /** Message body, or the media caption; empty when there is neither. */
  text: string;
  type: string;
  /** Phone number ID of the business number that received it. */
  phoneNumberId: string;
  media?: InboundMedia;
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
            image?: { id?: string; mime_type?: string; caption?: string };
            document?: {
              id?: string;
              mime_type?: string;
              caption?: string;
              filename?: string;
            };
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
        const attachment = message.image ?? message.document;
        const filename =
          message.document && !message.image
            ? message.document.filename
            : undefined;
        const media: InboundMedia | undefined =
          attachment?.id && attachment.mime_type
            ? {
                id: attachment.id,
                mime: attachment.mime_type,
                ...(filename ? { filename } : {}),
              }
            : undefined;
        messages.push({
          id: message.id,
          from: message.from,
          text: message.text?.body ?? attachment?.caption ?? "",
          type: message.type ?? "unknown",
          phoneNumberId,
          ...(media ? { media } : {}),
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

/**
 * Download a media attachment. The media ID is first exchanged for a download
 * URL, which expires within minutes -- call this immediately on delivery,
 * never from a queue.
 */
export async function downloadWhatsAppMedia(
  config: WhatsAppConfig,
  mediaId: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const auth = { Authorization: `Bearer ${config.accessToken}` };
  const metaResponse = await fetch(
    `https://graph.facebook.com/${config.graphApiVersion}/${mediaId}`,
    { headers: auth },
  );
  if (!metaResponse.ok) {
    throw new Error(`Media lookup failed: ${metaResponse.status}`);
  }
  const meta = (await metaResponse.json()) as {
    url?: string;
    mime_type?: string;
  };
  if (!meta.url) throw new Error(`Media ${mediaId} has no download URL`);

  const fileResponse = await fetch(meta.url, { headers: auth });
  if (!fileResponse.ok) {
    throw new Error(`Media download failed: ${fileResponse.status}`);
  }
  return {
    bytes: new Uint8Array(await fileResponse.arrayBuffer()),
    mime: meta.mime_type ?? "application/octet-stream",
  };
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
