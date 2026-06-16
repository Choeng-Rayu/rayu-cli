# PA Plan — System Admin + Bakong KHQR Payment

## Objective
Add (1) a System Admin surface to manage ALL users — list/view, change plan (free<->paid), and view payment history — and (2) a Bakong KHQR payment flow for paid plan upgrades. Built on the existing Rayu accounts platform (NestJS+Prisma backend, Next.js frontend). Do NOT touch `/home/rayu/rayu-cli/rayu/`.

## Key Findings (current state)
The platform already has most primitives — this is mostly **wiring + Bakong**, not greenfield:
- **Schema** (`rayu-backend/prisma/schema.prisma`): `User.role` (default "user"), `Plan` (code/priceCents/availability/limits), `Subscription` (userId/planId/status), and a **`Payment` table already exists** (userId, provider default "bakong", amountCents, currency, status pending/paid/failed, externalRef, createdAt). Relations already wired (`User.payments`, `User.subscriptions`).
- **Enums** (`src/common/enums.ts`): `USER_ROLES=['user','admin','superadmin']`, `PLAN_CODES=['free','pro','pro_plus','max','enterprise']`, `PAYMENT_STATUSES=['pending','paid','failed']`, `SUBSCRIPTION_STATUSES=['active','canceled']`. Use these; do NOT add Prisma native enums.
- **Auth/roles already done**: `RayuAuthGuard` (Bearer -> live user) + `RolesGuard` + `@Roles(...)` decorator. `AdminController` already exists (`src/admin/admin.module.ts`) guarded with `@UseGuards(RayuAuthGuard, RolesGuard) @Roles('admin','superadmin')` and has `GET /admin/users`, `PATCH /admin/users/:id/status`, `GET /admin/stats`.
- **Admin web page exists** (`rayu-web/app/admin/page.tsx`): exchanges Clerk token via `POST /api/web/session`, lists users, supports status changes, handles 403. We extend it — no new auth plumbing.
- **Plan currently paid-disabled**: `plans.constants.ts` marks pro/pro_plus/max as `coming_soon`; `/plans` page renders CTA disabled. Upgrade flow must flip the active plans to purchasable.
- **Web -> API auth pattern**: `useAuth().getToken()` (Clerk) -> `POST /api/web/session` -> `{accessToken}` -> call API with `Authorization: Bearer`. `apiUrl()` from `rayu-web/lib/config.ts`.
- **Backend deps**: NO bakong package installed yet (`rayu-backend/package.json`). Must add `bakong-khqr` (or the Choeng-Rayu wrapper). API prefix is `/api`; global ValidationPipe with `forbidNonWhitelisted`.

## Approach
**Chosen: extend existing modules in place + add one new `payments` module.** Reuse the existing `Payment` table and `Subscription` model; add a `planId` column to `Payment` to link a payment to the plan it buys, and add the admin plan-change + payment-history endpoints to the existing `AdminController`. Bakong lives in a dedicated `PaymentsModule` (controller + service) so secrets and the SDK stay isolated.

**Alternative considered: a separate `billing` bounded-context module owning Payment+Subscription+Bakong.** Rejected — Subscription is already managed in `UsersService.assignFreePlan` and Plan logic in `PlansService`; carving out a new owner would fragment plan logic and duplicate the upsert/active-subscription rule. Extending in place keeps one source of truth and a smaller blast radius.

**Bakong: server-side QR generate + poll-by-MD5 (no public webhook).** The NBC Bakong API supports `check_transaction_by_md5`; a hosted webhook is not reliably available, so the frontend polls a guarded status endpoint that re-checks the MD5 server-side. Activation is driven only by a verified PAID result — never by the client.

## Schema changes (exact Prisma additions — `rayu-backend/prisma/schema.prisma`)
Add `planId` (+ optional `md5`/`khqr` for verification & idempotency) to the existing `Payment` model. Keep enum-as-string convention.

```prisma
model Payment {
  id          Int      @id @default(autoincrement())
  userId      Int      @map("user_id")
  planId      Int?     @map("plan_id")            // ADD: plan this payment upgrades to
  provider    String   @default("bakong") @db.VarChar(64)
  amountCents Int      @default(0)
  currency    String   @default("USD") @db.VarChar(8)
  status      String   @default("pending") @db.VarChar(32)  // pending|paid|failed
  externalRef String?  @db.VarChar(191)          // Bakong txn ref once paid
  md5         String?  @unique @db.VarChar(64)    // ADD: KHQR md5, lookup key
  khqr        String?  @db.Text                   // ADD: generated KHQR string
  createdAt   DateTime @default(now())
  paidAt      DateTime?                            // ADD

  user User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  plan Plan? @relation(fields: [planId], references: [id])  // ADD relation

  @@index([userId])
  @@map("payments")
}
```
Add the back-relation on `Plan`:
```prisma
model Plan {
  // ...existing fields...
  subscriptions Subscription[]
  payments      Payment[]   // ADD
}
```
Migration: `npx prisma migrate dev --name add_payment_plan_khqr` (dev) / `prisma migrate deploy` (prod). Run `prisma generate`. Existing rows: new columns are nullable — safe, no backfill.

