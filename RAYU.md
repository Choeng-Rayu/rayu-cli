# RAYU.md

This file provides guidance to RAYU when working with code in this repository.

---

## Repository Layout

This monorepo contains four independent projects:

| Directory | Language / Framework | Role |
|---|---|---|
| `rayu/` | TypeScript + Bun + React/Ink | The CLI itself (published as `@rayu-dev/rayu-cli` on npm) |
| `rayu-backend/` | NestJS + Prisma + MySQL | Accounts API — users, auth, plans, usage, payments |
| `rayu-gateway/` | Go 1.24 + chi + Redis | Streaming AI gateway — proxies all hosted-model requests |
| `rayu-web/` | Next.js 15 + Clerk | Marketing site + user dashboard at rayu-web.vercel.app |
| `deploy/` | Docker Compose + Caddy | Single-VPS production stack for all four services |

The CLI sub-project also has its own `rayu/RAYU.md` with deeper CLI internals (ink renderer, tool/command system, build macros, permissions). Read it when working inside `rayu/`.

---

## Build & Dev Commands

### rayu/ — CLI (Bun)

```bash
cd rayu
bun install
bun run dev              # run from source (src/entrypoints/cli.tsx)
bun run src/entrypoints/cli.tsx  # same, explicit path
bun run build            # bundle → dist/rayu.js
bun run build:binaries   # cross-platform standalone executables
bun run build:packages   # .deb/.rpm Linux packages
bun run build:native     # native binary build
bun run typecheck        # tsc --noEmit
bun test                 # full test suite
```

Build uses compile-time DCE via `feature('FLAG')` from `bun:bundle`. Flags are defined in `scripts/macroValues.ts` under `ENABLED_FEATURES`. Only `ULTRATHINK`, `TOKEN_BUDGET`, and `BUILTIN_EXPLORE_PLAN_AGENTS` are enabled in production builds; everything else is stripped.

### rayu-backend/ — API (Node.js + npm)

```bash
cd rayu-backend
npm install
npm run start:dev        # NestJS watch mode (port 4000, prefix /api)
npm run build            # prisma generate + nest build → dist/
npm run typecheck        # tsc --noEmit
npm run test             # jest unit tests
npm run test:e2e         # jest e2e tests (requires running DB)
npm run migrate:dev      # prisma migrate dev (requires DATABASE_URL)
npm run db:push          # prisma db push (sync without migration file)
npm run seed             # seed plan catalog / default data
```

Run a single test:
```bash
cd rayu-backend
npx jest --testPathPattern="payments.service.spec"
```

### rayu-gateway/ — Gateway (Go)

```bash
cd rayu-gateway
cp .env.example .env     # fill RAYU_JWT_SECRET, DATABASE_URL, REDIS_URL, provider keys
go run ./cmd/gateway     # dev mode (godotenv loads .env)
go build ./cmd/gateway   # compile binary
go test ./...            # all tests
go test ./internal/server/...  # single package
```

Requires MySQL and Redis running (Docker Compose in `deploy/`).

### rayu-web/ — Frontend (Node.js + npm)

```bash
cd rayu-web
npm install
npm run dev              # Next.js dev server (port 3000)
npm run build            # next build (prebuild copies docs from rayu/documentations/)
npm run lint             # next lint
npm run typecheck        # tsc --noEmit
npm run test             # jest
```

### deploy/ — Production

```bash
cd deploy
cp .env.example .env     # fill all secrets
docker compose up -d --build
docker compose logs -f <service>
docker compose down
```

Caddy routes: `/api/*` → `backend:4000`, `/gateway/*` → `gateway:8080`, `/*` → `web:3000`.

---

## High-Level Architecture

### The Full Request Path

```
User → Clerk OAuth → rayu-backend /api/auth/session
  → issues Rayu JWT (signed with RAYU_JWT_SECRET)
  → CLI stores JWT in ~/.rayu/rayu-auth.json

CLI → rayu-gateway /v1/chat/completions
  Authorization: Bearer <rayu-jwt>
  → gateway validates JWT with same RAYU_JWT_SECRET
  → resolves plan entitlements (cached from MySQL)
  → pre-flight credit reserve (Redis)
  → proxies to upstream provider (DeepSeek, DeepInfra, Ollama, etc.)
  → settles actual usage → writes CreditLedger + UsageEvent

rayu-web → rayu-backend /api/ for user data + entitlements
```

`RAYU_JWT_SECRET` **must be identical** in both `rayu-backend` and `rayu-gateway`. Mismatch causes silent 401 errors.

### Service Contracts

- **Backend → Gateway:** No direct coupling. Gateway reads MySQL independently. They share only the JWT secret.
- **Backend → Web:** REST API under `/api`. Clerk-issued session tokens are exchanged for Rayu JWTs.
- **CLI → Backend:** Only for auth/login, plan lookups, usage events. AI calls go to the gateway.
- **CLI → Gateway:** All AI completions when `USE_RAYU_OAUTH=true`. Falls back to direct provider calls when false.

### Credit Model (gateway + backend)

Credits are fine-grained billable tokens, not whole-credit ceil:
- Each model has `inputPricePer1MCents`, `outputPricePer1MCents`, and `cacheReadCreditMultiplier`/`cacheWriteCreditMultiplier`.
- `baselineCreditsPer1M` (in `AppSettings`) converts raw cents → credit units.
- Pre-flight estimate reserves credits; `settle()` reconciles to actual usage after the response.
- Redis limiter tracks per-user per-period usage with TTL tied to subscription `currentPeriodEnd`.
- Daily turn caps (`maxDailyTurns`) are enforced before credit reserve on the hosted path; best-effort on the BYO-key proxy path.

### Build-Time Feature Flags

The CLI uses `feature('FLAG')` from `bun:bundle` which is compile-time dead-code elimination — disabled flags are removed from the bundle entirely. This is why many modules use conditional `require()` instead of static `import`. Do not convert a feature-gated `require()` to a static `import` — it will bloat the bundle and break DCE.

`MACRO_VALUES` in `scripts/macroValues.ts` also bakes `RAYU_OAUTH_DEFAULT` (defaults to `'true'`), `RAYU_API_URL`, and `RAYU_WEB_URL` at build time so entitlement gating works regardless of the directory the binary is launched from.

### Key Design Decisions

- **Provider keys live only in the gateway's env**, never in the DB or CLI. The gateway rotates multi-keys via round-robin and uses circuit breakers per upstream host.
- **The gateway writes credit ledger + usage events through a bounded serialized queue** (`eventqueue`) to prevent MySQL pool starvation under concurrent streaming load.
- **Promo codes** (new: `promo/` module, migration `0000000000007_promo_codes`) support percent/fixed discounts, per-plan scoping, `maxRedemptions` caps, date windows, and one-redemption-per-user enforcement. A `$0` claim bypasses the QR payment flow entirely.
- **Admin auth** supports both Clerk SSO and a local password login (`admin@rayucode.com` / `LOCAL_ADMIN_PASSWORD` env var), enabling access without Clerk during development.
