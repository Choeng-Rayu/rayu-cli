# rayu-backend — Defensive Security Audit (read-only)

Scope: `/home/rayu/rayu-cli/rayu-backend/` (NestJS + Prisma + MySQL) only.
Method: source read + input→sink tracing. No source file was modified.
Date: 2026-08-01.

Prisma note (per rules): every model access was checked. The ONLY raw SQL in the
service tree is 4 call sites in `admin/admin.service.ts` (2× `$queryRaw` tagged
templates with no user input, 2× `$queryRawUnsafe` interpolating a clamped
integer). No `$queryRawUnsafe`/`$executeRawUnsafe` receives an
attacker-controlled string, so there is no SQL-injection finding — see BE-012
for the evidence.

Severity legend: Critical = unauth RCE / auth bypass / secret disclosure / fund
loss · High = authed RCE / IDOR / major data leak · Medium = limited leak / DoS /
priv edge · Low = hardening · Informational = best practice.

---

## BE-001 — ABA Telegram credit-alert confirmation trusts unauthenticated group text and has no replay protection (credit/plan minting)

- Severity: Critical
- CWE: CWE-345 (Insufficient Verification of Data Authenticity), CWE-294 (Authentication Bypass by Capture-Replay), CWE-799 (Improper Control of Interaction Frequency)
- Confidence: Confirmed (code gaps) / Likely (real-world exploit depends on Telegram group posting policy)
- Untrusted boundary: text of a Telegram message observed by the MTProto userbot in `ABA_TELEGRAM_GROUP_ID`.
- Sink: `PaymentsService.activatePaid()` → subscription activation + `creditTopup` grant (money/credit mutation).

Evidence — the listener never checks WHO sent the message, and its only channel
filter fails open when `chatId` is null:

`src/payments/aba-telegram.listener.ts:119-127`
```ts
    if (expectedChatId && chatId && chatId !== expectedChatId) return

    const parsed = this.aba.parseAbaNotification(text)
    if (!parsed) return
    try {
      const confirmed = await this.payments.confirmAbaPaymentByAmount(
        parsed.amount,
        parsed.trxId,
      )
```

Match is by amount only, "most recent pending ABA payment", with no check that
`trxId` was ever seen before:

`src/payments/payments.service.ts:540-556`
```ts
  async confirmAbaPaymentByAmount(
    amountUsd: number,
    ref?: string | null,
  ): Promise<boolean> {
    const amountCents = Math.round(amountUsd * 100)
    const payment = await this.prisma.payment.findFirst({
      where: {
        provider: 'aba',
        status: 'pending',
        amountCents,
        expiresAt: { gte: new Date(Date.now() - ABA_MATCH_GRACE_MS) },
      },
```

The trx id is stored in `externalRef`, which is NOT unique (only `md5` is), so
nothing at the DB layer stops the same alert from confirming many payments:

`prisma/schema.prisma:99-100`
```prisma
  externalRef   String?   @db.VarChar(191)
  md5           String?   @unique @db.VarChar(64)
```

