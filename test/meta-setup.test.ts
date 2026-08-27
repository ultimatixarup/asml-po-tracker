import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appAccessToken,
  callbackUrl,
  loadSetupConfig,
  phoneNumberRequest,
  SetupError,
  subscribeAppRequest,
  subscribeWabaRequest,
  type SetupConfig,
} from "../src/setup/meta.ts";

const config: SetupConfig = {
  appId: "APP_ID",
  appSecret: "APP_SECRET",
  wabaId: "WABA_ID",
  phoneNumberId: "PHONE_NUMBER_ID",
  accessToken: "SYSTEM_TOKEN",
  publicUrl: "https://agent.example.com",
  verifyToken: "verify-me",
  graphApiVersion: "v23.0",
};

test("derives the callback URL and app access token", () => {
  assert.equal(callbackUrl(config), "https://agent.example.com/webhook");
  assert.equal(appAccessToken(config), "APP_ID|APP_SECRET");
});

test("app subscription registers the callback for the messages field", () => {
  const request = subscribeAppRequest(config);
  assert.equal(
    request.url,
    "https://graph.facebook.com/v23.0/APP_ID/subscriptions",
  );
  assert.equal(request.method, "POST");

  const body = request.body!;
  assert.equal(body.get("object"), "whatsapp_business_account");
  assert.equal(body.get("callback_url"), "https://agent.example.com/webhook");
  assert.equal(body.get("verify_token"), "verify-me");
  assert.equal(body.get("fields"), "messages");
  assert.equal(body.get("access_token"), "APP_ID|APP_SECRET");
});

test("WABA subscription uses the system token as a bearer", () => {
  const request = subscribeWabaRequest(config);
  assert.equal(
    request.url,
    "https://graph.facebook.com/v23.0/WABA_ID/subscribed_apps",
  );
  assert.equal(request.method, "POST");
  assert.equal(request.headers["Authorization"], "Bearer SYSTEM_TOKEN");
});

test("phone number lookup targets the number that acts as the handle", () => {
  const request = phoneNumberRequest(config);
  assert.match(
    request.url,
    /^https:\/\/graph\.facebook\.com\/v23\.0\/PHONE_NUMBER_ID\?fields=/,
  );
  assert.equal(request.method, "GET");
});

test("config loader strips a trailing slash and demands https", (t) => {
  const vars = {
    META_APP_ID: "APP_ID",
    WHATSAPP_APP_SECRET: "APP_SECRET",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "WABA_ID",
    WHATSAPP_PHONE_NUMBER_ID: "PHONE_NUMBER_ID",
    WHATSAPP_ACCESS_TOKEN: "SYSTEM_TOKEN",
    WHATSAPP_VERIFY_TOKEN: "verify-me",
    PUBLIC_URL: "https://agent.example.com/",
  };
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  Object.assign(process.env, vars);

  assert.equal(loadSetupConfig().publicUrl, "https://agent.example.com");

  process.env["PUBLIC_URL"] = "http://agent.example.com";
  assert.throws(() => loadSetupConfig(), SetupError);

  delete process.env["PUBLIC_URL"];
  assert.throws(() => loadSetupConfig(), SetupError);
});
