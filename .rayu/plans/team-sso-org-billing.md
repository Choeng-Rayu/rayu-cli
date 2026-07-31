# Plan: Team SSO + Organization Billing (one pay, many users)

**Status:** Planning (2026-07-31)
**Goal:** Let any existing user create a Team, pay for one org-level subscription, and invite unlimited members. Members sign in with their company Google account and are auto-joined to the team via a hosted-domain (`hd`) SSO check on the existing Google OAuth flow — no SAML, no third-party SSO vendor. Each member gets their own credit bucket allocated from the team's shared pool; the pool caps total team usage.
**Non-goals:**
- Do NOT build SAML or use WorkOS/Auth0 — Google Workspace `hd` check only (easiest path). Non-Google-Workspace teams use manual email invite.
- Do NOT change individual-user billing — existing per-user subscriptions keep working untouched.
- Do NOT break the CLI/gateway JWT contract — the `Rayu JWT` gains an optional `orgId`/`orgRole` claim; absent = individual user (backwards compatible).
- Do NOT migrate existing users' credits into teams — teams are a new, opt-in structure.
**Verified decisions:**
- SSO: Google Workspace `hd` (hosted domain) claim check on the existing `/auth/oauth/google` flow. Auto-join on first sign-in if the user's `hd` matches an org's `ssoDomain`.
- Billing: per-seat credit buckets. Org subscribes to one Team plan with a shared credit pool. Each member has their own bucket; admin allocates per-member quotas (default: equal split). Pool drains as members use credits. Unlimited members — no seat cap; the credit pool is the only cap.
- Self-serve: any user can create a team from `/dashboard`, pay for a Team plan, become the org admin, invite others.

---

## Why the architecture is forced

The backend today is **per-user only**: `Subscription.userId`, `Payment.userId`, `CreditLedger.userId`, `CreditTopup.userId` (verified in `rayu-backend/prisma/schema.prisma`). There is no `Organization`, `Team`, `Member`, or `Invite` table. To support "one pay, many users" we must introduce an `Organization` entity that owns the subscription, payment, and credit pool, plus an `OrganizationMember` join that links users to orgs and tracks per-seat credit buckets.

The existing Google OAuth flow (`OAuthService.verifyGoogleIdToken` at `rayu-backend/src/auth/oauth.service.ts:36-72`) already verifies Google ID tokens server-side and checks `aud` + `exp`. Google's ID token includes a `hd` (hosted domain) claim for Workspace accounts. Adding an SSO auto-join is a **~20-line check** on the existing flow — no new auth library, no SAML, no OIDC client. This is why we pick Google Workspace `hd` over SAML/broker: it's the easiest path that reuses what's already there.

The `RayuAuthGuard` JWT (`AuthService.mintTokens` at `auth.service.ts:231-254`) carries `{sub, role, type:'access'}`. Adding `orgId` + `orgRole` is a small additive change — absent for individual users, present for team members. The gateway already validates the JWT with the same `RAYU_JWT_SECRET`, so it sees the org claims for free. No gateway code changes for the basic flow.

---

## Target architecture

```
                       rayu-web (NextAuth Google OAuth)
                              │  POST /api/auth/oauth/google
                              ▼
                  rayu-backend /auth/oauth/google
                  ┌──────────────────────────────────────────┐
                  │ OAuthService.verifyGoogleIdToken            │
                  │  ├─ verify aud + exp (existing)             │
                  │  ├─ NEW: read hd claim                        │
                  │  └─ NEW: if hd matches Org.ssoDomain         │
                  │       → auto-upsert OrganizationMember      │
                  │       → mint JWT with { orgId, orgRole }     │
                  └──────────────────────────────────────────┘
                              │  Rayu JWT { sub, role, orgId?, orgRole? }
                              ▼
                  ┌──────────────────────────────────────────┐
                  │ Organization (NEW)                         │
                  │  ├─ admin: User (one)                      │
                  │  ├─ ssoDomain: "@company.com"              │
                  │  ├─ Subscription (org-owned, NEW)          │
                  │  ├─ Payment (org-owned, NEW)               │
                  │  └─ CreditPool (org-owned, NEW)             │
                  │       └─ per-member buckets (NEW)          │
                  └──────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
      OrganizationMember   OrganizationInvite   CreditBucket
      (user ↔ org, role)   (email, status)     (member, credits)
```

