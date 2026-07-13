# @chro/api (Rust)

Rust-based Cloudflare Worker that powers the waitlist and invite-code flows used by the Next.js app. The worker owns the Cloudflare D1 schema so the product and marketing surfaces can talk to a single source of truth.

## Features

- Workers-rs runtime with the shared `worker-build` pipeline.
- D1 (`APP_DB`) stores:
  - `waitlist_entries` – emails + metadata collected from the marketing site.
  - `invite_codes` / `invite_claims` – gated access for early adopters.
  - `feedback` – in-app feedback submissions (category, message, app context).
- JSON endpoints:
  - `POST /waitlist` – Public entry point to join the waitlist.
  - `GET /waitlist`, `PUT /waitlist/:id/status`, `GET /waitlist/summary` – Authenticated dashboards.
  - `POST /feedback` – Public endpoint that stores desktop feedback and posts it to Slack. Body: `{ "category": "feedback" | "bug" | "feature", "message": string, "appVersion"?, "platform"? }`.
  - `GET /invite-codes`, `POST /invite-codes` – Create/list invite codes.
  - `POST /internal/invite-codes` – Admin-only invite creation guarded by `ADMIN_SECRET` (send `X-Admin-Secret` header).
  - `POST /invite-codes/:code/claim` – Public claim endpoint that also upgrades the waitlist entry.
  - `GET /session` & `GET /health` – Diagnostics.
- Authentication: Clerk user JWTs via `Authorization: Bearer <token>`.

## Local development

```bash
cd apps/api
rustup target add wasm32-unknown-unknown
bun install # once at repo root
wrangler dev --local --persist-to=./.wrangler/state
```

Configure environment before running:

1. Copy dev vars template and set secrets.
   ```bash
   cp .dev.vars.example .dev.vars # create if missing
   wrangler secret put CLERK_SECRET_KEY
   wrangler secret put ADMIN_SECRET
   ```
2. Ensure the Cloudflare D1 binding `APP_DB` points to the shared dev database.
3. When running the Next.js app locally, set `API_URL`/`NEXT_PUBLIC_API_URL` so it reaches this worker (default `http://127.0.0.1:8788`).

### Admin invite creation

Use the admin-only endpoint to mint invite codes without Clerk authentication (guards via the `ADMIN_SECRET` secret and `X-Admin-Secret` header):

```bash
API="http://127.0.0.1:8788" # or your deployed worker URL
curl -X POST "$API/internal/invite-codes" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{"note":"Private beta batch","maxUses":5}'
```

The response mirrors `POST /invite-codes`, returning the newly created record (code, note, usage counts, etc.).

## Migrations

```bash
cd apps/api
wrangler d1 migrations apply APP_DB
```

To recreate a clean local database (removes `.wrangler/state` and reapplies migrations):

```bash
cd apps/api
bun run migrate:reset
# or run the script directly
bun scripts/reset-d1.ts
```

## Deployment

```bash
bun run apps/api deploy            # production deploy
bun run apps/api deploy:preview    # preview deploy
```

Deployment uses the same `worker-build` pipeline as other Rust Workers.
