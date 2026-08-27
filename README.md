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

## Quick start

```bash
npm install
cp .env.example .env    # then fill it in, see below
npm run dev             # or: npm run build && npm start
```

`GET /health` returns `{"status":"ok","agent":"hello-world"}` once it is up.

## Making it reachable as a WhatsApp handle

The webhook must be on a public HTTPS URL. For local development, tunnel it:

```bash
npx cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```

Then, in the [Meta app dashboard](https://developers.facebook.com/apps):

1. **Create an app** of type *Business* and add the **WhatsApp** product. This
   gives you a test phone number for free — that number is the chat handle.
2. **WhatsApp → API Setup** — copy the **Phone number ID** into
   `WHATSAPP_PHONE_NUMBER_ID`, and the temporary access token into
   `WHATSAPP_ACCESS_TOKEN`. Add your own number under *To* so the test number is
   allowed to message you.
3. **App settings → Basic** — copy the **App Secret** into
   `WHATSAPP_APP_SECRET`.
4. Invent any random string, put it in `WHATSAPP_VERIFY_TOKEN`, and start the
   server before the next step.
5. **WhatsApp → Configuration → Edit webhook** — set the callback URL to
   `https://<your-tunnel>/webhook` and the verify token to the same string.
   Meta calls `GET /webhook` immediately; the log line `[webhook] verified by
   Meta` means it worked.
6. In the same panel, **subscribe to the `messages` field**. Without this,
   nothing is delivered.
7. Message the test number from WhatsApp. You should get a reply.

The temporary token expires after 24 hours. For anything lasting, create a
system user in Meta Business Settings, grant it `whatsapp_business_messaging`
on the WhatsApp account, and generate a permanent token.

To use your own phone number as the handle instead of the test number, add it
under **WhatsApp → API Setup → Add phone number** and complete Meta's business
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
test/                 Unit tests for signature and payload handling
```

## Tests

```bash
npm test        # signature verification and webhook payload parsing
npm run typecheck
```

## Deploying

Any host that gives you a public HTTPS URL works — the container listens on
`PORT`.

```bash
docker build -t hello-world-whatsapp-agent .
docker run --env-file .env -p 3000:3000 hello-world-whatsapp-agent
```

Conversation history is in memory, so a restart forgets it and running more than
one instance splits it. Move `histories` in `src/agent.ts` to Redis or a
database before scaling out.
