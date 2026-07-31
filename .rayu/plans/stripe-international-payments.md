# Add Stripe International Payments to rayu-backend

## Improved Prompt

As a senior software engineer, add a **Stripe-based international payment path** to the existing rayu-backend billing system, following the official Stripe documentation at <https://docs.stripe.com/>. This must coexist with the current local payment rails (ABA + Bakong KHQR) — Stripe handles international cards, subscriptions, and payouts; ABA/Bakong continue to serve the local market.

## Current State (verified by reading the code)

The payments module lives at `rayu-backend/src/payments/` and currently supports only **local Cambodian rails**:
- `payments.service.ts` — `PaymentsService` with `PaymentMethod = 'aba' | 'bakong'`. KHQR (Bakong) pending payments have a 30-minute TTL (`KHQR_TTL_MINUTES`), an ABA out-of-band match grace window (`ABA_MATCH_GRACE_MS`), and a carryover-credits routine for credit-based plans.
- `aba.service.ts` + `aba-telegram.listener.ts` — ABA credit-alert matching via a Telegram listener.
- `bakong.service.ts` — KHQR generation.
- `payments.controller.ts` + `payments.module.ts` — REST endpoints for creating / renewing / checking payment status.
- Prisma schema (`prisma/schema.prisma`) has `Plan`, `Subscription`, `Payment` (with `currency String @default("USD") @db.VarChar(8)`), `CreditLedger`, `CreditTopup`, `PromoCode`, `PromoRedemption`. No Stripe fields, no Stripe customer/subscription/price IDs, no webhook event log.
- `package.json` has **no Stripe SDK** installed (verified — no `stripe`, `@stripe/stripe-js`, etc.).

So the task is: integrate Stripe as a **first-class international payment method** alongside the existing local rails, without disturbing the ABA/Bakong paths.

## CRITICAL RULES (per RAYU.md)

