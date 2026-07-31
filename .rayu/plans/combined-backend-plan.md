# Plan: Combined Backend — rayu-server (Rust) + rayu-studio (bolt.diy) integration

**Status:** Draft v2 (revised for clarity, correctness, and detail)
**Last reviewed:** 2026-07-31

**Purpose:** This plan is the *integration layer* connecting two existing plans:

| Existing plan | What it specifies | Where |
|---|---|---|
| `rust-merge.md` | Merge `rayu-backend` (NestJS) + `rayu-gateway` (Go) into one Rust service at `rayu-server/` | `.rayu/plans/rust-merge.md` |
| `integrate-bolt-diy-into-rayu-web.md` | Copy `bolt.diy` source into `rayu-studio/` and deploy to `studio.rayucode.com` | `.rayu/plans/integrate-bolt-diy-into-rayu-web.md` |

**This plan describes ONLY the glue between them:**
- The shared HTTP contract (what must not change).
- The cross-subdomain auth bridge (how rayu-web and rayu-studio share a session).
- The deploy topology (Caddy, docker-compose, Vercel).
- CI additions.
- Observability.
- Security analysis + verification.

**This plan does NOT re-specify:**
- Rust porting details (see `rust-merge.md` Phases 0–3).
- bolt.diy UI porting (see the bolt integration plan Steps 1–2).
- Anything in rayu-web except one new route + one nav link.

---

