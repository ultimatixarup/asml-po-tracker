# Hello World WhatsApp Agent

A minimal Claude agent you can chat with on WhatsApp. It runs as a small Express
webhook server: Meta delivers inbound messages, the agent answers with Claude,
and the reply goes back out through the WhatsApp Cloud API.

```
WhatsApp user  ──▶  Meta Cloud API  ──▶  POST /webhook  ──▶  Claude (claude-opus-5)
       ▲                                                            │
       └──────────  Graph API send  ◀───────────────────────────────┘
```

## What it does

- Verifies the webhook handshake (`GET /webhook`) and the signature on every
  delivery (`X-Hub-Signature-256`), rejecting anything unsigned.
- Answers text messages with Claude, keeping the last 10 turns per contact so
  the conversation has continuity. Send `reset` to clear that history.
- Ignores Meta's retries of a message it already answered.
- Falls back to a canned greeting when `ANTHROPIC_API_KEY` is unset, so you can
  get the WhatsApp plumbing working before adding a model.

## Telegram, the five-minute alternative

The same agent can be a Telegram handle with none of the Meta setup: message
[@BotFather](https://t.me/botfather), send `/newbot`, put the token it returns
in `TELEGRAM_BOT_TOKEN`, and run `npm run dev`. Telegram uses long polling, so
this works from a laptop with no public URL. Set both Telegram and WhatsApp
variables and one process serves both handles.

## Quick start

```bash
npm install
cp .env.example .env    # then fill it in, see below
npm run dev             # or: npm run build && npm start
```

`GET /health` returns `{"status":"ok","agent":"hello-world"}` once it is up.

## Deploying

The webhook needs a public HTTPS URL, so the agent has to run somewhere Meta can
reach. Any container host works; two are configured here.

**Fly.io** (`fly.toml`):

```bash
fly launch --no-deploy --copy-config
fly secrets set WHATSAPP_VERIFY_TOKEN=... WHATSAPP_APP_SECRET=... \
                WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_ACCESS_TOKEN=... \
                WHATSAPP_BUSINESS_ACCOUNT_ID=... META_APP_ID=... \
                ANTHROPIC_API_KEY=...
fly deploy
```

**Render** (`render.yaml`): point Render at the repo and it picks up the
blueprint; fill the secrets in the dashboard.

Either way, confirm `https://<your-host>/health` returns
`{"status":"ok","agent":"hello-world"}` before wiring up Meta.

For local development, tunnel instead of deploying:

```bash
npx cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```

## Enabling the WhatsApp handle

First, in the [Meta app dashboard](https://developers.facebook.com/apps), create
a *Business* app, add the **WhatsApp** product, and collect four values into
`.env`: the App ID and App Secret (App settings -> Basic), and the Phone number
ID and WhatsApp Business Account ID (WhatsApp -> API Setup). The free test number
the dashboard provisions works as the handle. Add your own number under *To* so
the test number is allowed to message you.

Then set `PUBLIC_URL` to the deployed URL and run:

```bash
npm run whatsapp:check    # report current state, change nothing
npm run whatsapp:setup    # apply the wiring
```

That registers the callback URL against the app, subscribes it to the `messages`
field, and subscribes the WhatsApp Business Account to the app — the step people
most often miss, without which nothing is delivered. **The service must already
be live at `PUBLIC_URL`**: Meta performs the verification handshake during the
call, and setup fails if the URL is down.

Message the number from WhatsApp and the agent should reply.

### Tokens

The temporary token in API Setup expires after 24 hours. For anything lasting,
create a system user in Meta Business Settings and grant it both
`whatsapp_business_messaging` (sending) and `whatsapp_business_management`
(subscribing the webhook), then generate a permanent token.

To use your own number as the handle instead of the test number, add it under
**WhatsApp -> API Setup -> Add phone number** and complete Meta's business
verification.

### The 24-hour window

WhatsApp only lets a business send free-form messages within 24 hours of the
user's last message. This agent always replies to an inbound message, so it
stays inside that window. Reaching out first requires a pre-approved message
template.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | yes | Shared string for the webhook handshake |
| `WHATSAPP_APP_SECRET` | yes | Verifies `X-Hub-Signature-256` on deliveries |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | The business number that sends replies |
| `WHATSAPP_ACCESS_TOKEN` | yes | Graph API token for sending |
| `META_APP_ID` | setup only | Identifies the app the webhook is registered on |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | setup only | The WABA subscribed to the app |
| `PUBLIC_URL` | setup only | Deployed HTTPS base URL, no trailing slash |
| `ANTHROPIC_API_KEY` | no | Without it, replies are a canned greeting |
| `GRAPH_API_VERSION` | no | Defaults to `v23.0` |
| `PORT` | no | Defaults to `3000` |

## The agent

`src/agent.ts` is one Claude call per message on `claude-opus-5`. Adaptive
thinking is on (the default for this model) at `effort: "low"`, which keeps
chat latency down; raise it if you give the agent real work. Server-side
refusal fallbacks are enabled, so a policy decline is retried on a fallback
model inside the same call rather than dropping the reply. `max_tokens` is 1024
because WhatsApp rejects message bodies over 4096 characters.

To make it do something beyond saying hello, edit `SYSTEM_PROMPT` and add tools
in that file — the webhook plumbing does not change.

## Layout

```
src/index.ts          Express app; keeps the raw body for signature checks
src/config.ts         Environment loading and validation
src/routes/webhook.ts GET verification, POST delivery, dedupe, dispatch
src/agent.ts          The Claude call and per-contact history
src/whatsapp.ts       Signature verification, payload parsing, Graph API send
src/setup/meta.ts     Graph API request builders for the Meta wiring
src/setup/run.ts      `npm run whatsapp:setup` -- registers the webhook
test/                 Unit tests for signature, payload and setup requests
```

## Tests

```bash
npm test        # signature verification, payload parsing, setup requests
npm run typecheck
```

## Running the container directly

Any host that gives you a public HTTPS URL works — the container listens on
`PORT`.

```bash
docker build -t hello-world-whatsapp-agent .
docker run --env-file .env -p 3000:3000 hello-world-whatsapp-agent
```

## Known limits

Conversation history is in memory, so a restart forgets it and running more than
one instance splits it. Move `histories` in `src/agent.ts` to Redis or a
database before scaling out.
