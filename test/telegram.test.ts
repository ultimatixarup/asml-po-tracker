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

test("extracts photos (largest size) and documents with captions", () => {
  const updates = [
    {
      update_id: 200,
      message: {
        chat: { id: 42 },
        caption: "north wall",
        photo: [
          { file_id: "small", width: 90 },
          { file_id: "large", width: 1280 },
        ],
      },
    },
    {
      update_id: 201,
      message: {
        chat: { id: 42 },
        document: {
          file_id: "doc1",
          mime_type: "text/csv",
          file_name: "estimate.csv",
        },
      },
    },
  ];
  assert.deepEqual(extractTelegramMessages(updates), [
    {
      chatId: 42,
      text: "north wall",
      updateId: 200,
      media: { fileId: "large", mime: "image/jpeg" },
    },
    {
      chatId: 42,
      text: "",
      updateId: 201,
      media: { fileId: "doc1", mime: "text/csv", filename: "estimate.csv" },
    },
  ]);
});
