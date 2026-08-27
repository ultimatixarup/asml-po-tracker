import "dotenv/config";

/** Configuration read from the environment, validated once at startup. */
export interface Config {
  port: number;
  /** Token you invent and paste into the Meta webhook setup form. */
  verifyToken: string;
  /** Meta app secret, used to verify the X-Hub-Signature-256 header. */
  appSecret: string;
  /** Phone number ID of the WhatsApp Business number that is the chat handle. */
  phoneNumberId: string;
  /** Permanent (system user) access token with whatsapp_business_messaging. */
  accessToken: string;
  graphApiVersion: string;
  /** Present only when the agent should think; absent means canned replies. */
  anthropicApiKey?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
    appSecret: required("WHATSAPP_APP_SECRET"),
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    accessToken: required("WHATSAPP_ACCESS_TOKEN"),
    graphApiVersion: process.env.GRAPH_API_VERSION ?? "v23.0",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  };
}
