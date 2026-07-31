# Plan: Combined Backend — rayu-server (Rust) + rayu-studio (bolt.diy) integration

**Status:** Draft
**Purpose:** This is the *integration* layer that connects the two existing plans:
- `rust-merge.md` — merge rayu-backend (NestJS) + rayu-gateway (Go) into one Rust service (`rayu-server/`).
- `integrate-bolt-diy-into-rayu-web.md` — copy bolt.diy source into `rayu-studio/` and deploy to `studio.rayucode.com`.

This plan describes **only** the glue between them: the shared HTTP contract, the deploy/Caddy changes, the env union, and the cross-cutting verification that proves the two plans fit together. It does **not** re-specify Rust porting details (those live in `rust-merge.md`) or bolt UI porting details (those live in the bolt integration plan).

---

## 1. What the combined system looks like

```
                                 rayucode.com  (rayu-web, Vercel)
                                       │  NextAuth Google OAuth
                                       │  /api/auth/session-cookie (NEW, mint .rayucode.com cookie)
                                       │
                                       ▼
                               studio.rayucode.com  (rayu-studio, Vercel)
                                       │  COOP/COEP origin-wide (WebContainer)
                                       │  reads rayu_session cookie (.rayucode.com)
                                       │  calls rayu-gateway /v1/* (default, billed)
                                       │  or user's provider directly (BYO-key fallback)
                                       │
            ┌──────────────────────────┼────────────────────────────────────────────┐
            │                          │                                            │
   Caddy ── /api/* ───────────────────┼──▶ rayu-server (Rust, actix) :8080        │
   Caddy ── /gateway/* ───────────────┼──▶ rayu-server :8080  (prefix stripped)   │
   CLI ── /v1/chat/completions ─────────┼──▶ rayu-server :8080  (gateway routes)   │
   CLI ── /v1/credits ──────────────────┼──▶ rayu-server :8080                     │
   CLI ── /usage, /login ───────────────┼──▶ rayu-server :8080  (/api/* + /v1/*)   │
            │                          │                                            │
            ▼                          ▼                                            │
      web:3000 (Next.js)        mysql:3306 + redis:6379                            │
                                  (rayu-server owns migrations)                   │
                                        │                                           │
                                        └───────────────────────────────────────────┘
                                        shared RAYU_JWT_SECRET + RAYU_PROVIDER_SECRET
```

**One Rust binary** (`rayu-server`) serves:
- `/api/*` — the full backend surface (auth, users, plans, payments, promo, providers, models, settings, telegram, admin, health).
- `/v1/*` + `/anthropic/*` + `/v1/proxy` — the full gateway surface (hosted LLM streaming, BYO-key proxy, credits, provider health/test).
- `/healthz` — public liveness.

Caddy routes `/api/*` (prefix kept) and `/gateway/*` (prefix stripped) to the same `:8080`. The CLI talks to `/v1/*` and `/api/*` directly (via the gateway URL env or `/api`).

rayu-web and rayu-studio both call `/api/*` and `/gateway/*` through Caddy. rayu-studio's WebContainer runs in-browser; its LLM calls go to `/gateway/*` (billed) or direct provider (BYO-key).

---

## 2. The shared HTTP contract (what must NOT change)

These are the external surfaces that rayu-web, rayu-studio, the CLI, Caddy, Telegram, Google, Bakong/ABA, and upstream providers all depend on. The Rust port must preserve them **byte-for-byte**. They are enumerated in `rust-merge.md` §1 (hard contracts 1–10) and §1D/§2. The integration-specific additions are:

### 2.1 New route on rayu-web (cookie bridge)
- `POST /api/auth/session-cookie` — validates the NextAuth session, mints/refreshes the Rayu access JWT, sets HttpOnly cookie `rayu_session=<access_jwt>` on `.rayucode.com` (Secure, SameSite=Lax, Path=/, 15-min TTL). On sign-out, same endpoint with empty value + `Max-Age=0` clears it.
- This route lives on **rayu-web** (Vercel), not rayu-server, because it needs the NextAuth session context.
- **Verify:** After sign-in on rayu-web, visiting `studio.rayucode.com` shows the authenticated studio UI without re-login.