**SSO flow (auto-join):**
1. Admin creates a Team at `/dashboard/team/new`, pays for a Team plan, sets `ssoDomain = "@company.com"`.
2. Admin invites `alice@company.com` via email (optional — auto-join makes this redundant for Workspace domains).
3. Alice signs in with her `@company.com` Google account on rayu-web.
4. rayu-web posts the Google ID token to `/auth/oauth/google`.
5. Backend verifies the token, reads `hd = "company.com"`, finds the `Organization` with `ssoDomain = "@company.com"`, upserts an `OrganizationMember` row with `role = "member"`.
6. Backend mints a Rayu JWT with `{ sub: alice.id, orgId, orgRole: "member" }`.
7. Alice is now a team member with her own credit bucket — no manual invite needed.

**Billing flow:**
1. Admin pays for a Team plan via KHQR/ABA (existing `PaymentsService`).
2. `activatePaid` creates an `OrganizationSubscription` (not `Subscription`) + seeds the org's `CreditPool` with `plan.limits.creditsPerPeriod`.
3. Each member's `CreditBucket` is allocated from the pool (admin sets quota; default = pool / member count).
4. CLI → gateway `/v1/chat/completions` with Alice's JWT. Gateway resolves her `orgId`, looks up her `CreditBucket`, reserves credits from her bucket. If her bucket is empty, falls back to the org's shared overflow (if any) or rejects.
5. `settle()` debits her bucket; `CreditLedger` row is `organizationId`-scoped (not `userId`).

---

## Step-by-step implementation

### Step 1 — Prisma schema: add Organization entities

**File**: `rayu-backend/prisma/schema.prisma`

Add four new models. Do NOT remove or alter `Subscription`/`Payment`/`CreditLedger`/`CreditTopup` (individual users keep working).

```prisma
model Organization {
  id            String   @id @default(cuid())
  name          String
  slug          String   @unique                     // for URLs /team/:slug
  ssoDomain     String?  @unique                     // "@company.com" — null = invite-only
  adminId       String                                // the creating user
  admin         User     @relation(fields: [adminId], references: [id])
  members       OrganizationMember[]
  invites       OrganizationInvite[]
  subscription  OrganizationSubscription?
  payments      Payment[]                              // existing Payment gains optional orgId
  creditPool    CreditPool?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

model OrganizationMember {
  id              String   @id @default(cuid())
  organizationId  String
  userId          String
  role            String   @default("member")          // "admin" | "member"
  bucketCredits   Int      @default(0)                 // per-seat bucket balance
  bucketQuota     Int      @default(0)                 // admin-set per-period quota
  status          String   @default("active")          // "active" | "removed"
  joinedAt        DateTime @default(now())
  organization    Organization @relation(fields: [organizationId], references: [id])
  user            User        @relation(fields: [userId], references: [id])
  @@unique([organizationId, userId])
  @@index([userId])
}

model OrganizationInvite {
  id              String   @id @default(cuid())
  organizationId  String
  email           String                                  // invitee email
  role            String   @default("member")
  status          String   @default("pending")            // "pending" | "accepted" | "revoked"
  token           String   @unique @default(cuid())        // invite link token
  expiresAt       DateTime
  createdAt       DateTime @default(now())
  organization    Organization @relation(fields: [organizationId], references: [id])
  @@unique([organizationId, email])
  @@index([email])
}

model OrganizationSubscription {
  id              String   @id @default(cuid())
  organizationId  String   @unique
  planId          String
  status          String   @default("active")
  currentPeriodEnd DateTime
  plan            Plan     @relation(fields: [planId], references: [code])
  organization    Organization @relation(fields: [organizationId], references: [id])
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model CreditPool {
  id              String   @id @default(cuid())
  organizationId  String   @unique
  totalCredits    Int      @default(0)                 // pool for the current period
  usedCredits     Int      @default(0)
  periodEnd       DateTime
  organization    Organization @relation(fields: [organizationId], references: [id])
  @@index([organizationId])
}
```

