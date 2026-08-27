import type { TelegramConfig } from "./config.ts";
import { forgetConversation, respond } from "./agent.ts";

/**
 * Telegram channel. Uses long polling (getUpdates), so it needs no public URL,
 * no webhook, and no signature handling -- the offset acknowledgement built
 * into getUpdates also makes redelivery dedupe unnecessary.
 */

/** Telegram rejects message bodies over 4096 characters, same as WhatsApp. */
const MAX_BODY_LENGTH = 4096;

/** Seconds Telegram holds a getUpdates call open waiting for messages. */
const POLL_TIMEOUT_S = 30;

export interface TelegramMessage {
  chatId: number;
  text: string;
}

/** Pull the text messages out of a getUpdates result. */
export function extractTelegramMessages(updates: unknown): TelegramMessage[] {
  const messages: TelegramMessage[] = [];
  const list = updates as {
    message?: { chat?: { id?: number }; text?: string };
  }[];
  for (const update of Array.isArray(list) ? list : []) {
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;
    if (typeof chatId === "number" && typeof text === "string") {
      messages.push({ chatId, text });
    }
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

async function handleMessage(
  config: TelegramConfig,
  message: TelegramMessage,
): Promise<void> {
  // Prefixed so a Telegram chat id can never collide with a WhatsApp number.
  const contactId = `tg:${message.chatId}`;
  const text = message.text.trim();

  let reply: string;
  if (text === "/start") {
    reply =
      "Hello, world! \u{1F44B} I'm a demo Claude agent. Say anything -- or send `reset` to wipe my memory of this chat.";
  } else if (text.toLowerCase() === "reset") {
    forgetConversation(contactId);
    reply = "Forgotten. We're starting fresh.";
  } else {
    reply = await respond(contactId, message.text);
  }

  await api(config, "sendMessage", {
    chat_id: message.chatId,
    text: reply.slice(0, MAX_BODY_LENGTH),
  });
}

/** Run the polling loop forever. Resolves only if `signal` aborts. */
export async function pollTelegram(
  config: TelegramConfig,
  signal?: AbortSignal,
): Promise<void> {
  const me = (await api(config, "getMe", {})) as { username?: string };
  console.log(`[telegram] polling as @${me.username ?? "unknown"}`);

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
        handleMessage(config, message).catch((error: unknown) => {
          console.error("[telegram] failed to answer:", error);
        });
      }
    } catch (error) {
      console.error("[telegram] poll failed, retrying in 5s:", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