Also flip the purchasable plans in `src/plans/plans.constants.ts` from `availability: 'coming_soon'` to `'active'` for `pro` (and any tiers to sell now); leave `enterprise` as contact-sales. Seed is idempotent on boot (`AppModule.onModuleInit`).

## API contracts

### Admin (extend `src/admin/admin.module.ts` controller + `admin.service.ts`)
All under `@Roles('admin','superadmin')` + both guards (already on the controller class).

1. `GET /api/admin/users` — EXISTS. Returns `{ items, total, page, pageSize }`. (No change required; optionally include active plan code per row — see #2 detail endpoint instead to keep list cheap.)

2. `GET /api/admin/users/:id` — NEW. Full user detail.
   - Resp `200`: `{ user: { id, email, displayName, avatarUrl, role, status, createdAt, lastActiveAt }, plan: { code, name, priceCents } | null, subscription: { id, status, startedAt, currentPeriodEnd } | null }`
   - `404` if not found.

3. `GET /api/admin/users/:id/payments` — NEW. Payment history for a user.
   - Query: `page` (default 1), `pageSize` (default 20, max 100).
   - Resp `200`: `{ items: Array<{ id, planCode: string|null, provider, amountCents, currency, status, externalRef, md5, createdAt, paidAt }>, total, page, pageSize }`

4. `PATCH /api/admin/users/:id/plan` — NEW. Change a user's plan (free<->paid).
   - Body: `{ planCode: PlanCode }` (validated with `@IsIn(PLAN_CODES)`).
   - Behavior: cancel current active Subscription, create a new active Subscription on the target plan (admin override — no payment required). Idempotent if already on that plan.
   - Resp `200`: `{ user: {...}, plan: {...}, subscription: {...} }`
   - `404` if user/plan not found; `400` on invalid planCode.

5. `GET /api/admin/payments` — NEW (optional, for global payment audit). Paginated all payments with user email + plan code. Same item shape as #3 plus `userEmail`.

### Payments / Bakong (NEW `src/payments/` module)
`PaymentsController` guarded by `@UseGuards(RayuAuthGuard)` (authenticated user; NOT admin).

1. `POST /api/payments/khqr` — create a KHQR for upgrading the current user to a paid plan.
   - Body: `{ planCode: PlanCode }` (`@IsIn(PLAN_CODES)`; reject `free`/`enterprise`).
   - Behavior: look up Plan (must be `availability: 'active'` and priceCents > 0); compute amount; call Bakong SDK to generate KHQR + md5; persist `Payment{ userId, planId, amountCents, currency, status:'pending', md5, khqr }`.
   - Resp `201`: `{ paymentId: number, planCode, amountCents, currency, qr: string, md5: string, expiresInSec?: number }`
   - Never returns the developer token.

2. `GET /api/payments/:id/status` — poll payment status (own payment only).
   - Behavior: load Payment (404 if not owned by `req.user`). If already `paid`/`failed`, return it. Else call Bakong `checkTransactionByMD5(md5)`; if PAID -> mark Payment `paid` + `paidAt` + `externalRef`, then switch the user's active Subscription to `planId` (cancel old active, create new active). Idempotent.
   - Resp `200`: `{ paymentId, status: 'pending'|'paid'|'failed', planCode, activated: boolean }`

3. `GET /api/payments/mine` — current user's own payment history (mirrors admin #3 shape, scoped to `req.user.id`). Used by a user-facing billing page.

## Frontend pages needed (`rayu-web/app/`)
1. **Extend `app/admin/page.tsx`** — add a "View" action per user row -> opens a user-detail panel/route showing plan + payment history, and a plan selector (`<select>` over PLAN_CODES) wired to `PATCH /api/admin/users/:id/plan`. Reuse existing Rayu-token exchange + `apiUrl` + table styling/classes (`.card`, `.btn-ghost`, `.badge`).
   - Optionally add `app/admin/users/[id]/page.tsx` for a dedicated detail view (same `web/session` token pattern).
2. **`app/billing/page.tsx`** (NEW, client component, behind Clerk sign-in) — user-facing upgrade:
   - Reads `/api/plans`, lets user pick a paid plan -> `POST /api/payments/khqr` -> render the KHQR (use a QR lib, e.g. `qrcode.react`, to render the returned `qr` string) -> poll `GET /api/payments/:id/status` every ~3s until `paid`/`failed` -> success state.
   - Show own history from `GET /api/payments/mine`.
3. **`app/plans/page.tsx`** — flip active paid plans' CTA from disabled "Coming soon" to "Upgrade" linking to `/billing?plan=<code>`. (`toPlanView` in `lib/plans.ts` already derives `available` from `availability`; once the backend plan is `active`, the CTA enables — just add the link target.)

## Bakong integration approach (`src/payments/bakong.service.ts`)
- Add dependency `bakong-khqr` to `rayu-backend/package.json` (the Choeng-Rayu `-bakong_js` repo wraps this same surface). **Pin an exact version** and verify the installed API surface before coding (see Risks).
- Extend `src/config/configuration.ts` with a `bakong` block reading `BAKONG_MERCHANT_ID`, `BAKONG_PHONE_NUMBER`, `BAKONG_DEVELOPER_TOKEN`, `BAKONG_API_URL` from `process.env` (server-side only, like `clerkSecretKey`).
- `BakongService`:
  - `generateKhqr({ amount, currency, billNumber }): { qr: string, md5: string }` — build `IndividualInfo(BAKONG_MERCHANT_ID, merchantName, 'Phnom Penh', { currency: khqrData.currency.usd|khr, amount, mobileNumber: BAKONG_PHONE_NUMBER, billNumber, storeLabel, terminalLabel })`, then `new BakongKHQR().generateIndividual(info)` -> `{ data: { qr, md5 } }`.
  - `checkPaidByMd5(md5): Promise<{ paid: boolean, ref?: string }>` — call `BakongKHQR.checkTransactionByMD5(BAKONG_DEVELOPER_TOKEN, md5)` (or `POST {BAKONG_API_URL}/check_transaction_by_md5` with Bearer token) and map `responseCode===0` / `data.hash` to paid.
- `PaymentsService` orchestrates: amount conversion (plan `priceCents` USD -> KHQR amount), persistence, and the verified subscription switch. Subscription switch reuses the cancel-active + create-active pattern already implied by `UsersService.assignFreePlan`.

## Security constraints
- Admin endpoints: keep `@UseGuards(RayuAuthGuard, RolesGuard)` + `@Roles('admin','superadmin')` on the whole controller (already the case). New routes inherit it — do not add unguarded admin routes.
- `PATCH /users/:id/plan` is an admin override and must be admin-only; the self-serve upgrade path requires a verified Bakong payment.
- Bakong `BAKONG_DEVELOPER_TOKEN` and full env config stay server-side; never serialize into any API response or log. KHQR `qr`/`md5` are safe to return to the owning user.
- Plan activation is gated strictly on a server-verified `checkTransactionByMD5` PAID result — the client cannot self-report success. `md5` is `@unique` to prevent duplicate-activation/replay.
- `GET /payments/:id/status` and `/payments/mine` must scope to `req.user.id` (ownership check) so users cannot read others' payments.
- All new DTOs use class-validator with `@IsIn(PLAN_CODES)` etc.; global ValidationPipe already strips unknown fields.

## Verification
- Backend: `cd rayu-backend && npm i && npx prisma generate && npm run typecheck && npm run build`; `npm test` (jest). Add unit tests for `PaymentsService` (mock BakongService) and admin plan-change. Migration via `prisma migrate dev`.
- Frontend: `cd rayu-web && npm i && npm run build` (+ existing vitest/jest for `lib/`). Add a QR render lib if not present.
- Do not commit real Bakong token; ensure `.env` stays gitignored.

## Critical files
- `/home/rayu/rayu-cli/rayu-backend/prisma/schema.prisma` (Payment additions)
- `/home/rayu/rayu-cli/rayu-backend/src/admin/admin.module.ts` (admin controller — add detail/payments/plan routes)
- `/home/rayu/rayu-cli/rayu-backend/src/admin/admin.service.ts` (admin business logic)
- `/home/rayu/rayu-cli/rayu-backend/src/payments/` (NEW: payments.module.ts, payments.controller.ts, payments.service.ts, bakong.service.ts)
- `/home/rayu/rayu-cli/rayu-backend/src/config/configuration.ts` (bakong env block)
- `/home/rayu/rayu-cli/rayu-backend/src/plans/plans.constants.ts` (activate purchasable plans)
- `/home/rayu/rayu-cli/rayu-web/app/admin/page.tsx` (plan change + payment history UI)
- `/home/rayu/rayu-cli/rayu-web/app/billing/page.tsx` (NEW: KHQR upgrade flow)

## Risks & open questions
- **SDK API surface unverified live.** Network fetch of the Choeng-Rayu repo/npm failed in this environment (WebFetch model-ID error / timeout). The method names above (`BakongKHQR`, `IndividualInfo`, `generateIndividual`, `checkTransactionByMD5`, `khqrData.currency`) match the standard `bakong-khqr` package the repo wraps, but the implementer MUST confirm exact exports/return shapes against the installed package's source/README before coding, and pin the version.
- **Currency**: plan prices are USD cents; KHQR can encode USD or KHR. Decide whether to charge in USD directly (simplest — `khqrData.currency.usd`, amount = priceCents/100) or convert to KHR (needs an FX rate). Recommend USD to avoid FX. Needs product confirmation.
- **No webhook -> polling.** Acceptable for low volume; add a payment expiry (e.g., 5 min) and a "refresh" action. Consider a future Bakong callback if available.
- **Admin bootstrap**: no seeded admin user exists. To test admin UI, one user's `role` must be set to `admin` (manual DB update or a seed addition). Flag to caller — may need a `seed`/script update or a documented manual step.
- **Subscription switch concurrency**: do the cancel-old + create-new active subscription inside a Prisma `$transaction` to avoid two active subscriptions.