**Widen existing models** (additive — nullable to preserve existing rows):
```prisma
model Payment {
  // ... existing fields ...
  organizationId  String?                            // null = individual payment
  organization    Organization? @relation(fields: [organizationId], references: [id])
}

model CreditLedger {
  // ... existing fields ...
  organizationId  String?                            // null = individual usage
  memberUserId    String?                            // which member used it
}

model Plan {
  // ... existing fields ...
  isTeamPlan      Boolean @default(false)
  seatCredits     Int     @default(0)                // default per-seat bucket quota
}
```

**Migration**: `npm run migrate:dev --name add_organizations`. Existing rows get `organizationId = null`, `isTeamPlan = false`. No data backfill needed.
**Verify**: `cd rayu-backend && npm run migrate:dev` succeeds; `npx prisma studio` shows the new tables; existing user records are intact.

### Step 2 — SSO auto-join via Google `hd` claim

**File**: `rayu-backend/src/auth/oauth.service.ts`

Add the `hd` check after the existing `verifyGoogleIdToken` tokeninfo call (around L36-72):

```typescript
async verifyGoogleIdToken(idToken: string, opts?: { autoJoinOrg?: boolean }) {
  // existing tokeninfo fetch + aud + exp checks...
  const payload = await tokeninfo.json()

  // NEW: extract hosted domain
  const hd = payload.hd as string | undefined

  // NEW: auto-join the user to an org whose ssoDomain matches
  let autoJoinedOrg: Organization | null = null
  if (opts?.autoJoinOrg && hd) {
    const ssoDomain = hd.startsWith('@') ? hd : `@${hd}`
    autoJoinedOrg = await this.prisma.organization.findUnique({
      where: { ssoDomain },
    })
    if (autoJoinedOrg) {
      const user = await this.findOrCreateUserFromGoogle(payload)
      await this.prisma.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: autoJoinedOrg.id, userId: user.id } },
        create: { organizationId: autoJoinedOrg.id, userId: user.id, role: 'member' },
        update: { status: 'active' },  // re-activate if previously removed
      })
    }
  }
  return { ...payload, hd, autoJoinedOrg }
}
```

**File**: `rayu-backend/src/auth/auth.service.ts`

Update `mintTokens` (L231-254) to include org claims when the user is an org member:

```typescript
async mintTokens(user: User, orgMembership?: { orgId: string; orgRole: string }) {
  const payload: JwtPayload = {
    sub: user.id,
    role: user.role,
    type: 'access',
    ...(orgMembership && { orgId: orgMembership.orgId, orgRole: orgMembership.orgRole }),
  }
  // ... sign as before
}
```

Update the `/auth/oauth/google` handler: after `verifyGoogleIdToken`, look up the user's org membership (auto-join may have just created it) and pass it to `mintTokens`.

**Verify**: `npx jest --testPathPattern=auth` passes; new test `oauth.sso.spec.ts` — a user with `hd = "company.com"` signing in against an org with `ssoDomain = "@company.com"` auto-joins; a user with `hd = "gmail.com"` does not.

### Step 3 — Team CRUD module

**New module**: `rayu-backend/src/organizations/`

- `organizations.controller.ts` — endpoints under `/api/organizations`:
  - `POST /` — create a team (auth required). Body: `{ name, slug, ssoDomain? }`. Creates `Organization` with `adminId = currentUser`, creates an empty `CreditPool`.
  - `GET /:slug` — get org info (members, pool, subscription). Admin only.
  - `POST /:slug/invite` — invite by email. Creates `OrganizationInvite` with a 7-day expiry. Sends email (existing email infra, if any; else logs the invite link).
  - `POST /:slug/invite/:token/accept` — accept invite by token. Upserts `OrganizationMember`.
  - `DELETE /:slug/members/:userId` — remove a member (admin only). Sets `status = "removed"`.
  - `PATCH /:slug/members/:userId/quota` — set per-member credit quota (admin only).
  - `POST /:slug/leave` — member leaves their own membership.