### Rule 1: NO ASSUMPTIONS — Read the Code First
Do NOT guess how the current billing flow works. Before writing:
- ✅ READ `rayu-backend/src/payments/payments.service.ts` end-to-end to learn the exact `Payment` lifecycle (create → pending → paid/expired), the `isCreditPlan` / `computeCarryoverCredits` logic, the promo application path, and how a successful payment activates a `Subscription` and grants credits.
- ✅ READ `payments.controller.ts` and `payments.module.ts` to learn the exact route shapes, auth guards, and DTOs so the new Stripe endpoints match the existing conventions.
- ✅ READ `rayu-backend/src/plans/` and `prisma/schema.prisma` `Plan` / `Subscription` / `Payment` models to learn which fields exist and which must be added (e.g. Stripe price IDs, Stripe customer IDs, Stripe subscription IDs, webhook event IDs).
- ✅ READ `rayu-backend/src/promo/promo.service.ts` to learn how promo codes are applied — Stripe Checkout must mirror the same discount logic (promo codes must work via Stripe Coupons/Promotion Codes, not only server-side).
- ✅ READ `rayu-backend/src/usage/` and `src/settings/app-settings.service.ts` to learn how credits/entitlements are granted after a successful payment — the Stripe success path must reuse the same grant logic, not duplicate it.
- ✅ READ `src/services/rayuAuth/` in the CLI (`rayu/src/services/rayuAuth/rayuPlansCatalog.ts`, `rayuEntitlements.ts`) to learn how the CLI fetches plan/pricing — Stripe-backed plans must surface through the same catalog endpoint so the CLI needs no changes.
- ✅ Check `ORIGIN_MANIFEST.md` (CLI side) for provenance of any CLI files you touch (you probably shouldn't touch the CLI at all for v1).
- ❌ DON'T assume Stripe's API shape from memory. Pull the exact request/response schemas and webhook event names from <https://docs.stripe.com/> (Payments, Checkout Sessions, Customer Portal, Webhooks, Subscriptions, Invoicing, Tax).
- ❌ DON'T replace ABA/Bakong. Stripe is **additive** for international users.

### Rule 2: Search Before Writing
- Grep `rayu-backend/src/` for any partial Stripe references (`stripe`, `Stripe`, `checkout.session`, `payment_intent`) — there may already be a stub or env var. Reuse before creating.
- Grep for `currency`, `USD`, `KHR` to learn how multi-currency is currently handled (the schema defaults to USD, but ABA/Bakong operate in KHR/USD — confirm before assuming).
- Grep for existing webhook handlers in the backend to mirror the pattern for Stripe webhook ingestion.

### Rule 3: Follow Project Conventions
- NestJS + Prisma + MySQL, npm (not Bun) — `npm run start:dev`, `npm run build`, `npm test`, `npm run migrate:dev`.
- New code goes under `rayu-backend/src/payments/stripe/` (new subdirectory) and/or a sibling `stripe/` module; register it in `payments.module.ts` and `app.module.ts` as appropriate.
- All Stripe secrets live in env (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, etc.) — never in the DB, never logged. Use `rayu-backend/.env.example` to document new vars.
- Follow the existing DTO + service + controller pattern. Do not introduce a different architectural style.
- Idempotency: every Stripe webhook must be idempotent (store `stripe_event_id` and skip on replay). Mirror the existing ABA grace-window matching discipline.
- The CLI side must not require changes for v1 — Stripe plans surface through the existing catalog endpoint.

## Goal

International users can pay for a Rayu plan using **Stripe** with cards and (optionally) other international payment methods, in their local currency where Stripe supports it. Recurring subscriptions, invoices, and a customer portal are handled by Stripe. Successful Stripe payments grant the same credits/entitlements as ABA/Bakong, through the same code path. ABA/Bakong continue to serve the local market unchanged.

## Required Plan (write in detail)

### 1. Discovery & Audit (no code yet)
- Read the full `payments.service.ts`, `payments.controller.ts`, `payments.module.ts`, `aba.service.ts`, `bakong.service.ts`, `promo.service.ts`, and the `Plan`/`Subscription`/`Payment`/`CreditLedger`/`CreditTopup` models. Document the exact happy path: `createPayment` → pending → success → grant entitlements → write ledger.
- Pull the current Stripe integration patterns from <https://docs.stripe.com/>: **Checkout Sessions** (`docs/stripe-js/checkout`), **Subscriptions** (`docs/billing/subscriptions/overview`), **Webhooks** (`docs/webhooks`), **Customer Portal** (`docs/billing/customer-portal`), **Invoicing** (`docs/invoicing/overview`), **Tax** (`docs/tax`), and **Payment Methods** (`docs/payments/payment-methods`). Document the exact endpoints, required parameters, webhook event names (`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`), and signature verification flow.
- Decide the Stripe product/price model: one Stripe Product per `Plan`, one or more Stripe Prices (per currency / per billing interval) per Product. Decide where to store the Stripe IDs (extend the `Plan` model or a new `PlanStripeConfig` table). Justify in the plan.
- Decide currency strategy: USD-only for v1 (simplest, matches the existing schema default) vs. multi-currency via Stripe's automatic currency conversion. Pick one and justify. Multi-currency should be a documented follow-up, not a v1 blocker.
- Decide the checkout flow: **Stripe-hosted Checkout** (lowest integration cost, recommended for v1) vs. **Custom Payment Element** (more control, heavier). Pick one and justify.
- Decide webhook handling: a single Stripe webhook endpoint with signature verification via the raw request body (NestJS raw-body requirement — verify how to capture the raw body in this NestJS setup before coding).

### 2. Schema Migration (Prisma)
- Add Stripe fields to `Plan` (or new `PlanStripeConfig`): `stripeProductId`, `stripePriceIdUsd` (and per-currency price IDs if multi-currency), `stripePriceIdMonthly`, `stripePriceIdAnnual` (if annual billing exists). Nullable, so ABA/Bakong-only plans remain valid.
- Add Stripe fields to `Subscription`: `stripeCustomerId`, `stripeSubscriptionId`, `stripePriceId`, `stripeStatus`, `stripeCurrentPeriodEnd`, `stripeCancelAtPeriodEnd`.
- Add Stripe fields to `Payment`: `stripeCheckoutSessionId`, `stripePaymentIntentId`, `stripeInvoiceId`, `stripeChargeId` (all nullable; existing ABA/Bakong rows stay null).
- New `StripeWebhookEvent` model: `id`, `stripeEventId` (unique), `type`, `createdAt`, `processedAt`, `rawPayload` (JSON). Used for idempotency and replay forensics.
- Generate a Prisma migration (`npm run migrate:dev -- --name add_stripe`) and update `src/seed.ts` / `plans/` seed so each plan that should be Stripe-billable gets a Stripe product+price created via the Stripe API on seed (use `stripe.products.create` + `stripe.prices.create`, idempotent on `idempotency_key`).

### 3. Backend Implementation (file-by-file)
- `rayu-backend/src/payments/stripe/stripe.config.ts` — load `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_TOLERANCE`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL` from env. Validate at boot; fail loudly if missing when Stripe is enabled.
- `rayu-backend/src/payments/stripe/stripe.client.ts` — singleton `Stripe` SDK instance (from the `stripe` npm package, installed via `npm i stripe`). Configure `apiVersion` to a pinned version (do not use `null`). Use `appInfo` to identify as `rayu-backend`.
- `rayu-backend/src/payments/stripe/stripe.service.ts` — wraps the SDK for the few operations we need: `createCheckoutSession`, `createCustomerPortalSession`, `createBillingPortalSession`, `constructWebhookEvent` (signature verification), `retrieveSubscription`, `cancelSubscription`, `listInvoices`. No business logic here — just SDK wrapping.
- `rayu-backend/src/payments/stripe/stripe.payments.service.ts` — the business layer: maps a `Plan` + user → Stripe Checkout Session (line_items from the plan's Stripe price, promo code applied via Stripe `discounts`/`promotion_codes`, `client_reference_id` = userId + planId + promoId, `metadata` carrying everything needed to grant entitlements on webhook), creates a pending `Payment` row, returns the Checkout URL. On webhook `checkout.session.completed`, mark the `Payment` paid, activate the `Subscription`, grant credits via the **existing** `PaymentsService` grant path (reuse, don't duplicate), record `StripeWebhookEvent`.
- `rayu-backend/src/payments/stripe/stripe.webhooks.controller.ts` — `POST /payments/stripe/webhook` with **raw body** + Stripe signature header verification. Dispatch each event type to the right handler (`checkout.session.completed` → grant; `invoice.paid` → renew recurring period; `invoice.payment_failed` → mark past_due; `customer.subscription.deleted` → expire; `charge.refunded` → claw back credits per existing refund logic). Idempotent via `StripeWebhookEvent.stripeEventId` unique constraint.
- `rayu-backend/src/payments/stripe/dto/` — DTOs for `CreateStripeCheckoutDto` (planCode, promoCode?, billingInterval?), `CreatePortalSessionDto`. Validate against existing `Plan` catalog and promo rules.
- `rayu-backend/src/payments/stripe/stripe.module.ts` — NestJS module wiring; register in `payments.module.ts` and `app.module.ts`. Export `StripeService` and `StripePaymentsService` for reuse by the existing `PaymentsService`.
- `rayu-backend/src/payments/payments.service.ts` — extend `PaymentMethod` to `'aba' | 'bakong' | 'stripe'`. Add a `payViaStripe` entrypoint that delegates to `StripePaymentsService`. The grant-entitlements-on-success path stays in `PaymentsService` and is called by the Stripe webhook handler so ABA/Bakong/Stripe all share one grant code path.
- `rayu-backend/src/payments/payments.controller.ts` — add `POST /payments/stripe/checkout` (create Checkout Session), `POST /payments/stripe/portal` (create Customer Portal session), and the webhook route (or put the webhook in its own controller as above). Auth-guard the user-facing routes; the webhook route is **public** but signature-verified.

### 4. Webhook Security & Idempotency
- Capture the **raw request body** for Stripe signature verification (NestJS requires `rawBody` — verify how this backend currently parses JSON and configure a raw-body route for the webhook). Document the exact config in the plan.
- Verify signature with `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET, tolerance)`. Reject on `SignatureVerificationError`.
- Persist `StripeWebhookEvent` **before** processing; if `stripeEventId` already exists, return 200 without reprocessing.
- All grant/side-effect operations run in a Prisma transaction; on failure, mark the event as failed and surface the error to logs (never expose internals to the client).
- Stripe retries failed webhooks — returning non-2xx causes retries, so only return non-2xx for transient errors (DB down). For permanent errors (bad data), log + return 200 to stop retries.

### 5. Promo Codes & Discounts
- Reuse the existing `PromoService` to validate promo eligibility server-side before creating the Checkout Session.
- Map Rayu promo codes to Stripe `promotion_codes` (percent/fixed) where possible, so the discount shows in the Stripe-hosted UI. Where Stripe cannot represent a Rayu promo (e.g. per-plan scoping edge cases), apply the discount server-side after `checkout.session.completed` via a credit adjustment — document this fallback explicitly.
- Promo redemption records (`PromoRedemption`) are written on webhook success, mirroring the ABA/Bakong path.

### 6. Recurring Subscriptions
- For credit-based plans, the recurring grant happens on `invoice.paid` (each billing cycle), reusing the same `grantCreditsForPeriod` path as ABA/Bakong renewals.
- For non-credit plans, `invoice.paid` extends `Subscription.currentPeriodEnd` and refreshes entitlements.
- `invoice.payment_failed` → mark `Subscription.status = 'past_due'`; after Stripe's dunning cycle, `customer.subscription.deleted` → expire the subscription.
- `charge.refunded` → claw back credits per the existing refund/clawback policy; if the refund policy doesn't exist yet, document it in the plan and implement the minimal version.

### 7. Configuration & Secrets
- Add to `rayu-backend/.env.example`: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` (for the web dashboard, if needed), `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_TOLERANCE` (default 300s), `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL`, `STRIPE_ENABLED` (feature flag).
- Document the local dev setup: Stripe CLI (`stripe listen --forward-to localhost:4000/api/payments/stripe/webhook`) with a separate `STRIPE_WEBHOOK_SECRET` for local testing.