## 1. Architecture (target state)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Browser / CLI client                         │
└─────────────┬───────────────────────────────────────────┬───────────┘
              │                                            │
              │  rayucode.com (rayu-web, Vercel)           │  studio.rayucode.com (rayu-studio, Vercel)
              │  - NextAuth Google OAuth                   │  - COOP: same-origin + COEP: credentialless (origin-wide)
              │  - /api/auth/session-cookie (NEW route)    │  - WebContainer sandbox runs in-browser
              │    sets rayu_session cookie on .rayucode.com│  - reads rayu_session cookie (cross-subdomain)
              │                                            │  - LLM calls:
              │                                            │     default → /gateway/v1/* (billed via rayu-gateway)
              │                                            │     fallback → user's provider directly (BYO-key)
              ▼                                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Caddy (TLS terminator, edge proxy)               │
│  - /api/*      → reverse_proxy server:8080   (prefix KEPT)          │
│  - /gateway/*  → handle_path → server:8080   (prefix STRIPPED)      │
│  - /*          → reverse_proxy web:3000                             │
│  - injects X-Rayu-Edge-Id + correlation headers                     │
└─────────────┬───────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  rayu-server (Rust, actix-web) — single binary, single port :8080  │
│                                                                     │
│  ┌───────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │ api router    │  │ gw router         │  │ health               │ │
│  │ /api/*        │  │ /v1/* /anthropic/*│  │ /healthz (public)    │ │
│  │ auth, users,  │  │ /v1/proxy         │  │                      │ │
│  │ plans,        │  │ hosted streaming, │  │                      │ │
│  │ payments,     │  │ credits, models,  │  │                      │ │
│  │ promo,        │  │ provider health   │  │                      │ │
│  │ providers,    │  │                   │  │                      │ │
│  │ models,       │  │                   │  │                      │ │
│  │ telegram,     │  │                   │  │                      │ │
│  │ admin, health │  │                   │  │                      │ │
│  └──────┬────────┘  └────────┬──────────┘  └──────────────────────┘ │
│         └──────────┬─────────┘                                    │
│  ┌─────────────────▼───────────────────────┐                       │
│  │ Shared domain core                      │                       │
│  │  • JWT HS256 (RAYU_JWT_SECRET)           │                       │
│  │  • SecretBox AES-GCM (RAYU_PROVIDER_   │                       │
│  │    SECRET)                              │                       │
│  │  • sqlx MySQL pool (camelCase cols)     │                       │
│  │  • moka caches + ArcSwap snapshot       │                       │
│  │  • redis limiter (Lua) + configbus      │                       │
│  │  • credits math + eventqueue            │                       │
│  │  • scrypt passwords                    │                       │
│  └────────────────────────────────────────┘                       │
│                                                                     │
│  owns sqlx migrations (0001_baseline.sql + future)                  │
└─────────────┬───────────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────┬────────────────────────────┐
│  mysql:3306             │  redis:6379 (ephemeral)   │
│  - Prisma-frozen schema │  - limiter + configbus   │
│  - baseline migration   │                           │
└────────────────────────┴────────────────────────────┘
```

### 1.1 What the single Rust binary serves

| Route prefix | Source | Surface |
|---|---|---|
| `/api/*` | backend (NestJS → Rust) | auth, users, plans, payments, promo, providers, models, settings, telegram, admin, health |
| `/v1/*` | gateway (Go → Rust) | hosted LLM streaming, credits, models, provider health/test, admin reload |
| `/anthropic/*` | gateway | `POST /anthropic/v1/messages` (+ `count_tokens`) |
| `/v1/proxy` | gateway | BYO-key transparent forward |
| `/healthz` | both | public liveness |

### 1.2 Who calls what

| Caller | Routes used | How |
|---|---|---|
| rayu-web (Vercel, `rayucode.com`) | `/api/*` for dashboard, `/gateway/*` for credits display | browser `fetch` with `rayu_session` cookie |
| rayu-studio (Vercel, `studio.rayucode.com`) | `/api/me/*`, `/gateway/v1/*` for billed chat, `/gateway/v1/proxy` for BYO-key | browser `fetch` with `rayu_session` cookie |
| CLI | `/api/cli/*` for login/refresh, `/v1/*` + `/anthropic/*` for AI, `/api/usage` for usage reporting | `Authorization: Bearer <jwt>` |
| Telegram bot | `/api/telegram/*` | bot webhook / poller (internal) |
| Google OAuth callback | `/api/auth/oauth/google` | redirect from Google |
| Bakong/ABA | `/api/payments/*` (outbound to Bakong API) | server-to-server |
| Upstream AI providers (Anthropic, OpenAI, Bedrock, etc.) | rayu-server proxies to them | server-to-server, streaming |

---

## 2. The shared HTTP contract (what must NOT change)

These external surfaces are depended on by rayu-web, rayu-studio, the CLI, Caddy, Telegram, Google, Bakong/ABA, and upstream providers. The Rust port preserves them **byte-for-byte** — they are enumerated in `rust-merge.md` §1 (hard contracts 1–10) and §1D/§2. The integration-specific additions are below.

### 2.1 Cross-subdomain auth bridge (NEW — the only rayu-web change)

**Problem:** rayu-studio needs to authenticate the user without its own login flow (its origin is COEP-isolated, so Google OAuth popups would break). The user is already logged in on rayu-web via NextAuth + a backend-issued Rayu JWT.

**Solution:** rayu-web sets a cross-subdomain HttpOnly cookie containing the Rayu **access** JWT. rayu-studio reads it server-side and validates with the shared `RAYU_JWT_SECRET`.

**Flow:**

```
1. User signs in on rayucode.com
   ├─ Google OAuth → NextAuth session (cookie on rayucode.com)
   ├─ rayu-web calls POST /api/auth/oauth/google on rayu-server
   │  → rayu-server returns { accessToken, refreshToken }
   │  → rayu-web stores them in localStorage (RAYU_SESSION_KEY)  [unchanged]
   └─ rayu-web ALSO calls POST /api/auth/session-cookie (NEW)
      → this NEW route runs on rayu-web (Next.js, not rayu-server)
      → it re-reads the NextAuth session
      → it calls rayu-server /api/cli/refresh (or re-mints) to get a fresh access JWT
      → sets Set-Cookie: rayu_session=<accessJwt>;
          Domain=.rayucode.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900
      (15-min TTL = access-token lifetime)

2. User navigates to studio.rayucode.com
   ├─ rayu-studio middleware reads rayu_session cookie
   ├─ validates JWT locally with RAYU_JWT_SECRET (server-side, HS256)
   ├─ if valid → populate getStudioSession() → render authenticated UI
   └─ if invalid/missing → 302 to https://rayucode.com/sign-in

3. Studio makes API calls
   └─ browser fetch includes rayu_session cookie automatically (same-site, .rayucode.com)
      → rayu-server reads Authorization: Bearer <jwt> from cookie
      → standard auth middleware

4. Sign-out on rayucode.com
   └─ rayu-web calls POST /api/auth/session-cookie with body {clear: true}
      → Set-Cookie: rayu_session=; Max-Age=0  (deletes on both subdomains)
```

**Why the new route lives on rayu-web (not rayu-server):** It needs the NextAuth session context, which only rayu-web holds. rayu-server only knows about Rayu JWTs, not NextAuth cookies.

**Security properties (detailed in §9.2):**
- HttpOnly → browser JS on either subdomain cannot read it (XSS can't steal it).
- Secure → only transmitted over HTTPS.
- SameSite=Lax → cross-site fetches don't include it (CSRF protection); top-level navigations do.
- Domain=.rayucode.com → visible to both `rayucode.com` and `studio.rayucode.com`.
- 15-min TTL → matches access token; refresh token never leaves rayu-web's localStorage.
- The cookie contains **only** the access JWT, never the refresh token.

**Verify:** After sign-in on rayu-web, visiting `studio.rayucode.com` shows authenticated UI with no redirect. `document.cookie` in either origin's console does NOT expose `rayu_session`.

### 2.2 rayu-studio → rayu-server call surface

rayu-studio calls the **same** endpoints as rayu-web/CLI, just from a different origin. The cookie is sent automatically by the browser (same-site).

| rayu-studio need | rayu-server route | Auth | Notes |
|---|---|---|---|
| "Am I logged in?" | `GET /api/me` | `rayu_session` cookie | returns user profile |
| "What models can I use?" | `GET /api/me/entitlements` | cookie | full entitlement shape (drives model picker) |
| "Show my credit balance" | `GET /v1/credits` | cookie | billing source of truth |
| "Chat with a hosted model" | `POST /v1/chat/completions` (via `/gateway` in prod) | cookie | billed via gateway credits |
| "Chat with my own key" | `POST /v1/proxy` (via `/gateway` in prod) | `X-Rayu-Token` header | BYO-key, no credit charge |
| "List hosted models" | `GET /v1/models` | cookie | OpenAI list shape |
| "My usage history" | `GET /api/me/credit-history` | cookie | |
| "My payments" | `GET /api/payments/mine` | cookie | |

**URL routing detail (critical):** In production, `NEXT_PUBLIC_RAYU_GATEWAY_URL=https://rayucode.com/gateway`. So the studio calls `https://rayucode.com/gateway/v1/credits`. Caddy's `handle_path /gateway/*` strips the prefix → `server:8080/v1/credits`. The studio never sees the prefix-strip; it just calls `${GATEWAY_URL}/v1/credits`. In local dev, `NEXT_PUBLIC_RAYU_GATEWAY_URL=http://localhost:8080` (no prefix, direct to server).

### 2.3 Environment variable union (single `server` container)

rayu-server receives the **full union** of backend + gateway env vars (per `rust-merge.md` §0.2). The integration-specific additions to the deploy env:

| Variable | Value | Used by |
|---|---|---|
| `NEXT_PUBLIC_STUDIO_URL` | `https://studio.rayucode.com` | rayu-web (nav link + OAuth redirect allowlist) |
| `NEXT_PUBLIC_RAYU_API_URL` | `https://rayucode.com/api` | rayu-studio (API base) |
| `NEXT_PUBLIC_RAYU_GATEWAY_URL` | `https://rayucode.com/gateway` | rayu-studio (gateway base) |

All three Vercel projects (rayu-web, rayu-studio) and the self-host Caddy stack must agree on these public URLs. `RAYU_JWT_SECRET` and `RAYU_PROVIDER_SECRET` are passed only to the `server` container (never to Vercel).

---

## 3. Deploy topology

### 3.1 `deploy/docker-compose.yml`

**Remove:** `backend` and `gateway` services.

**Add:** one `server` service.

```yaml
  server:
    build:
      context: ../rayu-server
      dockerfile: Dockerfile
    restart: unless-stopped
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      # ── Full union of backend + gateway env vars (see rust-merge.md §0.2) ──
      DATABASE_URL: mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@mysql:3306/${MYSQL_DATABASE}
      REDIS_URL: redis://redis:6379
      RAYU_JWT_SECRET: ${RAYU_JWT_SECRET}
      RAYU_PROVIDER_SECRET: ${RAYU_PROVIDER_SECRET}
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      RAYU_ACCESS_TTL: '3600'
      RAYU_REFRESH_TTL: '2592000'
      WEB_ORIGIN: ${PUBLIC_SITE_URL}
      # ── Bakong / ABA ──
      BAKONG_MERCHANT_ID: ${BAKONG_MERCHANT_ID:-}
      BAKONG_PHONE_NUMBER: ${BAKONG_PHONE_NUMBER:-}
      BAKONG_DEVELOPER_TOKEN: ${BAKONG_DEVELOPER_TOKEN:-}
      BAKONG_API_URL: ${BAKONG_API_URL:-api-bakong.nbc.gov.kh/v1}
      ABA_STATIC_QR: ${ABA_STATIC_QR:-}
      ABA_TELEGRAM_GROUP_ID: ${ABA_TELEGRAM_GROUP_ID:-}
      # ── Telegram shared bot ──
      TELEGRAM_API_ID: ${TELEGRAM_API_ID:-}
      TELEGRAM_API_HASH: ${TELEGRAM_API_HASH:-}
      TELEGRAM_SESSION: ${TELEGRAM_SESSION:-}
      RAYU_SHARED_BOT_TOKEN: ${RAYU_SHARED_BOT_TOKEN:-}
      TELEGRAM_WEBHOOK_URL: ${TELEGRAM_WEBHOOK_URL:-}
      TELEGRAM_WEBHOOK_SECRET: ${TELEGRAM_WEBHOOK_SECRET:-}
      SKIP_TELEGRAM_POLL: ${SKIP_TELEGRAM_POLL:-}
      # ── Admin / catalog ──
      LOCAL_ADMIN_PASSWORD: ${LOCAL_ADMIN_PASSWORD:-}
      SEED_CATALOG: ${SEED_CATALOG:-}
      ALLOW_INSECURE_PROVIDER_BASE_URL: ${ALLOW_INSECURE_PROVIDER_BASE_URL:-}
      # ── Gateway tuning ──
      CONFIG_REFRESH_SECONDS: '30'
      USER_CACHE_TTL_SECONDS: '10'
      RAYU_CONFIG_CHANNEL: rayu:config-changed
      RAYU_MAX_INFLIGHT: ${RAYU_MAX_INFLIGHT:-0}
      RAYU_ENFORCE_MODEL_FIDELITY: ${RAYU_ENFORCE_MODEL_FIDELITY:-}
      RAYU_PROXY_BODY_READ_TIMEOUT: ${RAYU_PROXY_BODY_READ_TIMEOUT:-0}
      GATEWAY_CORS_ORIGINS: '*'
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:8080/healthz']
      interval: 15s
      timeout: 5s
      retries: 10
    networks:
      - rayu
```

**Keep unchanged:** `mysql`, `redis`, `web` (with one env var update below), `caddy`.

**Update `web` service env:**
```yaml
        NEXT_PUBLIC_RAYU_API_URL: ${PUBLIC_SITE_URL}/api
        NEXT_PUBLIC_RAYU_GATEWAY_URL: ${PUBLIC_SITE_URL}/gateway
```
Both now terminate at `server:8080` via Caddy — no change needed in the web container itself, only the env vars point at the same public URLs.

**Update `caddy` service `depends_on`:** replace `backend` + `gateway` with `server`.
```yaml
    depends_on:
      - web
      - server
```

### 3.2 `deploy/Caddyfile`

Replace the two `handle` blocks for `backend` and `gateway` with a single block pointing at `server`:

```caddy
{$SITE_ADDRESS} {
	encode gzip

	# --- Edge access logging + request-id correlation ---
	log {
		output stdout
		format json
	}
	log_append rayu_request_id {http.request.header.X-Rayu-Request-Id}
	log_append rayu_logical_id {http.request.header.X-Rayu-Logical-Request-Id}

	# rayu-server (Rust) — single binary serving /gateway/* and /api/*
	# handle_path STRIPS the /gateway prefix, so /gateway/v1/* -> server:8080/v1/*
	# flush_interval -1 disables buffering so SSE streams to the CLI in real time.
	# NOTE: do NOT add read/write timeouts here — long SSE streams must not be cut.
	handle_path /gateway/* {
		reverse_proxy server:8080 {
			flush_interval -1
			header_up X-Rayu-Edge-Id {http.request.uuid}
		}
	}

	# Backend routes (/api/*) are mounted with the prefix, so we do NOT strip.
	handle /api/* {
		reverse_proxy server:8080
	}

	# Everything else goes to the Next.js website.
	handle {
		reverse_proxy web:3000
	}
}
```

**Routing table (verify before cutover):**

| Public URL | Caddy rule | Forwarded to | Path seen by server |
|---|---|---|---|
| `https://rayucode.com/api/health` | `handle /api/*` | `server:8080` | `/api/health` |
| `https://rayucode.com/gateway/healthz` | `handle_path /gateway/*` | `server:8080` | `/healthz` |
| `https://rayucode.com/gateway/v1/credits` | `handle_path /gateway/*` | `server:8080` | `/v1/credits` |
| `https://rayucode.com/gateway/v1/chat/completions` | `handle_path /gateway/*` | `server:8080` | `/v1/chat/completions` |
| `https://rayucode.com/` | `handle` | `web:3000` | `/` |

**Edge case:** `https://rayucode.com/api/v1/credits` → server sees `/api/v1/credits` → 404 (no such route; this is intentional — the `/v1` tree is only reachable via `/gateway`).

### 3.3 `deploy/.env.example`

Merge the env var lists from `rayu-backend/.env.example` and `rayu-gateway/.env.example`. Remove the old `backend`/`gateway`-specific sections. Add a top comment:

```bash
# ──────────────────────────────────────────────────────────────────
# rayu-server env (union of former backend + gateway env vars)
# RAYU_JWT_SECRET and RAYU_PROVIDER_SECRET MUST be the same values
# previously used by the NestJS backend and Go gateway. They are now
# both consumed by the single `server` container.
# ──────────────────────────────────────────────────────────────────
```

Document each variable with a comment indicating which subsystem uses it (auth / payments / telegram / gateway tuning / etc.).

### 3.4 Migrations

- `rayu-server` runs `sqlx migrate run` at boot (guarded — only runs if `DATABASE_URL` is set and the `migrations` table is empty or behind).
- The baseline migration `0001_baseline.sql` is generated from the **current production Prisma-produced schema** (per `rust-merge.md` §0.10). This snapshot must be byte-for-byte identical to what the 20 existing Prisma migrations produce, **including camelCase column names**.
- **Remove** the `npx prisma migrate deploy` step from any deploy scripts/CI.
- **Keep** `rayu-backend/prisma/schema.prisma` in the repo for reference (tooling only); freeze it.
- **Pre-cutover verification:** run `mysqldump --no-data` on a dev DB seeded by all 20 Prisma migrations → diff against `0001_baseline.sql` → must match. Then run `mysqldump --no-data` on production → diff against the dev result → must match (any drift must be reconciled before cutover).

### 3.5 Local dev workflow

For developers running the full stack locally without Vercel:

```bash
# Terminal 1: Rust server (with MySQL + Redis from deploy/docker-compose.yml)
cd rayu-server
cargo run --bin server
# Listens on :8080. Env from .env (see rayu-server/.env.example).

# Terminal 2: rayu-web (Next.js)
cd rayu-web
npm run dev
# Listens on :3000. NEXT_PUBLIC_RAYU_API_URL=http://localhost:8080/api
#                       NEXT_PUBLIC_RAYU_GATEWAY_URL=http://localhost:8080
# (No /gateway prefix locally — direct to server.)

# Terminal 3: rayu-studio (Next.js)
cd rayu-studio
pnpm dev
# Listens on :3001. Same NEXT_PUBLIC_* URLs as rayu-web.
# (No Caddy locally; both apps talk to :8080 directly.)
```

**Auth bridge locally:** Since both apps run on `localhost` (different ports, same host), cookies scoped to `localhost` work. Set the cookie `Domain=localhost` in local dev (the session-cookie route should detect `NEXTAUTH_URL` and pick the right domain). Alternatively, use `host.docker.internal` mapping in the compose file.

**Studio WebContainer locally:** COEP headers must be set on `localhost:3001`. The studio's `next.config.mjs` headers config handles this for `pnpm dev` too.

---

## 4. Vercel deploy (rayu-web + rayu-studio)

Both Vercel projects point at the **same** rayu-server (via `PUBLIC_SITE_URL`). They differ only in subdomain + COEP headers.

| Project | Domain | COOP/COEP | Env (key ones) |
|---|---|---|---|
| `rayu-web` | `rayucode.com` | **No** (OAuth popups, KHQR iframe need a normal origin) | `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_*`, `NEXT_PUBLIC_RAYU_API_URL=https://rayucode.com/api`, `NEXT_PUBLIC_RAYU_GATEWAY_URL=https://rayucode.com/gateway`, `NEXT_PUBLIC_STUDIO_URL=https://studio.rayucode.com` |
| `rayu-studio` | `studio.rayucode.com` | **Yes** (`same-origin` + `credentialless`, origin-wide) | `NEXT_PUBLIC_RAYU_API_URL=https://rayucode.com/api`, `NEXT_PUBLIC_RAYU_GATEWAY_URL=https://rayucode.com/gateway` (**no server secrets**) |

Vercel auto-previews every branch + auto-deploys `main` for both projects. rayu-web is already configured (`rayu-web/.vercel/project.json` → `prj_fhodu81BkehPkQanU4mJwPsUgvAj`). rayu-studio needs a new Vercel project linked to the repo with root dir `rayu-studio/` (per bolt plan Step 6).

**Cookie bridge detail:** The `rayu_session` cookie is set on `.rayucode.com`, so it's readable by both `rayucode.com` (rayu-web) and `studio.rayucode.com` (rayu-studio). The cookie-minting route (`POST /api/auth/session-cookie`) lives on rayu-web because it needs the NextAuth session context.

---

## 5. CI changes (`.github/workflows`)

### 5.1 `ci.yml` — add `studio-test` + `server-test` jobs

Append to the existing `ci.yml` (alongside `cli-test`, `backend-test`, `gateway-test`, `web-test`):

```yaml
  studio-test:
    name: Studio Tests
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
      with: { version: '9' }
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'pnpm'
        cache-dependency-path: rayu-studio/pnpm-lock.yaml
    - name: Install dependencies
      working-directory: ./rayu-studio
      run: pnpm install --frozen-lockfile
    - name: Type check
      working-directory: ./rayu-studio
      run: pnpm typecheck
    - name: Lint
      working-directory: ./rayu-studio
      run: pnpm lint
    - name: Build
      working-directory: ./rayu-studio
      run: pnpm build

  server-test:
    name: Server Tests (Rust)
    runs-on: ubuntu-latest
    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: test
          MYSQL_DATABASE: rayu_test
        ports: ['3306:3306']
        options: --health-cmd="mysqladmin ping" --health-interval=10s --health-timeout=5s --health-retries=3
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
        options: --health-cmd="redis-cli ping" --health-interval=10s --health-timeout=5s --health-retries=3
    steps:
    - uses: actions/checkout@v4
    - uses: dtolnay/rust-toolchain@stable
    - uses: Swatinem/rust-cache@v2
      with:
        workspaces: rayu-server
    - name: Install cargo-audit
      run: cargo install cargo-audit --locked
    - name: Security audit
      working-directory: ./rayu-server
      run: cargo audit
    - name: Format check
      working-directory: ./rayu-server
      run: cargo fmt -- --check
    - name: Clippy
      working-directory: ./rayu-server
      run: cargo clippy --all-targets --all-features -- -D warnings
    - name: Run migrations on test DB
      working-directory: ./rayu-server
      env:
        DATABASE_URL: mysql://root:test@localhost:3306/rayu_test
      run: cargo run --bin migrate
    - name: Tests
      working-directory: ./rayu-server
      env:
        DATABASE_URL: mysql://root:test@localhost:3306/rayu_test
        REDIS_URL: redis://localhost:6379
        RAYU_JWT_SECRET: test-secret-at-least-32-chars-long
        RAYU_PROVIDER_SECRET: test-provider-secret-32-chars
      run: cargo test --all-features
```

### 5.2 `deploy.yml` (NEW) — self-host deploy

```yaml
name: Deploy (self-host)

on:
  push:
    branches: [main]
    paths:
      - 'rayu-server/**'
      - 'rayu-web/**'
      - 'rayu-studio/**'
      - 'deploy/**'
      - '.github/workflows/deploy.yml'

jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: [server-test, web-test, studio-test]
    if: github.ref == 'refs/heads/main'
    steps:
    - uses: actions/checkout@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Login to container registry
      uses: docker/login-action@v3
      with:
        registry: ${{ secrets.REGISTRY_URL }}
        username: ${{ secrets.REGISTRY_USER }}
        password: ${{ secrets.REGISTRY_PASS }}

    - name: Build & push rayu-server image
      uses: docker/build-push-action@v5
      with:
        context: ./rayu-server
        file: ./rayu-server/Dockerfile
        push: true
        tags: |
          ${{ secrets.REGISTRY_URL }}/rayu-server:${{ github.sha }}
          ${{ secrets.REGISTRY_URL }}/rayu-server:latest
        cache-from: type=registry,ref=${{ secrets.REGISTRY_URL }}/rayu-server:buildcache
        cache-to: type=registry,mode=max,ref=${{ secrets.REGISTRY_URL }}/rayu-server:buildcache

    - name: Build & push rayu-web image
      uses: docker/build-push-action@v5
      with:
        context: ./rayu-web
        file: ./rayu-web/Dockerfile
        push: true
        tags: |
          ${{ secrets.REGISTRY_URL }}/rayu-web:${{ github.sha }}
          ${{ secrets.REGISTRY_URL }}/rayu-web:latest
        build-args: |
          NEXTAUTH_SECRET=${{ secrets.NEXTAUTH_SECRET }}
          NEXTAUTH_URL=${{ secrets.NEXTAUTH_URL }}
          GOOGLE_CLIENT_ID=${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET=${{ secrets.GOOGLE_CLIENT_SECRET }}
          NEXT_PUBLIC_RAYU_API_URL=${{ secrets.PUBLIC_SITE_URL }}/api
          NEXT_PUBLIC_RAYU_GATEWAY_URL=${{ secrets.PUBLIC_SITE_URL }}/gateway
          NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION=${{ secrets.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION }}

    - name: Build & push rayu-studio image
      uses: docker/build-push-action@v5
      with:
        context: ./rayu-studio
        file: ./rayu-studio/Dockerfile
        push: true
        tags: |
          ${{ secrets.REGISTRY_URL }}/rayu-studio:${{ github.sha }}
          ${{ secrets.REGISTRY_URL }}/rayu-studio:latest

    - name: Deploy to VPS
      uses: appleboy/ssh-action@v1
      with:
        host: ${{ secrets.VPS_HOST }}
        username: ${{ secrets.VPS_USER }}
        key: ${{ secrets.VPS_SSH_KEY }}
        script: |
          cd /opt/rayu
          export RAYU_SERVER_TAG=${{ github.sha }}
          export RAYU_WEB_TAG=${{ github.sha }}
          export RAYU_STUDIO_TAG=${{ github.sha }}
          docker compose pull
          docker compose up -d --build
          docker image prune -f

    - name: Health check
      run: |
        sleep 10
        curl -fsS https://${{ secrets.PUBLIC_SITE_URL }}/api/health || exit 1
        curl -fsS https://${{ secrets.PUBLIC_SITE_URL }}/gateway/healthz || exit 1
```

**Rollback strategy:** Old images are kept tagged with prior SHAs. To roll back, set `RAYU_SERVER_TAG=<old-sha>` in `/opt/rayu/.env` and `docker compose up -d`. Caddy upstreams revert in one env var change. No force-push, no destructive operations.

---

## 6. Observability

| Signal | Source | Where |
|---|---|---|
| Structured logs | `tracing` crate (Rust) → stdout | Caddy captures (JSON) → Docker logs |
| Request correlation | `X-Rayu-Request-Id` (CLI-generated or edge-injected `X-Rayu-Edge-Id`) | Caddy logs + server logs joinable by `grep <id>` |
| Metrics | `metrics` crate (Rust) — counters for inflight/reserve/settle/ledger-queue-depth | Prometheus endpoint `/metrics` (server) |
| Health | `GET /healthz` (public, server) + `GET /api/health` (server) | Caddy healthcheck + external uptime monitors |
| Error tracking | Sentry (optional, via `sentry` crate) | server |
| Vercel previews | Vercel dashboard + PR comments | per-branch preview URLs |

**Correlation flow:** CLI generates `X-Rayu-Request-Id` per physical attempt + `X-Rayu-Logical-Request-Id` stable across retries. Caddy logs both in its JSON access log. Server logs both. So a failing request is traceable edge ↔ server by `grep <id>`.

**Critical metrics to alert on:**
- `ledger_queue_depth` > 1000 (eventqueue backing up → MySQL pool starvation risk)
- `gateway_inflight` near `RAYU_MAX_INFLIGHT` (saturated)
- `settle_errors` > 0 (billing failures — credit charges lost)
- `provider_key_invalid_total` rising (a key was condemned — may need admin re-test)
- `5xx_rate` on `/v1/*` or `/api/*` > 1% over 5 min

---

## 7. Cross-cutting verification

These tests prove rayu-server + rayu-studio + rayu-web + Caddy + CLI all work together. Run **after** Phase 3 cutover in `rust-merge.md` + after Step 6 in the bolt plan.

### 7.1 Functional verification

| # | Test | How to verify |
|---|---|---|
| 1 | rayu-studio can authenticate | Sign in on rayu-web → cookie set → visit `studio.rayucode.com` → UI shows authenticated (no redirect to `/sign-in`) |
| 2 | Studio chat debits credits | Send a message via studio → gateway reserves/settles → rayu-web `/dashboard` shows credit deduction within 10s |
| 3 | Studio BYO-key fallback works | Paste a provider key in studio settings → send message → no credit deduction in `/dashboard`; request goes direct to provider |
| 4 | CLI + web + studio share auth | Same Rayu JWT works for CLI `/usage`, web `/dashboard`, and studio chat — all three show the same user |
| 5 | WebContainer boots under COEP | In studio browser console: `window.crossOriginIsolated === true`; `WebContainer.boot()` resolves; preview iframe loads from `*.local-credentialless.webcontainer-api.io` |
| 6 | Caddy routing correct | `curl https://rayucode.com/api/health` → 200; `curl https://rayucode.com/gateway/healthz` → 200; `curl https://rayucode.com/gateway/v1/credits` (no auth) → 401; `curl https://rayucode.com/api/v1/credits` → 404 (prefix not stripped) |
| 7 | Provider key decryption interop | Existing encrypted keys in MySQL (written by NestJS/Go) decrypt correctly in Rust — secretbox interop test passes against a known ciphertext |
| 8 | Streaming parity | Same Anthropic/OpenAI/Bedrock request through CLI and studio produces identical token counts + credit charges (diff `/v1/credits` before/after) |
| 9 | Payments work | Create a KHQR/ABA payment → poll status → `activatePaid` → subscription created → credits appear in `/dashboard` |
| 10 | Self-host deploy | `docker compose up -d --build` brings up `server` + `web` + `caddy`; all healthchecks pass within 60s |
| 11 | Rollback works | Set `RAYU_SERVER_TAG=<old-sha>` → `docker compose up -d` → old services back up; or revert Caddyfile → `backend` + `gateway` containers back up |

### 7.2 Security verification

| # | Test | How to verify |
|---|---|---|
| 12 | Cookie is HttpOnly | `document.cookie` in browser console on both `rayucode.com` and `studio.rayucode.com` does NOT expose `rayu_session` |
| 13 | Cookie is Secure | `curl -v http://rayucode.com/api/me` (HTTP, not HTTPS) → no `Set-Cookie` returned; cookie never transmitted over HTTP |
| 14 | BYO-key path doesn't bill | Send BYO-key message → no credit deduction in `/dashboard`; no provider key in gateway logs (grep for key prefix → 0 matches) |
| 15 | SSRF protection works | `curl -X POST https://rayucode.com/gateway/v1/proxy -H "X-Rayu-Token: <valid>" -H "X-Rayu-Upstream-URL: http://169.254.169.254"` → 403 |
| 16 | SSRF via DNS rebinding | `curl -X POST .../v1/proxy -H "X-Rayu-Upstream-URL: https://rebind.attacker.com"` (resolves to private IP) → 403 |
| 17 | No secret leakage | `rayu-studio` Vercel project env contains only `NEXT_PUBLIC_*` vars; no `RAYU_JWT_SECRET`/`NEXTAUTH_SECRET`/`RAYU_PROVIDER_SECRET` |
| 18 | CORS correct | `curl -H "Origin: https://evil.com" https://rayucode.com/gateway/v1/credits` → no `Access-Control-Allow-Origin: *` (or only whitelisted origins); `OPTIONS` preflight returns correct headers |
| 19 | Rate limits work | Send >20 requests/sec to `/v1/chat/completions` → 429 with `Retry-After` header |
| 20 | Daily turn cap works | Exceed `maxDailyTurns` for the user's plan → 429 with `"daily turn limit reached"` + `Retry-After` |

### 7.3 Data migration verification (pre-cutover)

| # | Test | How to verify |
|---|---|---|
| 21 | Schema baseline matches prod | `mysqldump --no-data` on prod → diff against `0001_baseline.sql` → 0 differences (any drift reconciled manually) |
| 22 | Existing sessions still valid | Rayu JWTs minted by the old NestJS service still verify in Rust (HS256, same secret) — integration test |
| 23 | Existing credits intact | Run `cargo test` parity suite against a prod snapshot → `CreditLedger` rows match; user `usedCredits` unchanged |
| 24 | Existing provider keys decrypt | secretbox interop test against a real ciphertext from prod `provider_api_keys.encryptedKey` |
| 25 | Telegram links persist | `telegramLinks` table unchanged; existing paired chats still receive messages after cutover |

---

## 8. What this plan does NOT cover

- **Rust porting details** — every line of NestJS → Rust and Go → Rust code. That's `rust-merge.md` Phases 0–3.
- **bolt.diy UI porting** — Remix → Next, UnoCSS, React 19 upgrade, component copy. That's `integrate-bolt-diy-into-rayu-web.md` Steps 1–2.
- **rayu-web changes beyond the cookie route + nav link** — covered here in §2.1 and the bolt plan Step 7.
- **WebContainer license procurement** — Step 0 of the bolt plan; flagged as an open question here.

---

## 9. Execution order (combined, sequenced by dependency)

| Step | Phase / step from source plan | What unblocks |
|---|---|---|
| 1 | rust-merge Phase 0 (foundations + secretbox interop) | proves the hardest contract (AES-GCM envelope) first |
| 2 | rust-merge Phase 1A–1B (config snapshot + credits/limiter) | billing core that studio depends on |
| 3 | rust-merge Phase 1C–1D (adapters + hosted routes) | streaming core; CLI can validate against it |
| 4 | rust-merge Phase 2A (auth: `/api/auth/*`, `/api/cli/*`) | unblocks web + CLI login |
| 5 | bolt plan Step 1–2 (scaffold rayu-studio, React 19 upgrade) | studio UI boots (with stub gateway) |
| 6 | bolt plan Step 3 (LLM proxy: gateway default + BYO fallback) | **depends on step 3** — studio can now make billed chat calls |
| 7 | bolt plan Step 4 (auth bridge: rayu-web cookie route + studio middleware) | studio can authenticate (depends on step 4 for JWT validation) |
| 8 | bolt plan Step 5 (COEP headers on studio origin) | WebContainer boots |
| 9 | rust-merge Phase 2B–2F (payments, promo, providers, models, settings, telegram, admin) | full backend parity |
| 10 | rust-merge Phase 3 + this plan §3 (deploy: docker-compose + Caddy) | single-binary cutover |
| 11 | this plan §5 (CI: studio-test + server-test + deploy.yml) | automated preview + deploy |
| 12 | bolt plan Step 6–7 (Vercel project + nav link) | studio live on `studio.rayucode.com` |
| 13 | this plan §7 (all 25 verification tests) | production-ready sign-off |

**Critical path:** Step 6 (studio LLM proxy) is blocked by Step 3 (gateway routes). Step 7 (auth bridge) is blocked by Step 4 (auth). Steps 5–8 can be scaffolded in parallel with Steps 2–4 using a stub gateway + stub auth, then swapped to real once dependencies land.

**Parallelization opportunity:** rust-merge Phases 2B–2F (step 9) are fairly independent and can be sliced across multiple contributors while the studio work (steps 5–8) proceeds on a separate branch.

---

## 10. Security analysis

### 10.1 Threat model (new surfaces introduced by this integration)

| Asset | Threat | Mitigation | Verify |
|---|---|---|---|
| `rayu_session` cookie (cross-subdomain auth bridge) | Cookie theft via XSS on either subdomain → account takeover on both | HttpOnly + Secure + SameSite=Lax; 15-min access-token TTL (not refresh); studio JS never handles the refresh token | §7.2 #12, #13 |
| rayu-studio's WebContainer sandbox | Malicious user code runs in-browser Node.js → exfiltrate `rayu_session` cookie or call gateway with stolen JWT | WebContainer runs under `credentialless` COEP; the cookie is HttpOnly so browser JS (including the sandbox) cannot read it; JWT has 15-min TTL + plan-scoped entitlements | §7.1 #5, §7.2 #12 |
| rayu-studio BYO-key path (`/v1/proxy`) | User pastes a provider key → studio forwards it to the provider → key leaks to rayu infrastructure logs | Gateway strips all `X-Rayu-*` headers before the provider hop; `proxy.Forward` only forwards the user's `Authorization`/`x-api-key` to the upstream, never to rayu logs; `RAYU_PROXY_BODY_READ_TIMEOUT` limits request body exposure | §7.2 #14 |
| SSRF via `X-Rayu-Upstream-URL` | User sets upstream URL to internal host (e.g. `169.254.169.254` metadata service) → scan/exfiltrate internal network | `validateUpstreamURL` rejects localhost, private/loopback/link-local IPs, and any hostname whose DNS A/AAAA resolves to a private IP (per `rust-merge.md` §1D `handleProxy`); `ALLOW_INSECURE_PROVIDER_BASE_URL` is the documented escape hatch for dev only | §7.2 #15, #16 |
| Provider API key storage | Keys entered in rayu-web admin dashboard → encrypted with AES-GCM → stored in MySQL → decrypted by rayu-server | `secretbox` uses `sha256(RAYU_PROVIDER_SECRET)[..32]`; keys are write-only (never returned by any endpoint); `maskedKey` only; decryption is in-memory only, never logged; interop unit-tested against existing ciphertext | §7.1 #7, §7.3 #24 |
| WebContainer license | `@webcontainer/api` is commercial — unlicensed use in production is a legal/compliance risk | Step 0 hard gate: confirm StackBlitz license before prod deploy; studio UI scaffolding can proceed but WebContainer boot is gated | (manual) |
| CSRF on cookie-authenticated routes | Attacker tricks browser into making a cross-site request with the cookie → unauthorized action | SameSite=Lax cookie → cross-site `fetch`/form POSTs don't include the cookie; only top-level navigations do; mutating `/api/*` routes additionally require a JSON content-type or custom header (rejected by simple CORS requests) | §7.2 #18 |
| JWT replay after logout | Stolen JWT used after user signs out | 15-min TTL bounds the window; sign-out clears the cookie (no new requests); future hardening: server-side token revocation list (out of scope) | §7.1 #11 (rollback) |
| CORS misconfiguration | `Access-Control-Allow-Origin: *` on authenticated routes → any site reads responses | Gateway CORS mirrors Origin only if in `GATEWAY_CORS_ORIGINS` (default `*` for unauthenticated; authenticated routes should restrict); OPTIONS preflight returns correct headers | §7.2 #18 |

### 10.2 Cookie bridge security (detailed)

- **Cookie attributes:** `Domain=.rayucode.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`.
- **Contents:** access JWT only (HS256, `{ sub: <number>, role, type: "access" }`). Never the refresh token.
- **Refresh token handling:** Stays in rayu-web's `localStorage` (`RAYU_SESSION_KEY`). Studio never sees it. rayu-web refreshes via `POST /api/cli/refresh` when the access token expires, then re-mints the cookie.
- **Sign-out flow:** rayu-web calls `POST /api/auth/session-cookie` with `{ clear: true }` → server returns `Set-Cookie: rayu_session=; Max-Age=0` → cookie deleted on both subdomains. Also clears `RAYU_SESSION_KEY` from localStorage.
- **Attack analysis:**
  - **XSS on studio:** `document.cookie` cannot read `rayu_session` (HttpOnly). Sandbox cannot reach across `same-origin` COOP. → Cookie not exfiltrable.
  - **XSS on rayu-web:** Same — HttpOnly prevents JS read. → Cookie not exfiltrable.
  - **CSRF:** SameSite=Lax prevents cross-site `fetch` from carrying the cookie. Top-level navigations (GET) carry it but are non-mutating. → No CSRF on mutating routes.
  - **Network MITM:** Secure + Caddy TLS → cookie only over HTTPS. → Not sniffable.
  - **Cookie fixation:** Server validates JWT signature + `type:"access"` claim → attacker can't forge a valid cookie.
- **Verify:** §7.2 #12, #13.

### 10.3 WebContainer isolation

- WebContainer's `coep: 'credentialless'` + COOP `same-origin` on the studio origin means the sandbox iframe runs in a **cross-origin-isolated** context that cannot access the parent's DOM or cookies directly.
- The sandbox can make `fetch()` calls to the gateway (cookie sent automatically, same-site), but the JWT has a 15-min TTL and is plan-scoped — a compromised sandbox session can only burn the user's current credits until the token expires.
- The sandbox runs **user-supplied code** in-browser. Risks: malicious Node.js code in the sandbox could try to exfiltrate data. Mitigations:
  - The sandbox is cross-origin-isolated from the parent → no DOM/cookie access.
  - User's `rayu_session` cookie is HttpOnly → sandbox's JS cannot read it.
  - Sandbox can call the gateway (cookie sent automatically) but is bounded by the user's plan entitlements + daily turn cap + credit reserve.
  - The sandbox runs in the user's browser, not on rayu infra → no lateral movement to other users' data.
- **Verify:** §7.1 #5.

### 10.4 BYO-key path (no credit billing)

- When a user pastes their own provider API key in studio settings, the studio sends it directly to the provider via `X-Rayu-Token` auth on `/v1/proxy`.
- The gateway **never** logs or stores the user's provider key. It only sees the `X-Rayu-Upstream-URL` + `Authorization` header forwarded to the upstream.
- The gateway strips all `X-Rayu-*` headers before the provider hop (per `rust-merge.md` §1D `handleProxy`).
- The gateway writes a `UsageEvent` (not a `CreditLedger` entry) for BYO-key calls — no credit charge.
- **Verify:** §7.2 #14.

### 10.5 Secrets management

- `RAYU_JWT_SECRET` and `RAYU_PROVIDER_SECRET` are passed to the single `server` container (no inter-service copy risk — they're both in one process now).
- Vercel project env vars for rayu-web + rayu-studio are separate; `NEXTAUTH_SECRET` lives only on rayu-web; `RAYU_JWT_SECRET` lives only on rayu-server.
- rayu-studio's Vercel project env contains only `NEXT_PUBLIC_*` vars — no server secrets.
- GitHub Actions secrets (`VPS_SSH_KEY`, `REGISTRY_PASS`, `NEXTAUTH_SECRET`, etc.) are referenced via `${{ secrets.* }}` — never inlined.
- **Verify:** §7.2 #17.

### 10.6 Caddy edge security

- Caddy terminates TLS; `X-Rayu-Edge-Id` is injected per request for correlation.
- `handle_path /gateway/*` strips the prefix before forwarding — the studio's `/v1/*` routes are never exposed at `/api/v1/*` by accident.
- `handle /api/*` keeps the prefix — the studio's `/api/*` calls (e.g. `/api/me`) route correctly.
- No `read`/`write` timeouts on the gateway route — long SSE streams must not be cut.
- **Verify:** §7.1 #6, §7.2 #18.

### 10.7 Supply chain

- bolt.diy is MIT-licensed — copying source is legal with attribution (preserved in `LICENSE` file copied to `rayu-studio/`).
- `@webcontainer/api` is a separate commercial license — confirmed in Step 0 of the bolt plan.
- All new dependencies (Rust crates, npm packages) are pinned in `Cargo.lock` / `pnpm-lock.yaml` and reviewed in CI.
- `cargo audit` runs in `server-test` CI job (§5.1). `pnpm audit` should be added to `studio-test`.
- **Verify:** `rayu-studio/LICENSE` contains the MIT attribution; `rayu-server/Cargo.lock` and `rayu-studio/pnpm-lock.yaml` are committed.

### 10.8 CI/CD security

- `deploy.yml` SSH deploy uses a GitHub secret (`VPS_SSH_KEY`) — never inline credentials.
- Docker images are built with Buildx + registry cache (faster + reproducible).
- Rollback keeps old images tagged — no force-rebuild that could drop security patches.
- `docker image prune -f` only removes untagged images, never tagged ones.
- **Verify:** No secrets in commit history (`git log -p | grep -i secret` returns nothing sensitive); `docker compose config` validates env var names before deploy.

### 10.9 Rate limiting + abuse prevention (preserved from existing services)

- Per-user per-period credit cap (Redis `cwperiod:<uid>`, TTL tied to subscription `currentPeriodEnd`).
- Per-user concurrency cap (`conc:<uid>`, TTL 10 min self-heal).
- Per-user 5-hour request cap (`req5h:<uid>`).
- Daily turn cap (`turns:<uid>:<YYYYMMDD>`, midnight-UTC TTL) — enforced before credit reserve on hosted path, best-effort on BYO-key path.
- Inflight limiter `RAYU_MAX_INFLIGHT` around the hosted endpoint.
- `POST /v1/_provider-test` rate-limited to 20/min/admin.
- `POST /v1/_reload` rate-limited to 60/min/admin.
- **Verify:** §7.2 #19, #20.

---

## 11. Risks specific to the integration

| Risk | Mitigation |
|---|---|
| rayu-studio's COEP breaks its own OAuth (if studio ever needs login) | Studio has **no** login flow — it trusts the `.rayucode.com` cookie from rayu-web. COEP only affects the studio origin. |
| Cookie bridge fails (SameSite/Cross-Site) | Cookie is SameSite=Lax, first-party across `.rayucode.com` subdomains. Test in incognito across both origins. If browser drops third-party cookies entirely in future, fall back to `postMessage` token relay (out of scope for v1). |
| Caddy prefix-strip mismatch | `handle_path /gateway/*` strips → `server:8080/v1/*`; `handle /api/*` keeps → `server:8080/api/*`. Test with `curl -v` before cutover (§7.1 #6). |
| Studio calls `/v1/credits` but the route is under `/gateway` in Caddy | `NEXT_PUBLIC_RAYU_GATEWAY_URL=https://rayucode.com/gateway` → studio calls `.../gateway/v1/credits` → Caddy strips → `server:8080/v1/credits`. The studio never sees the prefix. Documented in §2.2. |
| Self-host deploy image mismatch (Rust + Next images) | Build both images in one deploy job; tag both with the same git SHA; `docker compose pull` pulls both atomically. |
| Rollback leaves stale cookies | Cookie TTL is 15 min; on rollback, old rayu-web (NestJS) still sets the same cookie format, so no migration needed. |
| Existing user sessions break at cutover | Rayu JWTs are HS256 with the same `RAYU_JWT_SECRET` → old tokens still verify in Rust. No forced re-login. (§7.3 #22) |
| Prisma→sqlx schema drift | Baseline snapshot generated from a DB seeded by all 20 Prisma migrations; diff vs prod schema before cutover (§7.3 #21). |
| Single-instance in-memory state (code store, telegram file grants, poller offset) | Document as single-instance for now; multi-replica later → move code store + file grants to Redis with `SETNX` (per `rust-merge.md` open assumptions). |
| `finalizeRedemption` oversell-by-1 under concurrency | Preserve read-then-write exactly (drop-in behavior); documented as known limitation in `rust-merge.md`. |
| ABA MTProto (`grammers`) can't read bot alerts | Fallback: operator manual confirm via admin `activatePaid` (already supported). Spike early (Phase 2C.7). |
| WebContainer license not obtained before launch | Step 0 hard gate; degraded mode (static preview only) is the documented fallback. |
| Big-bang cutover with no fallback | Keep old `backend` + `gateway` images tagged; Caddy upstreams revert in one env var change; parity phase on staging first (§7.3). |

---

## 12. Open questions

| # | Question | Default / recommendation |
|---|---|---|
| 1 | Vercel project for rayu-studio: separate project, or single `rayu-web` project with output config? | **Separate project** — Vercel doesn't support per-route COEP headers on a single Next app cleanly. |
| 2 | Rust Dockerfile pattern: existing team pattern or write from scratch? | Standard `FROM rust:1-bookworm AS builder` → `FROM debian:bookworm-slim` (smaller than `rust:slim`). |
| 3 | Local dev: rayu-server alongside old backend+gateway, or replace immediately? | **Replace immediately** in a `deploy/docker-compose.staging.yml` override; keep `deploy/docker-compose.yml` for prod cutover. |
| 4 | WebContainer license confirmed? | Still pending. Studio UI scaffolding can proceed; WebContainer boot is gated behind license. |
| 5 | Security review sign-off: who reviews §10 before prod? | Team lead + the author of `rust-merge.md`. Required before §7 verification passes. |
| 6 | Observability stack: do we have Prometheus/Grafana, or just logs? | If none, ship logs only for v1; add `/metrics` endpoint ready for future scrape. |
| 7 | Token revocation: do we need server-side JWT revocation after logout? | **No for v1** — 15-min TTL bounds the window. Document as future hardening. |

---

## 13. Pre-deploy security checklist

- [ ] §10.1 threat model reviewed with the team
- [ ] §10.2 cookie bridge: HttpOnly/Secure/SameSite=Lax verified; refresh token never leaves rayu-web
- [ ] §10.3 WebContainer COEP/COOP isolation verified (`crossOriginIsolated === true`)
- [ ] §10.4 BYO-key path: no provider keys in gateway logs; only `UsageEvent`s written
- [ ] §10.5 `RAYU_JWT_SECRET`/`RAYU_PROVIDER_SECRET` passed only to `server` container; rayu-studio Vercel env has no server secrets
- [ ] §10.6 Caddy prefix routing verified (`curl -v` tests in §7.1 #6)
- [ ] §10.7 `cargo audit` + `pnpm audit` pass in CI
- [ ] §10.8 `deploy.yml` uses GitHub secrets only; no inline credentials; rollback images tagged
- [ ] §10.9 rate limits + daily turn caps verified (§7.2 #19, #20)
- [ ] §7.3 data migration tests pass (schema baseline, JWT interop, provider key decryption)

---

## Appendix A — File change map (integration-only)

| File | Change | Source plan |
|---|---|---|
| `rayu-web/app/api/auth/session-cookie/route.ts` | **NEW** — mint/clear `.rayucode.com` cookie | This plan §2.1 |
| `rayu-web/lib/useRayuToken.ts` | Modified — call session-cookie route on mint/logout | This plan §2.1, bolt plan Step 4a |
| `rayu-web/app/components/NavAuth.tsx` | Add "Studio" link to `studio.rayucode.com` | bolt plan Step 7 |
| `rayu-web/.env.example` | Add `NEXT_PUBLIC_STUDIO_URL` | This plan §2.3 |
| `rayu-studio/` | **NEW** — entire app (scaffolded from bolt.diy) | bolt plan Steps 1–2 |
| `rayu-studio/middleware.ts` | **NEW** — validate `rayu_session` cookie | bolt plan Step 4b |
| `rayu-studio/lib/auth/getStudioSession.ts` | **NEW** — server-side cookie validation | bolt plan Step 4b |
| `rayu-studio/lib/llm/gatewayClient.ts` | **NEW** — stream to rayu-gateway | bolt plan Step 3a |
| `rayu-studio/lib/llm/byoKeyClient.ts` | **NEW** — bolt's original direct-provider flow | bolt plan Step 3a |
| `rayu-studio/app/api/chat/route.ts` | **NEW** — Next route handler for LLM calls | bolt plan Step 3b |
| `rayu-studio/app/api/models/route.ts` | **NEW** — model list for picker | bolt plan Step 3b |
| `rayu-studio/next.config.mjs` | **NEW** — COOP/COEP headers + standalone | bolt plan Steps 1c, 5 |
| `rayu-studio/Dockerfile` | **NEW** — multi-stage node:20-alpine + standalone | bolt plan Step 6 |
| `rayu-studio/.vercel/project.json` | **NEW** — link `rayu-studio` Vercel project | bolt plan Step 6 |
| `rayu-server/` | **NEW** — Rust workspace (per `rust-merge.md` §1) | `rust-merge.md` |
| `rayu-server/Dockerfile` | **NEW** — multi-stage Rust build | This plan §3.1 |
| `rayu-server/.env.example` | **NEW** — full env var union | `rust-merge.md` §0.2 |
| `deploy/docker-compose.yml` | Remove `backend`+`gateway`, add `server`; update `web` env; update `caddy` depends_on | This plan §3.1 |
| `deploy/Caddyfile` | Single `server:8080` block for `/api/*` + `/gateway/*` | This plan §3.2 |
| `deploy/.env.example` | Merged env var list | This plan §3.3 |
| `.github/workflows/ci.yml` | Add `studio-test` + `server-test` jobs | This plan §5.1 |
| `.github/workflows/deploy.yml` | **NEW** — self-host deploy for all three images | This plan §5.2 |
| `rayu-web/.vercel/project.json` | Unchanged (existing `rayu-web` project) | — |

---

## Appendix B — Plan relationships

```
rust-merge.md                         (Rust port — authoritative for rayu-server internals)
   │
   │  references
   ▼
combined-backend-plan.md  ◀────────── (this plan — the integration glue)
   │  references
   ▼
integrate-bolt-diy-into-rayu-web.md  (bolt.diy port — authoritative for rayu-studio internals)
```

**Reading order for an implementer:**
1. Read this plan first for the overall architecture + integration contracts.
2. Read `rust-merge.md` for the Rust porting details (Phases 0–3).
3. Read `integrate-bolt-diy-into-rayu-web.md` for the studio UI porting details (Steps 1–7).
4. Cross-reference §9 (execution order) of this plan to sequence the work.