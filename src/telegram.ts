import type { TelegramConfig } from "./config.ts";
import { forgetConversation, preview, respond } from "./agent.ts";
import { handleMenu, rootMenu } from "./menu.ts";
import type { Ingestor } from "./ingest.ts";
import type { Store } from "./store.ts";

/**
 * Telegram channel. Uses long polling (getUpdates), so it needs no public URL,
 * no webhook, and no signature handling -- the offset acknowledgement built
 * into getUpdates also makes redelivery dedupe unnecessary.
 */

/** Telegram rejects message bodies over 4096 characters, same as WhatsApp. */
const MAX_BODY_LENGTH = 4096;

/** Seconds Telegram holds a getUpdates call open waiting for messages. */
const POLL_TIMEOUT_S = 30;

export interface TelegramMedia {
  fileId: string;
  mime: string;
  filename?: string;
}

export interface TelegramMessage {
  chatId: number;
  /** Message text, or the media caption; empty when there is neither. */
  text: string;
  updateId: number;
  media?: TelegramMedia;
}

/** Pull the text messages out of a getUpdates result. */
export function extractTelegramMessages(updates: unknown): TelegramMessage[] {
  const messages: TelegramMessage[] = [];
  const list = updates as {
    update_id?: number;
    message?: {
      chat?: { id?: number };
      text?: string;
      caption?: string;
      photo?: { file_id?: string; width?: number }[];
      document?: { file_id?: string; mime_type?: string; file_name?: string };
    };
  }[];
  for (const update of Array.isArray(list) ? list : []) {
    const message = update.message;
    const chatId = message?.chat?.id;
    if (typeof chatId !== "number") continue;
    const updateId = update.update_id ?? 0;

    // Photos arrive as multiple sizes; the last entry is the largest.
    const photo = message?.photo?.at(-1);
    let media: TelegramMedia | undefined;
    if (photo?.file_id) {
      media = { fileId: photo.file_id, mime: "image/jpeg" };
    } else if (message?.document?.file_id) {
      media = {
        fileId: message.document.file_id,
        mime: message.document.mime_type ?? "application/octet-stream",
        ...(message.document.file_name
          ? { filename: message.document.file_name }
          : {}),
      };
    }

    const text = message?.text ?? message?.caption ?? "";
    if (!text && !media) continue;
    messages.push({ chatId, text, updateId, ...(media ? { media } : {}) });
  }
  return messages;
}

async function api(
  config: TelegramConfig,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(
    `https://api.telegram.org/bot${config.botToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const parsed = (await response.json()) as {
    ok: boolean;
    result?: unknown;
    description?: string;
  };
  if (!parsed.ok) {
    throw new Error(`Telegram ${method}: ${parsed.description ?? "unknown error"}`);
  }
  return parsed.result;
}

/** Push a message to a chat outside the poll loop (async notifications). */
export async function sendTelegramText(
  config: TelegramConfig,
  chatId: number,
  text: string,
): Promise<void> {
  await api(config, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, MAX_BODY_LENGTH),
  });
}

/** Download a file sent to the bot. Bot API caps downloads at ~20MB. */
export async function downloadTelegramFile(
  config: TelegramConfig,
  fileId: string,
): Promise<Uint8Array> {
  const file = (await api(config, "getFile", { file_id: fileId })) as {
    file_path?: string;
  };
  if (!file.file_path) throw new Error(`File ${fileId} has no file_path`);
  const response = await fetch(
    `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`,
  );
  if (!response.ok) {
    throw new Error(`File download failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function handleMessage(
  config: TelegramConfig,
  store: Store,
  ingestor: Ingestor | null,
  message: TelegramMessage,
): Promise<void> {
  // Prefixed so a Telegram chat id can never collide with a WhatsApp number.
  const contactId = `tg:${message.chatId}`;
  const text = message.text.trim();
  console.log(`[trace] ${contactId} -> "${preview(message.text)}"`);

  const contact = await store.ensureContact(contactId);
  const recorded = await store.appendEvent({
    projectId: contact.activeProjectId,
    type: "message.received",
    actor: contactId,
    payload: { channel: "telegram", updateId: message.updateId, text },
    sourceMessageId: `tg:${message.updateId}`,
  });
  if (recorded === "duplicate") return;

  let reply: string;
  if (message.media) {
    if (!ingestor) {
      reply =
        "I received your file, but blob storage isn't configured on my server yet, so I can't keep it.";
    } else {
      try {
        const bytes = await downloadTelegramFile(config, message.media.fileId);
        const { placeholder } = await ingestor.ingest({
          bytes,
          mime: message.media.mime,
          caption: text,
          ...(message.media.filename ? { filename: message.media.filename } : {}),
          contactId,
          projectId: contact.activeProjectId,
          channel: "telegram",
          sourceMessageId: `tg:${message.updateId}`,
        });
        console.log(`[trace] ${contactId} ingested ${placeholder}`);
        reply = await respond(
          contactId,
          `${placeholder}${text ? `\nSender's note: ${text}` : ""}`,
        );
      } catch (error) {
        console.error(`[telegram] ingest failed:`, error);
        reply =
          "I couldn't store that file. Try again, or send it a different way.";
      }
    }
  } else if (text === "/start") {
    reply =
      "Hello! \u{1F477} I'm your construction manager agent.\n\n" + rootMenu();
  } else if (text.toLowerCase() === "reset") {
    await forgetConversation(contactId);
    reply = "Forgotten. We're starting fresh.";
  } else {
    const menu = handleMenu(contactId, text);
    if (menu?.reply) {
      reply = menu.reply;
    } else {
      reply = await respond(contactId, menu?.forward ?? message.text);
    }
  }

  await api(config, "sendMessage", {
    chat_id: message.chatId,
    text: reply.slice(0, MAX_BODY_LENGTH),
  });
  console.log(`[trace] ${contactId} <- "${preview(reply)}"`);
}

/** Run the polling loop forever. Resolves only if `signal` aborts. */
export async function pollTelegram(
  config: TelegramConfig,
  store: Store,
  ingestor: Ingestor | null,
  signal?: AbortSignal,
): Promise<void> {
  const me = (await api(config, "getMe", {})) as { username?: string };
  console.log(`[telegram] polling as @${me.username ?? "unknown"}`);

  // Native command menu (the "/" button in Telegram). Best-effort, idempotent.
  await api(config, "setMyCommands", {
    commands: [
      { command: "menu", description: "Open the menu" },
      { command: "help", description: "What can I send you?" },
      { command: "start", description: "Introduction + menu" },
    ],
  }).catch((error: unknown) => {
    console.warn("[telegram] setMyCommands failed:", error);
  });

  let offset = 0;
  while (!signal?.aborted) {
    try {
      const updates = (await api(config, "getUpdates", {
        offset,
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ["message"],
      })) as { update_id: number }[];

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
      }
      for (const message of extractTelegramMessages(updates)) {
        handleMessage(config, store, ingestor, message).catch((error: unknown) => {
          console.error("[telegram] failed to answer:", error);
        });
      }
    } catch (error) {
      console.error("[telegram] poll failed, retrying in 5s:", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
