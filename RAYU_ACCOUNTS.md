# Rayu Accounts — Phase 1

User accounts, a marketing website, and an opt-in CLI login for Rayu, across
three projects:

| Project        | Path             | Stack                                  |
|----------------|------------------|----------------------------------------|
| `rayu-cli`     | `./rayu`         | Bun + TypeScript + React/Ink (the CLI) |
| `rayu-backend` | `./rayu-backend` | NestJS + Prisma + MySQL + Clerk + JWT   |
| `rayu-web`     | `./rayu-web`     | Next.js App Router + Clerk             |

## What this includes (phase 1)

- Sign in with Clerk (Google / GitHub / Facebook). Telegram is deferred.
- New users are auto-assigned the **Free** plan (bring your own provider key
  via the CLI's `/connect` — direct to the provider).
- **Plans (all admin-editable at runtime — see below):**
  - **Free** — bring your own key; advanced features off by default + a daily
    turn cap. Admin can open features/limits up.
  - **Basic — $3/mo (active)** — bring your own key; all features unlocked.
  - **Pro / Pro+ / Max** — Rayu-hosted tiers, **"Coming soon"** until the model
    gateway ships.
  - **Enterprise** — contact sales.
- **All plan business logic is data-driven and admin-managed** — price,
  availability, per-feature access (telegram, collaborator swarm, model per
  subagent, collaborator model, image/video generation) and usage limits
  (`maxDailyTurns`, per-feature caps) live in MySQL and are edited from the
  admin dashboard. Nothing is hardcoded or in `.env`. The seed only writes
  **first-time, non-destructive defaults** (it never overwrites admin edits on
  restart). `GET /api/me/entitlements` returns a user's resolved plan/features.
- Super-admin dashboard: list/search users, suspend/ban, change a user's plan,
  view payments + stats, and **manage Plans & Features** (prices/availability/
  feature toggles/limits).
- Per-user provider usage tracking.
- CLI login gate behind `USE_RAYU_OAUTH` (default **off** = unchanged behavior).

**Deferred to a later phase:** the Rayu-hosted model proxy/streaming gateway
(needed only for Rayu-provided keys on the higher tiers) with 5h/daily/weekly
resets, wiring the CLI to enforce entitlements, Telegram login, and the real
chatbot. (Bakong payments scaffolding exists in the backend.)

> Security: the CLI ships **no secrets**. Clerk secret key, MySQL credentials,
> the Rayu JWT signing secret, and (future) Bakong credentials live only in the
> backend environment. If the Bakong developer token was shared anywhere, rotate
> it.

## The CLI ↔ web ↔ backend login bridge

```
CLI (/login, USE_RAYU_OAUTH=true)
  starts a localhost AuthCodeListener on :PORT, opens the browser to
  RAYU_WEB_URL/cli-login?port=PORT&state=STATE
      -> website signs the user in with Clerk
      -> website POST /api/cli/exchange (Clerk token + state) to the backend
      -> backend verifies Clerk, upserts the user (Free plan), returns a
         one-time code
      -> website redirects the browser to 127.0.0.1:PORT/callback?code&state
  CLI captures the code, POST /api/cli/token -> { accessToken, refreshToken }
  CLI stores ~/.rayu/rayu-auth.json (0600) and proceeds.
```

## Run locally (without Docker)

1. **MySQL** — start one (e.g. Docker): a database `rayu` with a user.
2. **Backend**
   ```bash
   cd rayu-backend
   cp .env.example .env   # set DATABASE_URL, CLERK_SECRET_KEY, RAYU_JWT_SECRET
   npm install
   npx prisma migrate deploy   # apply schema (plans are also seeded on boot)
   npm run start:dev            # http://localhost:4000/api/health
   ```
3. **Web**
   ```bash
   cd rayu-web
   cp .env.example .env.local   # set Clerk keys + NEXT_PUBLIC_RAYU_API_URL
   npm install
   npm run dev                  # http://localhost:3000
   ```
4. **CLI** (optional account login)
   ```bash
   cd rayu
   export USE_RAYU_OAUTH=true
   export RAYU_API_URL=http://localhost:4000/api
   export RAYU_WEB_URL=http://localhost:3000
   # first message now prompts /login; see rayu/.env.rayu-accounts.example
   ```

## Run on a single VPS (Docker)

```bash
cd deploy
cp .env.example .env     # fill in SITE_ADDRESS, Clerk keys, MySQL + JWT secrets
docker compose up -d --build
```

Caddy terminates TLS and routes `/api/*` → backend, everything else → web.
MySQL data persists in the `mysql_data` volume.

## Tests

```bash
# backend (e2e uses a live MySQL test DB `rayu_test`; start the deploy MySQL first)
cd rayu-backend && npm test && TEST_DATABASE_URL=mysql://rayu:rayu_app_local@127.0.0.1:3306/rayu_test npm run test:e2e
# web
cd rayu-web && npx jest --config jest.config.json && npm run build
# cli (Rayu auth only)
cd rayu && bun test test/rayuAuth.test.ts test/commandRegistry.test.ts
```

The backend e2e (`rayu-backend/test/app.e2e-spec.ts`) runs against a live MySQL
test database (`rayu_test`, auto-reset via `prisma db push` in jest
globalSetup) with a mocked Clerk verifier: exchange → token → `/me`, refresh,
usage summary, feedback, admin role-gating + suspend, and **login → usage →
visible in admin stats**.

## Environment variables

**rayu-backend** (`rayu-backend/.env`): `PORT`, `DATABASE_URL` (MySQL, used by
Prisma), `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `RAYU_JWT_SECRET`,
`RAYU_ACCESS_TTL`, `RAYU_REFRESH_TTL`, `WEB_ORIGIN`, and (phase 2) `BAKONG_*`.

**rayu-web** (`rayu-web/.env.local`): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY`, `NEXT_PUBLIC_RAYU_API_URL`.

**rayu-cli** (`rayu/.env.rayu-accounts.example`): `USE_RAYU_OAUTH`,
`RAYU_API_URL`, `RAYU_WEB_URL`.

## Note on the Clerk middleware file

Clerk's latest quickstart uses `proxy.ts`, which is the **Next.js 16** file
convention. This project targets **Next.js 15.5**, where the supported file is
`middleware.ts` — so `rayu-web/middleware.ts` holds the identical
`clerkMiddleware()` and matcher. When upgrading to Next 16, rename it to
`proxy.ts` (contents unchanged).
