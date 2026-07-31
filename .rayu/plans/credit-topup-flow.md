# Implement Pay-As-You-Go Credit Top-Up (No Hardcoded Pricing)

## Improved Prompt

As a senior software engineer, implement the **full pay-as-you-go credit top-up flow** end-to-end across the Rayu stack (backend → gateway → CLI). The credit price must be **read at runtime from `AppSettings.creditsPerDollar` / `minTopupCents`** (admin-editable on the Plans & Credits page), never hardcoded. Top-up must work across **every** payment rail the backend supports — ABA, Bakong KHQR, and Stripe (once Stripe is added) — through one shared pricing + grant code path.

## Current State (verified by reading the code)

The schema and a partial KHQR-only flow already exist:

- **Prisma `AppSettings`** (`prisma/schema.prisma:284`):
  - `baselineCreditsPer1M Int @default(1000)` — converts cents → credit units.
  - `creditsPerDollar Int @default(0)` — **how many credits one US dollar buys**. `0` means **top-up unavailable** (the admin has not enabled it).
  - `minTopupCents Int @default(100)` — smallest purchase allowed (default $1).
  - Schema comment is explicit: *"the gateway reads both so the CLI can quote a price without calling the backend."* The pricing source of truth is `AppSettings`, not constants in code.
- **Prisma `CreditTopup`** (`prisma/schema.prisma:326`): `id`, `userId`, `credits`, `amountCents`, `status` (pending → paid), `paymentId?`, `createdAt`. Schema comment: *"Pay-as-you-go credit purchases (schema only this phase; flow ships later)."* — i.e. the schema was staged earlier and the flow is what this task ships.
- **Prisma `CreditLedger`** (`prisma/schema.prisma:306`): the durable audit trail of credit consumption written by the gateway; top-up grants must write here with `source = 'topup'` (or the existing `source` enum value) so the ledger shows the purchase.
- **`payments/dto/create-topup.dto.ts`**: `CreateTopupDto { credits: number (1..100_000_000), method?: 'aba' | 'bakong' }` — already validates credit amount, not dollar amount.
- **`payments/payments.controller.ts:47`**: `POST /payments/topup-khqr` → `payments.createTopupKhqr(userId, credits, method)`. KHQR-only.
- **`payments/payments.service.ts`**: `createTopupKhqr` exists, and `activatePaid` already has a top-up branch (`payments.service.ts:572-604`) that flips `Payment` → `paid` + `CreditTopup` → `paid` idempotently via `updateMany` + transaction.
- **Gateway**: `rayu-gateway/internal/credits/credits.go` + `limiter.go` read `AppSettings` so the CLI can quote a price without calling the backend (per the schema comment). The top-up grant must surface through the same entitlement path the gateway reads.
- **CLI**: `rayu/src/commands/billing/` exists (`billing.ts`, `index.ts`) and `src/services/rayuAuth/rayuCredits.ts` / `rayuEntitlements.ts` already talk to the backend for credits. No top-up command exists yet.

So: schema is staged, KHQR top-up create + activate is partial, but the **full flow is not shipped** — no Stripe top-up, no CLI top-up command, no pricing preview endpoint, no gateway-side quote that guarantees the CLI's price matches the backend, no idempotent grant that writes `CreditLedger`, no admin toggle to enable/disable top-up.

## CRITICAL RULES (per RAYU.md)

### Rule 1: NO ASSUMPTIONS — Read the Code First
Do NOT guess how credits are granted or how the gateway reads them. Before writing:
- ✅ READ `payments.service.ts` fully — `createTopupKhqr`, `activatePaid` (top-up branch), `isCreditPlan`, `computeCarryoverCredits`, and any existing credit-grant helper. The top-up grant must reuse the existing grant path, not duplicate it.
- ✅ READ `src/settings/app-settings.service.ts` — how `creditsPerDollar` / `minTopupCents` / `baselineCreditsPer1M` are read and cached. The top-up service must read these live (with the existing cache), never hardcode the rate.
- ✅ READ `src/usage/` and any `grantCredits` / `addCredits` helper to learn the exact write path into `CreditLedger` and the user's credit balance. The top-up grant must go through it.
- ✅ READ `rayu-gateway/internal/credits/credits.go` and `limiter.go` — learn how the gateway reads `AppSettings` and how a top-up grant must surface to the gateway's per-user credit balance (likely via the same MySQL tables the gateway polls, since the gateway does not call the backend).
- ✅ READ `rayu/src/services/rayuAuth/rayuCredits.ts` and `rayuPlansCatalog.ts` — learn how the CLI already fetches credit balance and plan pricing; the top-up command must reuse the same client.
- ✅ READ the existing `createTopupKhqr` implementation to learn the exact amount calculation (credits → `creditsPerDollar` → `amountCents`) and the `minTopupCents` floor enforcement, so Stripe/CLI paths replicate the same math, not a divergent copy.
- ✅ Check `ORIGIN_MANIFEST.md` (CLI side) for any CLI files you touch.
- ❌ DON'T hardcode `creditsPerDollar`, `minTopupCents`, `baselineCreditsPer1M`, or any per-model price. All come from `AppSettings` at runtime.
- ❌ DON'T invent a new credit-balance store. The gateway reads MySQL directly; the grant must write to the same tables the gateway already reads.