- `organizations.service.ts` — business logic + Prisma calls.
- `organizations.module.ts` — NestJS module wiring.
- Guard: `OrgAdminGuard` — checks `req.user.orgId === org.id && req.user.orgRole === 'admin'`.
- **Verify**: `npx jest --testPathPattern=organizations` covers create, invite, accept, remove, quota, leave.

### Step 4 — Team billing (org-owned subscription + credit pool)

**File**: `rayu-backend/src/payments/payments.service.ts`

Widen `createKhqr` (L129-250) and `activatePaid` (L571) to accept an optional `organizationId`:
- When `organizationId` is set, `Payment.organizationId = orgId` (not `payment.userId`).
- `activatePaid` creates an `OrganizationSubscription` (not `Subscription`) + seeds the `CreditPool.totalCredits` with `plan.limits.creditsPerPeriod` + sets `periodEnd`.
- Allocate per-seat buckets: when `CreditPool` is seeded, distribute credits across active members per `Plan.seatCredits` (or equal split if `seatCredits = 0`).

**New**: `organizations.service.renewSubscription(orgId)` — called by the existing period-end scheduler. Re-seeds the `CreditPool`, resets each member's `bucketCredits` to their `bucketQuota`.

**New**: `organizations.service.chargeMemberBucket(orgId, userId, credits)` — debits the member's bucket; if empty, falls back to the org's `CreditPool.totalCredits - usedCredits`; if that's empty too, throws `InsufficientCreditsError`.

**Verify**: `npx jest --testPathPattern=payments` covers the org-billing path; a new test asserts an org payment seeds `CreditPool` and member buckets, not a `Subscription`.

### Step 5 — Gateway org-aware credit settlement

**File**: `rayu-gateway/internal/...` (the credit reserve + settle path)

The gateway reads the Rayu JWT, resolves plan entitlements from MySQL. Update the resolver:
- If the JWT has `orgId`, load the `OrganizationSubscription` + `CreditPool` + the member's `OrganizationMember.bucketCredits` instead of the user's individual `Subscription`.
- Pre-flight reserve: try the member's bucket first, then the org pool.
- Settle: write `CreditLedger` with `organizationId` + `memberUserId` (not just `userId`).
- Daily turn caps (`maxDailyTurns`): apply per-member, not per-org (an org member has their own daily cap).
- **Verify**: `cd rayu-gateway && go test ./...` — new test case for org-scoped reserve/settle; existing individual-user tests unchanged.

### Step 6 — rayu-web UI (dashboard, team admin, member view)

**New routes**:
- `rayu-web/app/dashboard/team/page.tsx` — list user's org memberships; "Create a team" CTA.
- `rayu-web/app/dashboard/team/new/page.tsx` — create-team form (name, slug, ssoDomain optional). On submit, POST `/api/organizations`, redirect to billing.
- `rayu-web/app/dashboard/team/[slug]/page.tsx` — admin view: members list, invite form, credit pool status, per-member quota editor, subscription status.
- `rayu-web/app/dashboard/team/[slug]/invite/[token]/page.tsx` — accept-invite page (if not signed in, redirect to `/sign-in` first; after sign-in, POST accept).

**New API routes** (thin pass-throughs to backend, since NextAuth holds the Google token):
- `rayu-web/app/api/organizations/route.ts` — POST create.
- `rayu-web/app/api/organizations/[slug]/route.ts` — GET.
- `rayu-web/app/api/organizations/[slug]/invite/route.ts` — POST invite.
- `rayu-web/app/api/organizations/[slug]/invite/[token]/accept/route.ts` — POST accept.

**Modify**:
- `rayu-web/app/dashboard/page.tsx` — add "Team" card if the user is an org admin or member.
- `rayu-web/app/components/NavAuth.tsx` — add "Team" link if `useSession()` shows an org membership.

