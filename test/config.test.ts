import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const whatsappVars = {
  WHATSAPP_VERIFY_TOKEN: "tok",
  WHATSAPP_APP_SECRET: "secret",
  WHATSAPP_PHONE_NUMBER_ID: "pnid",
  WHATSAPP_ACCESS_TOKEN: "access",
};

test("whatsapp-only config enables just that channel", () => {
  const config = loadConfig({ ...whatsappVars });
  assert.ok(config.whatsapp);
  assert.equal(config.telegram, undefined);
  assert.equal(config.whatsapp.graphApiVersion, "v23.0");
});

test("telegram-only config enables just that channel", () => {
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc" });
  assert.equal(config.whatsapp, undefined);
  assert.deepEqual(config.telegram, { botToken: "123:abc" });
});

test("both channels can be enabled together", () => {
  const config = loadConfig({ ...whatsappVars, TELEGRAM_BOT_TOKEN: "123:abc" });
  assert.ok(config.whatsapp);
  assert.ok(config.telegram);
});

test("no channel at all is a startup error", () => {
  assert.throws(() => loadConfig({}), /No chat channel is configured/);
});

test("partial whatsapp config names the missing variables", () => {
  assert.throws(
    () => loadConfig({ WHATSAPP_VERIFY_TOKEN: "tok", TELEGRAM_BOT_TOKEN: "x" }),
    /missing WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN/,
  );
});

test("db and storage groups activate independently of channels", () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "123:abc",
    DATABASE_URL: "postgres://localhost/cm",
    BUCKET_NAME: "blobs",
    AWS_REGION: "auto",
    AWS_ACCESS_KEY_ID: "k",
    AWS_SECRET_ACCESS_KEY: "s",
    AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev",
    AUDIT_TOKEN: "tok",
  });
  assert.deepEqual(config.db, { url: "postgres://localhost/cm" });
  assert.equal(config.storage?.bucket, "blobs");
  assert.equal(config.storage?.endpoint, "https://fly.storage.tigris.dev");
  assert.equal(config.auditToken, "tok");

  const bare = loadConfig({ TELEGRAM_BOT_TOKEN: "123:abc" });
  assert.equal(bare.db, undefined);
  assert.equal(bare.storage, undefined);
});

test("partial storage config names the missing variables", () => {
  assert.throws(
    () => loadConfig({ TELEGRAM_BOT_TOKEN: "x", BUCKET_NAME: "blobs" }),
    /missing AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY/,
  );
});
