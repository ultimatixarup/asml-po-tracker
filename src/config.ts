import "dotenv/config";

/** Credentials for the WhatsApp Cloud API channel. */
export interface WhatsAppConfig {
  /** Token you invent and paste into the Meta webhook setup form. */
  verifyToken: string;
  /** Meta app secret, used to verify the X-Hub-Signature-256 header. */
  appSecret: string;
  /** Phone number ID of the WhatsApp Business number that is the chat handle. */
  phoneNumberId: string;
  /** Permanent (system user) access token with whatsapp_business_messaging. */
  accessToken: string;
  graphApiVersion: string;
}

/** Credentials for the Telegram bot channel. */
export interface TelegramConfig {
  /** Bot token from @BotFather. */
  botToken: string;
}

/** Postgres connection for the ledger, estimates, and chat history. */
export interface DbConfig {
  url: string;
}

/** S3-compatible blob storage (Tigris on Fly; standard AWS env names). */
export interface StorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Non-AWS endpoints (Tigris: https://fly.storage.tigris.dev). */
  endpoint?: string;
}

/** Configuration read from the environment, validated once at startup. */
export interface Config {
  port: number;
  /** Present when all WhatsApp variables are set. */
  whatsapp?: WhatsAppConfig;
  /** Present when TELEGRAM_BOT_TOKEN is set. */
  telegram?: TelegramConfig;
  /** Present when DATABASE_URL is set; absent means in-memory operation. */
  db?: DbConfig;
  /** Present when the AWS/Tigris variables are set; absent means no blobs. */
  storage?: StorageConfig;
  /** Bearer token that gates the read-only /audit pages. */
  auditToken?: string;
  /** Present only when the agent should think; absent means canned replies. */
  anthropicApiKey?: string;
}

const WHATSAPP_VARS = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    port: Number(env.PORT ?? 3000),
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  };

  const setWhatsAppVars = WHATSAPP_VARS.filter((name) => env[name]);
  if (setWhatsAppVars.length === WHATSAPP_VARS.length) {
    config.whatsapp = {
      verifyToken: env.WHATSAPP_VERIFY_TOKEN!,
      appSecret: env.WHATSAPP_APP_SECRET!,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
      accessToken: env.WHATSAPP_ACCESS_TOKEN!,
      graphApiVersion: env.GRAPH_API_VERSION ?? "v23.0",
    };
  } else if (setWhatsAppVars.length > 0) {
    const missing = WHATSAPP_VARS.filter((name) => !env[name]);
    throw new Error(
      `WhatsApp is partially configured -- missing ${missing.join(", ")}. ` +
        `Set all of them to enable WhatsApp, or none to disable it.`,
    );
  }

  if (env.TELEGRAM_BOT_TOKEN) {
    config.telegram = { botToken: env.TELEGRAM_BOT_TOKEN };
  }

  if (env.DATABASE_URL) {
    config.db = { url: env.DATABASE_URL };
  }

  const STORAGE_VARS = [
    "BUCKET_NAME",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ] as const;
  const setStorageVars = STORAGE_VARS.filter((name) => env[name]);
  if (setStorageVars.length === STORAGE_VARS.length) {
    config.storage = {
      bucket: env.BUCKET_NAME!,
      region: env.AWS_REGION!,
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      ...(env.AWS_ENDPOINT_URL_S3 ? { endpoint: env.AWS_ENDPOINT_URL_S3 } : {}),
    };
  } else if (setStorageVars.length > 0) {
    const missing = STORAGE_VARS.filter((name) => !env[name]);
    throw new Error(
      `Blob storage is partially configured -- missing ${missing.join(", ")}. ` +
        `Set all of them to enable storage, or none to disable it.`,
    );
  }

  if (env.AUDIT_TOKEN) {
    config.auditToken = env.AUDIT_TOKEN;
  }

  if (!config.whatsapp && !config.telegram) {
    throw new Error(
      "No chat channel is configured. Set the WHATSAPP_* variables, " +
        "TELEGRAM_BOT_TOKEN, or both. See .env.example.",
    );
  }

  return config;
}
