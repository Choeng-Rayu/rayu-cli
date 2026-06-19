# RAYU.md

This file provides guidance to RAYU when working with code in this repository.

---

## Repository Layout

This monorepo contains four independent projects:

| Directory | Language / Framework | Role |
|---|---|---|
| `rayu/` | TypeScript + Bun + React/Ink | The CLI itself (published as `@rayu-dev/rayu-cli` on npm) |
| `rayu-backend/` | NestJS + Prisma + MySQL | Accounts API — users, auth, plans, usage, payments |
| `rayu-gateway/` | Go + chi + Redis | Streaming AI gateway — proxies all hosted-model requests |
| `rayu-web/` | Next.js 15 + Clerk | Marketing site + user dashboard at rayu-web.vercel.app |
| `deploy/` | Docker Compose + Caddy | Single-VPS production stack for all four services |

---

## rayu/ — CLI

**Runtime:** Bun (not Node). Use `bun` for all commands in this directory.

```bash
cd rayu
bun install          # install dependencies
bun run dev          # run from source (src/entrypoints/cli.tsx)
bun run build        # bundle → dist/rayu.js
bun run typecheck    # tsc --noEmit
bun test             # run tests
```

**Architecture:**
- Entry: `src/entrypoints/cli.tsx` → `src/main.tsx`
- The TUI is built with Ink (React for terminals). `src/components/` holds UI components; `src/screens/` holds full-screen views.
- `src/backend/` contains provider adapters (Anthropic, Bedrock, OpenAI-compatible). All AI calls flow through these.
- `src/tools/` implements the built-in tools (file read/write, bash, etc.).
- `src/upstreamproxy/` — when `USE_RAYU_OAUTH=true`, the CLI routes requests through `rayu-gateway` instead of calling the AI provider directly. `relay.ts` / `upstreamproxy.ts` handle this.
- `src/remote/` — WebSocket-based remote session support.
- `src/skills/` — skill loading and execution.
- Config is stored in `~/.rayu/`; diagnostics in `~/.rayu/diagnostics.jsonl`.

**Provider categories:**
1. `anthropic` — Anthropic SDK
2. `bedrock` — AWS Bedrock SDK
3. `openai-compatible` — any OpenAI-compatible endpoint (NVIDIA, DeepSeek, Kimi, etc.)
4. `rayu-hosted` — activates when `USE_RAYU_OAUTH=true`; proxied through `rayu-gateway`

---

## rayu-backend/ — Accounts API

**Runtime:** Node.js. Package manager: npm (has `package-lock.json`).

```bash
cd rayu-backend
npm install
npm run start:dev        # NestJS watch mode (port 4000, prefix /api)
npm run build            # prisma generate + nest build → dist/
npm run migrate:dev      # prisma migrate dev (requires DATABASE_URL in .env)
npm run db:push          # prisma db push (schema sync without migration file)
npm run seed             # seed plan catalog / default data
npm run test             # jest unit tests
npm run test:e2e         # jest e2e tests (requires running DB)
npm run typecheck        # tsc --noEmit
```

**Architecture:**
- NestJS modular layout. Global prefix `/api`. Global `ValidationPipe` with `whitelist: true`.
- **Auth flow:** Clerk webhook/SDK verifies the user → `/api/auth/session` issues a short-lived Rayu JWT (access + refresh). The gateway validates this JWT independently — `RAYU_JWT_SECRET` must be identical in both services.
- **Modules:** `auth`, `users`, `plans`, `subscriptions`, `payments`, `usage`, `feedback`, `admin`, `models`, `settings`, `health`.
- **Database:** MySQL via Prisma. Migrations in `prisma/migrations/`. Schema at `prisma/schema.prisma`.
- Key models: `User`, `Plan`, `Subscription`, `Payment`, `UsageEvent`, `CreditLedger`, `CreditTopup`.
- `AppModule.onModuleInit` idempotently seeds plan catalog, hosted models, and global settings on every boot.

