# Plan: Port rayu-gateway (Go) → Rust at `rayu-gateway-rust/`

> **Scope:** Port **only** the Go gateway (`rayu-gateway/`) to Rust. The NestJS backend (`rayu-backend/`) stays untouched — Rust reads the same MySQL + Redis. Everything the CLI, Caddy, and upstream AI providers see externally stays **byte-for-byte identical** to the Go gateway.
> **Related plan:** `.rayu/plans/rust-merge.md` merges backend + gateway into one Rust binary. This plan is a **subset**: gateway-only, backend stays NestJS. Phase 1 of rust-merge is the basis; Phase 2 (NestJS port) is **out of scope** here.
> **Output dir:** `/home/rayu/rayu-cli/rayu-gateway-rust/`
> **Focus:** speed, high concurrency for multi-user SSE streaming, long-lived requests, performance, security.

## Decision summary (locked)

- **Rollout:** Standalone Rust binary at `rayu-gateway-rust/`. Replaces the Go gateway in `deploy/` (Caddy routes `/gateway/*` → `gateway-rust:8080`). NestJS backend keeps running at `backend:4000`.
- **Stack:** **axum** (tokio-native, tower middleware, first-class SSE/streaming) + **sqlx** (MySQL, compile-time-checked raw SQL, camelCase columns preserved) + **moka** (lock-free caches) + **redis-rs** (Lua limiter + configbus pub/sub) + **jsonwebtoken** + **aes-gcm** + **reqwest** (streaming upstream) + **tokio** (multi-thread runtime, work-stealing).
- **Why axum over actix:** SSE-heavy workload with thousands of concurrent long-lived streams. axum is tower-based, has native `Sse` + `Body::from_stream`, lower per-connection overhead, and integrates cleanly with `tokio::sync` and `tower::limit` for backpressure. actix-web's actor model adds overhead for streaming. (rust-merge chose actix for the merged binary; this gateway-only plan picks axum for streaming performance.)
- **Migrations:** Rust **does not own** migrations — Prisma (NestJS backend) still owns the schema. Rust reads the existing tables read-only. No `0001_baseline.sql` snapshot needed (that was a merge-plan concern). Rust only depends on the current production schema.
- **HTTP surface:** one process, one port (:8080). Same routes as Go gateway (see §Routes). Caddy routes `/gateway/*` (stripped) → `gateway-rust:8080`.
- **No new env vars:** Rust reads the **same** gateway env vars as Go (see Appendix A). No backend env vars needed.

## Target architecture

```
                        ┌──────────────────────────────────────┐
   Caddy ── /gateway/*─▶│  rayu-gateway-rust (axum, :8080)      │
                        │                                       │
                        │  ┌──────────────────────────────────┐ │
                        │  │ HTTP router (axum)                │ │
                        │  │  /healthz, /v1/*, /anthropic/*    │ │
                        │  └────────────┬─────────────────────┘ │
                        │  ┌────────────▼─────────────────────┐ │
                        │  │ gateway domain core               │ │
                        │  │  jwt(HS256)  secretbox(aes-gcm)  │ │
                        │  │  sqlx pool   moka caches   redis  │ │
                        │  │  credits     limiter(Lua)          │ │
                        │  │  eventqueue  providers  proxy     │ │
                        │  │  circuitbreaker  adapters         │ │
                        │  └────────────┬─────────────────────┘ │
                        └───────────────┼──────────────────────┘
                                        │
                          ┌─────────────┼─────────────┐
                          ▼             ▼             ▼
                    MySQL (shared)  Redis (shared)  Upstream AI
                    (Prisma owns    (Lua scripts,    providers
                     schema)         configbus)
                                        │
                          (NestJS backend reads the same MySQL;
                           Rust never talks to backend over HTTP)
```

**Contract with backend:** Rust and NestJS share MySQL + Redis. Rust is **read-only on most tables** (`users`, `plans`, `subscriptions`, `hosted_models`, `providers`, `provider_api_keys`, `app_settings`, `credit_topups`) and **write-only** on `credit_ledger` + `usage_events` (via the eventqueue, same as Go). The backend's Prisma migrations keep owning the schema; Rust never runs migrations.

## Hard contracts preserved byte-for-byte (from Go source)

These must match the Go gateway exactly. Cited from `rayu-gateway/internal/`.

1. **HS256 JWT**, claims `{ sub: <NUMBER>, role, type: "access"|"refresh" }`, secret `RAYU_JWT_SECRET`. `sub` MUST serialize as a JSON number (Go reads `float64→int64`). Reject non-HMAC algs; require `type=="access"` for authed routes. (`internal/auth/`)
2. **AES-GCM `v1:` envelope** for `provider_api_keys.encryptedKey`: key = `sha256(RAYU_PROVIDER_SECRET)[..32]`, envelope = `"v1:" + base64(iv(12) ‖ tag(16) ‖ ciphertext)`. Must decrypt existing rows. (`internal/secretbox/`)
3. **MySQL schema** — camelCase columns (`currentPeriodEnd`, `upstreamModelId`, `cooldownUntil`, `creditMultiplier`, `allowedPlanCodes`, `encryptedKey`, `outputCreditMultiplier`, `cacheReadCreditMultiplier`, `cacheWriteCreditMultiplier`, `baselineCreditsPer1M`, etc.). Singleton `app_settings` id=1. (`internal/store/store.go`)
4. **Plan `limits` JSON**: `creditsPerPeriod`, `maxDailyTurns`, `topUpEnabled`, `creditsPerDollar`, `minTopupCents`, feature entitlements.
5. **Redis Lua scripts** (reserveScript, settleScript, turn reserve, turn hold) **verbatim** — paste, don't rewrite. Key scheme: `cwperiod:<uid>`, `cwperiodid:<uid>`, `conc:<uid>`, `req5h:<uid>`, `topup:<uid>`, `turns:<uid>:<YYYYMMDD>`, `turnhold:<uid>:<logicalID>`, configbus channel `rayu:config-changed`. (`internal/credits/limiter.go:69-390`)
6. **Error envelopes**: OpenAI-style `{"error":{"message","type"}}` for generic + proxy; Anthropic-style `{"type":"error","error":{"type","message","rayu_code"}}` on hosted path. `errType`: 401→`authentication_error`, 403→`permission_error`, 429→`rate_limit_exceeded`, 400→`invalid_request_error`, default→`api_error`. `provider_unavailable` type. Capability codes `model_no_image_support`, `model_no_thinking_support`. (`internal/httpx/`)
7. **`X-Rayu-*` headers**: `Request-Id`, `Logical-Request-Id`, `Query-Source`, `Intended-Model`, `Resolved-Model`, `Upstream-URL`, `Provider`, `Proxied: 1`, `Proxy-Error`, `Limit: daily_turn_limit`, `Model-Fidelity: mismatch`, `Edge-Id`, credit headers (`x-rayu-credits-used`, `x-rayu-credits-remaining`/`"unlimited"`, `x-rayu-topup-balance`).
8. **`/v1/credits`** shape (`RayuCreditStatus` exact field set): `plan, planName, priceCents, creditsPerPeriod, usedCredits, remainingCredits, tokensPerCredit, allowanceTokens, usedTokens, remainingTokens, resetSeconds, periodEnd, topupBalance, topUpEnabled, creditsPerDollar, minTopupCents, maxDailyTurns, turnsUsedToday, turnsRemaining, turnsResetSeconds`.
9. **Idempotency**: `recordLedger` via eventqueue (bounded serialized queue, same as Go).