Description: ABA has no payment API, so a payment is marked `paid` purely because
a message matching `/\$?([\d.]+)\s+paid by .+?\(\*(\d{3})\).+?Trx\.\s*ID:\s*(\d+)/i`
(`aba.service.ts:parseAbaNotification`) appeared in the watched group. The code
performs (a) no sender/identity verification (never inspects `senderId`/`fromId`
against ABA's bot), (b) no replay/idempotency check on `trxId`, and (c)
amount-only matching with no binding to the payer.

Exploit scenario:
1. Attacker creates a real pending purchase (e.g. `POST /api/payments/khqr`,
   `pro` plan) and reads back the exact `amountCents`.
2. Attacker (any account able to post in the ABA group, or via the null-`chatId`
   fail-open path above) posts `$X.00 paid by AAA (*123) Trx. ID: 999999`.
3. `confirmAbaPaymentByAmount` matches the attacker's pending payment and calls
   `activatePaid` → plan activated / credits granted with $0 actually paid.
4. Because `externalRef`/`trxId` is never deduplicated, re-posting the same line
   confirms each future same-amount pending payment — unlimited free
   activations/credits.
Additionally, amount-only matching lets a genuine alert for user A's $5 payment
confirm attacker B's more-recent $5 pending payment (cross-user hijack).

Impact: direct fund loss — free paid-plan activation and credit top-up minting;
one captured alert is replayable indefinitely.

Fix recommendation (describe only): authenticate the alert source (verify the
MTProto message `senderId`/peer is ABA's bot id, not just the chat), and reject
the message otherwise; make `trxId` a unique idempotency key persisted before
activation so a given alert confirms at most one payment; bind confirmation to a
single payment (e.g. include the payment/bill reference) rather than matching by
amount; do not fail open when `chatId` cannot be resolved.

Notes/mitigations: the source comment acknowledges the trust model ("Confirmation
trusts whatever is posted in that group, so group posting must be locked down")
— i.e. the only real-world control is Telegram group admin settings, external to
this code. If that group ever allows non-ABA posts (or the userbot is added to
another chat), minting is trivial.

---

## BE-002 — JWT signing secret silently falls back to a hardcoded value in production (token forgery / full auth bypass)

- Severity: Critical
- CWE: CWE-321 (Use of Hard-coded Cryptographic Key), CWE-798 (Use of Hard-coded Credentials)
- Confidence: Confirmed
- Untrusted boundary: `Authorization: Bearer <access token>` on every guarded route.
- Sink: `JwtService.sign/verify` (session issuance + `RayuAuthGuard`).

Evidence:

`src/config/configuration.ts:51-53`
```ts
      jwtSecret:
        process.env.RAYU_JWT_SECRET ??
        (isTest ? 'test-only-insecure-secret' : 'dev-only-insecure-secret'),
```

This value is the only key the JWT module is given (`auth.module.ts` →
`useFactory: (config) => ({ secret: config.get('app.jwtSecret') })`), and the
guard trusts any token that verifies against it (`auth.service.ts:resolveAccessToken`).

Description: if `RAYU_JWT_SECRET` is not set in a non-test process, the backend
signs and verifies session tokens with the compile-time-known string
`dev-only-insecure-secret`. There is no startup guard requiring the secret in
production (checked `main.ts`, `app.module.ts`, `configuration.ts` — none throw).
Anyone who knows this constant (it is in the source) can forge a valid access
token.

Exploit scenario: against a deployment that forgot to set `RAYU_JWT_SECRET`, an
attacker signs `{"sub":1,"role":"superadmin","type":"access"}` with HS256 and the
known secret, sends it as a Bearer token, and `RayuAuthGuard`→`resolveAccessToken`
loads user id 1 (or any id). Combined with `RolesGuard`, forging `role` is not
even required because the guard reloads the live user; but choosing an existing
admin's `sub` yields full `/api/admin/*` access.

Impact: complete authentication/authorization bypass; admin takeover; data and
funds exposure.

Fix recommendation: fail closed — refuse to boot in production when
`RAYU_JWT_SECRET` is unset or below a minimum entropy/length; never ship a usable
default secret.

Notes/mitigations: the local `.env` (line 15) and `.env.example` do set the
variable, so a correctly-provisioned environment is safe. The defect is the
silent fallback with no production enforcement. `.env.example` also ships the
literal placeholder `RAYU_JWT_SECRET=change-me-to-a-long-random-string`, which is
equally forgeable if deployed unchanged.

---

## BE-003 — Google ID-token audience check is skipped when GOOGLE_CLIENT_ID is unset (OAuth token-replay account takeover)

- Severity: High
- CWE: CWE-287 (Improper Authentication), CWE-1174 / OAuth `aud` not validated
- Confidence: Confirmed (fail-open code) / Likely (takeover chained with email linking)
- Untrusted boundary: `idToken` in body/header of `/api/auth/oauth/google`, `/api/web/session`, `/api/cli/exchange`.
- Sink: `AuthService.webSession/exchangeOAuthToken` → session issuance.

Evidence:

`src/auth/oauth.service.ts:55-57`
```ts
    if (this.googleClientId && data.aud !== this.googleClientId) {
      throw new UnauthorizedException('Google token audience mismatch')
    }
```

Description: the audience (`aud`) binding is only enforced when
`this.googleClientId` is truthy (`GOOGLE_CLIENT_ID`). If that env var is unset,
the check is skipped entirely and any signature-valid, unexpired Google ID token
— including one minted for a completely unrelated OAuth client — is accepted.
The upserted identity is keyed on the token's `sub`/`email`, and
`upsertFromOAuth` links to an existing account by email (see BE-011).

Exploit scenario (GOOGLE_CLIENT_ID unset): attacker stands up their own Google
OAuth app and induces a victim to sign in to it (or reuses any ID token the
victim's browser grants to an attacker-controlled `client_id`). The resulting ID
token carries the victim's real `sub`/`email`; the attacker POSTs it to
`/api/auth/oauth/google`. With no `aud` check it verifies, and because linking is
by email, the attacker receives Rayu tokens for the victim's account.

Impact: account takeover / authentication bypass for any Google-identified user.

Fix recommendation: require `GOOGLE_CLIENT_ID` (fail closed) and always validate
`aud` (and `iss`) against the expected client id; do not treat "no configured
client id" as "accept any audience".

Notes/mitigations: `.env` (line 12) sets a real `GOOGLE_CLIENT_ID`, so the
smoke-test env validates `aud`. The defect is that the code permits the unchecked
state instead of enforcing it.

---

## BE-004 — Telegram webhook secret check fails open when TELEGRAM_WEBHOOK_SECRET is unset (unauthenticated update injection)

- Severity: High (in webhook deployments) — precondition-gated
- CWE: CWE-306 (Missing Authentication for Critical Function), CWE-16 (Configuration / fail-open)
- Confidence: Confirmed (fail-open code) / Likely (end-to-end needs a target chatId)
- Untrusted boundary: public `POST /api/telegram/webhook` body (no JWT guard by design).
- Sink: `TelegramService.receiveUpdate` → `handleUpdate` → per-user inbound queue / link mutations.

Evidence:

`src/telegram/telegram.service.ts:426-428`
```ts
  validateWebhookSecret(headerValue: string | undefined): boolean {
    if (!this.webhookSecret) return true
    if (!headerValue) return false
```

The controller relies solely on this:

`src/telegram/telegram.controller.ts` (webhook handler)
```ts
    if (!this.telegram.validateWebhookSecret(secret)) {
      throw new UnauthorizedException()
    }
    await this.telegram.receiveUpdate(update)
```

Description: when `TELEGRAM_WEBHOOK_SECRET` is empty, `validateWebhookSecret`
returns `true` for every request, so the public webhook accepts arbitrary,
attacker-crafted Telegram `update` objects. (When the secret IS set, the compare
is correct and constant-time-ish.)

Exploit scenario (webhook mode on + secret unset): attacker POSTs a forged
update. `handleUpdate` routes by `chat.id`: for a `chatId` that is already linked
to a victim, a plain-text message is enqueued into that victim's
`TelegramInbound` queue and the CLI consumes it as if the user typed it — remote
injection into the victim's authenticated agent session. A forged `/disconnect`
for a known `chatId` unlinks the victim (griefing).

Impact: unauthenticated injection of instructions into another user's linked CLI
session; link tampering. Requires (a) webhook mode enabled and (b) secret
omitted, plus knowledge of a target `chatId`.

Fix recommendation: fail closed — if a webhook URL is configured, require a
non-empty secret at boot and reject webhook requests when no secret is set
(return false instead of true).

Notes/mitigations: `.env` does not enable webhook mode (`TELEGRAM_WEBHOOK_URL`
unset → poller path), so this is dormant in the audited config; the product
documents webhook mode as "recommended for production", where an operator
omitting the optional secret silently disables authentication.

---

## BE-005 — No rate limiting / lockout on authentication endpoints, including /admin-login (online brute force)

- Severity: Medium (High if the admin password is weak)
- CWE: CWE-307 (Improper Restriction of Excessive Authentication Attempts)
- Confidence: Confirmed
- Untrusted boundary: unauthenticated `POST /api/admin-login`, `/api/auth/login`, `/api/auth/register`.
- Sink: `AuthService.localAdminLogin` / `loginLocal` password verification.

Evidence — the admin login route is public and unthrottled:

`src/auth/auth.controller.ts:106-111`
```ts
  @Post('admin-login')
  adminLogin(
    @Body() body: LocalLoginDto,
  ): Promise<RayuTokens & { user: PublicUser }> {
    return this.auth.localAdminLogin(body.email, body.password)
  }
```

No throttler is registered anywhere (grep for `Throttle|ThrottlerModule|
rateLimit|helmet` across `src/` returns only comments), and `main.ts` installs no
rate-limiting middleware.

Description: the local admin account has a fixed, guessable email
(`app.module.ts:25` → `admin@rayucode.com`) and there is no per-IP/per-account
rate limit, lockout, backoff, or CAPTCHA on any auth endpoint. Password
comparison itself is sound (scrypt + `crypto.timingSafeEqual`, see POSITIVE
CONTROLS) and the password is not logged (the `main.ts` request logger records
only `method`+`url`, not the body), so the only missing control is
attempt-throttling.

Exploit scenario: attacker runs an online dictionary/brute-force against
`POST /api/admin-login` with `email=admin@rayucode.com`, unbounded by the server.
`/auth/register` and `/auth/login` are likewise open to automated abuse (account
spam, credential stuffing, email enumeration by timing since a missing user skips
scrypt).

Impact: admin-account compromise if `LOCAL_ADMIN_PASSWORD` is weak; resource
abuse; user enumeration.

Fix recommendation: add per-IP and per-account rate limiting + exponential
backoff/lockout on the auth routes (e.g. a throttler guard), and consider a
constant-work path for unknown users to flatten timing.

Notes/mitigations: strength of `LOCAL_ADMIN_PASSWORD` is the compensating control
and is outside code.

---

## BE-006 — Refresh tokens are stateless with no rotation, reuse detection, or revocation

- Severity: Medium
- CWE: CWE-613 (Insufficient Session Expiration)
- Confidence: Confirmed
- Untrusted boundary: `refreshToken` in `POST /api/cli/refresh` body.
- Sink: `AuthService.refresh` → new token issuance.

Evidence:

`src/auth/auth.service.ts:155-167`
```ts
    let claims: RefreshClaims
    try {
      claims = this.jwt.verify<RefreshClaims>(refreshToken)
    } catch {
      throw new UnauthorizedException('Invalid refresh token')
    }
    if (claims.type !== 'refresh') {
      throw new UnauthorizedException('Not a refresh token')
    }
    const user = await this.users.findById(claims.sub)
```

Description: refresh tokens are plain JWTs with a 30-day TTL
(`RAYU_REFRESH_TTL=2592000`). There is no `jti`, no server-side store, no
rotation on use, and no reuse detection. A refresh call mints new tokens but the
presented refresh token remains valid until natural expiry, so it cannot be
revoked and can be replayed repeatedly.

Exploit scenario: a refresh token captured (leaked log, stolen `~/.rayu`
credential file, MITM on a misconfigured deploy) grants a 30-day window of
renewable access to an active account with no way to invalidate it short of
suspending the user (`status`, which is checked) or rotating `RAYU_JWT_SECRET`
(which nukes all sessions).

Impact: prolonged unauthorized access from a single stolen refresh token.

Fix recommendation: rotate the refresh token on each use, persist a token
id/family and detect reuse (revoke the family on replay), and support explicit
revocation/logout.

Notes/mitigations: access-token authorization correctly reloads the live user
and role on every request (POSITIVE CONTROLS), limiting privilege staleness.

---

## BE-007 — Promo "first N accounts" cap has a TOCTOU race (no row lock) allowing oversell

- Severity: Medium
- CWE: CWE-362 (Concurrent Execution using Shared Resource / Race Condition)
- Confidence: Likely (depends on DB isolation + concurrency)
- Untrusted boundary: authenticated `POST /api/payments/promo/claim` (and paid-confirmation path) with a promo code.
- Sink: `PromoService.finalizeRedemption` → `promoCode.usedCount` increment vs `maxRedemptions`.

Evidence:

`src/promo/promo.service.ts:285-299`
```ts
    await this.prisma.$transaction(async (tx) => {
      const redemption = await tx.promoRedemption.findUnique({
        where: { promoCodeId_userId: { promoCodeId, userId } },
      })
      if (!redemption || redemption.status === 'applied') return
      const promo = await tx.promoCode.findUnique({ where: { id: promoCodeId } })
      if (!promo) return
      if (promo.maxRedemptions != null && promo.usedCount >= promo.maxRedemptions) {
        throw new BadRequestException('This promo code has reached its usage limit')
      }
      await tx.promoCode.update({
        where: { id: promoCodeId },
        data: { usedCount: { increment: 1 } },
      })
```

Description: the cap re-check reads `usedCount` with a non-locking
`findUnique` inside the transaction. Under MySQL/InnoDB REPEATABLE-READ, two
concurrent redemptions by different users can both read `usedCount = N-1`, both
pass the `>= maxRedemptions` guard, then both `increment`, pushing `usedCount`
past `maxRedemptions`. There is no `SELECT ... FOR UPDATE` / row lock on the
promo row. The per-user `@@unique([promoCodeId, userId])` (schema:promo_redemptions)
prevents a single user double-redeeming, so the race is bounded to concurrent
distinct users racing the last slot(s).

Exploit scenario: many users (or many attacker accounts) submit the last slot of
a limited, high-value (e.g. 100%-off) promo simultaneously; the cap is exceeded
by roughly the number of concurrent finalizers.

Impact: limited over-redemption of capped promos (extra free/discounted plan
grants); not unbounded.

Fix recommendation: enforce the cap atomically — e.g. a conditional
`UPDATE promo_codes SET usedCount = usedCount + 1 WHERE id = ? AND (maxRedemptions
IS NULL OR usedCount < maxRedemptions)` and treat 0 affected rows as "cap
reached", or lock the promo row `FOR UPDATE` before the check.

Notes/mitigations: `finalizeRedemption` is otherwise idempotent per (promo,user).

---

## BE-008 — Real, high-sensitivity secrets stored in plaintext in on-disk .env

- Severity: Medium (values are highly sensitive; access requires host/filesystem/working-tree access)
- CWE: CWE-312 (Cleartext Storage of Sensitive Information), CWE-798
- Confidence: Confirmed
- Boundary/sink: at-rest secret material on the deployment/working host.

Evidence (file:line only — values REDACTED, never printed):

`/home/rayu/rayu-cli/rayu-backend/.env`
```
15: RAYU_JWT_SECRET=REDACTED
22: BAKONG_DEVELOPER_TOKEN=REDACTED         (a real signed JWT)
30: ABA_STATIC_QR=REDACTED
35: TELEGRAM_BOT_TOKEN=REDACTED             (ABA-group bot token)
44: TELEGRAM_API_ID=REDACTED
45: TELEGRAM_API_HASH=REDACTED
48: TELEGRAM_SESSION=REDACTED               (MTProto string session = FULL account access)
70: RAYU_SHARED_BOT_TOKEN=REDACTED
82: RAYU_PROVIDER_SECRET=REDACTED           (AES-256-GCM master key for ALL provider keys)
```

Description: the working-tree `.env` contains what appear to be live credentials.
Two are especially dangerous: `TELEGRAM_SESSION` (line 48) is a GramJS string
session that grants full control of the linked Telegram user account, and
`RAYU_PROVIDER_SECRET` (line 82) is the master key that decrypts every stored
provider API key (`secretBox.ts`). `.gitignore` and `.dockerignore` both list
`.env` (so it is excluded from git and the image), but the plaintext file itself
exists on disk on this host.

Exploit scenario: any actor with read access to this working tree/host (backup,
snapshot, shared CI runner, a second process, or — as this audit demonstrates —
filesystem read) obtains: the ability to act as the Telegram account, decrypt all
provider keys given a DB dump, forge sessions if the JWT secret matches prod, and
use the Bakong/ABA/bot tokens.

Impact: broad credential compromise if the host or working tree is exposed.

Fix recommendation: treat all values in this file as compromised and rotate them
(`RAYU_PROVIDER_SECRET` — note rotating it requires re-entering every provider
key; `TELEGRAM_SESSION` — revoke the session; both bot tokens and the Bakong
token); source production secrets from a secrets manager rather than an on-disk
file; restrict file permissions.

Notes/mitigations: correctly excluded from git and the Docker image; exposure is
limited to host/working-tree access.

---

## BE-009 — Studio git-proxy forwards the inbound Authorization header (Rayu access JWT) to the upstream git host

- Severity: Low
- CWE: CWE-200 (Exposure of Sensitive Information to an Unauthorized Actor)
- Confidence: Likely
- Untrusted boundary: `Authorization` header on `ALL /api/studio/git-proxy/*`.
- Sink: server-side `fetch` to an allow-listed git host with forwarded headers.

Evidence:

`src/studio/studio-git-proxy.controller.ts` (forwarded request headers list)
```ts
const FORWARD_REQUEST_HEADERS = [
  'accept', 'accept-encoding', 'accept-language',
  'authorization',
  'cache-control', 'content-type', 'git-protocol', 'pragma', 'range', 'user-agent',
] as const
```

The same route is `@UseGuards(RayuAuthGuard)`, and `RayuAuthGuard` authenticates
using exactly that `Authorization: Bearer <rayu access token>` header
(`rayu-auth.guard.ts:extractBearer`). Whatever value satisfies the guard is then
copied into the upstream request headers and sent to the git host
(`headers.set('host', target.host)` + `fetch(target, { headers })`).

Description: because one header serves both purposes, the caller's Rayu access
JWT is transmitted to the destination git host (github.com / gitlab.com /
bitbucket.org / etc.). The host is allow-listed to public git providers, so this
is not an internal SSRF, but it does disclose the user's session bearer token to
a third party (and their logs).

Exploit scenario: a normal studio clone through the proxy sends the user's Rayu
access token to GitHub; the token is now present in GitHub's request logs and
transited to an external party that never needed it.

Impact: session-token disclosure to third-party git hosts (token hygiene). Bounded
by the allow-list (no arbitrary/internal host).

Fix recommendation: do not forward the request's `Authorization` header used for
Rayu auth to the upstream; carry git credentials on a distinct header/mechanism,
or strip `authorization` before forwarding and inject only the credential the git
operation actually needs.

Notes/mitigations: destination host is restricted by `requireGitProxyUrl`
(allow-list + private-IP re-check), and `redirect:'follow'` is scoped to
same-host redirects.

---

## BE-010 — No security response headers (helmet not installed)

- Severity: Low
- CWE: CWE-693 (Protection Mechanism Failure)
- Confidence: Confirmed

Evidence: `main.ts` configures body parsing, `ValidationPipe`, CORS,
`setGlobalPrefix`, and a logger, but installs no security-header middleware; grep
for `helmet` across `src/` returns only unrelated matches.

Description: responses carry no HSTS, `X-Content-Type-Options`, `X-Frame-Options`/
frame-ancestors, `Referrer-Policy`, etc. As a JSON API behind a reverse proxy the
risk is limited, but these are standard hardening headers.

Exploit scenario: MIME-sniffing / clickjacking / TLS-downgrade risks are not
mitigated at the app layer; depends entirely on the fronting proxy.

Impact: reduced defense-in-depth.

Fix recommendation: add `helmet` (or set the headers at the proxy) with an API-
appropriate policy.

---

## BE-011 — OAuth account linking by email does not require a verified email

- Severity: Low (elevates BE-003)
- CWE: CWE-287 (Improper Authentication)
- Confidence: Confirmed
- Untrusted boundary: verified OAuth profile email.
- Sink: `UsersService.upsertFromOAuth` account linking.

Evidence:

`src/users/users.service.ts:52-55`
```ts
    if (!existing) {
      // If an email is provided, try to link to an existing user first.
      let user = profile.email ? await this.findByEmail(profile.email) : null
      if (!user) {
```

Description: a new OAuth identity is linked to any pre-existing account with the
same email without checking `profile.emailVerified` (the flag is captured but not
gated). For first-party Google tokens the email is normally Google-verified, so
in isolation this is low risk — but it is the linking primitive that turns
BE-003 (accept any Google `aud`) into full account takeover, and would also link
an OAuth login to a local account whose `emailVerified` is `false` (local
registration sets it false).

Exploit scenario: see BE-003; also, a local account created for
`victim@example.com` (unverified) is silently merged with any OAuth login
presenting that email.

Impact: account linking/takeover when combined with a weak token-audience or
unverified-email assumption.

Fix recommendation: only link to an existing account when the incoming profile's
email is provider-verified, and consider requiring explicit user confirmation to
merge a local account with an OAuth identity.

---

## BE-012 — Informational: `$queryRawUnsafe` in analytics interpolates a clamped integer (reviewed, NOT injectable)

- Severity: Informational
- CWE: n/a (documented non-finding for the SQLi grep requirement)
- Confidence: Confirmed

Evidence:

`src/admin/admin.service.ts:562-569` (and the identical shape at 580-587)
```ts
    const signupRows = await this.prisma.$queryRawUnsafe<
      Array<{ d: Date | string; count: bigint | number }>
    >(
      `SELECT DATE(createdAt) AS d, COUNT(*) AS count
       FROM users
       WHERE createdAt >= (NOW() - INTERVAL ${win} DAY)
       GROUP BY d ORDER BY d ASC`,
    )
```

The interpolated `win` is sanitized to an integer in [7,90] before use:
`const win = Math.min(90, Math.max(7, Math.floor(days) || 30))` (admin.service.ts,
`analytics`), where `days` originates from `@Query('days')` → `parseInt(...)`. No
attacker-controlled string reaches the SQL, the route is admin-guarded, and the
other two raw calls (lines 545, 626) are `$queryRaw` tagged templates with no
user input. Conclusion: no SQL injection. Recommendation: still prefer a bound
parameter or `$queryRaw` for consistency and to keep the "no `Unsafe` with
interpolation" invariant mechanical.

---

## BE-013 — Informational: top-up credits→amountCents can overflow the 32-bit payments column at extreme inputs

- Severity: Informational
- CWE: CWE-190 (Integer Overflow or Wraparound) — availability/robustness only
- Confidence: Likely

Evidence: `create-topup.dto.ts` allows `credits` up to `100_000_000`
(`@Max(100_000_000)`), and `payments.service.ts:createTopupKhqr` computes
`amountCents = Math.ceil((credits / creditsPerDollar) * 100)` while
`Payment.amountCents` / `CreditTopup.amountCents` are `Int` (32-bit,
`schema.prisma`). With a small admin `creditsPerDollar`, `amountCents` can exceed
2,147,483,647 and fail the INSERT.

Description: no fund loss (credits are only granted on confirmed payment, and the
row write would error), but the mismatch between the DTO ceiling and the column
range means extreme requests raise an unhandled DB error rather than a clean 400.

Fix recommendation: bound `amountCents` explicitly (reject if it exceeds a sane
maximum) and/or align the DTO ceiling with the column type.

---

# POSITIVE CONTROLS (correctly implemented)

- Global input validation is strict: `main.ts:52-58`
  `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
- Body-size limits are configured: `main.ts:23-48` — 100kb default, 50mb only for
  the authenticated `/api/studio/deploy`, and `/api/studio/git-proxy` is streamed
  (not buffered).
- CORS is a single exact origin, not a wildcard: `main.ts:61-64`
  `enableCors({ origin: config.get('app.webOrigin'), credentials: true })`.
- Authorization reflects live state, not stale token claims: `RayuAuthGuard`
  reloads the user (`auth.service.ts:resolveAccessToken` → `findById`, rejects
  non-`active` status) and `RolesGuard` checks the DB role, so demotion/suspension
  take effect immediately (`roles.guard.ts`).
- Admin surface is fully guarded at the class level: `admin/admin.module.ts:495`
  `@Controller('admin') @UseGuards(RayuAuthGuard, RolesGuard) @Roles('admin','superadmin')`.
- Password hashing is sound and comparison is constant-time:
  `auth.service.ts:hashPassword` (scrypt + 16-byte random salt) and
  `verifyPassword` (`crypto.timingSafeEqual` over equal-length buffers).
- No user-payment IDOR: `payments.controller.ts` derives `userId` from
  `@CurrentUser()`, and `PaymentsService.checkStatus/cancel/renew` enforce
  `payment.userId !== userId → ForbiddenException`.
- Provider API keys are write-only: `providers.service.ts` `toKeyView`/`ProviderKeyView`
  expose only `maskedKey`; plaintext/`encryptedKey`/`keyHash` are never returned,
  and audit logs record the mask only. Same pattern for Studio tokens
  (`studio-connections.service.ts` returns `maskedToken` only).
- Secrets at rest use authenticated encryption: `common/secretBox.ts` — AES-256-GCM,
  12-byte random IV, 16-byte tag, versioned envelope, master key required to be
  ≥32 chars and never stored in the DB; decrypt failures are generic (no oracle).
- Provider base-URL SSRF controls: `common/provider-security.ts` — https-only to
  public hosts, blocks private/loopback/link-local/metadata literals and embedded
  credentials, validates endpoint paths; enforced on create AND update.
- Studio SSRF controls: `common/studio-urls.ts` — git-host allow-list
  (`requireGitProxyUrl`), private-address deny-list (`requirePublicUrl`), Supabase
  suffix rule; web-search re-validates the post-redirect URL; MCP rejects
  `command` servers (RCE) and re-validates stored URLs before use. All studio
  controllers are `@UseGuards(RayuAuthGuard)` and resolve per-user credentials.
- Telegram per-user isolation: `telegram.service.ts` `relaySend` whitelists
  methods and forces `chat_id` to the caller's own link; inbound file downloads
  require a per-user grant (`telegram.file-grants.ts`) and validate file id/path
  (`telegram.util.ts` `isPlausibleFileId`/`isSafeTelegramFilePath`); `tgDownloadFile`
  uses `redirect:'error'` + size/timeout caps and keeps the bot token out of errors.
- Money-setting inputs are bounded and admin-only: `admin.module.ts` `UpdateSettingsDto`
  (`creditsPerDollar` `@Min(0)@Max(10_000_000)`, `minTopupCents` `@Min(1)@Max(1_000_000)`)
  and per-model credit multipliers `@Min(0)@Max(1000)`; promo `computeDiscount`
  floors/caps the discount and clamps final ≥ 0. Non-admins cannot reach these
  routes (RolesGuard). (Direct answer: neither `creditsPerDollar` nor
  `minTopupCents` can be set negative, and only an admin can set them.)
- Payment paid-transition is idempotent: `payments.service.ts` `activatePaid` uses
  `updateMany({ where: { status:'pending' }})` and treats `count===0` as
  already-activated, preventing duplicate subscriptions/carry-over.
- MySQL access is via Prisma query builder everywhere except the 4 reviewed raw
  calls (BE-012); no string-interpolated SQL with user input.

---

# ROUTE / GUARD MATRIX (auth-guard question)

Enumerated every `@Controller` (grep-verified). Routes with NO auth guard, and
why each is acceptable:

- `GET /api/health` — `health.module.ts` HealthController, public liveness. OK.
- `GET /api/plans` — `plans.controller.ts`, public plan catalog (no sensitive
  data). OK.
- Auth entry points (necessarily public): `POST /api/auth/register`,
  `/api/auth/login`, `/api/admin-login`, `/api/auth/oauth/google`,
  `/api/web/session`, `/api/cli/exchange`, `/api/cli/token`, `/api/cli/refresh`
  (`auth.controller.ts`). These mint/verify credentials themselves; see BE-005
  (no throttling) and BE-002/BE-003 (secret/audience handling).
- `POST /api/telegram/webhook` — public by design, secret-gated; see BE-004
  (fail-open when secret unset).

All other controllers are guarded: `admin` (RayuAuthGuard+RolesGuard),
`payments`, `usage`, `feedback`, `telegram` (all non-webhook routes), and all 8
`studio/*` controllers use `RayuAuthGuard`; `me`/`me/entitlements`/
`me/credit-history` on the auth controller are `@UseGuards(RayuAuthGuard)`. No
global `APP_GUARD` is registered (guards are per-controller/route); no accidental
unguarded sensitive route was found. No IDOR found (all authenticated handlers
derive `userId` from the JWT, not the request body/param).

---

# FILES READ (every line)

- src/main.ts (re-read fresh — initial read was stale)
- src/app.module.ts (re-read fresh — initial read was stale, StudioModule present)
- src/config/configuration.ts
- src/seed.ts
- src/auth/auth.controller.ts, auth.service.ts, oauth.service.ts,
  code-store.service.ts, rayu-auth.guard.ts, roles.guard.ts, roles.decorator.ts,
  current-user.decorator.ts, dto/auth.dto.ts, auth.module.ts
- src/admin/admin.module.ts (contains AdminController), admin.service.ts
- src/users/users.service.ts
- src/payments/payments.controller.ts, payments.service.ts, aba.service.ts,
  aba-telegram.listener.ts, bakong.service.ts, dto/create-topup.dto.ts,
  dto/create-khqr.dto.ts, dto/promo-action.dto.ts
- src/promo/promo.service.ts
- src/settings/app-settings.service.ts
- src/providers/providers.service.ts
- src/common/secretBox.ts, provider-security.ts, features.ts, enums.ts, studio-urls.ts
- src/telegram/telegram.controller.ts, telegram.service.ts, telegram.client.ts,
  telegram.util.ts, telegram.file-grants.ts
- src/usage/usage.controller.ts, usage.service.ts
- src/feedback/feedback.service.ts, feedback.module.ts (contains FeedbackController)
- src/plans/plans.controller.ts
- src/prisma/prisma.service.ts
- src/health/health.module.ts
- src/studio/studio.module.ts, studio-connections.controller.ts,
  studio-connections.service.ts, studio-upstream.service.ts,
  studio-git-proxy.controller.ts, studio-web-search.controller.ts,
  studio-mcp.controller.ts, studio-supabase.controller.ts, studio-scm.controller.ts,
  studio-deploy.controller.ts
- prisma/schema.prisma
- Dockerfile, docker-entrypoint.sh, package.json
- scripts/mint-session.ts, scripts/backfill-provider-keys.ts
- .env (secrets reported redacted), .env.example, .gitignore, .dockerignore
- Grep sweeps across all of src/ for: raw SQL sinks; Throttle/helmet/rateLimit;
  child_process/eval/spawn; controller/guard enumeration.

# NOT READ (with reasons)

- src/models/models.service.ts, models.constants.ts, models.module.ts — admin-
  guarded catalog CRUD; grep confirmed no raw SQL and no secret-returning sink;
  admin DTOs for models were read in admin.module.ts. Not line-read (time-boxed,
  low residual risk).
- src/plans/plans.service.ts, plans.constants.ts — seeded catalog + entitlement
  math; no untrusted-input sink (consumed via guarded controllers). Not line-read.
- src/providers/providers.constants.ts — provider seed/format defaults (constants).
- scripts/telegram-login.ts — developer helper that generates a TELEGRAM_SESSION;
  not a runtime endpoint (relevant only to BE-008's secret provenance).
- Trivial DI wiring modules (users/usage/payments/plans/models/providers/telegram/
  prisma/app-settings/promo .module.ts) — controller registration confirmed via
  grep; no logic.
- All *.spec.ts, test/*, jest/tsconfig/nest-cli configs — test/build assets, not
  runtime attack surface.
- prisma/migrations/*.sql — schema.prisma is the authoritative current schema and
  was read in full; individual historical migrations were not re-read.

---

# ANSWERS TO THE SPECIFIC QUESTIONS

1. LOCAL_ADMIN_PASSWORD / admin@rayucode.com path: reachable in production via
   `POST /api/admin-login` (auth.controller.ts:106), created/refreshed on boot
   (app.module.ts `ensureLocalAdmin`, lines 25/114-140). NOT rate limited (BE-005).
   Comparison IS timing-safe (scrypt + `timingSafeEqual`). Password is NOT logged
   (request logger records method+url only; ensureLocalAdmin logs nothing).
2. ABA confirmation authenticity: NOT verified by sender — only a (fail-open)
   chat-id filter; no amount+reference binding (amount-only), no replay
   protection, no trxId idempotency. An attacker who can post in the group can
   mint credits/plans. See BE-001.
3. TELEGRAM_WEBHOOK_SECRET: enforced ONLY when set; when unset the check returns
   `true` (fail open). See BE-004 (telegram.service.ts:426-428).
4. Promo redemption: `usedCount` is incremented inside a transaction with a
   per-user unique constraint, but the "first N" cap re-check is not row-locked →
   TOCTOU oversell across concurrent distinct users. See BE-007.
5. Credits math: `amountCents` is `Math.ceil`, credits are `@Min(1)` integers, and
   admin rates are `@Min(0)`/`@Min(1)` bounded — no negative and no float rounding
   exposure; the only edge is a 32-bit column overflow at extreme inputs (BE-013).
   Non-admins cannot change money settings.
6. Every controller route: matrix above. Unguarded routes are health, public plan
   catalog, the auth entry points, and the (secret-gated) telegram webhook — all
   intentional. No global guard; no accidental unguarded sensitive route.
7. IDOR: none found — authenticated handlers take `userId` from the JWT; admin
   routes take `:id` but are role-guarded.
8. CORS/helmet/rate-limit/body-limit/validation: CORS single-origin (good), NO
   helmet (BE-010), NO rate limiting (BE-005), body limits configured (good,
   POSITIVE CONTROLS), ValidationPipe whitelist+forbidNonWhitelisted+transform
   (good).
9. Provider API keys / plaintext in responses: NO — keys are write-only, responses
   carry only `maskedKey` (providers.service.ts `toKeyView`). POSITIVE CONTROL.
10. JWT: HS256 (default; no asymmetric key, so no alg-confusion), secret from
    `RAYU_JWT_SECRET` with an insecure hardcoded fallback and no production guard
    (BE-002); access+refresh expiry validated by `jwt.verify`; NO refresh
    rotation/reuse detection/revocation (BE-006).
