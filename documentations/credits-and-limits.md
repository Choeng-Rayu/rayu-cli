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
- **`app_settings`** (singleton): `baselineCreditsPer1M`, `maxConcurrentStreams`, `maxTokensPerRequest`, `maxRequestsPer5h`, `topupCentsPer1kCredits`, plus projection-only knobs (`baselineModelCode`, `assumedInputRatio`, `assumedUsagePercent`, `infraCostCentsPerUser`).
- **`hosted_models`**: `code`, `provider`, `upstreamModelId`, prices, `creditMultiplier`, `allowedPlanCodes`, `enabled`.

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
| Plan `creditsPerPeriod` | `plans.limits` | Gateway `handleChat` → Redis reserve/settle (hosted models only) |
| Plan `topUpEnabled` | `plans.limits` | Gateway (fallback to top-up balance); backend top-up checkout |
| Plan **`maxDailyTurns`** | `plans.limits` | Gateway: **hard** on `/v1/chat/completions`, **best-effort** on `/v1/proxy` |
| Plan `features` | `plans.limits` | CLI `rayuFeatureAllowed()` — client-side UX gating, **fails open** |
| Plan `priceCents` / `availability` | `plans` | Backend checkout (`createKhqr` requires `active` + `priceCents>0`); `/plans` + `/billing` |
| `baselineCreditsPer1M`, `maxConcurrentStreams`, `maxTokensPerRequest`, `maxRequestsPer5h` | `app_settings` | Gateway |
| `topupCentsPer1kCredits` | `app_settings` | Backend top-up pricing |
| `baselineModelCode`, `assumedInputRatio`, `assumedUsagePercent`, `infraCostCentsPerUser` | `app_settings` | Admin **profit projection only** (advisory; no runtime effect) |
| Hosted model `allowedPlanCodes`, `creditMultiplier`, `enabled`, prices | `hosted_models` | Gateway model access + credit math |

## Credits

- **Definition:** `1 credit = (1e6 / baselineCreditsPer1M)` tokens at the reference model (`creditMultiplier = 1`). Cheaper models use a `<1` multiplier.
- **Charge math:** `credits = ceil(totalTokens / 1e6 * baselineCreditsPer1M * multiplier)` (any positive usage ≥ 1 credit).
- **Where credits move:** only on the **hosted path** (`POST {gateway}/v1/chat/completions`, used by the CLI's `rayu-hosted` provider). The BYO-key transparent proxy (`POST {gateway}/v1/proxy`) **tracks usage but never charges credits** — the user pays their own provider.
- **Period balance:** depletes over the billing period and resets at renewal (Redis key TTL = time to `currentPeriodEnd`); no weekly reset. Top-up is the durable fallback when `topUpEnabled`.
- **Field naming:** the canonical field is **`creditsPerPeriod`**. Legacy `creditsPerWeek` / `creditsPer5h` are removed from the CLI type and are no longer enforced (kept only as optional parse-compat in the backend `PlanLimits`).

## Daily turn cap (`maxDailyTurns`)

A per-user, per-UTC-day counter (Redis key `turns:<userId>:<YYYYMMDD>`, TTL = end of UTC day). `null` or `0` = unlimited (turns are still counted for display). Seeded default: **free = 50**, paid tiers = unlimited.

- **Hosted path (`/v1/chat/completions`) — HARD:** checked before the credit reserve. Over cap → `429` with `{"reason":"daily_turn_limit"}` + `Retry-After`. A turn is refunded if the subsequent credit reserve denies (so a credit denial never also burns a turn). The user cannot bypass this (the gateway holds the provider key).
- **BYO-key path (`/v1/proxy`) — BEST-EFFORT:** over cap → a `429` that is **not** tagged `X-Rayu-Proxy-Error` but **is** tagged `X-Rayu-Limit: daily_turn_limit`. The CLI surfaces this instead of failing safe to a direct call. It is best-effort because a user controlling their own machine can disable gateway routing (`RAYU_ROUTE_VIA_GATEWAY=false`) or go direct; and providers that don't route through the gateway (OAuth: Kiro/Gemini/Vertex/Copilot, and Bedrock-Converse) are not counted.

**Hard vs soft summary:** `maxDailyTurns` and `creditsPerPeriod` are a hard boundary **only for Rayu-hosted models**. For BYO-key usage all client-side gating (features, turn cap) is advisory.

## Where usage is shown

- **CLI:** `/credits` (or `/usage`) → `GET {gateway}/v1/credits`. Shows credits used/remaining and, when a cap is set, `Daily turns: X / Y used · Z left`.
- **Dashboard (`/dashboard`):** reads `GET {gateway}/v1/credits` (falls back to `/api/me/entitlements` allowance if the gateway is unavailable). Renders credit + daily-turn bars.
- **`/v1/credits` fields:** `creditsPerPeriod`, `usedCredits`, `remainingCredits`, `tokensPerCredit`, `maxDailyTurns`, `turnsUsedToday`, `turnsRemaining` (null when unlimited), `turnsResetSeconds`, `topupBalance`.

## Propagation latency (why a change isn't instant)

- Gateway config (models + app settings) refreshes every `CONFIG_REFRESH_SECONDS` (default 30s).
- Per-user entitlements are cached for `USER_CACHE_TTL_SECONDS` (default 10s) and invalidated after a credit settle.
- The CLI caches entitlements to `~/.rayu/rayu-entitlements.json` with a 30s background-refresh cooldown.

So an admin edit takes effect within ~10–30s; the CLI may need up to its cooldown (or a restart) to reflect feature changes.

## How to change business logic (admin panel)

1. **Plans & Features** (`/admin/plans`) — price, availability, `maxDailyTurns`, `creditsPerPeriod`, top-up, per-feature toggles/limits.
2. **Credit Settings** (`/admin/credit-settings`) — baseline credits, abuse caps, top-up price, and the profit projection knobs.
3. **Models** (`/admin/models`) — hosted model catalog, prices, multipliers, `allowedPlanCodes`, enable/disable.

Seeds are **non-destructive** (create-if-missing): editing in production is never overwritten on redeploy. Defaults live in `rayu-backend/src/plans/plans.constants.ts`, `models.constants.ts`, and `AppSettingsService`.

## Verifying end-to-end

See `rayu-gateway/RUNNING.md` → "Verify credits & the daily turn cap" for the concrete runbook (assign a paid plan → hosted chat → credits decrement on the dashboard → daily cap returns 429).