## Repo layout (new crate)

```
rayu-gateway-rust/
  Cargo.toml                  # workspace
  crates/
    core/       # config, db(sqlx), redis, jwt, secretbox, errors, sse, httpx, cache
    gateway/    # config snapshot, entitlements, credits, limiter, eventqueue,
                # providers, proxy, circuitbreaker, adapters, routes, providertest, diagnose
    server/     # main.rs wires router, boots workers, graceful shutdown
  .env.example
  Dockerfile
  README.md
```

---

## Phase 0 — Scaffolding & foundations

### 0.1 Workspace (`rayu-gateway-rust/Cargo.toml`)
Cargo workspace, edition 2021. Pin `rust-toolchain.toml` to stable. Crates: `core`, `gateway`, `server`.

**Key deps:**
- `axum` 0.7+, `tower` 0.4, `tower-http` (cors, trace, limit, timeout), `hyper` 1
- `tokio` 1 (full, multi-thread, `rt-multi-thread`)
- `sqlx` 0.8 (mysql, runtime-tokio-rustls, `chrono`, `json`)
- `redis` 0.27 (aio, tokio-comp, `script`)
- `moka` 0.12 (future, dash)
- `jsonwebtoken` 9
- `aes-gcm` 0.10, `sha2` 0.10, `base64` 0.22, `hex` 0.4
- `reqwest` 0.12 (rustls, stream, json)
- `serde` 1, `serde_json` 1, `chrono` 0.4 (serde)
- `tracing` 0.1, `tracing-subscriber` (env-filter, json)
- `axum-extra` (typed headers), `futures` 0.3, `bytes` 1
- `zeroize` 1 (secret material), `subtle` 2 (constant-time compare)
- `uuid` 1 (v4 for request IDs), `rand` 0.8 (OsRng)
- Dev: `wiremock` 0.6 (fake upstreams), `cargo-audit`, `testcontainers` (MySQL/Redis for integration)