### 2.2 rayu-studio → rayu-server call surface
rayu-studio calls the **same** endpoints as rayu-web/CLI, just from a different origin:

| rayu-studio need | rayu-server route | auth |
|---|---|---|
| "Am I logged in?" | `GET /api/me` | `rayu_session` cookie (Bearer) |
| "What models can I use?" | `GET /api/me/entitlements` | Bearer |
| "Show my credit balance" | `GET /v1/credits` | Bearer |
| "Chat with a hosted model" | `POST /gateway/v1/chat/completions` | Bearer (billed via gateway) |
| "Chat with my own key" | `POST /gateway/v1/proxy` | `X-Rayu-Token` header (BYO-key) |
| "List hosted models" | `GET /gateway/v1/models` | Bearer |
| "My usage history" | `GET /api/me/credit-history` | Bearer |
| "My payments" | `GET /api/payments/mine` | Bearer |

**Key detail:** The studio's gateway calls go to `NEXT_PUBLIC_RAYU_GATEWAY_URL` which, in production, is `https://rayucode.com/gateway` (Caddy strips `/gateway` → `:8080/v1`). In local dev, it's `http://localhost:8080`. The studio does **not** need to know it's talking to the same process as `/api/*` — the Caddy prefix-strip makes it transparent.

### 2.3 Env var union (single `server` container)
rayu-server receives the **full union** of backend + gateway env vars (per `rust-merge.md` §0.2). The studio-specific additions to the deploy env:
- `NEXT_PUBLIC_STUDIO_URL=https://studio.rayucode.com` (passed to rayu-web for the nav link + OAuth redirect allowlist).
- `NEXT_PUBLIC_RAYU_API_URL=https://rayucode.com/api` (passed to rayu-studio).
- `NEXT_PUBLIC_RAYU_GATEWAY_URL=https://rayucode.com/gateway` (passed to rayu-studio).

All three Vercel projects (rayu-web, rayu-studio, and the self-host Caddy) must agree on these public URLs.

---

## 3. Deploy changes (docker-compose + Caddy)

