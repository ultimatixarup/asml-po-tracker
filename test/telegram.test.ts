import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTelegramMessages } from "../src/telegram.ts";

test("extracts chat id and text from getUpdates results", () => {
  const updates = [
    {
      update_id: 100,
      message: {
        message_id: 1,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false },
        text: "hello bot",
      },
    },
  ];
  assert.deepEqual(extractTelegramMessages(updates), [
    { chatId: 42, text: "hello bot", updateId: 100 },
  ]);
});

test("skips non-text updates and malformed input", () => {
  const updates = [
    { update_id: 101, message: { chat: { id: 42 }, sticker: {} } },
    { update_id: 102, edited_message: { chat: { id: 42 }, text: "edited" } },
    { update_id: 103 },
  ];
  assert.deepEqual(extractTelegramMessages(updates), []);
  assert.deepEqual(extractTelegramMessages(null), []);
  assert.deepEqual(extractTelegramMessages({}), []);
});