### Rule 2: Search Before Writing
- Grep `rayu-backend/src/` for `creditsPerDollar`, `minTopupCents`, `grantCredits`, `addCredits`, `creditTopup`, `CreditLedger` to enumerate every consumer of the top-up + grant path.
- Grep the gateway for `creditsPerDollar`, `minTopupCents`, `CreditTopup` to confirm what the gateway already reads and what must be added so a top-up grant is visible to the gateway without a backend call.
- Grep the CLI (`rayu/src/`) for any partial top-up command or billing screen before creating one.

### Rule 3: Follow Project Conventions
- Backend: NestJS + Prisma + MySQL, `npm run start:dev` / `npm run build` / `npm test` / `npm run migrate:dev`. New code under `src/payments/topup/` (or extend `src/payments/`); register in `payments.module.ts`.
- Gateway: Go 1.24 + chi + Redis, `go run ./cmd/gateway` / `go test ./...`. No new credit-balance store — read MySQL.
- CLI: TypeScript + Bun, do NOT convert feature-gated `require()` to static `import` (`feature('FLAG')` is compile-time DCE). Lazy-load the top-up command UI.
- All pricing constants come from `AppSettings` (admin-editable at runtime). The only hardcoded numbers allowed are unit-conversion constants already in the schema (`baselineCreditsPer1M` etc.) and those are also `AppSettings` fields, not source constants.

## Goal

A logged-in user can buy additional credits at any time, regardless of their plan. The price is quoted from the live `AppSettings.creditsPerDollar` rate (with the `minTopupCents` floor), the purchase goes through any available rail (ABA, Bakong KHQR, or Stripe), and on success the credits are granted idempotently and made visible to the gateway's credit limiter without a backend round-trip. The admin can enable/disable top-up and change the rate at runtime by editing `AppSettings` — no code change, no redeploy.

## Required Plan (write in detail)

### 1. Discovery & Audit (no code yet)
- Read `payments.service.ts` `createTopupKhqr` and `activatePaid` end-to-end. Document the exact: credit → cents math (`amountCents = ceil(credits / creditsPerDollar * 100)` or the existing formula — use the existing one), `minTopupCents` floor enforcement, KHQR TTL, the `Payment` + `CreditTopup` row creation, and the idempotent paid-transition.
- Read `app-settings.service.ts` and document the cache TTL for `creditsPerDollar` / `minTopupCents`. The top-up service must read through the same cache so an admin rate change takes effect within that TTL.
- Read the gateway `credits.go` / `limiter.go` and document exactly how the gateway observes a user's credit balance today (MySQL `CreditLedger` aggregate? a denormalized column? Redis?). The top-up grant must write to whatever the gateway already reads — if the gateway reads a denormalized `User.creditBalance`, the grant must update it in the same transaction.
- Read the CLI `rayuCredits.ts` / `rayuEntitlements.ts` / `rayuPlansCatalog.ts` and document the endpoint(s) the CLI uses today for credit balance and plan pricing. The top-up command must reuse the same client + auth.
- Decide whether top-up is gated by `creditsPerDollar > 0` (yes — `0` means unavailable, per the schema comment) and surface that state to the CLI so it can hide/disable the top-up command.

### 2. Backend — Pricing Preview Endpoint (no payment creation)
- `GET /payments/topup/quote?credits=N` (or `POST` with a body — match existing convention) — returns `{ enabled, credits, amountCents, currency, minCredits, maxCredits, rateCreditsPerDollar, minTopupCents }` computed **live** from `AppSettings`. `enabled = creditsPerDollar > 0`. Enforce `minTopupCents` (convert back to a `minCredits` floor so the CLI can clamp the input). No `Payment` row created; pure quote.
- This endpoint is the single source of truth for the CLI's top-up UI pricing. The CLI must NOT compute the price locally from a hardcoded rate — even though the schema comment says the gateway bakes the rate so the CLI can quote without a backend call, the top-up quote must hit this endpoint (or the gateway's quote endpoint, see §4) so an admin rate change is reflected immediately.