### 8. CLI / Web Surface (v1 scope decision)
- The CLI's plan catalog must surface Stripe-billable plans automatically once they have Stripe price IDs in the catalog endpoint — verify this by reading the catalog service; if a change is needed, keep it minimal.
- The web (`rayu-web/`) "Subscribe" button for international users should POST to the new Checkout endpoint. If the web changes are out of scope for v1, document them as a follow-up and provide a minimal cURL/test path for verifying the flow end-to-end.

### 9. Verification Plan
- `npm run typecheck` (rayu-backend)
- `npm run build`
- `npm test` — add unit tests for `stripe.service.ts` (mocked SDK), `stripe.payments.service.ts` (create Checkout Session → pending Payment), and the webhook handler (event idempotency, signature failure, each event type → correct grant/expire/refund side effect). Use the Stripe CLI to replay real events locally.
- `npm run test:e2e` — extend e2e with: create Checkout Session (mock Stripe), simulate `checkout.session.completed` webhook, assert Subscription activated + credits granted + `StripeWebhookEvent` recorded; replay the same webhook and assert no double-grant.
- Manual: end-to-end with a real Stripe test card (`4242 4242 4242 4242`), confirm Checkout → success URL → credits granted → Customer Portal → cancel → `customer.subscription.deleted` webhook → entitlements revoked.