### 0.2 `crates/core/config`
Env loader for the gateway env vars (Appendix A). Defaults match Go. Fatal on missing `RAYU_JWT_SECRET` (production-safe). All env vars:
`PORT`(8080), `RAYU_JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`(redis://localhost:6379), `RAYU_PROVIDER_SECRET`, `ALLOW_INSECURE_PROVIDER_BASE_URL`, `CONFIG_REFRESH_SECONDS`(30), `USER_CACHE_TTL_SECONDS`(10), `RAYU_CONFIG_CHANNEL`(rayu:config-changed), `RAYU_MAX_INFLIGHT`(0=unlimited), `RAYU_ENFORCE_MODEL_FIDELITY`(off), `RAYU_PROXY_BODY_READ_TIMEOUT`(0), `GATEWAY_CORS_ORIGINS`(*).

### 0.3 `crates/core/db`
sqlx MySQL pool, **64 open / 16 idle / 3-min lifetime / 90s idle** (mirror `internal/store/store.go:109-117`). Accept Prisma-style `mysql://user:pass@host:port/db?...` URL. **No migrations** — read-only on schema owned by Prisma.

### 0.4 `crates/core/redis`
redis-rs async pool + pub/sub for configbus. Pre-load the four Lua scripts at boot (`SCRIPT LOAD`), cache SHA hashes for `evalsha`.

### 0.5 `crates/core/jwt`
`jsonwebtoken` — verify (pin HS256, reject non-HMAC, require `type=="access"`, read `sub` as number, `role` as string). No minting in the gateway (backend mints).

### 0.6 `crates/core/secretbox`
`aes-gcm` — `v1:` envelope, `sha256(secret)[..32]` key. **Unit test against known ciphertext** from Go first — proves interop before anything else. `Zeroizing<Vec<u8>>` for decrypted key bytes. Boot refusal if `provider_api_keys` has rows but `RAYU_PROVIDER_SECRET` missing/wrong (mirror `cmd/gateway/main.go:264-276`).

### 0.7 `crates/core/sse`
axum-native SSE via `axum::response::sse::Sse` + `Body::from_stream`. Per-event size cap 1 MiB line. Emitter helpers: `message_start` → `content_block_start` → `content_block_delta*` → `content_block_stop` → `message_delta` → `message_stop`. **Flushing:** axum flushes per event by default with `Sse::keep_alive` off (we manage our own keepalive).

### 0.8 `crates/core/httpx`
Both error envelopes + `errType` mapping + `provider_unavailable` + capability error helpers. **Never leak upstream bodies or stack traces in 5xx.** Generic `"provider_unavailable"` messages only.

### 0.9 `crates/core/cache`
`moka::future::Cache` for entitlements (TTL `USER_CACHE_TTL_SECONDS` 10s). `ArcSwap<Snapshot>` for the config snapshot (lock-free reads under SSE concurrency).

**Verify Phase 0:** `cargo build`; boot against seeded MySQL+Redis; `GET /healthz` → 200; secretbox interop test passes; `cargo audit` clean; no secret value in logs.

---

## Phase 1 — Gateway domain (Go → Rust)

### 1A. Config snapshot + caches
- `gateway/config::Snapshot`: load `hosted_models` JOIN `providers`, `provider_api_keys` (decrypt once), `app_settings`, `plans`. Mirror `internal/entitlements.go:205-266` `reload`. Wrap in `ArcSwap<Snapshot>` + `moka` for lock-free reads under SSE concurrency.
- `gateway/configbus`: subscribe Redis `rayu:config-changed`; on message → reload. Publish on `POST /v1/_reload`.
- Config refresh loop: every `CONFIG_REFRESH_SECONDS` (30s) reload as safety net.
- `gateway/entitlements`: per-user `Resolve` — `UserStatus` + `ActivePlan` (30-day `currentPeriodEnd` expiry → Free fallback) + `TopupBalance`. Single-flight per user (`tokio::sync::Mutex` per-user map, 3s deadline), `moka` TTL `USER_CACHE_TTL_SECONDS` (10s). `Invalidate(user)`. `AllowedModels` = enabled models whose `allowedPlanCodes` includes the plan code (from the live snapshot, **not** the cached user entry). `Keys()` returns the registry. `Route(providerID)` from the in-memory registry.

### 1B. Credits + limiter
- `gateway/credits`: port `internal/credits/credits.go` exactly:
  - `TokensPerCredit(baseline)` = `round(1_000_000 / baseline)`, baseline ≤ 0 → 1,000,000.
  - `ModelRatesFor(input, output, cacheRead, cacheWrite)`: non-positive output/cacheWrite → input; cacheRead < 0 → `CacheHitBillingWeight = 0.10`.
  - `EstimateTokens(req, defaultMaxTokens=2048)`: `len()` (bytes) of string content + text parts / 4 + `max_tokens` (float64) else 2048, floor 1.
  - `EstimateBillableTokens(est, inputMult)` = `round(est * inputMult)`, floor 1.
  - `BillableTokens(usage, rates)`: clamp negatives; if any cache bucket > 0 → `miss*Input + hit*CacheRead + write*CacheWrite + completion*Output`; else if prompt|completion > 0 → `prompt*Input + completion*Output`; else `total*Input`; `round`, ≤ 0 → 0.
  - `ForTokens`/`ForUsage` coarse paths for display.
- `gateway/limiter`: port the four Lua scripts **verbatim** into `redis-rs` `evalsha`:
  - **reserveScript** (`internal/credits/limiter.go:69-116`): on `cwperiodid:<uid>` change → zero `cwperiod`; deny `conc` if `conc >= maxc`; deny `req5h` if `req5h >= maxr`; charge `cwperiod` via INCRBY when `cap<0 || used+est<=cap` (source=`plan`), else decrement `topup` when enabled and sufficient (source=`topup`), else deny `period_limit`; always INCR `conc` (TTL 10 min) + `req5h` (TTL 5h).
  - **settleScript** (`limiter.go:121-130`): source `plan` → `INCRBY cwperiod (actual-est)`; source `topup` → `INCRBY topup (est-actual)`; `DECR conc` floored at 0.
  - **turn reserve / turn hold** (`limiter.go:235-390`): `SETNX turnhold:<uid>:<logicalID>` → reuse existing (`reused=1`, no double count); else deny-without-hold if over cap (`DEL` hold), else INCR `turns:<uid>:<YYYYMMDD>` with midnight-UTC TTL.
  - `keysFor`: `cwperiod`, `cwperiodid`, `conc` (TTL 10 min self-heal), `req5h` (TTL 5h), `topup` (SetNX TTL 5 min via `EnsureTopup`), `turns:<uid>:<YYYYMMDD>`, `turnhold:<uid>:<logicalID>`.
  - `periodTTLSeconds(periodEnd)`: seconds until period end, floor 60, 0 if nil.
  - `Reserve`, `Settle`, `ReserveTurn`, `ReleaseTurn`, `EnsureTopup`, `ReserveTurnFor`/`ReleaseTurnFor` (idempotent by logical ID).
- `gateway/eventqueue`: bounded (4096) `tokio::sync::mpsc`, 4 worker tasks, retry exp backoff max 5. Drains on shutdown. Writes: `InsertLedger` (to `credit_ledger`), `InsertUsageEvent` (to `usage_events`), `UpdateProviderKeyState`. **Same DB writes as Go** — backend reads these for dashboard/admin.

### 1C. Providers + adapters
- `gateway/providerkeys::Registry`: per-key state machine (active/cooling/invalid/disabled). `Pick` = enabled keys whose live status is active or cooldown elapsed (restore), priority order; invalid/disabled/still-cooling excluded. `MarkRateLimited` (429/402 → cooldown default 60s, cap 10min). `MarkInvalid` (401/403 → permanent out-of-rotation). `MarkUsed` (success → clear health). Persist via eventqueue.
- `gateway/circuitbreaker`: per-host, 5 consecutive failures → open, 15s cooldown. States closed/open/halfOpen (halfOpen admits exactly one trial). In-memory only. `Allow`/`Success`/`Failure`/`Do`.
- `gateway/proxy`: shared `reqwest` client (no total timeout, 30s response-header timeout, MaxIdleConns 100/Host 20, 90s idle, 10s TLS). `SendWithFailover` (iterate keys in priority order, rotate on 429/402/401/403, call `onKeyFailure` for every failing key including the last). `doWithRetry` (Breakers.Allow first; 2 retries on 502/503/504 only — **never 429**; backoff 250ms→500ms→1s capped 2s; honor integer `Retry-After`; transport error → Breakers.Failure + no retry; exhausted-still-5xx → Breakers.Failure; success/non-retryable-4xx → Breakers.Success).
- **Adapters** (port each `init()`-registered translate impl from `internal/translate/`):
  - `anthropicPassthrough` (`translate/anthropic.go`) — byte-verbatim SSE relay + sniff usage from `message_start` (input buckets) / `message_delta` (cumulative output, latest wins); `probeNonStreamError` re-issue with `stream=false` to recover real error. `newAnthropicReq`: POST, `Content-Type: application/json`, auth per `bearer` (Authorization: Bearer) vs `x-api-key`, `anthropic-version: 2023-06-01`, `Accept: text/event-stream`.
  - `openAIChat` (`translate/openai_chat.go`) — Anthropic↔OpenAI `/v1/chat/completions` translation: system, messages, roles, content blocks (text/image/tool_use/tool_result/thinking), tool calls, stop reasons, `finish_reason` mapping; `stream_options.include_usage`; mid-stream error → `error` SSE event + usage-so-far.
  - `openAIResponses` (`translate/openai_responses.go`) — OpenAI Responses API translation.
  - `genAI` (`translate/genai.go`) — Google `v1beta/models/{model}:streamGenerateContent`; Gemini 3 `thoughtSignature` relay.
  - `bedrockAnthropic` (`translate/bedrock.go`) — Bedrock URL-path model id, `anthropic_version: bedrock-2023-05-31`, AWS event-stream frames (port `translate/eventstream.go` decoder).
  - `thinking` (`translate/thinking.go`) — strip `thinking`/`redacted_thinking` from completed turns (model-switch safety).
  - `sse.go` — SSE parser/emitter shared helpers.
  - Usage normalization: `CacheReadTokens()` = `PromptCacheHitTokens` || `PromptTokensDetails.CachedTokens` || 0. `FreshInputTokens()` = `PromptCacheMissTokens` || (`PromptTokens - CacheReadTokens`) || 0 || `PromptTokens`. ReasoningTokens is a subset of CompletionTokens (observability only).
  - `IsUpstreamRequestError`: 400/413/422. `UpstreamErrorMessage`: `error.message` || top-level `message`, 300-char cap, fallback `"The request was rejected by the model provider."`.
- `gateway/capabilities`: `requestHasImage` (walks messages[].content recursively incl. tool_result.content for `{"type":"image"}`); `requestWantsThinking` (`thinking` object; `type=="disabled"` → false; `"enabled"` → true; any other/absent with object → true). `MaxTokensPerRequest` guard.

### 1D. Hosted routes (port `internal/server/server.go`)

**Routes** (mirror `server.go:130-167`):
- `GET /healthz` (public)
- `GET /v1/models` (`handleModels`)
- `POST /anthropic/v1/messages` (`handleAnthropicMessages`, wrapped in inflight limiter)
- `POST /anthropic/v1/messages/count_tokens` (`handleCountTokens`)
- `POST /v1/chat/completions` (`handleRetiredChatCompletions` → 410 Gone)
- `GET /v1/credits` (`handleCredits`)
- `GET /v1/_whoami` (`handleWhoami`)
- `GET /v1/_entitlements` (`handleEntitlements`)
- `GET /v1/_provider-health` (`handleProviderHealth`, admin role gate)
- `POST /v1/_provider-test` (`handleProviderTest`, admin)
- `POST /v1/_reload` (`handleReload`, admin)
- `POST /v1/proxy` (`handleProxy`, BYO-key)
- CORS: mirror Origin if in `CorsOrigins` (default `*`), methods `GET, POST, OPTIONS`, max-age 600; OPTIONS → 204.

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
17. Build `settle` closure (idempotent, 5s detached bg ctx via `tokio::task::spawn` with `tokio::time::timeout`): `actual = actualBillable(usage, rates)`; `Settle(bg, uid, source, est, actual)`; `ent.Invalidate(uid)`; log; `recordLedger` (cacheReadFraction = rates.CacheRead/rates.Input; billableInputTokens = Fresh + CacheRead*frac; cost = billableInput/1e6*InputPrice + completion/1e6*OutputPrice; realCostCents = round(cost); enqueue `InsertLedger(uid, code, promptTokens, completionTokens, creditsConsumed, realCostCents, source)`).

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
- `GET /v1/credits` (`RayuCreditStatus` exact field set — see contract 8).
- `GET /v1/_whoami`, `GET /v1/_entitlements`.
- `POST /v1/chat/completions` → 410 Gone (retired).
- `GET /v1/_provider-health` (admin role gate: `claims.role ∈ {admin, superadmin}` else 403 `"admin only"`).
- `POST /v1/_provider-test` (admin; 1-token real ping `max_tokens:1` content `"ping"`; classification `ok|bad_api_key|unknown_model|bad_base_url|format_mismatch|rate_limited|upstream_error`; per-stage checks `reachable/keyAccepted/modelAccepted`; Levenshtein-near model suggestion; canonical path suggestion; redact secrets; 20/min/admin rate limit; **never condemn on unproven 401/403**; passing test calls `MarkUsed` to rehabilitate).
- `POST /v1/_reload` (admin; reload snapshot + publish configbus; 60/min/admin).
- Inflight limiter `RAYU_MAX_INFLIGHT` around `POST /anthropic/v1/messages`: saturated → `Retry-After: 5` + `WriteProviderUnavailable(503)`. Implemented via `tokio::sync::Semaphore` + `tower::limit::ConcurrencyLimit`.
- CORS: mirror Origin if in `CorsOrigins` (default `*`), methods `GET, POST, OPTIONS`, max-age 600; OPTIONS → 204.

**`gateway/diagnose`** (port `internal/server/providerdiagnose.go`): `canonicalPaths` (per-format known-good endpoint paths), `authHint`, `looksLikeHTML`, `detectResponseFormat` (sniff which wire format a 200 body actually is), `looksLikeAnthropicMessage` (must reject OpenAI/Responses/GenAI bodies that merely contain a `usage` object), `formatLabel`, `suggestEndpointPath`.

---

## Phase 2 — Performance & concurrency tuning (gateway-specific)

This phase is **new** vs. rust-merge.md (which only covered logic fidelity). The user's focus: speed, multi-user SSE, long requests, performance.

### 2A. Tokio runtime
- Multi-thread runtime, `worker_threads = num_cpus`, `blocking_threads = 512` (DB/Redis calls are blocking-aware via sqlx/redis async, but body reads + DNS use `spawn_blocking`).
- **Thread-local pools:** sqlx + reqwest connection pools sized for concurrency (sqlx 64 conns, reqwest 100 idle / 20 per host).
- **Backpressure:** `tower::limit::ConcurrencyLimit` on `/anthropic/v1/messages` = `RAYU_MAX_INFLIGHT` (default unlimited). Per-route `tower::timeout` only on body-read (`RAYU_PROXY_BODY_READ_TIMEOUT`), **not** on the SSE stream itself (long requests).

### 2B. SSE streaming efficiency
- axum `Sse` with `Body::from_stream(reqwest_stream)` — zero-copy pipe from upstream `reqwest::Response::bytes_stream()` to the client response. No buffering of full SSE events; flush per `content_block_delta`.
- **No per-stream heap allocator pressure:** reuse `bytes::BytesMut` for SSE line buffering; cap line at 1 MiB (drop upstream chunks larger than that with a `provider_unavailable` error — same as Go's `MaxBytesError`).
- **Keepalive:** `Sse::keep_alive(Duration::from_secs(15))` on idle streams (Anthropic upstream can pause for minutes during long thinking blocks). This keeps the TCP connection alive without sending data — matches Go's behavior.
- **Backpressure:** if the client reads slowly, `reqwest` backpressures upstream automatically (Tokio's async IO). No OOM from a fast upstream + slow client.

### 2C. Lock-free hot paths
- `ArcSwap<Snapshot>` for config — reads are `Arc::clone`, no lock. Reloads swap the whole snapshot atomically.
- `moka` for entitlements — lock-free concurrent cache, 10s TTL. Per-user single-flight via `tokio::sync::Mutex` map (only contended on first load per user per 10s).
- Provider key registry: `DashMap`-style via `moka` or `arc-swap` per provider. `Pick` is a hot path under SSE concurrency.
- Circuit breaker: `AtomicU8` state + `AtomicU64` failure count per host. No mutex on the `Allow` check.

### 2D. Connection pooling
- **reqwest** (upstream AI providers): one shared `Client` per process, `pool_max_idle_per_host(20)`, `pool_idle_timeout(Duration::from_secs(90))`, `tcp_keepalive(Duration::from_secs(10))`, `tcp_nodelay(true)`, `rustls` (no OpenSSL for binary size + cross-compile).
- **sqlx** (MySQL): 64 max conns, 16 min idle, 3-min max lifetime, 90s idle timeout. `SET NAMES utf8mb4` on connect. Prepared statement cache on.
- **redis** (Lua limiter + configbus): async pool, 16 conns. Reconnect on drop.

### 2E. Long requests
- **No total timeout** on upstream streaming (matches Go). Only a 30s response-header timeout (first byte). Once streaming starts, run until upstream closes or client disconnects.
- **Client disconnect detection:** axum propagates `Cancel::cancel()` from a disconnected client through the response future; the reqwest stream drops, cancelling upstream. No wasted work on closed connections.
- **Settle on cancel:** if the client disconnects mid-stream, the `settle` closure still runs in the detached 5s bg task (Tokio `JoinHandle` not cancelled by request cancellation). This is critical — Go does the same; Rust must too. Verify with a test that cancels mid-stream and asserts the `credit_ledger` row is still written.

### 2F. Memory bounds
- Body read cap 8 MiB (matches Go `MaxBytesReader`). SSE line cap 1 MiB.
- eventqueue bounded 4096 — if saturated, drop with a log (same as Go's non-blocking send).
- No unbounded growth: per-user single-flight map is bounded by active users (10s TTL on entitlement cache clears idle entries).

---

## Phase 3 — Security hardening (gateway-specific)

- **JWT:** reject `alg=none`, non-HS256, missing/`refresh` type. Constant-time compare on signature (jsonwebtoken does this).
- **SSRF (proxy path):** `validateUpstreamURL` — https only, reject private/loopback/link-local/unspecified IPs, DNS-rebind check (resolve A/AAAA, reject any private IP). Use `std::net::IpAddr::is_private()` etc. **No DNS rebinding race:** resolve once, pin the IP for the request.
- **Secret material:** `Zeroizing<Vec<u8>>` for decrypted provider keys; `zeroize` on drop. Never log keys, JWTs, or upstream bodies in 5xx.
- **Constant-time compare:** `subtle::ConstantTimeEq` for any webhook/token comparison (upgrade from Go's bytewise loop in `server.go:1114`).
- **CSPRNG:** `rand::rngs::OsRng` for all request IDs, pairing codes, ABA md5 sentinels (upgrade from Go's `crypto/rand` — equivalent, but explicit).
- **No secret in logs:** `tracing` fields filter — never emit `authorization`, `x-api-key`, `encryptedKey`, `RAYU_JWT_SECRET`, `RAYU_PROVIDER_SECRET`. Add a `tracing-subscriber` layer that redacts these field names.
- **Boot refusal:** if `RAYU_JWT_SECRET` missing or is a known dev/test fallback in prod → refuse to start. If `provider_api_keys` has rows but `RAYU_PROVIDER_SECRET` missing/wrong → refuse. If `RAYU_MAX_INFLIGHT` set but `Semaphore` acquire would block forever → log warning.
- **Rate limits:** admin routes (`/v1/_provider-test` 20/min/admin, `/v1/_reload` 60/min/admin) via `tower::limit::rate` per-IP + per-admin. In-flight limiter on `/anthropic/v1/messages`.
- **CORS:** only origins in `GATEWAY_CORS_ORIGINS` (default `*` for dev; tighten in prod).

---

## Phase 4 — Deploy & cutover

### 4A. Dockerfile
Multi-stage `rust:1-bookworm` builder → `debian:bookworm-slim` runtime. Static-link `rustls` (no OpenSSL). Target `x86_64-unknown-linux-gnu` (or `musl` for static). Final image < 50 MB.

### 4B. `deploy/docker-compose.yml`
Replace the `gateway` service (or add `gateway-rust` alongside for canary):
```yaml
gateway:
  image: <registry>/rayu-gateway-rust:${RAYU_GATEWAY_RUST_TAG:-latest}
  build: { context: ../rayu-gateway-rust, dockerfile: Dockerfile }
  environment:
    - PORT=8080
    - RAYU_JWT_SECRET
    - DATABASE_URL
    - REDIS_URL
    - RAYU_PROVIDER_SECRET
    - ALLOW_INSECURE_PROVIDER_BASE_URL
    - CONFIG_REFRESH_SECONDS
    - USER_CACHE_TTL_SECONDS
    - RAYU_CONFIG_CHANNEL
    - RAYU_MAX_INFLIGHT
    - RAYU_ENFORCE_MODEL_FIDELITY
    - RAYU_PROXY_BODY_READ_TIMEOUT
    - GATEWAY_CORS_ORIGINS
  labels:
    - caddy=gateway.rayucode.com
    - caddy.reverse_proxy={{upstreams 8080}}
  depends_on: [mysql, redis]   # NOT backend — Rust doesn't talk to NestJS
```
Caddyfile unchanged (still routes `/gateway/*` → `gateway:8080`).

### 4C. CI
`.github/workflows/ci.yml` add `gateway-rust-test`:
```yaml
  gateway-rust-test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: dtolnay/rust-toolchain@stable
    - uses: Swatinem/rust-cache@v2
      with: { workspaces: rayu-gateway-rust }
    - name: cargo audit
      working-directory: ./rayu-gateway-rust
      run: cargo install cargo-audit && cargo audit
    - name: cargo fmt --check
      working-directory: ./rayu-gateway-rust
      run: cargo fmt --all --check
    - name: cargo clippy
      working-directory: ./rayu-gateway-rust
      run: cargo clippy --all-targets -- -D warnings
    - name: cargo test
      working-directory: ./rayu-gateway-rust
      run: cargo test --all
    - name: cargo build --release
      working-directory: ./rayu-gateway-rust
      run: cargo build --release
```

### 4D. Cutover
1. Deploy `gateway-rust` alongside `gateway` (Go) in `deploy/` — both read the same MySQL+Redis.
2. Smoke test: `curl` both `/healthz`, then a real chat through each, compare `/v1/credits` output byte-for-byte.
3. Switch Caddy `/gateway/*` → `gateway-rust:8080`.
4. Watch for 24h; keep Go `gateway` as fallback (start it back if Rust misbehaves).
5. After stable for a week, remove Go `gateway` from `deploy/`.

---

## Logic Fidelity (Rust MUST follow Go source exactly)

> The Rust gateway is a **behavioral clone** of the Go gateway, not a reimagining. Every algorithm, ordering, edge case, rounding step, sign convention, fallback, and idempotency shape documented in Phase 1 is normative. Where the Go source has a quirk, the Rust port replicates it — it is not "fixed" unless explicitly flagged.

### Logic-porting rules (apply to every module)
1. **Read the Go source before writing Rust.** For each module, read the cited `.go` file + its `_test.go` in full, then write Rust. No porting from the plan summary alone.
2. **Preserve ordering.** `reserveHosted`'s 17 steps; `validateUpstreamURL`'s order; `handleProxy`'s 14 steps. Reordering is a bug.
3. **Preserve rounding exactly.** `EstimateTokens` floor 1; `EstimateBillableTokens` round floor 1; `BillableTokens` round ≤0→0; `TokensPerCredit` round; `realCostCents` round. Use the same rounding mode (Go's `math.Round` = Rust `f64::round`, `math.Floor` = `.floor()`, `math.Ceil` = `.ceil()`).
4. **Preserve sign conventions.** `credit_ledger.credits` positive for consumption. `settleScript`: `plan` → `INCRBY (actual-est)`; `topup` → `INCRBY (est-actual)`. Don't flip.
5. **Preserve fallbacks.** `MaxDailyTurns` nil/≤0 → unlimited; `baselineCreditsPer1M ≤ 0` → 1,000,000; `cacheReadCreditMultiplier < 0` → 0.10; `outputCreditMultiplier ≤ 0` → input; `max_tokens` absent/≤0 → 2048; `currentPeriodEnd` null → no expiry gate.
6. **Preserve error messages verbatim.** Every string the CLI matches on: `"model not available on your plan: "`, `"account is " + status`, `"daily turn limit reached"`, `"credit limit reached: " + reason`, `"provider key not configured"`, `"model temporarily unavailable: " + code`, `"missing X-Rayu-Token"`, `"invalid X-Rayu-Token"`, `"admin only"`, `"upstream temporarily unavailable"`, `"upstream unreachable"`, `"gateway busy, please retry"`, `"too large"`, `"timeout"`, `"unreadable"`, `"invalid JSON body"`, `"max_tokens exceeds the per-request limit"`. `rayu_code`s: `model_no_image_support`, `model_no_thinking_support`. `reason`s: `daily_turn_limit`, `concurrency`, `requests`, `period_limit`.
7. **Preserve HTTP status codes per case.** 410 retired; 413/408/400 body errors; 429 + reason JSON for limits; 503 + Retry-After for busy/circuit-open; 400 capability; 409 fidelity (if enforced); 403 account suspended; 502 upstream unreachable; 503 + Retry-After: 5 circuit-open.
8. **Preserve header semantics.** `X-Rayu-Proxied: 1` before forward; `X-Rayu-Proxy-Error` on gateway-origin error; `X-Rayu-Limit: daily_turn_limit` (NOT `X-Rayu-Proxy-Error`) on proxy turn cap; `X-Rayu-Model-Fidelity: mismatch` only when enforced; credit headers; correlation headers.
9. **Preserve idempotency.** `settle` is idempotent (runs once) + uses a detached 5s bg task (request ctx may be cancelling during streaming). `ReserveTurnFor`/`ReleaseTurnFor` idempotent by logical ID (SETNX hold → reuse, no double count).
10. **Lua scripts byte-identical.** Paste, don't rewrite. `evalsha` with cached SHA.
11. **No "improvements" unless flagged.** Phase 3 security additions (`subtle`, `zeroize`, OsRng, boot refusal) are explicit **new controls** that don't change existing logic.

### Domain checklists (must pass before marking a module done)

**Credits + limiter:**
- [ ] `EstimateTokens` uses `len()` (bytes); `max_tokens` float64 else 2048; floor 1.
- [ ] `BillableTokens` per-bucket: any cache>0 → `miss*Input + hit*CacheRead + write*CacheWrite + completion*Output`; else `prompt*Input + completion*Output`; else `total*Input`; round; ≤0→0.
- [ ] `settle` idempotent + detached 5s bg task (request cancel must not cancel settle).
- [ ] Non-streaming credit header = `used - est + actual`.
- [ ] Reserve in billable tokens; `capBillable = CreditsPerPeriod * tpc` (-1 if unlimited).
- [ ] Four Lua scripts byte-identical to Go.
- [ ] `periodTTLSeconds` floor 60, 0 if nil; `periodID` empty if nil.
- [ ] `EnsureTopup` SetNX TTL 5 min; `conc` TTL 10 min; `req5h` TTL 5h; `turns:<uid>:<YYYYMMDD>` TTL midnight UTC.
- [ ] `ReserveTurnFor`/`ReleaseTurnFor` idempotent by logical ID.

**Proxy + circuitbreaker:**
- [ ] `SendWithFailover` rotates on 429/402/401/403; reports `onKeyFailure` for every failing key including last; transport errors fail over.
- [ ] `doWithRetry` retries **only** 502/503/504 (never 429); 2 retries; 250ms→500ms→1s capped 2s; honor integer Retry-After; transport error → Breakers.Failure + no retry.
- [ ] A key returning retryable 5xx does NOT fail over (returned as-is).
- [ ] Circuit breaker: 5 consecutive → open 15s; halfOpen admits exactly one trial; halfOpen failure → re-open immediately.
- [ ] `StreamAnthropic` reports `wrote=true` on pre-stream upstream errors.
- [ ] `Forward` drops `X-Rayu-*`, Host, Content-Length, hop-by-hop; keeps user's `Authorization`/`x-api-key`; 32 KiB flush.
- [ ] `CacheReadTokens()` = PromptCacheHitTokens || CachedTokens || 0; `FreshInputTokens()` reconciles to provider's prompt_tokens.
- [ ] `IsUpstreamRequestError`: 400/413/422 only.

**Adapters:**
- [ ] `anthropicPassthrough` byte-verbatim relay + sniff usage from `message_start`/`message_delta`; `probeNonStreamError` re-issue stream=false.
- [ ] `openAIChat` requests `stream_options.include_usage`; mid-stream error → `error` SSE event + usage-so-far.
- [ ] `bedrockAnthropic` URL-path model id; `anthropic_version: bedrock-2023-05-31`; AWS event-stream frames per `eventstream.go`.
- [ ] `genAI` Gemini 3 `thoughtSignature` relay preserved.
- [ ] `thinking` strips `thinking`/`redacted_thinking` from completed turns (exact block list from `thinking.go`).
- [ ] Model substitution `req["model"] = hm.UpstreamModelID` before upstream call on hosted path.

**`reserveHosted`:**
- [ ] All 17 steps in order.
- [ ] Every error response code + envelope (OpenAI vs Anthropic) + `rayu_code` matches.
- [ ] `releaseTurnBG` refunds the daily turn on credit-reserve failure.
- [ ] All-unusable keys → 503 + Retry-After: 60; empty snapshot → 500 `"provider key not configured"`.
- [ ] Capability gates fire before turn/credit reservation.
- [ ] `allowedModels` derives from the live config snapshot (not cached user entry).

**`handleProxy`:**
- [ ] `X-Rayu-Token` auth (not Authorization).
- [ ] Daily turn cap best-effort, fail-open; `!OK` → `X-Rayu-Limit: daily_turn_limit` (NOT `X-Rayu-Proxy-Error`).
- [ ] Model fidelity: known-family cross-mismatch only; opaque ids never flag; always logged; enforced only if `RAYU_ENFORCE_MODEL_FIDELITY`.
- [ ] `X-Rayu-Proxied: 1` before forward; `Del` on pre-flight fail.
- [ ] Turn refund on pre-flight fail, mid-stream break, upstream non-200.
- [ ] UsageEvent write (NOT ledger) via eventqueue.

---

## Verification matrix (must-pass before considering done)

| # | Test | How |
|---|---|---|
| 1 | Boot against shared MySQL+Redis | `cargo run` → `GET /healthz` 200; NestJS backend still running on same DB |
| 2 | Secretbox interop | Decrypt an existing `provider_api_keys.encryptedKey` row written by Go; matches the key |
| 3 | JWT interop | Verify a Rayu JWT minted by NestJS backend; reject `alg=none`, `type=refresh` |
| 4 | `/v1/credits` byte-identical | Same JWT → Go gateway vs Rust gateway → identical JSON (field order aside) |
| 5 | `/v1/models` byte-identical | Same response shape as Go |
| 6 | Anthropic streaming | CLI sends a chat → SSE stream matches Go's bytes (events + deltas) |
| 7 | OpenAI provider streaming | DeepSeek/OpenRouter chat → SSE matches Go |
| 8 | Bedrock streaming | AWS event-stream frames decode identically |
| 9 | Credit reserve + settle | After a chat, `credit_ledger` row written with same `credits`, `realCostCents`, `source` as Go would write |
| 10 | Daily turn cap | 429 + `reason: daily_turn_limit` + `X-Rayu-Limit: daily_turn_limit` |
| 11 | Credit limit | 429 + `reason: period_limit` (or `concurrency`/`requests`) + `Retry-After` |
| 12 | Concurrency limit | `RAYU_MAX_INFLIGHT=N` → N+1th → 503 + `Retry-After: 5` |
| 13 | Client disconnect mid-stream | Cancel SSE → upstream cancelled; `settle` still writes the ledger row (5s bg task) |
| 14 | BYO-key proxy | `X-Rayu-Token` + `X-Rayu-Upstream-URL` → forwards; private IP rejected 403; SSRF blocked |
| 15 | Model fidelity | Mismatch logged; enforced flag → 409 + `X-Rayu-Model-Fidelity: mismatch` |
| 16 | Admin routes | `user`-role JWT → 403 `"admin only"`; admin JWT → ok |
| 17 | Provider-test | Classification `ok/bad_api_key/unknown_model/...` matches Go; never condemns on unproven 401/403 |
| 18 | Config reload | `POST /v1/_reload` → snapshot reloaded + configbus published → both Rust and Go (if still running) reload |
| 19 | Multi-user SSE | 1000 concurrent SSE streams → no OOM, no request drops; `tokio` runtime doesn't block |
| 20 | Long request | 5-minute upstream stream → no timeout; client sees all deltas |
| 21 | Security | `cargo audit` clean; no secret in logs; no upstream body in 5xx; SSRF blocked; `alg=none` rejected |
| 22 | Build | `cargo build --release`; `cargo fmt --check`; `cargo clippy -D warnings`; `cargo test --all` green |

---

## Files created/modified (final list)

**New (rayu-gateway-rust/):**
- `Cargo.toml` (workspace), `rust-toolchain.toml`
- `crates/core/` — `config/`, `db/`, `redis/`, `jwt/`, `secretbox/`, `sse/`, `httpx/`, `cache/` (each `mod.rs` + tests)
- `crates/gateway/` — `config/`, `configbus/`, `entitlements/`, `credits/`, `limiter/`, `eventqueue/`, `providerkeys/`, `circuitbreaker/`, `proxy/`, `capabilities/`, `adapters/` (`anthropic.rs`, `openai_chat.rs`, `openai_responses.rs`, `genai.rs`, `bedrock.rs`, `thinking.rs`, `eventstream.rs`), `routes/` (`server.rs`, `hosted.rs`, `proxy.rs`, `counttokens.rs`, `credits.rs`, `models.rs`, `whoami.rs`, `entitlements.rs`, `providerhealth.rs`, `providertest.rs`, `reload.rs`, `diagnose.rs`)
- `crates/server/main.rs` — wires router, boots workers (eventqueue, config refresh), graceful shutdown
- `.env.example`, `Dockerfile`, `README.md`

**Modified (deploy/):**
- `deploy/docker-compose.yml` — replace `gateway` service image with `rayu-gateway-rust` (or add `gateway-rust` for canary)
- `.github/workflows/ci.yml` — add `gateway-rust-test` job

**Unchanged:**
- `rayu-backend/` — NestJS untouched; keeps owning Prisma migrations + the MySQL schema
- `rayu/` CLI — no changes (talks to the same gateway URL via Caddy)
- `rayu-web/` — no changes
- `rayu-gateway/` Go source — kept as fallback during cutover, removed after stable
- `deploy/Caddyfile` — unchanged (still `/gateway/*` → `gateway:8080`)

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| axum SSE behavior differs from Go's hand-written flush | Phase 2B; byte-comparison test against Go for a real Anthropic stream |
| sqlx camelCase column mapping | `sqlx::FromRow` with `rename_all = "camelCase"`; verify against `hosted_models`/`providers` rows |
| Lua script SHA mismatch | Pre-load all four at boot via `SCRIPT LOAD`, cache SHA; fall back to `eval` if `NOSCRIPT` |
| Configbus pub/sub drops a message | 30s poll safety net (matches Go); `POST /v1/_reload` manual trigger |
| Client disconnect cancels settle | Settle runs in `tokio::task::spawn` with `tokio::time::timeout(5s)` — not tied to request future |
| reqwest stream backpressure leaks memory | Tokio async IO auto-backpressures; verify with 1000-stream load test (verification 19) |
| Native module deps (OpenSSL) | Use `rustls` feature everywhere; no OpenSSL link |
| Rust binary size | `--release` + `strip` + `lto=true` in `Cargo.toml`; final < 50 MB |
| Concurrent settle race | eventqueue serialized (4 workers, retry) — same as Go; no new race |
| Schema drift (Prisma adds a column) | Rust only reads known columns via `SELECT explicit columns` (not `SELECT *`); new columns ignored until Rust adds them |
| Cutover breaks billing | Keep Go `gateway` running as fallback for 7 days; Caddy can switch back in seconds |

---

## Out of scope (deferred to v2)
- Porting the NestJS backend to Rust (that's the separate `rust-merge.md` plan).
- New billing features (team/org billing — separate plan).
- Custom protocol adapters beyond what Go has today.
- gRPC/HTTP3 transport.
- WASM build of the gateway.
- Multi-region gateway federation.

---

## Appendix A — Gateway env vars (Rust reads the same as Go)

```
PORT=8080
RAYU_JWT_SECRET=<required, shared with backend>
DATABASE_URL=mysql://...
REDIS_URL=redis://localhost:6379
RAYU_PROVIDER_SECRET=<required if provider_api_keys has rows>
ALLOW_INSECURE_PROVIDER_BASE_URL=false
CONFIG_REFRESH_SECONDS=30
USER_CACHE_TTL_SECONDS=10
RAYU_CONFIG_CHANNEL=rayu:config-changed
RAYU_MAX_INFLIGHT=0   # 0 = unlimited
RAYU_ENFORCE_MODEL_FIDELITY=off
RAYU_PROXY_BODY_READ_TIMEOUT=0   # 0 = no timeout
GATEWAY_CORS_ORIGINS=*
```

---

## Open questions (non-blocking, confirm during implementation)
1. **axum vs actix** — this plan picks axum for SSE performance. The rust-merge plan picked actix for the merged binary. If you want consistency with the future merge, switch to actix here. (Recommendation: axum for the gateway-only build; revisit if/when the merge happens.)
2. **Crate name** — `rayu-gateway-rust` vs `rayu-gateway` (replace Go) vs a published name. Assumed `rayu-gateway-rust` for the dir; binary name `rayu-gateway`.
3. **Canary vs replace** — run Rust alongside Go for 7 days (safer) or cut over directly (faster). Assumed canary.
4. **MySQL read-only** — Rust never writes except `credit_ledger` + `usage_events` (via eventqueue) + `provider_api_keys` state (via eventqueue). Confirm no other writes are needed (Go doesn't).