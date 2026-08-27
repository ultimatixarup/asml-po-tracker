# Construction Manager Agent

A Claude agent for US general contractors, reachable over WhatsApp and
Telegram. Field crews send photos, receipts, plans, and notes; the agent files
everything on an append-only hash-chained ledger, imports estimates from
spreadsheets, and reconciles change requests into draft change orders that
price only the delta -- with every line citing its evidence. A read-only
`/audit` view renders the ledger for dispute resolution.

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
| `src/store.ts` | One Store interface; memory + Postgres implementations |
| `src/ledger.ts` | Pure hash-chain primitives (canonical JSON, verify) |
| `src/ingest.ts` | Media -> blob -> artifact -> classification -> events |
| `src/estimates.ts` | Spreadsheet parsing, column mapping, line building |
| `src/reconcile.ts` | The reconciliation engine (high-effort, validated) |
| `src/tools.ts` | The agent's tools over the store |
| `src/domain/` | GC system prompt + CSI MasterFormat table |
| `src/routes/audit.ts` | Token-gated read-only audit pages |
| `migrations/` | Plain SQL, applied at startup when DATABASE_URL is set |

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
- Chat runs at `effort: "low"`; the reconciliation engine and only it runs at
  `effort: "high"`. Keep that split.
- The system prompt is cached (`cache_control`); volatile facts (date, active
  project) go in the user turn, never the system prompt.
- The ledger is append-only. Corrections are new events. Anything that lets
  an UPDATE near the events table is a bug.
- Model outputs that become money (CO lines) are validated in code
  (validateDelta); never trust arithmetic or citations from the model.
- Adaptive thinking stays on (the default for this model) at `effort: "low"` —
  disabling thinking on Opus 5 risks tool calls leaking into visible text.
- `@anthropic-ai/sdk` must be >= 0.121, which is where `fallbacks` landed.
- `max_tokens` is 1024 deliberately: WhatsApp rejects bodies over 4096 chars.
- Tests must keep passing without network access or credentials.
