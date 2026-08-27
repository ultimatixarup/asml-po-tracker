/**
 * Request builders for the Meta-side wiring that turns a deployed webhook into
 * a live WhatsApp handle. Kept as pure functions so they can be tested without
 * touching the Graph API.
 */

export interface SetupConfig {
  /** Meta app ID (App Dashboard -> App settings -> Basic). */
  appId: string;
  appSecret: string;
  /** WhatsApp Business Account ID (WhatsApp -> API Setup). */
  wabaId: string;
  phoneNumberId: string;
  /** System-user token with whatsapp_business_management + _messaging. */
  accessToken: string;
  /** Public HTTPS base URL of the deployed service, no trailing slash. */
  publicUrl: string;
  verifyToken: string;
  graphApiVersion: string;
}

export class SetupError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new SetupError(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

export function loadSetupConfig(): SetupConfig {
  const publicUrl = requireEnv("PUBLIC_URL").replace(/\/+$/, "");
  if (!publicUrl.startsWith("https://")) {
    throw new SetupError(
      `PUBLIC_URL must be an https:// URL (Meta rejects plain http). Got: ${publicUrl}`,
    );
  }
  return {
    appId: requireEnv("META_APP_ID"),
    appSecret: requireEnv("WHATSAPP_APP_SECRET"),
    wabaId: requireEnv("WHATSAPP_BUSINESS_ACCOUNT_ID"),
    phoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
    accessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    publicUrl,
    verifyToken: requireEnv("WHATSAPP_VERIFY_TOKEN"),
    graphApiVersion: process.env.GRAPH_API_VERSION ?? "v23.0",
  };
}

/** The callback URL Meta will POST deliveries to. */
export function callbackUrl(config: SetupConfig): string {
  return `${config.publicUrl}/webhook`;
}

/**
 * App access token. Meta accepts the `{app-id}|{app-secret}` form for app-level
 * calls such as registering webhook subscriptions.
 */
export function appAccessToken(config: SetupConfig): string {
  return `${config.appId}|${config.appSecret}`;
}

export interface GraphRequest {
  url: string;
  method: "GET" | "POST";
  /** Form-encoded body, absent on GET. */
  body?: URLSearchParams;
  headers: Record<string, string>;
}

function graphUrl(config: SetupConfig, path: string): string {
  return `https://graph.facebook.com/${config.graphApiVersion}/${path}`;
}

/**
 * Step 1 - point the app's `whatsapp_business_account` webhook at this service
 * and subscribe to the `messages` field. Meta calls back with the verification
 * handshake during this request, so the service must already be live.
 */
export function subscribeAppRequest(config: SetupConfig): GraphRequest {
  return {
    url: graphUrl(config, `${config.appId}/subscriptions`),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      object: "whatsapp_business_account",
      callback_url: callbackUrl(config),
      verify_token: config.verifyToken,
      fields: "messages",
      access_token: appAccessToken(config),
    }),
  };
}

/**
 * Step 2 - subscribe the app to this specific WhatsApp Business Account.
 * Without this, the app has a webhook but receives nothing for the number.
 */
export function subscribeWabaRequest(config: SetupConfig): GraphRequest {
  return {
    url: graphUrl(config, `${config.wabaId}/subscribed_apps`),
    method: "POST",
    headers: { Authorization: `Bearer ${config.accessToken}` },
  };
}

/** Step 3 - read back which apps the WABA is subscribed to. */
export function listWabaSubscriptionsRequest(config: SetupConfig): GraphRequest {
  return {
    url: graphUrl(config, `${config.wabaId}/subscribed_apps`),
    method: "GET",
    headers: { Authorization: `Bearer ${config.accessToken}` },
  };
}

/** Confirms the token can see the number that will act as the handle. */
export function phoneNumberRequest(config: SetupConfig): GraphRequest {
  return {
    url:
      graphUrl(config, config.phoneNumberId) +
      "?fields=display_phone_number,verified_name,quality_rating,code_verification_status",
    method: "GET",
    headers: { Authorization: `Bearer ${config.accessToken}` },
  };
}
