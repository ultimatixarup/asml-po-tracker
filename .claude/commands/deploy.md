---
description: Deploy the agent to a public HTTPS URL and wire up the WhatsApp handle
argument-hint: [fly|render|docker]
---

Deploy this WhatsApp agent and enable the handle. Target platform: $1 (if empty,
ask which one before doing anything).

Work through these phases in order and stop at the first genuine blocker rather
than guessing.

## 1. Preflight

- `npm install && npm run typecheck && npm test` — all must pass before deploying.
- Confirm `.env` exists with the Meta values filled in. If it does not, copy
  `.env.example` and tell the user exactly which values to fetch and where from
  (App ID and App Secret: App Dashboard -> App settings -> Basic; Phone number
  ID and WhatsApp Business Account ID: WhatsApp -> API Setup).
- Confirm the access token carries **both** `whatsapp_business_messaging` and
  `whatsapp_business_management`. The send-only token from API Setup will pass
  the send test and then fail the subscribe step — check this before deploying,
  not after.

## 2. Deploy

**fly**: `fly launch --no-deploy --copy-config`, then `fly secrets set` for every
non-empty var in `.env` except `PUBLIC_URL`, then `fly deploy`. If flyctl is not
installed, install it first.

**render**: the repo has `render.yaml`. Deploying is a dashboard action — walk
the user through connecting the repo and entering the secrets, since it cannot
be done from here.

**docker**: `docker build -t hello-world-whatsapp-agent .` then run it wherever
the user wants, and get a public HTTPS URL in front of it.

The image build has never been exercised in CI — if it fails, fix the Dockerfile
rather than working around it.

## 3. Verify the deployment

`curl https://<host>/health` must return `{"status":"ok","agent":"hello-world"}`.
Do not proceed until it does — the next step fails if the service is down.

## 4. Wire up Meta

```bash
PUBLIC_URL=https://<host> npm run whatsapp:check   # inspect first
PUBLIC_URL=https://<host> npm run whatsapp:setup   # then apply
```

These Graph API calls have never run against the live API. If a request shape is
rejected, fix the builders in `src/setup/meta.ts`, update the tests in
`test/meta-setup.test.ts` to match, and re-run — do not paper over it with a
one-off curl.

## 5. Prove it works

Ask the user to message the number from WhatsApp. If no reply arrives, diagnose
in this order — it goes from most to least likely:

1. Is the WABA actually subscribed? `npm run whatsapp:check`.
2. Are deliveries arriving? Check the service logs for `[webhook]` lines.
3. Signature rejections show as `rejected a payload with a bad signature` —
   that means `WHATSAPP_APP_SECRET` is wrong.
4. Graph API send errors appear as `failed to answer wamid...`.

Report what you deployed, the live URL, and anything you had to change.