**Required env vars:** `DATABASE_URL`, `CLERK_SECRET_KEY`, `RAYU_JWT_SECRET`, `WEB_ORIGIN`.

---

## rayu-gateway/ — Streaming AI Gateway

**Runtime:** Go 1.24. No build tool config — standard `go` commands.

```bash
cd rayu-gateway
go run ./cmd/gateway       # dev mode (reads .env via godotenv)
go build ./cmd/gateway     # compile binary
go test ./...              # run all tests
```

**Development setup:** Copy `.env.example` → `.env` and fill in `RAYU_JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, provider keys. MySQL and Redis must be running (Docker).

**Architecture:**
- `cmd/gateway/` — main entrypoint, wires config + store + credits + entitlements + server.
- `internal/server/` — HTTP router (chi). Routes: `GET /healthz`, `GET /v1/models`, `POST /v1/chat/completions`, `GET /v1/credits`, `GET /v1/proxy` (transparent BYO-key proxy).
- `internal/auth/` — JWT middleware. Validates Rayu access tokens (same secret as backend).
- `internal/credits/` — Redis-backed rate/credit limiter (`credits.go`, `limiter.go`).
- `internal/entitlements/` — in-memory cache of plan entitlements read from MySQL.
- `internal/proxy/` — upstream proxy to AI providers (DeepSeek, DeepInfra, etc.).
- `internal/store/` — MySQL queries (credit ledger, user plan lookups).
- Provider API keys live **only** in the gateway's env — never in the DB or CLI.
- `/v1/proxy` uses `X-Rayu-Token` (not `Authorization`) so the upstream provider key passes through in `Authorization`.

**Required env vars:** `PORT`, `RAYU_JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, plus provider keys like `DEEPSEEK_API_KEY`.

---

## rayu-web/ — Frontend Website

**Runtime:** Node.js. Package manager: npm.

```bash
cd rayu-web
npm install
npm run dev          # Next.js dev server (port 3000)
npm run build        # next build (also runs prebuild: copies docs)
npm run lint         # next lint
npm run typecheck    # tsc --noEmit
npm run test         # jest
```

**Architecture:**
- Next.js 15 App Router. Auth via `@clerk/nextjs`.
- `app/` — pages: `dashboard`, `billing`, `credits`, `plans`, `changelog`, `docs`, `admin`, `cli-login`, `chatbot`.
- `components/` — shared UI components.
- `lib/` — shared utilities.
- `scripts/copy-docs.js` — prebuild step that copies docs from `rayu/documentations/` into the web app.
- The browser calls `NEXT_PUBLIC_RAYU_API_URL` (backend `/api`) and `NEXT_PUBLIC_RAYU_GATEWAY_URL` (gateway) at runtime.

---

## Production Deployment (`deploy/`)

Single-VPS stack: `mysql → redis → backend → gateway → web → caddy`.

```bash
cd deploy
cp .env.example .env     # fill secrets
docker compose up -d --build
docker compose logs -f <service>
docker compose down
```

**Caddy routing (TLS termination):**
- `/api/*` → `backend:4000`
- `/gateway/*` → `gateway:8080`
- `/*` → `web:3000`

**Required `.env` vars:** `MYSQL_*`, `RAYU_JWT_SECRET`, `DEEPSEEK_API_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `PUBLIC_SITE_URL`, `SITE_ADDRESS`.

---

## Cross-Service Auth Flow

```
User → Clerk OAuth → rayu-backend /api/auth/session
         → issues Rayu JWT (signed with RAYU_JWT_SECRET)
         → CLI stores token in ~/.rayu/rayu-auth.json

CLI → rayu-gateway /v1/chat/completions
         Authorization: Bearer <rayu-jwt>
         → gateway validates JWT with same RAYU_JWT_SECRET
         → checks plan entitlements + deducts credits
         → proxies to upstream provider (DeepSeek, DeepInfra, etc.)
```

`RAYU_JWT_SECRET` **must be identical** in both `rayu-backend` and `rayu-gateway`. Mismatch causes `401` errors from the gateway.