### 3. Backend — Unified Top-Up Create + Grant (all rails)
- Refactor the existing `createTopupKhqr` so the credit → cents pricing + `CreditTopup` row creation is a single `createTopupPayment(userId, credits, method)` that all rails call:
  - `method = 'aba' | 'bakong'` → existing KHQR/ABA path (returns QR + `paymentId`).
  - `method = 'stripe'` → returns a Stripe Checkout Session URL (depends on the Stripe plan; if Stripe is not yet integrated, gate `method = 'stripe'` behind `STRIPE_ENABLED` and return 501 / clear error when unavailable). The Stripe path reuses the Checkout Session creation from the Stripe integration plan, with `client_reference_id` carrying `userId + topupId` and `metadata.kind = 'topup'`.
- Keep `activatePaid` as the **single** grant entrypoint. Its existing top-up branch already does the idempotent `Payment` → `paid` + `CreditTopup` → `paid` flip; extend it to also **write the credit grant** through the shared grant helper (from §1 discovery) in the same transaction, and **update the gateway-visible credit balance** (the denormalized column or `CreditLedger` aggregate the gateway reads) so the gateway sees the new credits without a backend call.
- Document the idempotency contract: the `updateMany({ where: { status: 'pending' } })` returning `count === 0` means another caller already activated — return the already-activated state, do not grant twice. This already exists; preserve it.
- Refund path (Stripe `charge.refunded` or ABA reversal, if applicable): claw back the granted credits via the existing clawback policy (define the minimal policy if none exists — e.g. never go negative; clamp at 0 and log).

### 4. Gateway — Quote Endpoint (so CLI can quote without backend)
- Per the schema comment, the gateway bakes `creditsPerDollar` / `minTopupCents` so the CLI can quote a price without calling the backend. Add `GET /v1/credits/topup/quote?credits=N` to `rayu-gateway` that reads `AppSettings` from MySQL (the gateway already reads MySQL independently, per RAYU.md) and returns the same shape as the backend's `/payments/topup/quote`. The CLI calls the gateway (it already talks to the gateway for AI calls), avoiding a backend round-trip in the common case.
- The gateway must NOT grant credits — it only quotes. Granting stays in the backend (`activatePaid`) so there is one write path.
- Document the cache TTL the gateway uses for `AppSettings` (it already caches entitlements; reuse the same cache for the quote).

### 5. CLI — Top-Up Command
- `rayu/src/commands/billing/` — add a top-up flow (slash command, e.g. `/topup` or extend `/billing`). Lazy-load the UI; do not bloat the main bundle.
- UX:
  1. Fetch the quote from the gateway (`/v1/credits/topup/quote`) — show the user their current balance, the live `creditsPerDollar` rate, the `minCredits` floor, and the resulting price for a default amount.
  2. Let the user pick a credit amount (input, clamped to `minCredits` and a sane max — `CreateTopupDto` already enforces `1..100_000_000`).
  3. Show available payment methods (ABA, Bakong KHQR, Stripe if enabled) — reuse the existing provider/method discovery so this is not hardcoded.
  4. Call the backend `POST /payments/topup-khqr` (or the Stripe Checkout endpoint) to create the pending purchase.
  5. Render the QR (KHQR) or open the Stripe Checkout URL; poll `GET /payments/:id/status` until paid/expired (reuse the existing poll path used by plan purchases).
  6. On paid, refresh the credit balance via `rayuCredits.ts` and show the new total.
- If `enabled = false` (`creditsPerDollar === 0`), hide/disable the command with a clear message ("Credit top-up is not enabled on this server").
- No hardcoded rate anywhere in the CLI — every price shown comes from a quote endpoint response.

### 6. Admin Surface
- The admin already edits `creditsPerDollar` / `minTopupCents` on the Plans & Credits page (per the schema comment). Verify the existing admin controller writes through `app-settings.service.ts` and that the cache invalidation reaches both the backend top-up service and the gateway (the gateway may need a cache-bust on admin save — document the invalidation path; if none exists, add a `POST /admin/settings/invalidate` or rely on TTL).
- No new admin endpoints required for v1 unless cache invalidation is missing.

### 7. Verification Plan
- Backend: `npm run typecheck`, `npm run build`, `npm test`, `npm run test:e2e`.
  - Unit: `topup.quote` reads `AppSettings` live and clamps `minTopupCents`; `createTopupPayment` rejects when `creditsPerDollar === 0`; `activatePaid` grants exactly once under concurrent calls (simulate two concurrent `activatePaid` on the same `paymentId`, assert one grant); refund clawback clamps at 0.
  - e2e: create top-up → pending → simulate paid → assert `CreditTopup.status = paid`, `CreditLedger` row written with `source = 'topup'`, gateway-visible balance updated, and a replayed paid event does not double-grant.
