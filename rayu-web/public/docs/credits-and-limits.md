# Credits & Limits — admin-editable business logic

This document is the source of truth for how Rayu's **plan business logic** —
credit allowances, per-day turn caps, feature toggles, hosted-model access and
pricing — is configured by the super-admin and **enforced** across the stack.

> TL;DR: the **MySQL database is the source of truth**. The admin panel writes to
> it; the gateway and backend read from it. A setting only has an effect if a
> service downstream reads and enforces it — this doc maps every admin-editable
> field to where it is enforced.

## Services

| Service | Role |
|---|---|
| `rayu` (CLI) | Client. Reads entitlements; displays usage; routes provider calls through the gateway. Client-side gating only (fails open). |
| `rayu-backend` (NestJS, `/api`) | Users, plans, payments, entitlements. Owns the DB schema; serves the admin panel APIs. |
| `rayu-web` (Next.js) | Admin panel (`/admin/*`), public `/plans`, `/billing`, and the user `/dashboard`. |
| `rayu-gateway` (Go) | Streaming gateway. Reads the same MySQL, enforces credit + turn caps in Redis, and meters hosted usage to the `credit_ledger`. |

## Data model (all admin-editable, stored in MySQL)

- **`plans.limits`** (JSON per plan):
  - `creditsPerPeriod` — per-billing-period credit balance for hosted models (`null` = none).
  - `maxDailyTurns` — per-day request/turn cap (`null` or `0` = unlimited).
  - `topUpEnabled` — allow pay-as-you-go top-up credits.
  - `features` — per-feature `{ enabled, limit }` map (telegram, swarm, image/video gen, …).
- **`plans.priceCents` / `plans.availability`** — pricing and whether the plan is purchasable (`active` vs `coming_soon`).
- **`app_settings`** (singleton): `baselineCreditsPer1M`, `maxConcurrentStreams`, `maxTokensPerRequest`, `maxRequestsPer5h`, `creditsPerDollar` + `minTopupCents` (credit top-up pricing), plus projection-only knobs (`baselineModelCode`, `assumedInputRatio`, `assumedUsagePercent`, `infraCostCentsPerUser`).
- **`hosted_models`**: `code`, `provider`, `upstreamModelId`, prices, the four credit charges (`creditMultiplier` = input, `outputCreditMultiplier`, `cacheReadCreditMultiplier`, `cacheWriteCreditMultiplier`), `allowedPlanCodes`, capability flags, `enabled`.

