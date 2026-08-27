import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { extractMessages, verifySignature } from "../src/whatsapp.ts";

const APP_SECRET = "test-app-secret";

function sign(body: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex")
  );
}

test("accepts a correctly signed body", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifySignature(Buffer.from(body), sign(body), APP_SECRET), true);
});

test("rejects a tampered body, a wrong secret, and a missing header", () => {
  const body = JSON.stringify({ hello: "world" });
  const signature = sign(body);

  assert.equal(
    verifySignature(Buffer.from(body + " "), signature, APP_SECRET),
    false,
  );
  assert.equal(verifySignature(Buffer.from(body), signature, "other"), false);
  assert.equal(verifySignature(Buffer.from(body), undefined, APP_SECRET), false);
  assert.equal(verifySignature(Buffer.from(body), "deadbeef", APP_SECRET), false);
});

test("extracts a text message from a webhook payload", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550001111",
                phone_number_id: "PHONE_NUMBER_ID",
              },
              messages: [
                {
                  from: "15551234567",
                  id: "wamid.ABC",
                  timestamp: "1724750000",
                  type: "text",
                  text: { body: "hi there" },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  assert.deepEqual(extractMessages(payload), [
    {
      id: "wamid.ABC",
      from: "15551234567",
      text: "hi there",
      type: "text",
      phoneNumberId: "PHONE_NUMBER_ID",
    },
  ]);
});

test("ignores delivery-status callbacks and malformed payloads", () => {
  const statusPayload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "PHONE_NUMBER_ID" },
              statuses: [{ id: "wamid.ABC", status: "delivered" }],
            },
          },
        ],
      },
    ],
  };

  assert.deepEqual(extractMessages(statusPayload), []);
  assert.deepEqual(extractMessages({}), []);
  assert.deepEqual(extractMessages(null), []);
});