- Gateway: `go test ./...` — add a test for `/v1/credits/topup/quote` returning the live rate from `AppSettings` and clamping `minTopupCents`.
- CLI: `bun run typecheck`, `bun run build` (verify lazy-load — no bundle bloat), `bun run dev`.
  - Unit: the quote-fetch + clamp + render logic with a mocked gateway response.
  - Manual: `/topup` with a test backend that has `creditsPerDollar > 0` — confirm the quoted price matches the admin-set rate, complete a KHQR payment, confirm credits granted and balance refreshed; change `creditsPerDollar` in admin and confirm the new rate is quoted without a CLI restart.
  - Manual: set `creditsPerDollar = 0` in admin, confirm the CLI shows "top-up not enabled".

### 8. Risks
- **Hardcoded rate drift** — any constant rate in code will silently diverge from the admin-set rate. The plan explicitly forbids it; review must grep for any numeric literal that looks like a credit/dollar rate.
- **Gateway/backend rate mismatch** — if the gateway quotes from a stale `AppSettings` cache, the CLI shows one price and the backend charges another. Pin the cache TTL and document it; the backend `createTopupPayment` is the authoritative price — if the amount computed there differs from the quote by more than rounding, reject with a clear "price changed" error and re-quote.
- **Double-grant** — `activatePaid` is already idempotent via `updateMany` count; preserve it. The grant helper inside the transaction must also be idempotent (e.g. unique constraint on `(topupId)` in `CreditLedger` or a `grantedAt` guard on `CreditTopup`).
- **Gateway balance drift** — if the grant writes `CreditLedger` but not the denormalized balance the gateway reads, the user pays but the gateway still rate-limits them. Confirm the exact column/aggregate the gateway reads and update it in the same transaction.
- **Refund clawback** — define the minimal policy before implementing `charge.refunded` (Stripe) / ABA reversal: never go below 0, log the clawback, write a `CreditLedger` row with negative credits and `source = 'refund'`.
- **CLI bundle bloat** — top-up UI must be lazy-loaded; do not import the billing/topup modules at CLI startup.
- **DCE** — do NOT convert feature-gated `require()` in the touched CLI files to static `import`.
- **Concurrency on `activatePaid`** — already handled by `updateMany` count; do not weaken it.
- **minTopupCents vs minCredits** — the floor is in cents; the CLI input is in credits. The conversion must use the live rate, so `minCredits = ceil(minTopupCents / 100 * creditsPerDollar)`. Recompute on every quote; never cache the derived value across rate changes.

## Acceptance Criteria

- [ ] `GET /payments/topup/quote` (backend) and `GET /v1/credits/topup/quote` (gateway) return the live price from `AppSettings` — `enabled`, `credits`, `amountCents`, `minCredits`, `rateCreditsPerDollar`, `minTopupCents`. No hardcoded rate anywhere.
- [ ] `createTopupPayment` (all rails) reads `creditsPerDollar` / `minTopupCents` live, enforces the floor, rejects when `creditsPerDollar === 0`, and creates a pending `Payment` + `CreditTopup`.
- [ ] `activatePaid` grants credits **exactly once** per top-up, in a Prisma transaction, via the shared grant helper, writing a `CreditLedger` row with `source = 'topup'` and updating the gateway-visible credit balance.
- [ ] Concurrent `activatePaid` calls on the same `paymentId` grant exactly once (idempotent via `updateMany` count).
- [ ] Refund/clawback path clamps the balance at 0 and writes a `CreditLedger` row with `source = 'refund'`.
- [ ] Gateway quote endpoint reads `AppSettings` from MySQL with the same TTL as entitlements; never grants credits.
- [ ] CLI `/topup` (or extended `/billing`) fetches the quote, clamps input to `minCredits`, creates the purchase via the right rail, polls to paid, and refreshes the balance — with no hardcoded rate.
- [ ] When `creditsPerDollar = 0` (admin-disabled), the quote returns `enabled = false`, the backend rejects creation, and the CLI hides/disables the command.
- [ ] Changing `creditsPerDollar` in admin is reflected in the next quote (within the documented TTL) — no code change, no redeploy.
- [ ] Backend: `npm run typecheck` / `npm run build` / `npm test` / `npm run test:e2e` pass; ABA/Bakong plan-purchase paths unchanged.
- [ ] Gateway: `go test ./...` passes.
- [ ] CLI: `bun run typecheck` / `bun run build` / `bun run dev` pass; top-up module is lazy-loaded (no main-bundle bloat).
- [ ] No duplicated grant logic — ABA, Bakong, and Stripe all flow through the same `activatePaid` grant path.