**Verify**: `cd rayu-web && npm run typecheck && npm run build`; manual: create a team, invite a member by email, the member signs in and sees the team in their dashboard.

### Step 7 — CLI / gateway JWT contract (backwards compatible)

**File**: `rayu-backend/src/auth/auth.service.ts` (`mintTokens`) — already updated in Step 2.

**File**: `rayu-gateway` JWT validator — read `orgId`/`orgRole` claims if present; absent = individual user. No breaking change.

**File**: `rayu/` CLI — no change. The CLI sends the JWT as-is; the gateway handles the org resolution. If the user is an org member, their credit bucket is used; if not, their individual subscription is used. The CLI does not need to know about orgs.

**Verify**: existing CLI auth flow still works for individual users (no `orgId` claim); a team-member JWT is accepted by the gateway and debits the org pool.

### Step 8 — Admin oversight (existing admin module)

**File**: `rayu-backend/src/admin/`

Add endpoints:
- `GET /admin/organizations` — list all orgs (superadmin only).
- `GET /admin/organizations/:id` — org detail (members, pool, payments).
- `POST /admin/organizations/:id/suspend` — suspend an org (sets `OrganizationMember.status = "removed"` for all members + cancels `OrganizationSubscription`).

**File**: `rayu-web/app/admin/organizations/` — new admin pages mirroring `admin/users/`.

**Verify**: `npx jest --testPathPattern=admin` covers the new endpoints; admin can list + suspend orgs.

---

## Verification matrix (must-pass before considering done)

| # | Test | How |
|---|---|---|
| 1 | Migration is additive | `npm run migrate:dev` succeeds; existing rows have `organizationId = null`; existing user tests pass |
| 2 | SSO auto-join works | User with `hd = "company.com"` signs in → `OrganizationMember` row created with `role = "member"`; JWT contains `orgId` |
| 3 | SSO does not over-join | User with `hd = "gmail.com"` (or no `hd`) signs in → no auto-join, individual user only |
| 4 | Team creation self-serve | Any user creates a team → becomes admin → `CreditPool` seeded on first payment |
| 5 | Invite by email | Admin invites `bob@company.com` → invite row created; Bob accepts via link → member row created |
| 6 | Per-seat bucket debit | Member sends a chat → gateway debits their `bucketCredits`; `CreditLedger` row has `organizationId` + `memberUserId` |
| 7 | Bucket exhaustion → pool fallback | Member's bucket empty → gateway falls back to org `CreditPool` |
| 8 | Pool exhaustion → blocked | All member buckets + pool empty → gateway returns `InsufficientCreditsError` |
| 9 | Unlimited members, pool caps | Admin invites 50 members on a 5-seat-credit plan → all join; pool drains; usage stops when pool hits 0 |
| 10 | Individual users unaffected | Existing individual subscription user signs in → no `orgId` claim → existing per-user billing unchanged |
| 11 | CLI still works | CLI login for an org member → gateway accepts JWT, debits org pool; for an individual → debits user subscription |
| 12 | Admin oversight | Superadmin lists orgs, suspends one → all members lose access |
| 13 | Renewal re-seeds pool | Period-end scheduler fires → `CreditPool.totalCredits` reset, each member's `bucketCredits` reset to `bucketQuota` |
| 14 | Build quality | `npm run typecheck && npm test && npm run build` green in rayu-backend; `go test ./...` green in rayu-gateway; `npm run build` green in rayu-web |

---

## Files created/modified (final list)

**New (rayu-backend/):**
- `prisma/migrations/<ts>_add_organizations/` (migration)
- `src/organizations/organizations.module.ts`, `controller.ts`, `service.ts`, `dto.ts`, `org-admin.guard.ts`
- `src/auth/oauth.sso.spec.ts` (SSO auto-join test)
- `src/organizations/organizations.service.spec.ts`