All of the above is edited in the admin dashboard: **Plans & Credits** (plans, model access per plan, top-up rate, global limits) and **Providers** (providers, their API keys, and each model's credit charges).

## Flow

```
Admin panel (rayu-web)  --PATCH /api/admin/*-->  MySQL  <--reads--  rayu-gateway
                                                   ^                    |
                              rayu-backend --------/             enforce caps (Redis)
                              (/me/entitlements,                        |
                               /api/plans, payments)             credit_ledger
                                                                        |
                              CLI /credits  <---- GET /v1/credits ------/
                              Dashboard     <---- GET /v1/credits
```

## What each admin control does — and where it is enforced

| Admin control | Stored in | Enforced / consumed by |
|---|---|---|
| Plan `creditsPerPeriod` | `plans.limits` | Gateway `reserveHosted` → Redis reserve/settle in billable tokens (hosted `/v1/chat/completions` + `/anthropic/v1/messages`) |
| Plan `topUpEnabled` | `plans.limits` | Gateway (fallback to top-up balance); backend top-up checkout |
| Plan **`maxDailyTurns`** | `plans.limits` | Gateway: **hard** on `/v1/chat/completions`, **best-effort** on `/v1/proxy` |
| Plan `features` | `plans.limits` | CLI `rayuFeatureAllowed()` — client-side UX gating, **fails open** |
| Plan `priceCents` / `availability` | `plans` | Backend checkout (`createKhqr` requires `active` + `priceCents>0`); `/plans` + `/billing` |
| `baselineCreditsPer1M`, `maxConcurrentStreams`, `maxTokensPerRequest`, `maxRequestsPer5h` | `app_settings` | Gateway |
| `creditsPerDollar`, `minTopupCents` | `app_settings` | Backend top-up pricing (`POST /payments/topup-khqr`); reported by the gateway on `/v1/credits` so clients can quote the price |
| `baselineModelCode`, `assumedInputRatio`, `assumedUsagePercent`, `infraCostCentsPerUser` | `app_settings` | Admin **profit projection only** (advisory; no runtime effect) |
| Hosted model `allowedPlanCodes` (edited per plan on Plans & Credits) | `hosted_models` | Gateway + backend model access |
| Hosted model credit charges (input/output/cache-read/cache-write), `enabled`, prices | `hosted_models` | Gateway credit math (charges are used VERBATIM — nothing is derived from the cost prices) |

## Credits

- **Definition:** `1 credit = tokensPerCredit = round(1e6 / baselineCreditsPer1M)` billable tokens at the reference model (`creditMultiplier = 1`). With the seeded `baselineCreditsPer1M` (e.g. `1`), one credit = 1,000,000 tokens. Cheaper models bill at a `<1` multiplier, so they consume proportionally fewer credits per token.
- **Charge math (fine-grained):** the gateway accumulates **billable tokens** — a credit-weighted token count priced per bucket (see [How tokens are counted](#how-tokens-are-counted-hosted-credit-path)) — and derives credits by dividing:

  ```
  billableTokens = Σ (bucketTokens × bucketRate)     # per request; rounded, NOT ceil'd
  credits        = billableTokens / tokensPerCredit   # fractional
  ```

  A turn costs its **true proportional share** — it is **not** rounded up to a whole credit. A trivial "hi" (~12 billable tokens on deepseek-v4-flash) costs ~0.00001 credit, not a full 1M-token credit.
- **Where credits move:** only on the **hosted path** — `POST {gateway}/v1/chat/completions` (OpenAI-compatible) and `POST {gateway}/anthropic/v1/messages` (native Anthropic, used by the current `rayu-hosted` provider). The BYO-key transparent proxy (`POST {gateway}/v1/proxy`) **tracks usage but never charges credits** — the user pays their own provider.
- **Period balance:** the Redis period counter (`cwperiod:<userId>`) stores **billable tokens** and depletes over the billing period. It resets at renewal (key TTL = time to `currentPeriodEnd`, plus a period-id guard that zeroes the counter when the billing period rolls over); no weekly reset. Top-up is the durable fallback when `topUpEnabled`.
- **Field naming:** the canonical field is **`creditsPerPeriod`**. Legacy `creditsPerWeek` / `creditsPer5h` are removed from the CLI type and are no longer enforced (kept only as optional parse-compat in the backend `PlanLimits`).

## How tokens are counted (hosted credit path)

Rayu meters the **rayu-hosted** provider the same way first-class agent CLIs do —
Claude Code (`utils/modelCost.ts`: `inputTokens` / `outputTokens` /
`promptCacheWriteTokens` / `promptCacheReadTokens`) and OpenCode (models.dev's
`Cost` schema: `input` / `output` / `cache_read` / `cache_write`) — from the
provider's **actual per-bucket token usage**, priced by a 5-bucket rate table.
It never applies one flat rate, and (since the fine-grained fix) never rounds a
request up to a whole coarse credit.

> The implementation lives in `rayu-gateway/internal/credits/credits.go`
> (`Usage`, `ModelRates`, `DeriveModelRates`, `BillableTokens`,
> `EstimateBillableTokens`, `TokensPerCredit`) and is driven from
> `internal/server/server.go` (`reserveHosted` → `settle`).

### 1. Usage buckets and their rates

Every hosted response's `usage` is normalized into `credits.Usage` and split into
buckets priced independently by `credits.ModelRates` (built by `DeriveModelRates`):

| Bucket | Source field(s) | Rate |
|---|---|---|
| **Input** (cache-miss / fresh prompt) | `prompt_tokens` − cache-read, or Anthropic `input_tokens` | `creditMultiplier` |
| **Output** (completion) | `completion_tokens` / `output_tokens` | `creditMultiplier × outputPricePer1MCents / inputPricePer1MCents` (falls back to `creditMultiplier` when prices unset) |
| **Cache read** (prompt prefix served from the provider's cache) | `prompt_cache_hit_tokens` / `cache_read_input_tokens` | `CacheHitBillingWeight` = **0.10** (a 90% discount) unless the model sets `cacheReadCreditMultiplier` |
| **Cache write** (cache creation) | `cache_creation_input_tokens` | `creditMultiplier` unless `cacheWriteCreditMultiplier` is set (DeepSeek reports 0 here today) |

Provider shapes are reconciled first: OpenAI-compatible DeepSeek reports
`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; the Anthropic Messages
shape reports `input_tokens` (already cache-excluded) + `cache_read_input_tokens`
+ `cache_creation_input_tokens`. Both collapse to the same buckets via
`proxy.Usage.CacheReadTokens()` / `FreshInputTokens()`.

### 2. Billable tokens (the accumulated unit)

```
billableTokens = miss×Input + cacheHit×CacheRead + cacheWrite×CacheWrite + output×Output
```

Rounded to the nearest integer (`credits.BillableTokens`) — **no `/1e6`, no
`ceil`**. Graceful fallbacks: if a provider reports no cache breakdown,
prompt/completion are billed at Input/Output; if only `total_tokens` is present,
it is billed at Input.

**Why cache-aware:** in an agentic tool-use loop the CLI resends the whole growing
conversation on every turn (chat APIs are stateless), so all but the newest
increment is a byte-for-byte repeat the provider serves from its on-disk cache at
~2–8% of full price. Billing cache hits at `0.10×` mirrors that instead of
charging full price for context the provider barely charged Rayu for.

### 3. Estimate → settle (reserve reconciliation)

The real input/output/cache split isn't known until the upstream responds, so
each request is a two-step reserve/settle:

1. **Pre-flight reserve** — `EstimateBillableTokens(EstimateTokens(req), creditMultiplier)`, where `EstimateTokens ≈ promptChars/4 + max_tokens`. Holds a rough billable-token slot against the period allowance (and top-up when enabled). Minimum 1 so a reservation always claims a slot.
2. **Settle** — after the response the estimate is reconciled to the exact `BillableTokens(usage)`; the Redis counter is adjusted by `(actual − estimate)`. Streaming and non-streaming both settle from the parsed `usage` block (SSE `message_start` + `message_delta` on the Anthropic path).

The **allowance is enforced in billable tokens**: `capBillable = creditsPerPeriod × tokensPerCredit`. Over cap → `429 {"reason":"period_limit"}` (with top-up fallback when enabled).

### 4. Worked example — deepseek-v4-flash (`creditMultiplier = 0.33`, baseline = 1)

- Rates: Input = `0.33`, Output = `0.33 × 28/14 = 0.66`, CacheRead = `0.10`.
- A "hi" using 20 fresh-input + 8 output tokens → `20×0.33 + 8×0.66 ≈ 12` billable tokens.
- `tokensPerCredit = 1,000,000` ⇒ the turn costs **≈ 0.000012 credit** (and `/usage` shows `usedTokens += 12`).
- The pre-fix `ceil(billable / 1e6 × baseline)` path charged **1 whole credit (1,000,000 tokens)** for that same "hi" — and again for each per-turn side query (e.g. memory retrieval / classifiers routed through the hosted provider) — which is the over-billing this model replaced.

## Daily turn cap (`maxDailyTurns`)

A per-user, per-UTC-day counter (Redis key `turns:<userId>:<YYYYMMDD>`, TTL = end of UTC day). `null` or `0` = unlimited (turns are still counted for display). Seeded default: **free = 50**, paid tiers = unlimited.

- **Hosted path (`/v1/chat/completions`) — HARD:** checked before the credit reserve. Over cap → `429` with `{"reason":"daily_turn_limit"}` + `Retry-After`. A turn is refunded if the subsequent credit reserve denies (so a credit denial never also burns a turn). The user cannot bypass this (the gateway holds the provider key).
- **BYO-key path (`/v1/proxy`) — BEST-EFFORT:** over cap → a `429` that is **not** tagged `X-Rayu-Proxy-Error` but **is** tagged `X-Rayu-Limit: daily_turn_limit`. The CLI surfaces this instead of failing safe to a direct call. It is best-effort because a user controlling their own machine can disable gateway routing (`RAYU_ROUTE_VIA_GATEWAY=false`) or go direct; and providers that don't route through the gateway (OAuth: Kiro/Gemini/Vertex/Copilot, and Bedrock-Converse) are not counted.

**Hard vs soft summary:** `maxDailyTurns` and `creditsPerPeriod` are a hard boundary **only for Rayu-hosted models**. For BYO-key usage all client-side gating (features, turn cap) is advisory.

## Where usage is shown

- **CLI:** `/credits` (or `/usage`) → `GET {gateway}/v1/credits`. Shows credits used/remaining and, when a cap is set, `Daily turns: X / Y used · Z left`.
- **Dashboard (`/dashboard`):** reads `GET {gateway}/v1/credits` (falls back to `/api/me/entitlements` allowance if the gateway is unavailable). Renders credit + daily-turn bars.
- **`/v1/credits` fields:** `creditsPerPeriod`, `usedCredits` (fractional — derived from billable tokens), `remainingCredits`, `tokensPerCredit`, `allowanceTokens` (= `creditsPerPeriod × tokensPerCredit`), `usedTokens` (real billable tokens used this period), `remainingTokens`, `maxDailyTurns`, `turnsUsedToday`, `turnsRemaining` (null when unlimited), `resetSeconds`, `topupBalance`, `topUpEnabled`, `periodEnd`.

## Propagation latency (why a change isn't instant)

- Gateway config (models + app settings) refreshes every `CONFIG_REFRESH_SECONDS` (default 30s).
- Per-user entitlements are cached for `USER_CACHE_TTL_SECONDS` (default 10s) and invalidated after a credit settle.
- The CLI caches entitlements to `~/.rayu/rayu-entitlements.json` with a 30s background-refresh cooldown.

So an admin edit takes effect within ~10–30s; the CLI may need up to its cooldown (or a restart) to reflect feature changes.

## How to change business logic (admin panel)

There are two pages, because there are two decisions:

1. **Plans & Credits** (`/admin/plans`) — what a customer gets for their money: price, availability, `maxDailyTurns`, `creditsPerPeriod`, per-feature toggles/limits, which models each plan may use (`allowedPlanCodes`), the credit top-up rate (`creditsPerDollar`, `minTopupCents`), and — collapsed — the baseline credit rate, abuse caps and profit projection.
2. **Providers** (`/admin/providers`) — how the gateway reaches an upstream: base URL, wire format, auth scheme, its encrypted API keys, and the models it serves (upstream model id, context window, the four credit charges, capabilities). Each key and model has a **Test** button that makes a real 1-token request through the gateway and charges nothing.

(`/admin/credit-settings` and `/admin/models` are retired; both redirect to the page that absorbed them.)

Seeds are **non-destructive** (create-if-missing) and the hosted catalog is only seeded when `SEED_CATALOG=true`, so a fresh deployment starts empty and the admin owns it. Plan/settings defaults live in `rayu-backend/src/plans/plans.constants.ts` and `AppSettingsService`.

## Verifying end-to-end

See `rayu-gateway/RUNNING.md` → "Verify credits & the daily turn cap" for the concrete runbook (assign a paid plan → hosted chat → credits decrement on the dashboard → daily cap returns 429).
