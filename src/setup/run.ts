import "dotenv/config";
import {
  callbackUrl,
  listWabaSubscriptionsRequest,
  loadSetupConfig,
  phoneNumberRequest,
  SetupError,
  subscribeAppRequest,
  subscribeWabaRequest,
  type GraphRequest,
} from "./meta.ts";

/**
 * One-command Meta wiring: registers this service as the app's webhook and
 * subscribes the WhatsApp Business Account to it.
 *
 *   npm run whatsapp:setup           apply the wiring
 *   npm run whatsapp:setup -- --check   report current state, change nothing
 *
 * The deployed service must be reachable at PUBLIC_URL before running this:
 * Meta performs the verification handshake during step 2.
 */

async function graph(request: GraphRequest): Promise<unknown> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const detail =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? JSON.stringify((parsed as { error: unknown }).error)
        : text;
    throw new SetupError(`Graph API ${response.status}: ${detail}`);
  }
  return parsed;
}

async function checkServiceIsLive(config: {
  publicUrl: string;
}): Promise<void> {
  const url = `${config.publicUrl}/health`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new SetupError(`${url} returned ${response.status}`);
    }
    console.log(`  reachable: ${url}`);
  } catch (error) {
    throw new SetupError(
      `Could not reach ${url} -- deploy the service before wiring up Meta. ` +
        `Meta verifies the callback URL during setup and setup fails if it is down. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const config = loadSetupConfig();

  console.log(`WhatsApp handle setup${checkOnly ? " (check only)" : ""}`);
  console.log(`  app:      ${config.appId}`);
  console.log(`  waba:     ${config.wabaId}`);
  console.log(`  number:   ${config.phoneNumberId}`);
  console.log(`  callback: ${callbackUrl(config)}`);
  console.log();

  console.log("[1/4] Checking the number is visible to this token");
  const number = await graph(phoneNumberRequest(config));
  console.log(`  ${JSON.stringify(number)}`);

  console.log("[2/4] Checking the deployed service");
  await checkServiceIsLive(config);

  if (checkOnly) {
    console.log("[3/4] Current WABA subscriptions");
    console.log(`  ${JSON.stringify(await graph(listWabaSubscriptionsRequest(config)))}`);
    console.log("[4/4] Skipped -- --check makes no changes");
    return;
  }

  console.log("[3/4] Registering the webhook and subscribing to `messages`");
  console.log(`  ${JSON.stringify(await graph(subscribeAppRequest(config)))}`);

  console.log("[4/4] Subscribing the WhatsApp Business Account to the app");
  console.log(`  ${JSON.stringify(await graph(subscribeWabaRequest(config)))}`);
  console.log(`  now subscribed: ${JSON.stringify(await graph(listWabaSubscriptionsRequest(config)))}`);

  console.log();
  console.log("Done. Message the number from WhatsApp and the agent should reply.");
}

main().catch((error: unknown) => {
  if (error instanceof SetupError) {
    console.error(`\nSetup failed: ${error.message}`);
  } else {
    console.error("\nSetup failed:", error);
  }
  process.exitCode = 1;
});