### 10. Risks
- **Webhook raw body** — NestJS JSON parsing corrupts the signature. Verify the raw-body config before coding the webhook.
- **Currency mismatch** — `Payment.currency` defaults to USD; Stripe may charge in other currencies. Normalize to a single `currency` per `Payment` row and store the original Stripe amount/currency in metadata.
- **Idempotency races** — Stripe can deliver the same event twice concurrently. The unique `stripeEventId` constraint + transaction prevents double-grant, but the code must handle the unique-constraint violation gracefully (catch, return 200).
- **Promo discount divergence** — if Stripe's displayed discount differs from the server-side promo discount, users see a mismatch. Either always use Stripe `promotion_codes` for the displayed amount, or hide the discount from Stripe's UI and apply server-side (pick one, document it).
- **Recurring grant drift** — `invoice.paid` and `customer.subscription.updated` can both fire; ensure grants happen exactly once per period (use the invoice ID as the idempotency key for grants).
- **Refund clawback** — if no existing refund/clawback policy exists in ABA/Bakong, define the minimal policy before implementing the Stripe `charge.refunded` handler.
- **Key rotation** — Stripe key rotation must not drop in-flight webhooks; document the rotation procedure.
- **DCE / CLI bundle** — no CLI changes for v1, so no DCE risk.

## Acceptance Criteria

- [ ] Stripe SDK installed and a singleton client configured from env; secrets never logged.
- [ ] `Plan` (or `PlanStripeConfig`) carries `stripeProductId` + per-interval/currency `stripePriceId`s; ABA/Bakong-only plans remain valid with null Stripe fields.
- [ ] `Subscription` and `Payment` carry Stripe linkage fields; a new `StripeWebhookEvent` model provides idempotent webhook processing.
- [ ] `POST /payments/stripe/checkout` creates a Stripe Checkout Session for a valid plan + optional promo, returns the Checkout URL, and creates a pending `Payment`.
- [ ] `POST /payments/stripe/webhook` verifies the Stripe signature against the raw body, dispatches `checkout.session.completed` / `invoice.paid` / `invoice.payment_failed` / `customer.subscription.deleted` / `charge.refunded` to the correct handlers, and is idempotent via `stripeEventId`.
- [ ] Successful Stripe payment grants the same credits/entitlements as ABA/Bakong via the **shared** `PaymentsService` grant path (no duplication).
- [ ] Recurring `invoice.paid` extends the subscription period and grants per-period credits exactly once per invoice.
- [ ] Customer Portal session can be created for an existing Stripe customer.
- [ ] Promo codes (percent/fixed) apply via Stripe `promotion_codes` where representable, with a documented server-side fallback.
- [ ] ABA/Bakong paths unchanged and still passing their existing tests.
- [ ] `npm run typecheck`, `npm run build`, `npm test`, `npm run test:e2e` all pass.
- [ ] `.env.example` documents all new Stripe env vars; Stripe is disabled when `STRIPE_ENABLED=false` so existing deployments keep working without Stripe keys.