### 3.1 `deploy/docker-compose.yml`
- Remove `backend` and `gateway` services.
- Add one `server` service:
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
      # FULL union of backend + gateway env vars (see §0.2 of rust-merge.md)
      DATABASE_URL: mysql://...
      REDIS_URL: redis://redis:6379
      RAYU_JWT_SECRET: ${RAYU_JWT_SECRET}
      RAYU_PROVIDER_SECRET: ${RAYU_PROVIDER_SECRET}
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      BAKONG_MERCHANT_ID: ...
      # ... all other vars
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:8080/healthz']
      interval: 15s
      timeout: 5s
      retries: 10
    networks:
      - rayu
  ```
- Keep `mysql`, `redis`, `web`, `caddy` unchanged except as noted below.
- `web` now points `NEXT_PUBLIC_RAYU_API_URL` and `NEXT_PUBLIC_RAYU_GATEWAY_URL` at the Caddy-routed URLs (`${PUBLIC_SITE_URL}/api` and `${PUBLIC_SITE_URL}/gateway`), which now both terminate at `server:8080`.

### 3.2 `deploy/Caddyfile`
Replace the two `handle` blocks for `backend` and `gateway` with a single block pointing at `server`:
```caddy
  # rayu-server (Rust) — single binary serving /api/* and /gateway/*
  handle_path /gateway/* {
    reverse_proxy server:8080 {
      header_up X-Rayu-Edge-Id {http.request.uuid}
      flush_interval -1   # disable buffering for SSE streaming
    }
  }

  handle /api/* {
    reverse_proxy server:8080
  }
```
- `/gateway/*` → `handle_path` (strips prefix) → `server:8080/v1/...`.
- `/api/*` → `handle` (keeps prefix) → `server:8080/api/...`.
- Everything else (`/*`) → `web:3000` (unchanged).
- `server` depends on `web` in the `caddy` service's `depends_on` list (replace `backend` + `gateway` with `server`).

### 3.3 `deploy/.env.example`
Merge the env var lists from `rayu-backend/.env.example`, `rayu-gateway/.env.example`, and the new studio vars. Remove the old `backend`/`gateway`-specific sections. Document that `RAYU_JWT_SECRET` and `RAYU_PROVIDER_SECRET` must be identical (they're now both consumed by one process, so this is automatic).

### 3.4 Migrations
- `rayu-server` runs `sqlx migrate run` at boot (guarded — only if `DATABASE_URL` is set).
- The baseline migration `0001_baseline.sql` is generated from the current Prisma-produced schema (per `rust-merge.md` §0.10).
- Remove the `npx prisma migrate deploy` step from any deploy scripts/CI.
- Keep `rayu-backend/prisma/schema.prisma` in the repo for reference but freeze it.

---

## 4. Vercel deploy (rayu-web + rayu-studio)

Both Vercel projects point at the **same** `rayu-server` (via `PUBLIC_SITE_URL`). The difference is only the subdomain + COEP headers:

| Project | Domain | COOP/COEP | Env |
|---|---|---|---|
| rayu-web | `rayucode.com` | No (OAuth/KHQR need normal origin) | `NEXT_PUBLIC_RAYU_API_URL=https://rayucode.com/api`, `NEXT_PUBLIC_RAYU_GATEWAY_URL=https://rayucode.com/gateway` |
| rayu-studio | `studio.rayucode.com` | Yes (`same-origin` + `credentialless`) | Same public URLs; reads `.rayucode.com` cookie |

Vercel auto-previews every branch + auto-deploys `main` for both projects (already configured for rayu-web; set up identically for rayu-studio per the bolt integration plan §6).

**Cookie bridge note:** The `rayu_session` cookie is set on `.rayucode.com`, so it's readable by both `rayucode.com` (rayu-web) and `studio.rayucode.com` (rayu-studio). The cookie-minting route (`POST /api/auth/session-cookie`) lives on rayu-web because it needs the NextAuth session. rayu-studio reads it server-side in middleware.

---

## 5. CI changes (`.github/workflows`)

### 5.1 `ci.yml` — add `studio-test` + `server-test` jobs
```yaml
  studio-test:
    name: Studio Tests
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: '20', cache: 'pnpm' }
    - uses: pnpm/action-setup@v4
      with: { version: '9' }
    - working-directory: ./rayu-studio
      run: pnpm install --frozen-lockfile
    - working-directory: ./rayu-studio
      run: pnpm typecheck
    - working-directory: ./rayu-studio
      run: pnpm lint
    - working-directory: ./rayu-studio
      run: pnpm build

  server-test:
    name: Server Tests (Rust)
    runs-on: ubuntu-latest
    services:
      mysql:
        image: mysql:8.0
        env: { MYSQL_ROOT_PASSWORD: test, MYSQL_DATABASE: rayu_test }
        ports: ['3306:3306']
        options: --health-cmd="mysqladmin ping" --health-interval=10s --health-timeout=5s --health-retries=3
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
    steps:
    - uses: actions/checkout@v4
    - uses: dtolnay/rust-toolchain@stable
    - working-directory: ./rayu-server
      run: cargo test --all-features
```

### 5.2 `deploy.yml` (new) — self-host deploy
On push to `main` after CI green:
1. Build + push `rayu-server` Docker image.
2. Build + push `rayu-studio` Docker image (same node:20-alpine standalone pattern).
3. SSH into VPS: `cd /opt/rayu && docker compose pull && docker compose up -d --build`.
4. Keep old `backend` + `gateway` images tagged for rollback (do **not** delete until parity confirmed).

---

## 6. Cross-cutting verification (the integration tests)

These tests prove rayu-server + rayu-studio + rayu-web + Caddy + CLI all work together. They run **after** Phase 3 cutover in `rust-merge.md` + after Step 6 in the bolt plan.

| # | Test | How |
|---|---|---|
| 1 | rayu-studio can authenticate | Sign in on rayu-web → cookie set → visit studio → UI shows authenticated |
| 2 | Studio chat debits credits | Send a message via studio → gateway reserves/settles → `/dashboard` shows credit deduction |
| 3 | Studio BYO-key fallback works | Paste a provider key in studio settings → message goes direct, no credit charge |
| 4 | CLI + web + studio share auth | Same Rayu JWT works for CLI `/usage`, web `/dashboard`, and studio chat |
| 5 | WebContainer boots under COEP | `window.crossOriginIsolated === true`, `WebContainer.boot()` resolves, preview iframe loads |
| 6 | Caddy routing correct | `curl https://rayucode.com/api/health` → 200; `curl https://rayucode.com/gateway/healthz` → 200; `curl https://rayucode.com/gateway/v1/credits` (no auth) → 401 |
| 7 | Provider key decryption interop | Existing encrypted keys in MySQL (written by NestJS/Go) decrypt correctly in Rust |
| 8 | Streaming parity | Same Anthropic/OpenAI/Bedrock request through CLI and studio produces identical token counts + credit charges |
| 9 | Payments work | Create a KHQR/ABA payment → poll status → `activatePaid` → subscription created → credits appear |
| 10 | Self-host deploy | `docker compose up -d --build` brings up `server` + `web` + `caddy`; all healthchecks pass |
| 11 | Rollback works | If parity fails, `docker compose up -d --build backend gateway` + revert Caddy → old services back up |
| 12 | Cookie is HttpOnly | `document.cookie` in browser console on both origins does NOT expose `rayu_session` |
| 13 | BYO-key path doesn't bill | Send BYO-key message → no credit deduction in `/dashboard`; no provider key in gateway logs |
| 14 | SSRF protection works | `curl -X POST https://rayucode.com/gateway/v1/proxy -H "X-Rayu-Upstream-URL: http://169.254.169.254"` → 403 |
| 15 | No secret leakage | `rayu-studio` Vercel project env contains only `NEXT_PUBLIC_*`; no `RAYU_JWT_SECRET`/`NEXTAUTH_SECRET` |

---

## 7. What this plan does NOT cover (belongs to other plans)

- **Rust porting details** — every line of NestJS → Rust and Go → Rust code. That's `rust-merge.md` Phases 0–3.
- **bolt.diy UI porting** — Remix → Next, UnoCSS, React 19 upgrade, component copy. That's `integrate-bolt-diy-into-rayu-web.md` Steps 1–2.
- **rayu-web changes** — everything except the one new `/api/auth/session-cookie` route + nav link (covered here).

---

## 8. Execution order (combined)

1. **Phase 0 (rust-merge)** — foundations + secretbox interop test. Proves the hardest contract first.
2. **Phase 1A–1B (rust-merge)** — config snapshot + credits/limiter. The billing core that studio depends on.
3. **Phase 1C–1D (rust-merge)** — adapters + hosted routes. Validate against CLI.
4. **Phase 2A (rust-merge)** — auth. Unblocks web + CLI login.
5. **bolt plan Step 1–2** — scaffold rayu-studio from bolt source, React 19 upgrade.
6. **bolt plan Step 3** — LLM proxy (gateway default + BYO fallback). Now studio can talk to rayu-server.
7. **bolt plan Step 4** — auth bridge (rayu-web cookie route + studio middleware). Now studio can authenticate.
8. **bolt plan Step 5** — COEP headers on studio origin.
9. **Phase 2B–2F (rust-merge)** — payments, promo, providers, models, settings, telegram, admin.
10. **Phase 3 (rust-merge)** — deploy (docker-compose + Caddy changes from §3 above) + parity testing.
11. **bolt plan Step 6–7** — CI + deploy for studio + nav link.
12. **§6 verification** — run all 11 cross-cutting tests.

**Critical dependency:** bolt plan Step 3 (LLM proxy) depends on rust-merge Phase 1D (gateway routes). So Phase 1D must land before studio can make billed chat calls. The studio can be scaffolded + auth-bridged earlier (Steps 1–2, 4) and validated with a stub gateway, but the real billing integration needs 1D done.

---

---

## 9. Security analysis

### 9.1 Threat model (new surfaces introduced by this integration)

| Asset | New threat | Mitigation |
|---|---|---|
| `rayu_session` cookie (cross-subdomain auth bridge) | Cookie theft via XSS on either subdomain → account takeover on both | HttpOnly + Secure + SameSite=Lax; 15-min access-token TTL (not refresh); studio has no login flow so its JS never handles the refresh token |
| rayu-studio's WebContainer sandbox | Malicious user code runs in-browser Node.js → exfiltrate `rayu_session` cookie or call gateway with stolen JWT | WebContainer runs under `credentialless` COEP; the cookie is HttpOnly so browser JS (including the sandbox) cannot read it; gateway calls from the browser always carry the cookie automatically, but the JWT has a 15-min TTL and is scoped to the user's plan entitlements |
| rayu-studio BYO-key path (`/v1/proxy`) | User pastes a provider key → studio forwards it to the provider → key leaks to rayu infrastructure logs | Gateway strips all `X-Rayu-*` headers before the provider hop; `proxy.Forward` only forwards the user's `Authorization`/`x-api-key` to the upstream, never to rayu logs; `RAYU_PROXY_BODY_READ_TIMEOUT` limits request body exposure |
| SSRF via `X-Rayu-Upstream-URL` | User sets upstream URL to internal host → scan internal network | `validateUpstreamURL` rejects localhost, private/loopback/link-local IPs, and any hostname whose DNS A/AAAA resolves to a private IP (per `rust-merge.md` §1D `handleProxy`) |
| Provider API key storage | Keys entered in rayu-web admin dashboard → encrypted with AES-GCM → stored in MySQL → decrypted by rayu-server | `secretbox` uses `sha256(RAYU_PROVIDER_SECRET)[..32]`; keys are write-only (never returned by any endpoint); `maskedKey` only; decryption is in-memory only, never logged; interop unit-tested against existing ciphertext |
| WebContainer license | `@webcontainer/api` is commercial — unlicensed use in production is a legal/compliance risk | Step 0 hard gate: confirm StackBlitz license before prod deploy; studio UI scaffolding can proceed but WebContainer boot is gated |

### 9.2 Cookie bridge security (§2.1)
- The `rayu_session` cookie is **access-only** (15-min TTL), never the refresh token. The refresh token stays in rayu-web's `localStorage` (same as today).
- Cookie attributes: `Domain=.rayucode.com; Path=/; Secure; HttpOnly; SameSite=Lax`.
- On sign-out: rayu-web calls `POST /api/auth/session-cookie` with an empty body → server returns `Set-Cookie: rayu_session=; Max-Age=0` → cookie deleted on both origins.
- **Attack:** If an XSS on `studio.rayucode.com` steals the cookie — it can't, it's HttpOnly. If an XSS on `rayucode.com` steals it — it can't, HttpOnly. The cookie is only transmitted automatically on same-site requests; a cross-site fetch won't include it (SameSite=Lax).
- **Verify:** `document.cookie` in browser console on both origins does NOT expose `rayu_session`.

### 9.3 WebContainer isolation
- WebContainer's `coep: 'credentialless'` + COOP `same-origin` on the studio origin means the sandbox iframe runs in a **cross-origin-isolated** context that cannot access the parent's DOM or cookies directly.
- The sandbox can make `fetch()` calls to the gateway (cookie sent automatically), but the JWT has a 15-min TTL and is plan-scoped — a compromised sandbox session can only burn the user's current credits until the token expires.
- **Verify:** In browser console on studio: `window.crossOriginIsolated === true`; `document.querySelector('iframe[src*="webcontainer"]')` has no `contentWindow` access from parent.

### 9.4 BYO-key path (no credit billing)
- When a user pastes their own provider API key in studio settings, the studio sends it directly to the provider via `X-Rayu-Token` auth on `/v1/proxy`.
- The gateway **never** logs or stores the user's provider key. It only sees the `X-Rayu-Upstream-URL` + `Authorization` header forwarded to the upstream.
- The gateway writes a `UsageEvent` (not a `CreditLedger` entry) for BYO-key calls — no credit charge.
- **Verify:** Send a BYO-key message → check rayu-web `/dashboard` → no credit deduction; check gateway logs → no provider key in logs.

### 9.5 Secrets management
- `RAYU_JWT_SECRET` and `RAYU_PROVIDER_SECRET` are passed to the single `server` container (no inter-service copy risk — they're both in one process now).
- Vercel project env vars for rayu-web + rayu-studio are separate; `NEXTAUTH_SECRET` lives only on rayu-web; `RAYU_JWT_SECRET` lives only on rayu-server.
- **Verify:** `rayu-studio` Vercel project env does NOT contain `RAYU_JWT_SECRET` or `NEXTAUTH_SECRET` (it only has `NEXT_PUBLIC_*` vars).

### 9.6 Caddy edge security
- Caddy terminates TLS; `X-Rayu-Edge-Id` is injected per request for correlation.
- `handle_path /gateway/*` strips the prefix before forwarding — the studio's `/v1/*` routes are never exposed at `/api/v1/*` by accident.
- `handle /api/*` keeps the prefix — the studio's `/api/*` calls (e.g. `/api/me`) route correctly.
- **Verify:** `curl https://rayucode.com/gateway/v1/credits` → 401 (not 404); `curl https://rayucode.com/api/v1/credits` → 404 (prefix not stripped, route doesn't exist at `/api/v1`).

### 9.7 Supply chain
- bolt.diy is MIT-licensed — copying source is legal with attribution (preserved in `LICENSE` file copied to `rayu-studio/`).
- `@webcontainer/api` is a separate commercial license — confirmed in Step 0.
- All new dependencies (Rust crates, npm packages) are pinned in `Cargo.lock` / `package-lock.json` and reviewed in CI.
- **Verify:** `rayu-studio/LICENSE` contains the MIT attribution; `rayu-server/Cargo.lock` is committed; CI runs `cargo audit` (add to `server-test` job).

### 9.8 CI security
- `deploy.yml` SSH deploy uses a GitHub secret (`VPS_SSH_KEY`) — never inline credentials.
- Docker images are built with `--pull` to avoid stale base layers.
- Rollback keeps old images tagged — no force-rebuild that could drop security patches.
- **Verify:** No secrets in commit history; `docker compose config` validates env var names before deploy.

---

## 10. Risks specific to the integration

| Risk | Mitigation |
|---|---|
| rayu-studio's COEP breaks its own OAuth (if studio ever needs login) | Studio has **no** login flow — it trusts the `.rayucode.com` cookie from rayu-web. COEP only affects the studio origin. |
| Cookie bridge fails (SameSite/Cross-Site) | Cookie is SameSite=Lax, first-party across `.rayucode.com` subdomains. Test in incognito across both origins. |
| Caddy prefix-strip mismatch | `handle_path /gateway/*` strips → `server:8080/v1/*`; `handle /api/*` keeps → `server:8080/api/*`. Test with `curl -v` before cutover. |
| Studio calls `/v1/credits` but the route is under `/gateway` in Caddy | `NEXT_PUBLIC_RAYU_GATEWAY_URL=https://rayucode.com/gateway` → studio calls `.../gateway/v1/credits` → Caddy strips → `server:8080/v1/credits`. The studio never sees the prefix. |
| Self-host deploy image mismatch (Rust + Next) | Build both images in one deploy job; tag both with the same git SHA; `docker compose pull` pulls both atomically. |
| Rollback leaves stale cookies | Cookie TTL is 15 min; on rollback, old rayu-web (NestJS) still sets the same cookie format, so no migration needed. |

---

## 10. Open questions

1. **Vercel project for rayu-studio** — create `rayu-studio` project linked to the repo with root dir `rayu-studio/`, or use a single `rayu-web` project with a different output? (Single project is simpler but the COEP headers would need to be conditional — Vercel doesn't support per-route headers on a single Next app cleanly. **Recommendation:** separate project.)
2. **Rust Dockerfile** — does the team have a Rust multi-stage Dockerfile pattern, or should `rayu-server/Dockerfile` be written from scratch? (Will write a standard `FROM rust:slim AS builder` → `FROM debian:bookworm-slim` pattern.)
3. **Local dev** — should `rayu-server` run alongside the existing `rayu-backend` + `rayu-gateway` in `deploy/docker-compose.yml` during the parity phase, or replace them immediately? (**Recommendation:** replace immediately in a `deploy-staging.yml` override, keep `deploy/docker-compose.yml` for prod cutover.)
4. **WebContainer license** — still pending confirmation from Step 0 of the bolt plan. The studio UI scaffolding can proceed, but WebContainer boot will fail in preview without it.
5. **Security review sign-off** — the §9 security analysis items (12–15 in the verification table) must pass before production deploy.

---

## 11. Security review checklist (pre-deploy)

- [ ] §9.1 threat model reviewed with the team
- [ ] §9.2 cookie bridge: HttpOnly/Secure/SameSite=Lax verified; refresh token never leaves rayu-web
- [ ] §9.3 WebContainer COEP/COOP isolation verified (`crossOriginIsolated === true`)
- [ ] §9.4 BYO-key path: no provider keys in gateway logs; only UsageEvents written
- [ ] §9.5 `RAYU_JWT_SECRET`/`RAYU_PROVIDER_SECRET` passed only to `server` container; rayu-studio Vercel env has no server secrets
- [ ] §9.6 Caddy prefix routing verified (`curl -v` tests)
- [ ] §9.7 `cargo audit` + npm audit pass in CI
- [ ] §9.8 `deploy.yml` uses GitHub secrets only; no inline credentials

---

## Appendix — file change map (integration-only)

| File | Change | Plan |
|---|---|---|
| `rayu-web/app/api/auth/session-cookie/route.ts` | **NEW** — mint/clear `.rayucode.com` cookie | This plan §2.1 |
| `rayu-web/lib/useRayuToken.ts` | Modified — call session-cookie route on mint/logout | This plan §2.1, bolt plan Step 4a |
| `rayu-web/app/components/NavAuth.tsx` | Add "Studio" link to `studio.rayucode.com` | bolt plan Step 7 |
| `rayu-studio/` | **NEW** — entire app (scaffolded from bolt.diy) | bolt plan Steps 1–2 |
| `rayu-studio/middleware.ts` | **NEW** — validate `rayu_session` cookie | bolt plan Step 4b |
| `rayu-studio/lib/auth/getStudioSession.ts` | **NEW** — server-side cookie validation | bolt plan Step 4b |
| `rayu-studio/lib/llm/gatewayClient.ts` | **NEW** — stream to rayu-gateway | bolt plan Step 3a |
| `rayu-studio/lib/llm/byoKeyClient.ts` | **NEW** — bolt's original direct-provider flow | bolt plan Step 3a |
| `rayu-studio/app/api/chat/route.ts` | **NEW** — Next route handler for LLM calls | bolt plan Step 3b |
| `rayu-studio/app/api/models/route.ts` | **NEW** — model list for picker | bolt plan Step 3b |
| `rayu-studio/next.config.mjs` | **NEW** — COOP/COEP headers + standalone | bolt plan Steps 1c, 5 |
| `rayu-server/` | **NEW** — Rust workspace (per rust-merge.md §1) | rust-merge.md |
| `deploy/docker-compose.yml` | Remove `backend`+`gateway`, add `server` | This plan §3.1 |
| `deploy/Caddyfile` | Single `server:8080` block for `/api/*` + `/gateway/*` | This plan §3.2 |
| `deploy/.env.example` | Merged env var list | This plan §3.3 |
| `.github/workflows/ci.yml` | Add `studio-test` + `server-test` jobs | This plan §5.1 |
| `.github/workflows/deploy.yml` | **NEW** — self-host deploy for both images | This plan §5.2 |
| `rayu-web/.vercel/project.json` | Unchanged (existing `rayu-web` project) | — |
| `rayu-studio/.vercel/project.json` | **NEW** — link `rayu-studio` Vercel project | bolt plan Step 6 |