**Modified (rayu-backend/):**
- `prisma/schema.prisma` — new models + additive widening of `Payment`/`CreditLedger`/`Plan`
- `src/auth/oauth.service.ts` — `hd` check + auto-join
- `src/auth/auth.service.ts` — `mintTokens` adds `orgId`/`orgRole` claims
- `src/payments/payments.service.ts` — `organizationId` branch in `createKhqr`/`activatePaid`
- `src/admin/admin.module.ts` — add org oversight endpoints

**Modified (rayu-gateway/):**
- JWT validator (read `orgId`/`orgRole`)
- Credit reserve/settle path (org-scoped + per-member bucket)

**New (rayu-web/):**
- `app/dashboard/team/page.tsx`, `app/dashboard/team/new/page.tsx`, `app/dashboard/team/[slug]/page.tsx`, `app/dashboard/team/[slug]/invite/[token]/page.tsx`
- `app/api/organizations/route.ts`, `app/api/organizations/[slug]/route.ts`, `app/api/organizations/[slug]/invite/route.ts`, `app/api/organizations/[slug]/invite/[token]/accept/route.ts`
- `app/admin/organizations/` (admin oversight pages)

**Modified (rayu-web/):**
- `app/dashboard/page.tsx` (Team card)
- `app/components/NavAuth.tsx` (Team link)

**Unchanged:**
- `rayu/` CLI — no changes (gateway handles org resolution transparently)
- Existing individual-user billing flow (Subscription, Payment, CreditLedger for users without orgId)

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `hd` claim missing for personal Google accounts | Treat absent `hd` as "no auto-join" — the user stays a standalone user. Manual invite still works for any email. |
| `hd` spoofing | `hd` is in the Google-signed ID token, verified server-side via `tokeninfo`. Not spoofable. |
| Two orgs claim the same `ssoDomain` | `ssoDomain` is `@unique` in the schema — first org wins. Admin must contact support to dispute. |
| Org admin stops paying → members lose access | `OrganizationSubscription.status = "past_due"` → gateway rejects org-member JWTs with a clear error; admin sees a banner. Members can fall back to their own individual subscription if they have one. |
| Per-seat bucket quota not set → member gets 0 credits | Default `bucketQuota` = `Plan.seatCredits` (or equal split if 0). Admin can override per member. |
| Existing user with individual subscription creates a team | Keep both: individual `Subscription` + `OrganizationSubscription` coexist. JWT carries `orgId` when the user is acting as a team member; gateway prefers org pool. User can switch context in `/dashboard`. |
| Credit pool exhausted mid-stream | Pre-flight reserve checks pool before the stream starts; `settle()` reconciles. Existing pattern already handles this for individuals. |
| Member removed while a stream is active | Membership status checked at pre-flight; an active stream completes. Next request is rejected. |
| Migration breaks existing rows | All new columns are nullable; migration is additive. Run on a staging DB first. |

---

## Out of scope (deferred to v2)
- SAML support (enterprise IdPs other than Google Workspace).
- OIDC for non-Google providers (Microsoft, Okta, Keycloak).
- Per-seat invoicing (Team plan = $X base + $Y/extra seat). v1 has a flat plan price + unlimited members capped by credits.
- Team API keys (a single org API key usable by any member).
- Team usage analytics dashboard (per-member usage breakdown charts).
- Team-wide MCP server configuration (org-level MCP servers).
- Cross-org membership (a user belonging to multiple teams — v1: one org per user).

---

## Open questions (non-blocking, confirm during implementation)
1. **Per-seat default quota** — when `Plan.seatCredits = 0`, default to equal split (`pool.totalCredits / memberCount`) or to "unlimited per member until pool drains"? Assumed equal split; will confirm.
2. **Email sending for invites** — does rayu-backend have an email service today? If not, v1 logs the invite link in the API response and the admin copies it manually; v2 wires an email provider.
3. **Dual membership** — can a user belong to multiple orgs? Assumed no (one org per user) for v1; `OrganizationMember` allows it in schema but the UI/flow restricts to one. Confirm.
4. **Context switch** — when an admin is also a member, does the JWT always carry the org role, or does the user pick a context at sign-in? Assumed: always carries the org membership; the gateway uses it. Individual subscription is a fallback, not a switchable context.