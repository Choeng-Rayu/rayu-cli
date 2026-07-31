# Plan: Merge rayu-backend (NestJS) + rayu-gateway (Go) into one Rust service

> **Scope note:** This is a complete porting spec. It preserves **every route, every edge case, every business rule** from both services. The *only* thing dropped is the inter-service connection paths (backend↔gateway no longer communicate over HTTP — they're in one process). Everything the CLI, web, Caddy, Telegram, Google, Bakong/ABA, and upstream AI providers see externally stays byte-for-byte identical.

## Decision summary (locked)

- **Rollout:** Big-bang single binary.
- **Payments:** Port both Bakong KHQR and ABA MTProto userbot to Rust natively. No Node sidecar.
- **Stack:** actix-web + sqlx (MySQL, compile-time-checked raw SQL, camelCase columns) + moka (lock-free caches) + redis-rs (Lua limiter + configbus pub/sub) + jsonwebtoken + aes-gcm + scrypt + reqwest (streaming upstream) + tokio.
- **Migrations:** Rust owns migrations. `0001_baseline.sql` snapshots the current Prisma-produced schema (camelCase intact). Freeze Prisma.
- **HTTP surface:** one process, one port (:8080). Mounts `/api/*` scope AND gateway routes (unprefixed). Caddy routes `/api/*` and `/gateway/*` (stripped) both to it.

## Target architecture

```
                        ┌─────────────────────────────────────┐
   Caddy ── /api/* ───▶ │  rayu-server (Rust, actix-web)       │
          ── /gateway/*▶│  :8080 single port                  │
                        │  ┌─────────────┐  ┌──────────────┐  │
                        │  │ api router  │  │ gw router    │  │
                        │  │ (/api/*)    │  │ (/v1/*,      │  │
                        │  │             │  │  /anthropic) │  │
                        │  └──────┬──────┘  └──────┬───────┘  │
                        │  ┌──────▼────────────────▼───────┐  │
                        │  │ shared domain core            │  │
                        │  │  auth/JWT(HS256) secretbox    │  │
                        │  │  sqlx pool moka caches redis  │  │
                        │  │  credits eventqueue           │  │
                        │  └──────────────────────────────┘  │
                        └─────────────────────────────────────┘
```

Repo layout (new crate at repo root):
```
rayu-server/
  Cargo.toml                # workspace
  crates/
    core/       # config, db(sqlx), redis, jwt, secretbox, errors, sse, cache, password, httpx
    gateway/    # config snapshot, entitlements, credits, limiter, eventqueue,
                # providers, proxy, circuitbreaker, adapters, routes, providertest, diagnose
    api/        # auth, users, plans, usage, payments, promo, providers, models,
                # settings, telegram, feedback, admin, health, routes
    server/     # main.rs wires routers, boots workers, runs migrations
    migrations/# 0001_baseline.sql + future
  .env.example
```

## Hard contracts preserved byte-for-byte

1. **HS256 JWT**, claims `{ sub: <NUMBER>, role, type: "access"|"refresh" }`, secret `RAYU_JWT_SECRET`. `sub` MUST serialize as a JSON number (Go reads `float64→int64`). Reject non-HMAC algs; require `type=="access"` for authed routes.
2. **AES-GCM `v1:` envelope** for `provider_api_keys.encryptedKey`: key = `sha256(RAYU_PROVIDER_SECRET)[..32]`, envelope = `"v1:" + base64(iv(12) ‖ tag(16) ‖ ciphertext)`. Must decrypt existing rows.
3. **MySQL schema** — camelCase columns (`currentPeriodEnd`, `upstreamModelId`, `cooldownUntil`, `creditMultiplier`, `allowedPlanCodes`, `encryptedKey`, `creditMultiplier`, `outputCreditMultiplier`, `cacheReadCreditMultiplier`, `cacheWriteCreditMultiplier`, `baselineCreditsPer1M`, etc.). Singleton `app_settings` id=1.
4. **Plan `limits` JSON**: `creditsPerPeriod`, `maxDailyTurns`, `topUpEnabled`, `creditsPerDollar`, `minTopupCents`, feature entitlements.
5. **Redis Lua scripts** (reserveScript, settleScript, turn reserve, turn hold) **verbatim**. Key scheme: `cwperiod:<uid>`, `cwperiodid:<uid>`, `conc:<uid>`, `req5h:<uid>`, `topup:<uid>`, `turns:<uid>:<YYYYMMDD>`, `turnhold:<uid>:<logicalID>`, configbus channel `rayu:config-changed`.
6. **Error envelopes**: OpenAI-style `{"error":{"message","type"}}` for generic + proxy; Anthropic-style `{"type":"error","error":{"type","message","rayu_code"}}` on hosted path. `errType`: 401→`authentication_error`, 403→`permission_error`, 429→`rate_limit_exceeded`, 400→`invalid_request_error`, default→`api_error`. `provider_unavailable` type. Capability codes `model_no_image_support`, `model_no_thinking_support`.
7. **`X-Rayu-*` headers**: `Request-Id`, `Logical-Request-Id`, `Query-Source`, `Intended-Model`, `Resolved-Model`, `Upstream-URL`, `Provider`, `Proxied: 1`, `Proxy-Error`, `Limit: daily_turn_limit`, `Model-Fidelity: mismatch`, `Edge-Id`, credit headers (`x-rayu-credits-used`, `x-rayu-credits-remaining`/`"unlimited"`, `x-rayu-topup-balance`).
8. **Two entitlement shapes**: `/api/me/entitlements` (CLI feature gating + dashboard) and `/v1/credits` (billing source of truth for CLI `/usage` + dashboard).
9. **Idempotency**: `activatePaid` conditional `UPDATE … WHERE status='pending'`; `finalizeRedemption` read-then-write in-transaction (preserve the theoretical oversell-by-1 window OR tighten to conditional UPDATE — decision: preserve exactly).
10. **scrypt** `salt:hash` hex password format.

---

## Phase 0 — Scaffolding & foundations

### 0.1 Workspace
Create `rayu-server/` Cargo workspace with the crate layout. Pin stable toolchain.

### 0.2 `crates/core/config`
Env loader for the **full union** of env vars (see appendix A). Defaults match existing. Fatal on missing `RAYU_JWT_SECRET` (gateway behavior — production-safe). All env vars:

**Backend:** `PORT`, `NODE_ENV`(ignored), `WEB_ORIGIN`, `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `RAYU_JWT_SECRET`, `RAYU_ACCESS_TTL`(3600), `RAYU_REFRESH_TTL`(2592000), `RAYU_PROVIDER_SECRET`, `BAKONG_MERCHANT_ID`, `BAKONG_PHONE_NUMBER`, `BAKONG_DEVELOPER_TOKEN`, `BAKONG_API_URL`(api-bakong.nbc.gov.kh/v1), `ABA_STATIC_QR`, `ABA_TELEGRAM_GROUP_ID`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, `RAYU_SHARED_BOT_TOKEN`, `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`, `SKIP_TELEGRAM_POLL`, `LOCAL_ADMIN_PASSWORD`, `SEED_CATALOG`, `SKIP_PLAN_SEED`, `ALLOW_INSECURE_PROVIDER_BASE_URL`.

**Gateway:** `PORT`(8080), `RAYU_JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`(redis://localhost:6379), `RAYU_PROVIDER_SECRET`, `ALLOW_INSECURE_PROVIDER_BASE_URL`, `CONFIG_REFRESH_SECONDS`(30), `USER_CACHE_TTL_SECONDS`(10), `RAYU_CONFIG_CHANNEL`(rayu:config-changed), `RAYU_MAX_INFLIGHT`(0=unlimited), `RAYU_ENFORCE_MODEL_FIDELITY`(off), `RAYU_PROXY_BODY_READ_TIMEOUT`(0), `GATEWAY_CORS_ORIGINS`(*).

### 0.3 `crates/core/db`
sqlx MySQL pool, **64 open / 16 idle / 3-min lifetime / 90s idle** (mirror `store.go:109-117`). Accept Prisma-style `mysql://user:pass@host:port/db?...` URL.

### 0.4 `crates/core/redis`
redis-rs async pool + pub/sub for configbus.

### 0.5 `crates/core/jwt`
`jsonwebtoken` — issue (access + refresh, mirror `mintTokens` claims/TTLs) + verify (pin HS256, reject non-HMAC, require `type=="access"`, read `sub` as number, `role` as string). Refresh is **not rotate-on-use**; requires `user.status === "active"`.

### 0.6 `crates/core/secretbox`
`aes-gcm` — `v1:` envelope, `sha256(secret)[..32]` key. **Unit test against known ciphertext** from Go/NestJS first — proves interop before anything else. Use `Zeroizing<Vec<u8>>` for decrypted key bytes (zeroize on drop). Boot refusal if keys exist and decryption fails (mirror `main.go:264-276`).

### 0.7 `crates/core/sse`
SSE writer flushing per event (1 MiB line cap), emitter helpers: `message_start` → `content_block_start` → `content_block_delta*` → `content_block_stop` → `message_delta` → `message_stop`. Per-event size cap to prevent upstream-driven OOM.

### 0.8 `crates/core/httpx`
Both error envelopes + `errType` mapping + `provider_unavailable` + capability error helpers. **Never leak upstream bodies or stack traces in 5xx.** Generic `"provider_unavailable"` messages only.

### 0.9 `crates/core/password`
`scrypt` matching `salt:hash` hex storage. Never log plaintext or hashes.

### 0.10 `crates/core/crypto`
`subtle::ConstantTimeEq` for webhook secret comparison (upgrade from source's bytewise loop). `rand::rngs::OsRng` (CSPRNG) for all tokens, codes, request IDs, pairing codes, ABA md5 sentinel UUIDs. `zeroize` for any secret material in memory.

### 0.10 `crates/migrations/0001_baseline.sql`
Dump current production schema via `mysqldump --no-data` against a dev DB seeded by all 20 Prisma migrations. Verify camelCase columns. Add `0002_seed_plans.sql` (mirror `plans.constants.ts`: free/basic/pro/ultra/max/enterprise). Future schema changes = sqlx migrations.

### 0.11 `crates/server/main.rs`
config → pools → migrations → caches → routers → workers (eventqueue, telegram poller, ABA listener, config refresh) → graceful shutdown draining eventqueue. **Boot-time security checks:** refuse to start if `RAYU_JWT_SECRET` missing or is a known dev/test fallback in prod; refuse if `provider_api_keys` has rows but `RAYU_PROVIDER_SECRET` missing/wrong; refuse if webhook configured but `TELEGRAM_WEBHOOK_SECRET` unset in prod; `ensureLocalAdmin` from `LOCAL_ADMIN_PASSWORD` (no silent default in prod).

**Verify Phase 0:** `cargo build`; boot against seeded MySQL+Redis; `GET /healthz` + `GET /api/health` → 200; secretbox interop test passes; `cargo audit` clean; no secret value appears in logs.

---

## Phase 1 — Gateway domain (Go → Rust)

### 1A. Config snapshot + caches
- `gateway/config::Snapshot`: load `hosted_models` JOIN `providers`, `provider_api_keys` (decrypt once), `app_settings`, `plans`. Mirror `entitlements.go:205-266` `reload`. Wrap in `ArcSwap<Snapshot>` + `moka` for lock-free reads under SSE concurrency.
- `gateway/configbus`: subscribe Redis `rayu:config-changed`; on message → reload. Publish on `POST /v1/_reload`.
- Config refresh loop: every `CONFIG_REFRESH_SECONDS` (30s) reload as safety net.
- `gateway/entitlements`: per-user `Resolve` — `UserStatus` + `ActivePlan` (30-day `currentPeriodEnd` expiry → Free fallback) + `TopupBalance`. Single-flight per user, 3s deadline, `moka` TTL `USER_CACHE_TTL_SECONDS` (10s). `Invalidate(user)`. `AllowedModels` = enabled models whose `allowedPlanCodes` includes the plan code (from the live snapshot, **not** the cached user entry). `Keys()` returns the registry. `Route(providerID)` from the in-memory registry.

### 1B. Credits + limiter
- `gateway/credits`: port `credits.go` exactly:
  - `TokensPerCredit(baseline)` = `round(1_000_000 / baseline)`, baseline ≤ 0 → 1,000,000.
  - `ModelRatesFor(input, output, cacheRead, cacheWrite)`: non-positive output/cacheWrite → input; cacheRead < 0 → `CacheHitBillingWeight = 0.10`.
  - `EstimateTokens(req, defaultMaxTokens=2048)`: `len()` (bytes) of string content + text parts / 4 + `max_tokens` (float64) else 2048, floor 1.
  - `EstimateBillableTokens(est, inputMult)` = `round(est * inputMult)`, floor 1.
  - `BillableTokens(usage, rates)`: clamp negatives; if any cache bucket > 0 → `miss*Input + hit*CacheRead + write*CacheWrite + completion*Output`; else if prompt|completion > 0 → `prompt*Input + completion*Output`; else `total*Input`; `round`, ≤ 0 → 0.
  - `ForTokens`/`ForUsage` coarse paths for display.
- `gateway/limiter`: port the four Lua scripts **verbatim** into `redis-rs` `evalsha`:
  - **reserveScript** (`limiter.go:69-116`): on `cwperiodid:<uid>` change → zero `cwperiod`; deny `conc` if `conc >= maxc`; deny `req5h` if `req5h >= maxr`; charge `cwperiod` via INCRBY when `cap<0 || used+est<=cap` (source=`plan`), else decrement `topup` when enabled and sufficient (source=`topup`), else deny `period_limit`; always INCR `conc` (TTL 10 min) + `req5h` (TTL 5h).
  - **settleScript** (`limiter.go:121-130`): source `plan` → `INCRBY cwperiod (actual-est)`; source `topup` → `INCRBY topup (est-actual)`; `DECR conc` floored at 0.
  - **turn reserve / turn hold** (`limiter.go:235-390`): `SETNX turnhold:<uid>:<logicalID>` → reuse existing (`reused=1`, no double count); else deny-without-hold if over cap (`DEL` hold), else INCR `turns:<uid>:<YYYYMMDD>` with midnight-UTC TTL.
  - `keysFor`: `cwperiod`, `cwperiodid`, `conc` (TTL 10 min self-heal), `req5h` (TTL 5h), `topup` (SetNX TTL 5 min via `EnsureTopup`), `turns:<uid>:<YYYYMMDD>`, `turnhold:<uid>:<logicalID>`.
  - `periodTTLSeconds(periodEnd)`: seconds until period end, floor 60, 0 if nil.
  - `Reserve`, `Settle`, `ReserveTurn`, `ReleaseTurn`, `EnsureTopup`, `ReserveTurnFor`/`ReleaseTurnFor` (idempotent by logical ID).
- `gateway/eventqueue`: bounded (4096) tokio mpsc, 4 worker tasks, retry exp backoff max 5. Drains on shutdown. Writes: `InsertLedger`, `InsertUsageEvent`, `UpdateProviderKeyState`.

### 1C. Providers + adapters
- `gateway/providerkeys::Registry`: per-key state machine (active/cooling/invalid/disabled). `Pick` = enabled keys whose live status is active or cooldown elapsed (restore), priority order; invalid/disabled/still-cooling excluded. `MarkRateLimited` (429/402 → cooldown default 60s, cap 10min). `MarkInvalid` (401/403 → permanent out-of-rotation). `MarkUsed` (success → clear health). Persist via eventqueue.
- `gateway/circuitbreaker`: per-host, 5 consecutive failures → open, 15s cooldown. States closed/open/halfOpen (halfOpen admits exactly one trial). In-memory only. `Allow`/`Success`/`Failure`/`Do`.
- `gateway/proxy`: shared `reqwest` client (no total timeout, 30s response-header timeout, MaxIdleConns 100/Host 20, 90s idle, 10s TLS). `SendWithFailover` (iterate keys in priority order, rotate on 429/402/401/403, call `onKeyFailure` for every failing key including the last). `doWithRetry` (Breakers.Allow first; 2 retries on 502/503/504 only — **never 429**; backoff 250ms→500ms→1s capped 2s; honor integer `Retry-After`; transport error → Breakers.Failure + no retry; exhausted-still-5xx → Breakers.Failure; success/non-retryable-4xx → Breakers.Success).
- **Adapters** (port each `init()`-registered translate impl):
  - `anthropicPassthrough` — byte-verbatim SSE relay + sniff usage from `message_start` (input buckets) / `message_delta` (cumulative output, latest wins); `probeNonStreamError` re-issue with `stream=false` to recover real error. `newAnthropicReq`: POST, `Content-Type: application/json`, auth per `bearer` (Authorization: Bearer) vs `x-api-key`, `anthropic-version: 2023-06-01`, `Accept: text/event-stream`.
  - `openAIChat` — Anthropic↔OpenAI `/v1/chat/completions` translation: system, messages, roles, content blocks (text/image/tool_use/tool_result/thinking), tool calls, stop reasons, `finish_reason` mapping; `stream_options.include_usage`; mid-stream error → `error` SSE event + usage-so-far.
  - `openAIResponses` — OpenAI Responses API translation.
  - `genAI` — Google `v1beta/models/{model}:streamGenerateContent`; Gemini 3 `thoughtSignature` relay.
  - `bedrockAnthropic` — Bedrock URL-path model id, `anthropic_version: bedrock-2023-05-31`, AWS event-stream frames (port `eventstream.go` decoder).
  - `thinking` — strip `thinking`/`redacted_thinking` from completed turns (model-switch safety).
  - Usage normalization: `CacheReadTokens()` = `PromptCacheHitTokens` || `PromptTokensDetails.CachedTokens` || 0. `FreshInputTokens()` = `PromptCacheMissTokens` || (`PromptTokens - CacheReadTokens`) || 0 || `PromptTokens`. ReasoningTokens is a subset of CompletionTokens (observability only).
  - `IsUpstreamRequestError`: 400/413/422. `UpstreamErrorMessage`: `error.message` || top-level `message`, 300-char cap, fallback `"The request was rejected by the model provider."`.
- `gateway/capabilities`: `requestHasImage` (walks messages[].content recursively incl. tool_result.content for `{"type":"image"}`); `requestWantsThinking` (`thinking` object; `type=="disabled"` → false; `"enabled"` → true; any other/absent with object → true). `MaxTokensPerRequest` guard.

### 1D. Hosted routes
**`reserveHosted`** (exact ordered preamble, `server.go:444-717`):
1. `hostedIdentity`: `reqID = X-Rayu-Request-Id` || `"gw_" + 12 crypto-random bytes hex`; `source = X-Rayu-Query-Source` || `"unknown"`; `intended = X-Rayu-Intended-Model`.
2. `ent.Resolve`; on DeadlineExceeded/Canceled → 503 `"gateway busy, please retry"` + `Retry-After: 1`; else 500.
3. `ent.Active()` (`status == "active"`) else 403 `"account is " + statusOrUnknown`.
4. Body read cap 8 MiB; `*MaxBytesError` → 413 `"too large"`; timeout → 408 `"timeout"` + `Retry-After: 1`; else 400 `"unreadable"` (all via OpenAI-style `WriteError`).
5. JSON decode fail → 400 `"invalid JSON body"`.
6. Model lookup in `ent.AllowedModels`; not found → 403 `"model not available on your plan: " + modelCode`.
7. `ent.Route(providerID)`; no route → 503 `"model temporarily unavailable: " + code`.
8. Route err → 503 same. (Invalid rows refused, never repaired.)
9. `!route.Enabled` → 503 same.
10. `translate.For(format)` unknown → 503 same.
11. `max_tokens` > `settings.MaxTokensPerRequest` → 400 `"max_tokens exceeds the per-request limit"`.
12. Capability gates (Anthropic-style + `rayu_code`, HTTP 400): `!SupportsImage && requestHasImage` → `model_no_image_support`; `!SupportsReasoning && requestWantsThinking` → `model_no_thinking_support`.
13. `Keys().Pick(providerID)`; empty snapshot → 500 `"provider key not configured"`; all unusable → 503 + `Retry-After: 60`.
14. Daily turn cap (`dailyTurnCap(MaxDailyTurns)`: nil/≤0 → 0=unlimited); `ReserveTurn`; error → 500 `"rate limiter unavailable"`; `!OK` → `Retry-After` if reset>0 + 429 JSON `{"error":{"message":"daily turn limit reached","type":"rate_limit_exceeded"},"reason":"daily_turn_limit","resetSeconds":N}`.
15. Credit pre-flight: `tpc = TokensPerCredit(baseline)`, `rates = ModelRatesFor(...)`, `capBillable = CreditsPerPeriod * tpc` (-1 if unlimited), `estBillable = EstimateBillableTokens(EstimateTokens(req, 2048), inputMult)`, `topUpAvailable = TopUpEnabled && TopupBalance>0`, `EnsureTopup` if so, `Reserve(...)`. Error → `releaseTurnBG` + 500. `!OK` → `releaseTurnBG` + `Retry-After` + 429 JSON `{"error":{"message":"credit limit reached: "+reason,"type":"rate_limit_exceeded"},"reason":rr.Reason,"resetSeconds":reset}` (`reason ∈ {concurrency, requests, period_limit}`).
16. `creditSource = rr.Source` (`"plan"|"topup"`).
17. Build `settle` closure (idempotent, 5s detached bg ctx): `actual = actualBillable(usage, rates)`; `Settle(bg, uid, source, est, actual)`; `ent.Invalidate(uid)`; log; `recordLedger` (cacheReadFraction = rates.CacheRead/rates.Input; billableInputTokens = Fresh + CacheRead*frac; cost = billableInput/1e6*InputPrice + completion/1e6*OutputPrice; realCostCents = round(cost); enqueue `InsertLedger(uid, code, promptTokens, completionTokens, creditsConsumed, realCostCents, source)`).

**`handleAnthropicMessages`** (`server.go:747-820`): `stream` from req; **model substitution** `req["model"] = hm.UpstreamModelID`; build `translate.Request{Route, Keys, UpstreamModelID, Anthropic: req, Stream, OnKeyFailure}`. `OnKeyFailure` → `MarkRateLimited` (429/402) or `MarkInvalid` (401/403). Streaming: `setCreditHeaders` first, `adapter.Stream`, `settle(usage)`, log; `serr && !wrote` → `writeUpstreamError`. Non-streaming: `adapter.Complete`; `cerr` → `settle(nil)` (refund) + `writeUpstreamError`; log non-200; `settle(usage)`; `setCreditHeaders(used - est + actual, ...)`; status 400/413/422 → `WriteAnthropicError(status, UpstreamErrorMessage(body))`; else → `WriteProviderUnavailable(502)`; else 200 + raw body. `writeUpstreamError`: `circuitbreaker.ErrOpen` → 503 + `Retry-After: 5`; else 502. Never leaks upstream body. `setCreditHeaders`: `x-rayu-credits-used = used/tpc`; `x-rayu-credits-remaining = cap<0 ? "unlimited" : max(0,(cap-used)/tpc)`; `x-rayu-topup-balance`.

**`handleProxy`** (BYO-key, `server.go:888-1085`):
1. `X-Rayu-Token` auth (HS256, `type=="access"`) — missing → 401 `"missing X-Rayu-Token"`; invalid → 401 `"invalid X-Rayu-Token"`.
2. `X-Rayu-Upstream-URL` required (400 if missing). `validateUpstreamURL`: https only, host required, not private (reject localhost, private/link-local/loopback/unspecified IPs, and any hostname whose DNS A/AAAA contains a private IP). Failure → 403.
3. Identity headers (Request-Id, Logical-Request-Id).
4. Daily turn cap **best-effort, fail-open**: `ent.Resolve` + `ReserveTurnFor(uid, cap, logicalID)`; limiter error → fail open; `!OK` → `Retry-After` + `X-Rayu-Limit: daily_turn_limit` (NOT `X-Rayu-Proxy-Error` — CLI surfaces, not fails-safe) + 429 JSON.
5. Body read deadline (`RAYU_PROXY_BODY_READ_TIMEOUT`, read-only): timeout → 408 + `Retry-After: 1`; MaxBytes → 413; else 400. Refund turn if reserved.
6. Attribution: `provider = X-Rayu-Provider` || `"unknown"`; `source = X-Rayu-Query-Source` || `"unknown"`; `intended`; `actual` = `modelFromUpstreamURL` (Bedrock regex `/model/([^/]+)/invoke(?:-with-response-stream)?(?:$|\?|#)`) || `bestEffortModel(body)` (`body.model`) || `X-Rayu-Resolved-Model`.
7. Model fidelity: `familyMismatch(intended, actual)` (both non-empty, both classify via `opus/sonnet/haiku` else `other`, families differ) → always logged; if `RAYU_ENFORCE_MODEL_FIDELITY` → refund turn + `X-Rayu-Model-Fidelity: mismatch` + 409 `"model fidelity mismatch..."`.
8. `X-Rayu-Proxied: 1` before forward.
9. `proxy.Forward`: copy headers (drop `X-Rayu-*`, Host, Content-Length, hop-by-hop; keep user's `Authorization`/`x-api-key`), 32 KiB buffer flush. Returns `(status, wrote, err)`.
10. Pre-flight fail (`err && !wrote`): refund turn; `Del X-Rayu-Proxied`; `ErrOpen` → 503 + `Retry-After: 5` `"upstream temporarily unavailable"`; else 502 `"upstream unreachable"`.
11. Mid-stream break (`err && wrote`): refund turn (so retry doesn't burn cap).
12. Upstream non-200: refund turn (CLI will retry).
13. **UsageEvent write (NOT ledger)** via eventqueue: `InsertUsageEvent(uid, provider, actual, "gateway")`.
14. `proxyError(w, status, msg)`: `X-Rayu-Proxy-Error: msg` + OpenAI-style `WriteError`.

**Other gateway routes:**
- `POST /anthropic/v1/messages/count_tokens` (free metadata).
- `GET /v1/models` (OpenAI list shape).
- `GET /v1/credits` (`RayuCreditStatus` exact field set: `plan, planName, priceCents, creditsPerPeriod, usedCredits, remainingCredits, tokensPerCredit, allowanceTokens, usedTokens, remainingTokens, resetSeconds, periodEnd, topupBalance, topUpEnabled, creditsPerDollar, minTopupCents, maxDailyTurns, turnsUsedToday, turnsRemaining, turnsResetSeconds`).
- `GET /v1/_whoami`, `GET /v1/_entitlements`.
- `POST /v1/chat/completions` → 410 Gone (retired).
- `GET /v1/_provider-health` (admin role gate: `claims.role ∈ {admin, superadmin}` else 403 `"admin only"`).
- `POST /v1/_provider-test` (admin; 1-token real ping `max_tokens:1` content `"ping"`; classification `ok|bad_api_key|unknown_model|bad_base_url|format_mismatch|rate_limited|upstream_error`; per-stage checks `reachable/keyAccepted/modelAccepted`; Levenshtein-near model suggestion; canonical path suggestion; redact secrets; 20/min/admin rate limit; **never condemn on unproven 401/403**; passing test calls `MarkUsed` to rehabilitate).
- `POST /v1/_reload` (admin; reload snapshot + publish configbus; 60/min/admin).
- Inflight limiter `RAYU_MAX_INFLIGHT` around `POST /anthropic/v1/messages`: saturated → `Retry-After: 5` + `WriteProviderUnavailable(503)`.
- CORS: mirror Origin if in `CorsOrigins` (default `*`), methods `GET, POST, OPTIONS`, max-age 600; OPTIONS → 204.
- `GET /healthz` public.

**`gateway/diagnose`** (port `providerdiagnose.go`): `canonicalPaths` (per-format known-good endpoint paths), `authHint`, `looksLikeHTML`, `detectResponseFormat` (sniff which wire format a 200 body actually is), `looksLikeAnthropicMessage` (must reject OpenAI/Responses/GenAI bodies that merely contain a `usage` object), `formatLabel`, `suggestEndpointPath`.

**Verify Phase 1:** `cargo test gateway::` — adapter round-trips, provider-test classification, diagnose shape checks, Lua scripts vs real Redis, Bedrock event-stream framing property tests. Port `provideronboard_test.go` + `providerdiagnose_test.go` as Rust integration tests (`wiremock` crate for fake upstreams). Manually drive the CLI against the Rust gateway (Anthropic streaming, OpenAI providers, Bedrock) and confirm `/v1/credits` matches. **Security:** `/v1/proxy` rejects http://localhost/private IPs; `alg=none` JWT rejected; `type != "access"` rejected; `status != "active"` user 403; body > 8 MiB → 413; `RAYU_MAX_INFLIGHT` saturated → 503 + `Retry-After: 5`; no upstream body in 5xx; `X-Rayu-Proxy-Error` set on gateway-origin errors; `X-Rayu-Limit: daily_turn_limit` (not `X-Rayu-Proxy-Error`) on turn cap; admin routes reject `user`-role JWT with 403.

---

## Phase 2 — API domain (NestJS → Rust)

### 2A. Auth
- `POST /api/auth/oauth/google` + `POST /api/auth/web/session` — verify Google ID token via `https://oauth2.googleapis.com/tokeninfo?id_token=...` (reqwest); check `aud == GOOGLE_CLIENT_ID` + `exp`; OAuth upsert + account linking.
- `POST /api/auth/register` + `POST /api/auth/login` — scrypt `salt:hash` hex.
- `POST /api/cli/exchange` (verify Google ID + CSRF `state` → one-time code), `POST /api/cli/token` (redeem code), `POST /api/cli/refresh`. One-time code store: in-memory `DashMap` 5-min TTL + sweep (mirror `CodeStoreService`); flag for Redis later.
- `POST /api/admin-login` (local admin, role gate). `ensureLocalAdmin` at boot from `LOCAL_ADMIN_PASSWORD` (`admin@rayucode.com`).
- `GET /api/me`, `GET /api/me/entitlements` (full shape: plan, credit config, allowed + hosted model catalog, topup balance), `GET /api/me/credit-history`.
- Auth middleware: Bearer → verify → load live user from MySQL → reject `status !== "active"` → attach. Roles guard (`user|admin|superadmin`).

### 2B. Plans / Users / Usage
- `GET /api/plans` (public catalog). `PlanLimits` JSON parsing. Non-destructive seed/backfill (mirror `plans.service.ts:78-126`).
- Users: OAuth upsert + account linking; `getActiveSubscription` (expired `currentPeriodEnd` → Free); `getTopupBalance = SUM(paid topups) − SUM(ledger source='topup')`; credit history; list/search/setStatus.
- Usage: `POST /api/usage` (record + touch `lastActiveAt`), `GET /api/usage/summary` (by-provider), `GET /api/usage/features` (per-tool since UTC month start — drives image/video monthly caps).

### 2C. Payments (Cambodia KHQR — the risky part)

**Constants:** `KHQR_TTL_MINUTES=30`, `KHQR_TTL_MS=30*60*1000`, `ABA_MATCH_GRACE_MS=10*60*1000`. `PaymentMethod = "aba"|"bakong"`. Currency always `"USD"`. Period always 30 days. `method` defaults `"aba"`; renew maps any non-bakong → `"aba"`.

**Helpers:**
- `isCreditPlan(plan)` = `limits.creditsPerPeriod` is a number > 0 (else false; feature-unlock plan).
- `isAba(payment)` = `provider === "aba" || md5?.startsWith("ABA-")`.
- `isExpired(payment)` = `expiresAt != null && expiresAt <= now`.

**`computeCarryoverCredits(userId, previousSub)`** (`payments.service.ts:58-82`): `!prev` → 0; `currentPeriodEnd <= now` → 0; `allowance = plan.limits.creditsPerPeriod` if number else 0; `used = SUM(credit_ledger.credits WHERE userId AND source='plan' AND createdAt >= prevSub.startedAt)`; `max(0, allowance - used)`. Window = whole sub life. Sign: ledger stores consumption positive.

**`switchSubscriptionWithCarryover(userId, planId, periodEnd)`** (`:90-127`): find most-recent active sub; `carryover = computeCarryoverCredits`; transaction: `UPDATE subscriptions SET status='canceled' WHERE userId AND status='active'` (all), `INSERT subscription (userId, planId, status='active', currentPeriodEnd)`; if `carryover > 0` → `INSERT credit_topup (userId, credits=carryover, amountCents=0, status='paid')`. Returns carryover.

**`createKhqr(userId, planCode, method="aba", promoCode?)`** (`:129-250`):
1. Load plan by code (404 `"Plan not found"`).
2. Purchasability: `availability !== "active" || priceCents <= 0` → 400 `"Plan is not purchasable"`.
3. Duplicate-purchase guard (non-credit plans only): resolve effective plan; if `current.code === plan.code` → 400 `"You're already on the {name} plan..."`. Credit plans exempt.
4. Promo quote: `validateForPurchase(promoCode, planCode, userId, priceCents)` or null.
5. `$0 bypass`: `quote?.isFree` → 400 `"This promo code makes the plan free — claim it instead of paying."`.
6. `amountCents = quote ? finalCents : priceCents`; `discountCents`; `promoCodeId`.
7. QR reuse: `findFirst WHERE userId, planId, provider=method, status='pending', amountCents, promoCodeId, expiresAt>now ORDER BY createdAt DESC`. If `khqr && md5` → return reused (no new payment, no re-recorded redemption). Intent key includes `promoCodeId` + discounted `amountCents`.
8. New: `billNumber = "RAYU-{userId}-{ms}"`; `buildQr`; `INSERT payment (userId, planId, provider, amountCents, currency='USD', status='pending', md5, khqr, promoCodeId, discountCents, expiresAt=now+30min)`.
9. Promo reservation: `recordPendingRedemption(...)` (**not atomic** with payment insert — preserve the crash window).

**`buildQr(method, amountUsd, billNumber)`** (`:445-456`): `method==="aba"` → `aba.generateAbaQR`, `md5 = "ABA-{uuid}"`, provider `"aba"`. Else `bakong.generateKhqr` → `{qr, md5}`, provider `"bakong"`.

**`aba.generateAbaQR(amountUsd, ttlMinutes=30)`** (`aba.service.ts:39-75`): require `ABA_STATIC_QR`; parse EMVCo TLV (tag/len/val); require tag `01`; mutate `01="12"` (dynamic), `54=amount.toFixed(2)`, `99="0013"+createdMs+"0113"+expiresMs`, delete `63`; re-serialize tags sorted ascending; append `6304`; CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021, per byte `crc ^= c<<8`, 8 iters, `& 0xffff`); uppercase hex padStart 4.

**`bakong.generateKhqr(amountUsd, billNumber, ttlMs=30min)`** (`bakong.service.ts:16-39`): build `IndividualInfo(merchantId, "Rayu", "Phnom Penh", {currency: usd, amount, mobileNumber, billNumber, storeLabel: "Rayu Plan", expirationTimestamp: now+ttl})`; return `{qr, md5}` or 500 `"Failed to generate KHQR"`.

**`bakong.checkPaidByMd5(md5)`** (`:41-57`): `POST {apiUrl}/check_transaction_by_md5` Bearer `BAKONG_DEVELOPER_TOKEN` body `{md5}`; `!res.ok` → `{paid:false}`; paid iff `responseCode===0 && data`; `ref = data.externalRef ?? data.hash`.

**`aba.parseAbaNotification(text)`** (`:77-86`): regex `/\$?([\d.]+)\s+paid by .+?\(\*(\d{3})\).+?Trx\.\s*ID:\s*(\d+)/i` → `{amount, phoneSuffix, trxId}` or null.

**`previewPromo`** (`:258-282`): plan load + purchasability + `validateForPurchase`; return quote shape (no payment/redemption).

**`claimFreePromo`** (`:291-351`, $0 bypass): plan + purchasability + quote; `!quote.isFree` → 400; `periodEnd = now+30d`; `INSERT payment (provider='promo', amountCents=0, status='paid', promoCodeId, discountCents, paidAt, externalRef="PROMO-{code}")` (no md5/khqr/expiresAt); `recordPendingRedemption`; `switchSubscriptionWithCarryover`; `finalizeRedemption`. **Four separate DB ops — preserve the crash windows** (paid-without-sub, subscribed-without-finalized-promo).

**`createTopupKhqr(userId, credits, method="aba")`** (`:361-436`):
1. `creditsPerDollar = settings.creditsPerDollar`; `<=0` → 400 `"Top-up is not available"`.
2. `amountCents = ceil((credits / creditsPerDollar) * 100)`.
3. `minCents = max(1, settings.minTopupCents)` (default 100).
4. `amountCents < minCents` → 400 with `minCredits = ceil((minCents/100) * creditsPerDollar)`.
5. Topup QR reuse: `findFirst creditTopup WHERE userId, credits, status='pending'`; if `existingTopup.paymentId` → `findFirst payment WHERE id, provider=method, status='pending', expiresAt>now`. If `reusable.khqr && md5` → return reused. (Reuse does NOT re-derive amountCents — preserves old price on rate change.)
6. New: `billNumber="RAYU-TOPUP-{userId}-{ms}"`; `buildQr`; `INSERT payment`; `INSERT creditTopup (userId, credits, amountCents, status='pending', paymentId)`. (Not shared transaction — preserve orphan-window.)

**`checkStatus(paymentId)`** (`:458-498`): findUnique + 404 + 403; non-pending → return state (no poll, no expiry transition); if `!isAba` → `bakong.checkPaidByMd5`; if paid → `activatePaid` (**poll before expiry check — just-in-time payments activate past deadline**); if `isExpired` → `expirePayment`; else return pending.

**`expirePayment`** (`:509-531`): transaction `payment.status='expired'` + `creditTopup.updateMany pending→expired`; after tx (non-atomic) `cancelPendingRedemption` if promoCodeId.

**`confirmAbaPaymentByAmount(amountUsd, ref)`** (`:540-558`): `amountCents = round(amountUsd*100)`; `findFirst WHERE provider='aba', status='pending', amountCents, expiresAt >= now-10min ORDER BY createdAt DESC`; no match → false; match → `activatePaid(payment, ref)` → true. (Grace = 30-min TTL + 10-min alert post. Status must still be pending. Ties = newest.)

**`activatePaid(payment, ref)`** (`:571-653`, idempotent):
- **Topup path** (creditTopup exists): one tx `payment.updateMany WHERE id,status='pending' → status='paid', paidAt, externalRef=ref` + `creditTopup.updateMany WHERE id,status='pending' → status='paid'`. `count==0` (concurrent loser) → return already-paid shape. Winner returns same.
- **Plan path** (no topup): `!planId||!plan` → 400; `periodEnd = now+30d`; tx `payment.updateMany WHERE id,status='pending' → paid`; `count==0` → return already-paid (no sub, no carryover); winner → `switchSubscriptionWithCarryover` (**separate tx** — crash leaves paid-without-sub) + `finalizeRedemption` if promoCodeId (**separate** — crash leaves redemption pending). Return with `carryoverCredits`.

**`cancelPayment`** (`:661-698`): 404 + 403; `paid` → 400; pending → tx `payment.status='canceled'` + `creditTopup pending→canceled` + `cancelPendingRedemption` (after tx, non-atomic); expired/canceled → no-op.

**`renewPayment`** (`:707-747`): 404 + 403; `paid` → 400; if pending → tx expire old + pending topup (**do NOT call `cancelPendingRedemption`** — leave redemption pending so user can re-apply); `method = provider==='bakong' ? 'bakong' : 'aba'`; topup → `createTopupKhqr(userId, topup.credits, method)`; plan → `createKhqr(userId, plan.code, method)` (**no promo code passed — discount lost**); neither → 400.

**`getUserPayments(userId, page, pageSize)`** (`:749-777`): `skip=(page-1)*pageSize`; `findMany WHERE userId include plan.select.code ORDER BY createdAt DESC skip take` + count. Controller: `page=parseInt||1`, `pageSize=min(parseInt||20, 100)`. Response items: `id, planCode, provider, amountCents, currency, status, externalRef, createdAt, paidAt`.

**ABA Telegram listener** (`aba-telegram.listener.ts`): start unless test or `TELEGRAM_API_ID/HASH/SESSION` unset. Use **`grammers`** crate (pure-Rust MTProto user session — Bot API can't read another bot's messages). `normalizeChatId`: strip leading `-100` (supergroup/channel) else leading `-`. `onMessage`: skip empty text; skip non-matching chatId; `parseAbaNotification`; on match → `confirmAbaPaymentByAmount`. Connection retries 5. **Fallback** if `grammers` proves insufficient: operator manual confirm via admin `activatePaid` (already supported).

**ABA QR reuse note:** reuse keeps old price on rate change. ABA sentinel `ABA-` md5 prefix. All plan activations = fixed 30 days. `renew` drops promo. `cancel`/`expire` free the promo slot non-atomically. `tgCall` 429: single retry with `retry_after*1000+200ms`; second 429 throws.

### 2D. Promo / Providers / Models / Settings

**PromoService** (`promo.service.ts`):
- `normalizeCode`: `trim().toLowerCase()`. Codes stored normalized, `@unique`.
- `parsePlans`: non-array (null/object/string) → `[]` = all plans.
- `validateShape`: type ∈ `{percent, fixed}`; `discountValue` non-negative integer; percent ≤ 100.
- Admin CRUD: create (normalize, shape, dup-error, `appliesToPlans` via `plansToJson` where null/empty → JsonNull), update (partial, code clash excludes self, re-validate merged values), remove, setActive, findAll (order id desc), findOne (404 `"Unknown promo code: {id}"`).
- `computeDiscount(code, originalCents)` (`:161-172`): `base = max(0, round(originalCents))`; percent → `floor(base*value/100)`; fixed → `value`; clamp `min(max(0, discount), base)`; `final = base - discount` (≥0).
- `validateForPurchase(code, planCode, userId, originalCents)` (`:179-235`) — load-bearing order: normalize+find (404 `"Invalid promo code"`); `!active` → `"not active"`; `startsAt > now` → `"not active yet"`; `endsAt < now` → `"has expired"`; `plans.length>0 && !plans.includes(planCode)` → `"cannot be used for the selected plan"`; `mine = findUnique(promoCodeId_userId)`; `mine.status === 'applied'` → `"already used"` (only `applied` blocks; pending/canceled allow); **first-N cap only for users with NO row**: `maxRedemptions != null && !mine && usedCount >= maxRedemptions` → `"usage limit"`; return `{promo, originalCents, discountCents, finalCents, isFree: finalCents<=0}`.
- `recordPendingRedemption` (`:240-272`): upsert on `(promoCodeId, userId)`; create sets `{planCode, paymentId??null, originalCents, discountCents, finalCents, status:'pending'}`; update sets same + **unconditionally `status:'pending'`** (safe only because call sites gate via `validateForPurchase` rejecting applied; Rust port must either replicate the unconditional write OR add an explicit guard).
- `finalizeRedemption(promoCodeId, userId, paymentId)` (`:279-306`): tx: read redemption; `!redemption || status==='applied'` → return silently; read promo; `!promo` → return; **atomic cap re-check**: `maxRedemptions != null && usedCount >= maxRedemptions` → throw `"usage limit"` (rollback); `promoCode.update usedCount++`; `promoRedemption.update status='applied'` (+ paymentId if provided). (Preserve read-then-write; theoretical oversell-by-1 under REPEATABLE READ. Port decision: preserve exactly.)
- `cancelPendingRedemption(promoCodeId, userId)` (`:309-317`): `updateMany WHERE status='pending' → status='canceled'`. Only pending; applied untouched.

**ProvidersService** (`providers.service.ts`): provider registry CRUD with **SSRF/HTTPS validation** on write (`assertSecure` → `provider-security.ts`, `ALLOW_INSECURE_PROVIDER_BASE_URL` escape hatch for http/private hosts), key encryption on write (`secretbox.seal`), dup-key rejection via `keyHash`, rotation priority ordering, key status writes from gateway. **Keys are write-only; `maskedKey` only readable.**

**ModelsService** (`models.service.ts`): hosted model catalog CRUD; **Claude model-family consistency** between `code` and `upstreamModelId` (opus/sonnet/haiku) on create/update; non-destructive seed reconciling `providerId` when seed re-points a model to a new provider.

**AppSettingsService** (`app-settings.service.ts`): singleton row get-or-create (creates with `baselineCreditsPer1M=1`), update, seed.

**AdminService** (`admin.service.ts`):
- User/plan/payment administration, bulk status.
- `analytics(days=30)` (`:481-671`): window clamp `min(90, max(7, floor(days)||30))`. Batch 1 (parallel): `countAll`, `countActiveSince(now-1d/7d/30d)`, `statusBreakdown`, `planDistribution` (joined to plans, order id asc), `revenue.totalCents/paidCount` (SUM amountCents where paid), `countCanceled`, `usageByProviderGlobal`/`usageByToolGlobal`. `paidVsFree` (free vs priceCents>0). **Monthly revenue SQL**: `SELECT DATE_FORMAT(paidAt,'%Y-%m') AS month, SUM(amountCents) AS cents, COUNT(*) FROM payments WHERE status='paid' AND paidAt IS NOT NULL AND paidAt >= (NOW()-INTERVAL 12 MONTH) GROUP BY month ORDER BY month ASC`. **Signups/day SQL**: `SELECT DATE(createdAt) AS d, COUNT(*) FROM users WHERE createdAt >= (NOW()-INTERVAL {win} DAY) GROUP BY d ORDER BY d ASC`. **Active/day SQL**: `SELECT DATE(createdAt) AS d, COUNT(DISTINCT user_id) FROM usage_events WHERE createdAt >= (NOW()-INTERVAL {win} DAY) GROUP BY d ORDER BY d ASC`. `fillDays(sparse, n, now)`: continuous last n days ending today UTC, missing → 0. Top users: `groupBy userId _count desc take 10` joined to users. Profit block: `creditLedger.aggregate(_sum credits, realCostCents)`; **MRR SQL**: `SELECT COALESCE(SUM(p.priceCents),0) AS cents FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.status='active'`. `marginCents = revenueCents - aiCostCents`. `creditsByModel` = `groupBy modelCode` sum credits/realCostCents order credits desc.
- `creditProjection()` (`:297-410`): `ratio = assumedInputRatio ?? 0.67`; `baseCredits = baselineCreditsPer1M || 1000`; `blended(m) = ratio*inputPrice + (1-ratio)*outputPrice`; `baseline` = model with `code==baselineModelCode` else lowest-blended enabled; per-model: `suggestedMultiplier = baselineBlended>0 ? max(0.1, round(b/baselineBlended, 2)) : 1`, `costPerCreditCents = baseCredits>0 && creditMultiplier>0 ? b/(baseCredits*creditMultiplier) : 0`, outputs `blendedCentsPer1M`, `currentMultiplier`, `costPerCreditCents`. Per-plan (priceCents>0 || creditsPerPeriod != null): `cpp = limits.creditsPerPeriod ?? null`; `allowed` = enabled models whose `allowedPlanCodes` includes plan code; `worst` = max `costPerCreditCents` (last max wins); `unlimited = cpp == null`; `monthlyCredits = cpp`; `worstCaseMonthlyCostCents = round(monthlyCredits*worst)`; `expectedMonthlyCostCents = round(worstCase * (assumedUsagePercent ?? 25)/100)`; `infra = infraCostCentsPerUser ?? 0`; `marginCents = priceCents - expected - infra`; `worstCaseMarginCents = priceCents - worstCase - infra`; `marginNegative = worstCaseMargin != null ? <0 : (unlimited && allowed.length>0)`.

**`PUT /api/admin/plans/:code/models`** — full atomic rewrite of a plan's allowed model set (one transaction).

### 2E. Telegram

**Constants:** `PAIRING_TTL_MS=10min`, `INBOUND_LONG_POLL_MS=25000`, `INBOUND_POLL_STEP_MS=1000`, `INBOUND_BATCH=50`, `MAX_INBOUND_FILE_BYTES=10MB`, `GRANT_TTL_MS=15min`, `MAX_GRANTS=5000`. Token from `RAYU_SHARED_BOT_TOKEN` (different from ABA bot's `TELEGRAM_BOT_TOKEN`).

**Poller vs webhook mutual exclusion** (`onModuleInit`): never start if `!configured || NODE_ENV==="test"`; `SKIP_TELEGRAM_POLL==="true" && !webhookConfigured` → log + return; `webhookConfigured` → `registerWebhook` only; else `startPoller` only. Telegram allows one consumer per token; webhook `setWebhook` displaces any poller.

**409-conflict handling** (`onPollError`): `/conflict/i` → log warning rate-limited 1/30s (`lastConflictLogAt`).

**Pairing flow:** `createPairing` — `code = randomBytes(6).hex()` (12 hex), `expiresAt = now+10min`; delete all pairings where `userId == user OR expiresAt < now` (global sweep); insert `{code, userId, expiresAt}`; deep link `https://t.me/{botUsername}?start={code}` if botUsername known.

**Update routing** (`handleUpdate`): `chatId = message.chat.id || callback_query.message.chat.id`; `text = message.text || message.caption`; `link = findUnique(chatId)`; `routeUpdate`: `parseStartCommand` → `"pair"` (works from ANY chat); `hasLink && isDisconnectCommand` (`/disconnect`/`/stop`, optional `@botname`) → `"disconnect"`; `hasLink` → `"enqueue"`; else → `"ignore"`. `disconnect` → `deleteMany(chatId)` + send `"🔌 Disconnected..."`. `enqueue && link` → `INSERT telegramInbound (userId, payload=raw update)`. `ignore` (only if text truthy) → send `"This chat is not linked..."`.

**`handlePairing`**: `code = parseStartCommand(text)` (regex `^(?:start|link)(?:@\w+)?\s+(\S+)`); `pairing = findUnique(code)`; `!pairing || isExpired` → check existing link, reply `unmatchedPairingReply(!!existing)` (`"✅ Already linked..."` if linked else `"❌ Invalid or expired..."`) — **duplicate /start after link = success**; valid: `username = message.from.username ?? message.chat.username ?? callback_query.from.username`; tx: `deleteMany(OR: userId, chatId)` (transitive rebinding) + `create(userId, chatId, username)` + `deleteMany(pairing.userId)` (consume all codes) + `deleteMany(telegramInbound userId)` (purge stale, prevent replay); send `"✅ Linked to rayu-cli..."`.

**Inbound long-poll** (`fetchInbound`): ack — if `after>0` → `deleteMany WHERE userId AND id <= after` (rows deleted on NEXT call using previously returned max id). `deadline = now+25s`. Loop: `findMany WHERE userId AND id>after ORDER BY id ASC take 50`; exit if rows.length>0 || now>=deadline; else sleep 1s. On exit: fetch link; for each row `grantFileIds(userId, collectFileIds(payload))` (grants recorded at delivery); return `{linked, updates: [{id, payload}]}`. Batched ≤50.

**Outbound relay** (`relaySend`): `configured` check; `method` must be in `{sendMessage, editMessageText, sendChatAction, answerCallbackQuery}` else 400 `"method not allowed: ..."`; link must exist else `"telegram not linked"`; `forced = {...params}`; if method in `{sendMessage, editMessageText, sendChatAction}` → `forced.chat_id = link.chatId` (**overwrites caller-supplied** — isolation); `answerCallbackQuery` NOT chat-scoped; `tgCall(token, method, forced)`; return `{ok, result}`.

**File download** (`downloadInboundFile`): three gates — `configured` else 400; `isPlausibleFileId` (`/^[A-Za-z0-9_-]{8,256}$/`) else `"invalid file_id"`; link exists else `"telegram not linked"`; `mayReadFile(userId, fileId)` = `hasFileGrant` (in-memory, `${userId}:${fileId}` → expiry ms, TTL 15min, prune + budget 5000) OR fallback scan user's up-to-50 most-recent undelivered `telegramInbound` rows' `collectFileIds`; failure → 403 `"file not available for this account"` (deliberately ambiguous). Then `tgCall('getFile')`; `filePath`; `isSafeTelegramFilePath` (len 1..256, no `..`, not starting `/`, charset `/^[A-Za-z0-9_./-]+$/`); `file_size > 10MB` → `"file too large"`; `tgDownloadFile`; any error → 400 `"could not download file"` (URL with token never surfaces); `mediaType = resolveImageMediaType(filePath, contentType)` (**extension wins**: jpg/jpeg→image/jpeg, png, webp, gif; fallback content-type before `;`, trimmed lowercase, must be in set); null → `"only image files can be sent to the CLI"`; return `{base64, mediaType, size}`.

**Webhook** (`POST /api/telegram/webhook`): public (no auth), `@HttpCode(200)`; reads `x-telegram-bot-api-secret-token`; if `webhookSecret` empty → accept all; missing header → 401; length mismatch → 401; else bytewise compare; `receiveUpdate(update)`.

**Poller internals** (`startPoller`): `offset = loadOffset()` (singleton id=1, BigInt, default 0); loop `tgGetUpdates(token, offset, 50)`; per update `offset = max(offset, update_id+1)`; each `handleUpdate` in own try/catch (log warn, never fatal); if `updates.length>0` → `saveOffset(offset)`; else sleep 1s. `tgCall` 429: single retry with `retry_after*1000+200ms`; second 429 throws. `tgGetMe` → `username ?? null`. `tgDownloadFile`: `fetch(API_BASE/file/bot{token}/{filePath}, redirect:'error', timeout 15s)`, pre-check content-length, post-check byteLength.

### 2F. Admin / Feedback / Health
- Admin routes (all JWT + `@Roles('admin','superadmin')`): `GET users`, `GET users/:id`, `GET users/:id/payments`, `PATCH users/:id/status`, `PATCH users/:id/plan`, `GET payments`, `GET stats`, `GET analytics`, `GET feedback`, `PATCH users/bulk-status`, `GET plans`, `GET credit-projection`, `PATCH plans/:code`, `PUT plans/:code/models`, `GET/POST/PATCH/DELETE providers`, `providers/:name`, `providers/:name/keys[/:id]` (write-only), `GET/POST/PATCH/DELETE models`, `models/:code`, `GET/POST/PATCH/DELETE promo-codes[/:id]`, `GET/PATCH credit-settings`.
- `POST /api/feedback`.
- `GET /api/health`.

**Verify Phase 2:** `cargo test api::` — port the NestJS jest unit tests as Rust tests (auth flows, promo discount math + all `validateForPurchase` rejection paths + cap exemption, `activatePaid` idempotency, plan carryover math, ABA amount matching, just-in-time Bakong activation, renewal, cancel/renew of paid rejected). Manually exercise the web dashboard (sign-in, billing, admin CRUD) + CLI `/login` + `/usage`. **Security:** one-time code is single-use (second redemption fails); `/api/cli/exchange` + `/api/cli/token` per-IP rate-limited; `/api/admin/*` rejects `user`-role JWT; webhook with wrong/missing secret → 401 (when configured); `isPlausibleFileId` + `isSafeTelegramFilePath` reject path-traversal file_ids; file-download 403 ambiguous (no existence leak); `maskedKey` is the only readable key form in admin responses; raw SQL uses bound params (no interpolation of `win`); scrypt hashes never logged.

---

## Phase 3 — Integration, deploy, cutover

- 3.1 Single binary single port: actix `App` mounts `/api/*` scope + gateway routes (unprefixed).
- 3.2 `deploy/docker-compose.yml`: remove `backend` + `gateway`; add one `server` service (build `../rayu-server`, port 8080). Keep `mysql`, `redis`, `web`, `caddy`.
- 3.3 Caddy: `handle_path /gateway/*` → `reverse_proxy server:8080` (prefix stripped, `flush_interval -1`); `handle /api/*` → `reverse_proxy server:8080` (prefix kept); `handle` → `web:3000`. Inject `X-Rayu-Edge-Id` + correlation headers.
- 3.4 Migrations: `server` runs `sqlx migrate run` at boot (guarded). Remove `npx prisma migrate deploy`. Keep `prisma/schema.prisma` in repo for reference, freeze it.
- 3.5 Env: pass the union of both services' env vars to `server`. Document in `rayu-server/.env.example`.
- 3.6 Parity testing: run Rust server alongside old pair on staging with same MySQL+Redis. Drive CLI + web against both; diff `/v1/credits`, `/api/me/entitlements`, streaming outputs, ledger rows. Confirm provider key decryption against existing rows.
- 3.7 Cutover: switch Caddy upstreams to `server`, decommission old containers. Keep old images tagged for rollback.
- 3.8 Observability: `tracing` crate, request correlation via `X-Rayu-Request-Id`, metrics for inflight/reserve/settle/ledger-queue-depth.

---

## Security

This rewrite is a security-sensitive consolidation: the merged service handles authentication, payment confirmation, encrypted provider keys, third-party webhooks, and is a streaming proxy to upstream AI providers. The security posture below is **preserved-from-source** (every existing control is kept) plus **strengthened-where-Rust-allows** (no new behavior introduced without explicit decision).

### S1. Threat model

| Asset | Adversary | Threat | Existing control (preserve) | Rust-strengthening |
|---|---|---|---|---|
| User accounts / JWTs | Attacker with stolen token | Replay after logout/status change | Per-request DB user load, reject `status !== "active"` | Keep; add short access TTL enforcement, reject `type !== "access"` on every authed route |
| Provider API keys (DB) | DB leak / SQL dump | Decrypt keys offline | AES-256-GCM `v1:` envelope under `RAYU_PROVIDER_SECRET` | Keep; add zeroize of decrypted keys in memory on snapshot reload + on drop |
| Provider base URLs | Malicious admin / SSRF | Proxy to internal hosts via `/v1/proxy` or provider rows | `validateUpstreamURL` (https-only, no private/loopback IPs, DNS A/AAAA private-IP check), `ALLOW_INSECURE_PROVIDER_BASE_URL` dev-only escape | Keep; add the same check at provider-row write time (admin CRUD) AND at proxy time |
| Payment confirmation | Attacker forging Bakong/ABA webhook | Activate unpaid plan | Bakong Bearer developer token; ABA via MTProto user session (not a public webhook); `activatePaid` idempotent conditional `WHERE status='pending'` | Keep; ABA MTProto session string is a secret — never log, never surface in errors |
| Telegram webhook | Attacker posting fake updates | Inject inbound messages | `x-telegram-bot-api-secret-token` byte compare; empty secret → accept all (dev only) | Keep; in prod default, refuse to boot if webhook configured but no secret |
| One-time CLI login codes | Attacker sniffing / replay | Login as victim | 5-min TTL, single-use, sweep on issue, in-memory | Keep; flag for Redis `SETNX` if multi-replica; add rate limit per-source-IP on `/api/cli/exchange` |
| Upstream stream body | Malicious provider | Inject SSE that breaks the CLI | Anthropic envelope validation, `probeNonStreamError` recovery | Keep; add SSE line-length cap (1 MiB) + per-event cap to prevent memory blowup |
| MySQL | Concurrent writers | Race condition oversells credits/promos | Conditional `updateMany WHERE status='pending'`; `finalizeRedemption` in-transaction cap re-check | Keep the exact semantics; document the known oversell-by-1 window |
| Redis | Attacker with Redis access | Forge credit reserve/settle | Redis is internal (no external port); keys namespaced per user | Keep; Redis must be on the internal docker network only (already true in deploy/) |
| Error responses | Attacker probing | Discover internals via error messages | `proxyError` redacts upstream; file-download errors hide URL-with-token; provider-test redacts secrets | Keep; never leak stack traces, SQL, or upstream bodies in 5xx responses |
| Secrets in env | Compromise / leak | `RAYU_JWT_SECRET`, `RAYU_PROVIDER_SECRET`, `BAKONG_DEVELOPER_TOKEN`, `TELEGRAM_SESSION` | Env vars only, never DB (except encrypted keys), never logged | Keep; add startup check refusing to boot with weak/missing required secrets |

### S2. Authentication & authorization

- **JWT (HS256, `RAYU_JWT_SECRET`):**
  - Pin `HS256` only; reject non-HMAC algs (`alg=none` is a classic attack — must be impossible).
  - Require `type === "access"` for every authed route; `type === "refresh"` only on `/api/cli/refresh`.
  - `sub` is a JSON **number** (Go reads `float64→int64`); never serialize as string.
  - Access TTL `RAYU_ACCESS_TTL` (3600s); refresh `RAYU_REFRESH_TTL` (30d). **Not rotate-on-use** (preserve source behavior; document).
  - **Every authed request reloads the live user from MySQL and rejects `status !== "active"`** — the JWT alone is never sufficient. Preserve exactly.
  - Roles guard: `user | admin | superadmin`. Admin routes (`/api/admin/*`, `/v1/_provider-health`, `/v1/_provider-test`, `/v1/_reload`) require `admin` or `superadmin`; check `claims.role` in-handler (mirror Go) or via guard (mirror NestJS) — pick one, apply consistently.
  - `/v1/proxy` uses `X-Rayu-Token` (not `Authorization`, which is forwarded upstream) — preserve this asymmetry.
- **scrypt** password hashing, `salt:hash` hex storage. Never store plaintext; never log hashes.
- **`ensureLocalAdmin`** at boot creates/updates `admin@rayucode.com` from `LOCAL_ADMIN_PASSWORD`. If `LOCAL_ADMIN_PASSWORD` is empty/unset in prod, refuse to create the admin (do not silently default).
- **One-time CLI codes:** in-memory `DashMap`, 5-min TTL, single-use, sweep on issue. **Add:** per-source-IP rate limit on `/api/cli/exchange` and `/api/cli/token` (the source has none — flag for addition, do not silently skip).
- **Google OAuth:** verify ID token via `https://oauth2.googleapis.com/tokeninfo?id_token=...`; check `aud == GOOGLE_CLIENT_ID` + `exp`. Server-side only; never trust client claims.

### S3. Crypto

- **AES-256-GCM envelope** (`RAYU_PROVIDER_SECRET`, min 32 chars): key = `sha256(secret)[..32]`, envelope `"v1:" + base64(iv(12) ‖ tag(16) ‖ ciphertext)`.
  - **Interop test first** (Phase 0.6): decrypt a known ciphertext from the Go/NestJS impls before any other work.
  - **Boot refusal:** if `provider_api_keys` has rows but `RAYU_PROVIDER_SECRET` is missing/wrong (decryption fails), refuse to start (mirror `main.go:264-276`). Never run with keys it can't read.
  - **Memory hygiene:** decrypted key bytes live only in the in-memory snapshot; on snapshot reload and on process exit, zeroize (use the `zeroize` crate). Avoid `String` for secrets; use `Zeroizing<Vec<u8>>`.
  - **Key rotation:** document that rotating `RAYU_PROVIDER_SECRET` makes every stored key undecryptable (no re-encryption tool in scope — flag as a future task).
- **JWT secret:** min 32 chars recommended; refuse to boot in prod with the dev/test fallbacks (`test-only-insecure-secret`, `dev-only-insecure-secret`) — the backend has fallbacks, the gateway does not; the merged service follows the **gateway's strict** behavior.
- **Constant-time comparisons:** webhook secret (Telegram) uses bytewise compare in source — **upgrade to `subtle` crate `ConstantTimeEq`** in Rust (the source's loop is "constant-time-ish"; do better). Same for any future HMAC verification.
- **Random:** all tokens (one-time codes, pairing codes, request IDs, ABA md5 sentinel UUID) use `rand::rngs::OsRng` (CSPRNG) — never a fast PRNG.

### S4. Input validation, SSRF, SQLi, body limits

- **SQL injection:** sqlx compile-time-checked queries (or runtime-checked with bound params). **Never** string-interpolate user input into SQL. The source has raw SQL in `AdminService.analytics` and `creditProjection` (monthly revenue, signups/day, active/day, MRR) — port these with bound parameters, not `$queryRawUnsafe` interpolation (the source interpolates `win` after clamping to an int; Rust will bind it as a param to eliminate even the clamped-interpolation risk).
- **SSRF (`/v1/proxy` + provider rows):** `validateUpstreamURL` — https only, host required, reject `localhost`/literal private/link-local/loopback/unspecified IPs, and any hostname whose DNS A/AAAA set contains a private IP. Apply at **two** layers: (a) provider-row write (admin CRUD) — reject bad base URLs on save, not just at request time; (b) `/v1/proxy` upstream URL. Keep `ALLOW_INSECURE_PROVIDER_BASE_URL` as a dev-only escape hatch (refuse in prod unless explicitly set).
- **Body limits:** 8 MiB request body cap (`maxRequestBytes`) on hosted endpoints; 8 MiB on `/v1/proxy`; `RAYU_PROXY_BODY_READ_TIMEOUT` for stalled reads → 408 + `Retry-After: 1`. Inflight limiter `RAYU_MAX_INFLIGHT` around `POST /anthropic/v1/messages` → 503 `provider_unavailable` + `Retry-After: 5` when saturated (DoS protection).
- **DTO validation:** mirror NestJS `class-validator` decorators (`@Min`, `@Max`, `@IsString`, etc.) via `serde` + `validator` crate (or hand-rolled guards). Notable: topup `credits` `@Min(1) @Max(100_000_000)`.
- **Telegram file_id:** `isPlausibleFileId` (`/^[A-Za-z0-9_-]{8,256}$/`) + `isSafeTelegramFilePath` (len 1..256, no `..`, not starting `/`, charset `/^[A-Za-z0-9_./-]+$/`) — path traversal defense. Preserve exactly.
- **SSE line cap:** 1 MiB per line (mirror `translate/sse.go:45`); per-event size cap to prevent a malicious upstream from OOMing the server.

### S5. Rate limiting & abuse

- **Credit limiter (Redis Lua):** per-user `cwperiod`, `conc`, `req5h`, `topup`, daily `turns`. Deny `concurrency` / `requests` / `period_limit` / `daily_turn_limit` with `Retry-After`. Preserve verbatim.
- **Admin endpoint rate limits:** provider-test 20/min/admin, reload 60/min/admin (in-process in Go). Port as in-process token buckets (single-instance assumption; flag for Redis if multi-replica).
- **`/v1/proxy` daily turn cap:** best-effort, fail-open (limiter error → no block). `!OK` → `X-Rayu-Limit: daily_turn_limit` (NOT `X-Rayu-Proxy-Error`) so the CLI surfaces, not fails-safe to a direct call. Preserve.
- **Circuit breaker:** per-upstream-host, 5 consecutive failures → open 15s, halfOpen admits one trial. Protects upstreams from a hammering client and the gateway from cascading failure. In-memory only.
- **Telegram `tgCall` 429:** single retry with `retry_after*1000+200ms`; second 429 throws. Preserve.
- **New (add):** per-source-IP rate limit on auth endpoints (`/api/auth/login`, `/api/auth/register`, `/api/cli/exchange`, `/api/cli/token`, `/api/admin-login`). The source has none — flag for addition. Start conservative (e.g., 10/min per IP) and make it configurable.

### S6. Secrets handling & logging

- **Env-only secrets:** `RAYU_JWT_SECRET`, `RAYU_PROVIDER_SECRET`, `BAKONG_DEVELOPER_TOKEN`, `BAKONG_MERCHANT_ID`, `BAKONG_PHONE_NUMBER`, `ABA_STATIC_QR`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, `RAYU_SHARED_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `LOCAL_ADMIN_PASSWORD`, `GOOGLE_CLIENT_ID`. Never in DB (except encrypted provider keys), never in responses, never in logs.
- **Structured logging (`tracing` crate):** never log raw secrets, JWTs, provider keys, ABA/Bakong tokens, Telegram session strings, or user passwords. Log only: user IDs, request IDs, model codes, statuses, credit counts, error types. Provider-test redacts secrets before logging.
- **Error responses:** `writeUpstreamError` never leaks the upstream body (502/503 `provider_unavailable` with a generic message). File-download errors return `"could not download file"` (the URL contains the bot token — must never surface). `proxyError` sets `X-Rayu-Proxy-Error` with a short message, never the upstream body.
- **`maskedKey`** is the only readable form of a provider key; `encryptedKey` is write-only. Never expose `encryptedKey` in API responses (even admin).
- **DB credentials / Redis URL:** from env, never logged. The Prisma `DATABASE_URL` may contain the password in the URL string — do not log the raw URL; log a redacted form.

### S7. Transport security

- **HTTPS:** Caddy terminates TLS (already). The Rust service listens on plain HTTP inside the docker network. `/v1/proxy` and provider calls MUST use https (enforced by SSRF check). The `ALLOW_INSECURE_PROVIDER_BASE_URL` escape hatch is dev-only.
- **Upstream TLS:** `reqwest` with default rustls/native-tls; `ResponseHeaderTimeout` 30s; no total timeout (streams live off the request context).
- **CORS:** mirror Origin if in `GATEWAY_CORS_ORIGINS` (default `*`), methods `GET, POST, OPTIONS`, max-age 600; OPTIONS → 204. Backend `WEB_ORIGIN` CORS — the merged service must apply the gateway CORS to `/v1/*` and `/anthropic/*` and the backend CORS to `/api/*` (or a single union if origins match — they do in prod).
- **HSTS / security headers:** Caddy already handles; no change. The Rust service should not add its own (avoid duplicate/conflicting headers).

### S8. Dependency security

- **`cargo audit`** in CI (run `cargo audit` on every build). Flag advisories; fail on high/critical.
- **Pin versions:** `Cargo.lock` checked in. `cargo update` only with review.
- **Minimal deps:** prefer well-maintained, widely-audited crates: `actix-web`, `sqlx`, `redis`, `jsonwebtoken`, `aes-gcm`, `scrypt`, `reqwest`, `tokio`, `tracing`, `zeroize`, `subtle`. Avoid niche/unmaintained crates. The `grammers` MTProto crate is the riskiest choice — audit its threat surface (it holds a user Telegram session).
- **No `unsafe`** in our code unless absolutely required (actix/tokio internal unsafe is acceptable; ours should be zero). Audit any `unsafe` block.

### S9. Rust-specific safety

- **No `unwrap`/`expect` in hot paths or on user data** — `?` + `Result` everywhere; panics only at boot for unrecoverable config errors. A panic in a request handler must be caught by actix's `ErrorHandlers`/`Recover` middleware and return a 500 `provider_unavailable` (never a stack trace to the client).
- **`ArcSwap<Snapshot>`** for the config snapshot — lock-free reads under SSE concurrency; avoids mutex contention and the lock-convoy risk under high streaming load.
- **`moka` cache** — bounded size, TTL-based eviction; prevents unbounded memory growth from cached entitlements. Set `max_capacity` (e.g., 100k users) and TTL.
- **Connection pool sizing:** 64/16 (mirror gateway). Under load, the pool is the bottleneck; monitor `sqlx` pool wait time. Do not raise without benchmarking.
- **Backpressure:** eventqueue bounded at 4096 — if it fills, the request must not block indefinitely; drop + log (mirror Go's bounded channel behavior). Never let the queue grow unbounded.
- **Integer overflow:** billing math uses `i64`/`f64`; clamp negatives (`BillableTokens` clamps; preserve). `creditsPerDollar` division by zero → 400 (preserve). Use `checked_*` arithmetic where the source uses `Math.max(0, ...)`.

### S10. Migration & cutover security

- **Secret continuity:** `RAYU_JWT_SECRET` and `RAYU_PROVIDER_SECRET` MUST be the same values at cutover (otherwise every existing JWT invalidates and every provider key becomes undecryptable). Verify in parity phase (Phase 3.6) before cutover.
- **Schema freeze:** the baseline migration is a snapshot of the current Prisma-produced schema. Do NOT modify the schema during the rewrite (any schema change is a post-cutover sqlx migration). This prevents the NestJS service from drifting while the Rust service is being built.
- **Rollback:** keep old `backend` + `gateway` images tagged. Caddy reverts in one config change. If the Rust service misbehaves, revert Caddy first, then debug — do not patch the Rust service live under load.
- **Parity phase (3.6) must include:** (a) decrypt every existing `provider_api_keys` row with the Rust `secretbox` — a single failure blocks cutover; (b) verify a sample of existing JWTs validate in Rust; (c) diff `/v1/credits` and `/api/me/entitlements` for a sample of users; (d) confirm a streamed completion produces an identical ledger row (model, in/out tokens, credits, realCostCents, source).
- **No new attack surface:** the merge does not expose any new endpoint, env var, or DB table. The HTTP surface is the union of the two existing surfaces. Any addition is out of scope.

### S11. Security verification checklist (run before cutover)

- [ ] `secretbox` decrypts every existing provider key row
- [ ] A sample of existing JWTs (access + refresh) validate in Rust
- [ ] `alg=none` JWT is rejected; non-HS256 is rejected; `type != "access"` on authed route is rejected; `status != "active"` user is rejected
- [ ] `/v1/proxy` rejects http://, localhost, private IPs, and a hostname resolving to a private IP
- [ ] Provider-row admin write rejects an http base URL (prod mode)
- [ ] Webhook with wrong/missing `x-telegram-bot-api-secret-token` is 401 (when secret configured)
- [ ] One-time code is single-use (second redemption fails)
- [ ] `activatePaid` is idempotent under concurrent confirmation (only one winner)
- [ ] `finalizeRedemption` rolls back on cap-exceeded
- [ ] Body > 8 MiB → 413; stalled read → 408 + `Retry-After: 1`
- [ ] `RAYU_MAX_INFLIGHT` saturated → 503 + `Retry-After: 5`
- [ ] No secret value appears in any log line or error response (grep logs for token prefixes)
- [ ] `cargo audit` clean; `cargo deny` (if configured) clean
- [ ] Decrypted provider keys are zeroized on snapshot reload (memory check)
- [ ] `/api/admin/*` rejects a `user`-role JWT with 403

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| AES-GCM envelope doesn't decrypt existing keys | Unit-test `secretbox` against prod ciphertext first; fail boot if keys exist and decryption fails (mirror `main.go:264-276`); zeroize decrypted keys in memory |
| `sub` serialized as string breaks CLI auth | Serialize `sub` as number; integration-test token issue→verify against Go impl |
| JWT `alg=none` / non-HS256 attack | Pin `HS256` only in `jsonwebtoken` verification; reject all other algs; require `type=="access"` |
| Stolen JWT replay after logout | Per-request DB user load + reject `status !== "active"` (preserve exactly); short access TTL |
| SSRF via `/v1/proxy` or provider rows | `validateUpstreamURL` at both admin-write and proxy-time; https-only; private-IP + DNS-private-IP rejection; `ALLOW_INSECURE_PROVIDER_BASE_URL` dev-only |
| Forged Bakong/ABA webhook activates unpaid plan | Bakong Bearer developer token; ABA via MTProto user session (not a public webhook); `activatePaid` idempotent conditional `WHERE status='pending'`; ABA session string never logged |
| Telegram webhook injection | `x-telegram-bot-api-secret-token` constant-time compare (`subtle`); refuse to boot if webhook configured but no secret in prod |
| SQL injection via raw admin SQL | Bound params (not `$queryRawUnsafe` interpolation of `win`); sqlx compile-time-checked queries elsewhere |
| Upstream-driven memory blowup | SSE 1 MiB line cap + per-event cap; body 8 MiB cap; `RAYU_MAX_INFLIGHT` inflight limiter |
| Error/secret leakage | Never log secrets/JWTs/tokens/session strings; `writeUpstreamError` returns generic 502/503; file-download errors hide URL-with-token; provider-test redacts secrets |
| KHQR spec mismatch (tag set, CRC) | Byte-compare generated QR with npm SDK output on a plan corpus; validate via Bakong `check_transaction_by_md5` |
| `grammers` MTProto can't read ABA bot alerts | Fallback: operator manual confirm via admin `activatePaid`; audit `grammers` threat surface (holds user Telegram session) |
| Bedrock event-stream framing edge cases | Port `eventstream.go` decoder + property tests; validate against a recorded Bedrock stream |
| Streaming throughput under load | actix worker pool + `moka` lock-free caches + `ArcSwap` snapshot; bench with `wrk`/`oha` SSE vs Go gateway; target ≥ parity |
| Prisma→sqlx migration drift | Baseline snapshot from DB seeded by all 20 Prisma migrations; diff vs prod schema before cutover |
| Single-instance in-memory state (code store, telegram file grants, poller flag) | Document as single-instance; multi-replica later → move code store + file grants to Redis `SETNX` |
| Big-bang with no fallback | Keep old `backend` + `gateway` images tagged; Caddy revert in one config change; parity phase on staging first |
| Secret discontinuity at cutover | `RAYU_JWT_SECRET` + `RAYU_PROVIDER_SECRET` MUST be unchanged — verify in parity phase (decrypt every key row, validate sample JWTs) before cutover |
| `finalizeRedemption` oversell-by-1 under concurrency | Preserve read-then-write exactly (drop-in behavior); document as known limitation |
| `recordPendingRedemption` unconditional `status:'pending'` write | Replicate the upstream `validateForPurchase` gate (rejects `applied`) OR add explicit guard in Rust |
| ABA QR reuse keeps old price on rate change | Preserve exactly (documented behavior) |
| Brute-force auth endpoints (source has no rate limit) | Add per-IP rate limit on `/api/auth/*` + `/api/cli/*` (new control, configurable) |
| Supply-chain (Rust deps) | `cargo audit` in CI; `Cargo.lock` checked in; minimal well-audited deps; `grammers` audited separately |

## Open assumptions

- Prod MySQL = schema after the 20 existing Prisma migrations (verify via `mysqldump --no-data` before baseline).
- `RAYU_JWT_SECRET` + `RAYU_PROVIDER_SECRET` unchanged at cutover.
- `grammers` crate acceptable for ABA userbot (spike in Phase 2C.7).
- Web + CLI need no code changes (HTTP surfaces preserved). Only deploy changes.

## Suggested execution order (within big-bang)

1. **Phase 0** (foundations + secretbox interop test) — proves the hardest contract first.
2. **Phase 1A–1B** (config snapshot + credits/limiter) — the billing core.
3. **Phase 1C–1D** (adapters + hosted routes) — the streaming core; validate against CLI.
4. **Phase 2A** (auth) — unblocks web + CLI login.
5. **Phase 2B–2F** slices (each fairly independent; payments + telegram are the longest).
6. **Phase 3** (deploy + parity + cutover).

## Appendix A — Full env var union

(All listed in §0.2; the merged service passes every one to the single `server` container.)

## Appendix B — Cross-cutting behaviors to preserve

1. `EstimateTokens` uses `len()` (bytes, not runes) of string content + text parts only; `max_tokens` as JSON float64.
2. Every billing amount is integer tokens with float math then `round`/`ceil` at precise points; credits display rounds to 2 dp in `handleCredits`. Never switch to fixed-point without matching each rounding site.
3. `BillableTokens` (fine-grained) is the active path; `ForUsage` (coarse ceil) is display/legacy. Reserve is in billable tokens.
4. `settle` is idempotent (runs once) + uses a detached 5s bg ctx (request ctx may be cancelling during streaming).
5. Credit-header math for non-streaming = `used - est + actual` (estimated hold replaced by settled actual).
6. Proxy path never touches credit limiter (only daily turns) and writes usage events, NOT the ledger.
7. `SendWithFailover` failover on 429/402/401/403; `doWithRetry` retries only 502/503/504 (never 429); a key returning retryable 5xx does NOT fail over (returned as-is); only transport errors + rotatable statuses fail over.
8. `StreamAnthropic` reports `wrote=true` even on pre-stream upstream errors (error was written); server doesn't double-write.
9. Model fidelity on `/v1/proxy` triggers only for known-family cross-mismatches (`opus`/`sonnet`/`haiku`); opaque ids never flag.
10. `MaxBytesReader`: oversized → 413; stalled read → 408 (+`Retry-After:1`); else 400.
11. `activatePaid` plan path = three separate transactions (payment flip → subscription switch → promo finalize). Crash windows: paid-without-sub, subscribed-without-finalized-promo. **Preserve.**
12. `claimFreePromo` = four separate DB ops. Preserve crash windows.
13. `renewPayment` drops promo (calls `createKhqr` without promoCode) and does NOT cancel the old pending redemption (leaves it pending so user can re-apply; pending doesn't block cap).
14. First-N cap only applies to users with NO redemption row (`!mine`); once a user has any row, cap is never re-checked.
15. Carryover window = `createdAt >= previousSub.startedAt` (whole sub life); only most-recent active sub; expired period → 0; ledger positive-consumption.
16. Topup QR reuse keyed `(userId, credits, pending)` then payment `(provider==method, pending, not expired)`; NOT re-derived `amountCents` (old price preserved on rate change).
17. Plan QR reuse intent key includes `promoCodeId` + discounted `amountCents`.
18. ABA confirmation matches only `status='pending'` with `expiresAt >= now-10min`, newest first; rows already `'expired'` excluded; `ABA-` md5 prefix OR `provider==='aba'` identifies ABA.
19. Bakong just-in-time payments activate even past deadline (poll precedes expiry check in `checkStatus`).
20. All plan activations = fixed 30 days; currency always USD; `method` defaults `aba`; renew maps non-bakong → `aba`.
21. Payment lifecycle: `pending → paid | expired | canceled`; expired/canceled terminal for polling/matching; paid rejects cancel/renew.
22. `cancel`/`expire` free promo slot via `cancelPendingRedemption` after their tx (non-atomic).
23. `tgCall` 429: single retry `retry_after*1000+200ms`; second 429 throws.
24. `fetchInbound` ack: rows `id <= after` deleted on NEXT call; grants at delivery; long-poll ≤25s in 1s steps; batches ≤50.
25. `relaySend` forces `chat_id` only for `{sendMessage, editMessageText, sendChatAction}`; `answerCallbackQuery` passes through untouched.
26. Webhook secret: no configured secret → accept all; length + bytewise compare otherwise.
27. Pairing: 12-hex codes, 10-min TTL, one active per user (old user codes + all expired codes swept on every pair request), transitive rebinding, duplicate /start after link = success, inbound rows purged on relink to prevent replay.
28. Poller offset persisted singleton id=1 BigInt; saved only when updates received; per-update offset advance = `max(offset, update_id+1)`; handleUpdate errors logged, never fatal.
29. `computeDiscount` percent uses `floor`; fixed clamped to `base`; `final >= 0` by construction.
30. `recordPendingRedemption` update unconditionally writes `status:'pending'` — safe only via upstream `validateForPurchase` gate (rejects `applied`). Replicate the gate OR add explicit guard.

## Appendix C — Security cross-cutting behaviors (preserve + strengthen)

1. **JWT strict verification:** HS256 only, reject non-HMAC, `type=="access"` on authed routes, `type=="refresh"` only on `/api/cli/refresh`, `sub` as JSON number. Every authed route reloads the live user and rejects `status !== "active"`. (Preserve.)
2. **AES-GCM envelope:** `v1:` + base64(iv‖tag‖ct), `sha256(secret)[..32]` key, min secret 32 chars. Boot refusal if keys exist and decryption fails. Decrypted keys zeroized in memory on reload/drop. (Preserve + strengthen with `zeroize`.)
3. **SSRF two-layer defense:** `validateUpstreamURL` at provider-row admin write AND at `/v1/proxy` time. https-only, no private/loopback IPs, DNS A/AAAA private-IP check. `ALLOW_INSECURE_PROVIDER_BASE_URL` dev-only. (Preserve + add write-time check.)
4. **SQL injection:** bound params everywhere; the source's `$queryRawUnsafe` interpolation of `win` (clamped int) becomes a bound param in Rust. sqlx compile-time-checked for the rest. (Strengthen.)
5. **Body limits + DoS:** 8 MiB body cap, `RAYU_PROXY_BODY_READ_TIMEOUT` (408 + `Retry-After: 1`), `RAYU_MAX_INFLIGHT` inflight limiter (503 + `Retry-After: 5`), SSE 1 MiB line cap + per-event cap. (Preserve + add per-event cap.)
6. **Constant-time comparison:** webhook secret uses `subtle::ConstantTimeEq` (source's bytewise loop is "constant-time-ish"). (Strengthen.)
7. **CSPRNG:** `rand::rngs::OsRng` for all tokens, one-time codes, pairing codes (12 hex), request IDs, ABA md5 sentinel UUIDs. Never a fast PRNG. (Preserve.)
8. **No secret in logs/responses:** `tracing` structured logging; never log JWTs, provider keys, ABA/Bakong tokens, Telegram session strings, passwords, scrypt hashes. Error responses (`writeUpstreamError`, file-download, provider-test) redact. (Preserve.)
9. **`maskedKey`-only:** `encryptedKey` is write-only; never in API responses (even admin). `maskedKey` is the only readable form. (Preserve.)
10. **Idempotency = anti-double-spend:** `activatePaid` conditional `WHERE status='pending'` (one winner); `finalizeRedemption` in-transaction cap re-check. (Preserve, incl. oversell-by-1 window.)
11. **Webhook auth:** Telegram `x-telegram-bot-api-secret-token` constant-time compare; empty secret → accept all (dev only); refuse to boot if webhook configured but no secret in prod. (Preserve + strengthen.)
12. **One-time codes:** in-memory, 5-min TTL, single-use, sweep on issue. **Add** per-IP rate limit on `/api/cli/exchange` + `/api/cli/token`. (Preserve + strengthen.)
13. **Path traversal defense:** `isPlausibleFileId` (`/^[A-Za-z0-9_-]{8,256}$/`) + `isSafeTelegramFilePath` (no `..`, not starting `/`, charset-restricted). (Preserve.)
14. **Ambiguous 403:** file-download `mayReadFile` failure returns `"file not available for this account"` — does not distinguish "exists but not yours" from "doesn't exist". (Preserve.)
15. **Admin role gates:** every `/api/admin/*` + `/v1/_provider-health` + `/v1/_provider-test` + `/v1/_reload` requires `admin` or `superadmin`. Check `claims.role` explicitly. (Preserve.)
16. **Rate limits:** Redis Lua credit/turn limiter (preserve verbatim); admin endpoint token buckets 20/min + 60/min in-process (preserve); **add** per-IP rate limit on auth endpoints (new). (Preserve + strengthen.)
17. **Boot refusal:** missing/weak `RAYU_JWT_SECRET` (no dev fallback in prod), keys-exist-but-no-`RAYU_PROVIDER_SECRET`, webhook-but-no-secret, no `LOCAL_ADMIN_PASSWORD` in prod. (Strengthen.)
18. **Panic safety:** no `unwrap`/`expect` on user data; actix `Recover` middleware catches handler panics → 500 `provider_unavailable` (no stack trace to client). (Rust-native.)
19. **Backpressure:** eventqueue bounded 4096; on full, drop + log (never block indefinitely). `moka` cache bounded + TTL. Pool sized 64/16. (Preserve.)
20. **Integer/overflow safety:** `checked_*` arithmetic where source uses `Math.max(0, …)`; `creditsPerDollar <= 0` → 400 (div-by-zero guard); `BillableTokens` clamps negatives. (Preserve + Rust-native.)
21. **Supply chain:** `cargo audit` in CI, `Cargo.lock` checked in, minimal well-audited deps, `grammers` audited for holding a user session. (Rust-native.)
22. **Secret continuity at cutover:** `RAYU_JWT_SECRET` + `RAYU_PROVIDER_SECRET` unchanged — parity-phase verifies (decrypt every key row, validate sample JWTs) before cutover. (New control.)