# Hello World WhatsApp Agent

An Express webhook service that makes a WhatsApp Business number the chat handle
for a Claude agent. Meta delivers inbound messages to `POST /webhook`, the agent
answers with Claude, and the reply goes back out through the Graph API.

## Commands

```bash
npm run dev          # watch mode, no build step
npm run build        # tsc -> dist/
npm start            # run the build
npm test             # node:test, no network or credentials needed
npm run typecheck
npm run whatsapp:check   # report Meta wiring state, change nothing
npm run whatsapp:setup   # apply the Meta wiring
```

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Express app; retains the raw body for signature checks |
| `src/routes/webhook.ts` | GET handshake, POST delivery, dedupe, dispatch |
| `src/agent.ts` | The Claude call and per-contact history |
| `src/whatsapp.ts` | Signature verification, payload parsing, Graph API send |
| `src/telegram.ts` | Telegram channel: long polling, no webhook |
| `src/setup/meta.ts` | Graph API request builders for the Meta wiring |
| `src/setup/run.ts` | The `whatsapp:setup` CLI |

## Channels

WhatsApp and Telegram are independent: each activates when its variables are
set, and startup fails if neither is. Both share `src/agent.ts` -- contact keys
are `tg:<chat_id>` for Telegram, the bare phone number for WhatsApp.

## Things that will bite you

- **The signature is computed over the raw request bytes.** `src/index.ts`
  stashes `rawBody` in the `express.json` verify hook. Re-serializing the parsed
  body changes whitespace and breaks the HMAC.
- **The webhook must ack before doing work.** A model call takes longer than
  Meta waits, and a slow ack triggers retries. `POST /webhook` sends 200 and
  then processes asynchronously.
- **Retries are deduped by `wamid`.** Meta redelivers for up to 7 days if it
  does not get a fast 200; without the dedupe a retry produces a second reply.
- **Subscribing the WABA is a separate step from registering the webhook.**
  Miss it and the app has a webhook that receives nothing. `whatsapp:setup`
  does both.
- **The service must be live before `whatsapp:setup` runs.** Meta performs the
  verification handshake during the call and fails if the URL is down.
- **The 24-hour window.** Free-form sends are only allowed within 24h of the
  user's last message. Replying is always fine; reaching out first needs an
  approved template.
- **History is in memory.** A restart forgets it and a second instance splits
  it. Move `histories` in `src/agent.ts` to Redis before scaling out.

## Conventions

- The agent runs on `claude-opus-5`. Do not downgrade the model for cost.
- Adaptive thinking stays on (the default for this model) at `effort: "low"` —
  disabling thinking on Opus 5 risks tool calls leaking into visible text.
- `@anthropic-ai/sdk` must be >= 0.121, which is where `fallbacks` landed.
- `max_tokens` is 1024 deliberately: WhatsApp rejects bodies over 4096 chars.
- Tests must keep passing without network access or credentials.
