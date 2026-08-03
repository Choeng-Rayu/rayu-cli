# rayu-web — Defensive Security Audit Findings

Scope: `/home/rayu/rayu-cli/rayu-web/` only (Next.js 15 App Router + NextAuth v5 beta). Read-only. No source file was modified.
Method: full read of every `*.ts/*.tsx/*.mjs`/`Dockerfile` in scope (node_modules/.next excluded), input→sink tracing, guard bypass analysis, dependency version check against the lockfile.

## Executive summary

rayu-web is a **thin client**: the only server route is NextAuth (`app/api/auth/[...nextauth]/route.ts`). Every "protected" page (dashboard, billing, credits, admin) is a `'use client'` component that fetches from the **rayu-backend / rayu-gateway** with a bearer token; all authorization is delegated to those services (out of scope). Consequently there is **no server-rendered sensitive data and no privileged web API route** to attack directly.

No Critical or High web-tier finding was confirmed: no XSS sink (React auto-escaping throughout; the three `dangerouslySetInnerHTML` uses are static JSON-LD; `react-markdown` is used without `rehype-raw`), no open redirect, no client-controlled price/amount (all money is backend-authoritative), no IDOR in the web tier, and the installed Next.js (15.5.19) is **past** the CVE-2025-29927 fix. The real findings are credential-handling and hardening weaknesses (tokens in `localStorage`, Google ID token surfaced to the client, no security headers, container as root) plus defense-in-depth gaps (no server-side auth gate; admin role check is client-side only).

| ID | Title | Severity |
|----|-------|----------|
| WEB-001 | Rayu access **and 30-day refresh** tokens persisted in `localStorage` | Medium |
| WEB-002 | Google OIDC **id_token** exposed to client JavaScript via the NextAuth session | Medium |
| WEB-003 | No server-side authz: middleware is a no-op; admin role gate is client-side only | Low |
| WEB-004 | No HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) | Low |
| WEB-005 | Docker image runs as root (no `USER`) | Low |
| WEB-006 | Real OAuth client secret + NextAuth signing key present in on-disk `.env.local` | Low |
| WEB-007 | Server secrets passed as Docker build `ARG`/`ENV` | Low |
| WEB-008 | CLI-login device-code: weak state check + code↔identity binding delegated to backend | Informational |
| WEB-009 | Decorative client-only promo code on `/plans` | Informational |

---

## WEB-001 — Rayu access and 30-day refresh tokens persisted in `localStorage`

- Severity: **Medium** (escalates to High/Critical if any XSS is introduced)
- CWE/OWASP: CWE-522 Insufficiently Protected Credentials, CWE-539 Persistent Storage of Sensitive Data / OWASP A07:2021 Identification & Authentication Failures
- File:line: `lib/useRayuToken.ts:44`, `app/admin/AdminProvider.tsx:79` (+`:50`), `app/sign-in/page.tsx:36,58`, `app/sign-up/page.tsx:37,63`

`lib/useRayuToken.ts` (interface + writer):
```ts
export interface RayuSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  ...
}
```
```ts
function writeStoredSession(s: RayuSession): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(RAYU_SESSION_KEY, JSON.stringify(s))
}
```
`app/admin/AdminProvider.tsx:50,79` (admin session):
```ts
const LOCAL_SESSION_KEY = 'rayu_admin_session'
...
  localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(s))
```

Description: The full backend-issued session — `accessToken` **and** `refreshToken` (documented in `useRayuToken.ts` as a "30-day lifetime, issued by the backend") plus `user.role` — is written to `localStorage` under `rayu_session` (users) and `rayu_admin_session` (admins). `localStorage` is readable by any JavaScript executing on the origin and is not cleared on tab close.

Exploit scenario: Any script-execution foothold on the origin (a future XSS, a compromised/typosquatted npm dependency in the client bundle, or a malicious browser extension) can read both keys and exfiltrate the refresh token, granting ~30 days of silent re-authentication via `POST /cli/refresh` (see `refreshSession`), surviving password changes unless the backend revokes. Theft of `rayu_admin_session` yields an admin refresh token.

Impact: Long-lived account takeover on token theft; elevated (admin) takeover for the admin key. The 30-day refresh token is the highest-value secret in the browser and is the class of credential that should never live in `localStorage`.

Fix recommendation (describe only): Have the server perform the token exchange and set the tokens as `HttpOnly; Secure; SameSite=Lax/Strict` cookies (a Route Handler or Server Action), so client JS never holds the refresh token; keep only short-lived, low-value data client-side. Pair with a CSP (WEB-004). Ensure backend refresh-token rotation/revocation.

Confidence: **High** — code paths read directly.

Notes: No XSS sink was found in the current app, so this is a latent amplifier rather than an actively exploitable leak today; severity is stated accordingly.

---

## WEB-002 — Google OIDC `id_token` exposed to client JavaScript via the NextAuth session

- Severity: **Medium**
- CWE/OWASP: CWE-200 Exposure of Sensitive Information, CWE-522 / OWASP A02:2021 Cryptographic Failures
- File:line: `auth.ts:91`, `types/next-auth.d.ts:5,11`; consumed at `app/cli-login/page.tsx:41-42`, `lib/useRayuToken.ts:158-166`, `app/sign-in/page.tsx:27-33`, `app/admin/AdminProvider.tsx:196-199`

`auth.ts:89-92`:
```ts
async session({ session, token }) {
  if ((token as any).idToken) {
    session.idToken = (token as any).idToken as string
  }
```
`types/next-auth.d.ts:4-6`:
```ts
  interface Session {
    idToken?: string
```

Description: The `session` callback copies the raw Google **id_token** into the NextAuth `Session`, which is exposed to the browser via `useSession()` and the unauthenticated-to-JS `GET /api/auth/session` endpoint. That id_token is a bearer credential the backend accepts to mint a full Rayu session (`POST /auth/oauth/google`) and a CLI device code (`POST /cli/exchange`, `app/cli-login/page.tsx:42`). The Google **refresh_token** is correctly kept server-side (it is set on the JWT in the `jwt` callback but never added to `session`) — only the id_token leaks, which is the right thing to scrutinize.

Exploit scenario: Any theft of the session (XSS reading `session.idToken`, or exfiltration/replay of the NextAuth session cookie against `/api/auth/session`) lets an attacker replay the id_token to `/auth/oauth/google` and obtain the victim's Rayu access+refresh tokens, within the token's ~1h validity.

Impact: Account impersonation; combined with WEB-001 it widens the credential blast radius of any client-side compromise.

Fix recommendation (describe only): Do not place the raw `id_token` in the client-visible session. Perform the `/auth/oauth/google` exchange on the server (Route Handler/Server Action) immediately after sign-in and store the resulting Rayu session in `HttpOnly` cookies; expose only non-sensitive profile fields (name/email/avatar) to the client.

Confidence: **High**.

Notes: This is a deliberate design choice (the client currently needs the id_token to call the backend). It is common with NextAuth but does raise the client-side attack surface.

---

## WEB-003 — No server-side authorization: middleware is a no-op; admin role gate is client-side only

- Severity: **Low** (defense-in-depth; no web-tier data leak demonstrable because enforcement is on the backend, which was not in scope to verify)
- CWE/OWASP: CWE-602 Client-Side Enforcement of Server-Side Security, CWE-284 Improper Access Control / OWASP A01:2021 Broken Access Control
- File:line: `middleware.ts:4-6,10`; `app/admin/AdminProvider.tsx:140`; `app/admin/AdminShell.tsx:83-84`; `app/admin/layout.tsx`

`middleware.ts:4-11`:
```ts
export default auth((req) => {
  // Allow all public traffic; protected pages check auth themselves.
  return NextResponse.next()
})

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|robots\\.txt|sitemap\\.xml|.*\\.png$).*)'],
}
```
`app/admin/AdminProvider.tsx:139-143` (the only role gate):
```ts
        const user = await validateToken(s.accessToken)
        if (user.role !== 'admin' && user.role !== 'superadmin') {
          clearStoredAdmin()
          setForbidden(true)
          return
        }
```

Description: The middleware matches nearly all routes but unconditionally returns `NextResponse.next()` — it enforces nothing. No `layout.tsx`/page performs a server-side auth check (all seven route layouts are pass-throughs; verified). `/admin` is protected only by a **client-side** role comparison in `AdminProvider`/`AdminShell`, and every admin data call goes through `apiFetch` (bearer token) to the backend.

Exploit / bypass: An attacker can trivially render the admin shell locally (patch the JS, or set `localStorage['rayu_admin_session']`, or flip `forbidden`), but this yields **no data**: `apiFetch` only carries a token the backend must accept for `/admin/*`, and `validateToken` calls `/me`. Without a valid admin bearer token the backend returns 401/403 and the UI stays empty. So the client gate is cosmetic and its bypass does not, by itself, disclose anything.

Impact: Defense-in-depth gap. Sensitive admin route structure/logic ships to all clients; the entire access-control burden rests on the backend/gateway (not verified here). If a backend `/admin/*` endpoint ever misses a role check, there is no second line of defense in the web tier.

Fix recommendation (describe only): Enforce authentication/role in `middleware.ts` (or in server components/route handlers) for `/admin`, `/dashboard`, `/billing`, `/credits`; treat the client-side gate as UX only. If middleware remains a no-op, remove the misleading matcher.

Confidence: **High** for the code facts; impact bounded by the backend being the real enforcement point.

---

## WEB-004 — No HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)

- Severity: **Low**
- CWE/OWASP: CWE-693 Protection Mechanism Failure, CWE-1021 UI Redress / OWASP A05:2021 Security Misconfiguration
- File:line: `next.config.mjs:1-30` (no `headers()` / `async headers()`)

```js
const nextConfig = {
  output: 'standalone',
  webpack: (config, { isServer }) => { ... },
  experimental: { serverComponentsExternalPackages: ['jose'] },
}
export default nextConfig
```

Description: The Next config defines no response security headers. There is no Content-Security-Policy, HSTS, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options: nosniff`, or `Referrer-Policy`. Given that auth tokens live in `localStorage` (WEB-001) and the Google id_token is client-readable (WEB-002), the absence of a CSP notably enlarges the impact of any injected script; the absence of framing controls allows clickjacking of `/billing` and the admin login form.

Exploit scenario: Clickjacking overlay of the billing/admin-login pages; and if any XSS arises, no CSP exists to blunt token exfiltration.

Impact: Weakened XSS containment and framing/MIME hardening across the whole site.

Fix recommendation (describe only): Add `async headers()` in `next.config.mjs` returning a strict `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options: DENY` (or CSP `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`.

Confidence: **High**.

---

## WEB-005 — Docker image runs as root (no `USER`)

- Severity: **Low**
- CWE/OWASP: CWE-250 Execution with Unnecessary Privileges / CIS Docker Benchmark 4.1
- File:line: `Dockerfile:41-53` (runner stage)

```dockerfile
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
...
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
```

Description: The runner stage never drops privileges (`node:20-alpine` defaults to `root`, and no `USER` directive is present). The Next standalone server runs as root inside the container.

Exploit scenario: A remote-code-execution or container-escape primitive gained through any dependency runs with root in the container, easing further compromise/persistence.

Impact: Larger blast radius for any container compromise.

Fix recommendation (describe only): Add a non-root user in the runner stage (the base image ships `node`), `chown` the copied app files, and `USER node` before `CMD`.

Confidence: **High**.

---

## WEB-006 — Real OAuth client secret and NextAuth signing key present in on-disk `.env.local`

- Severity: **Low** (verified NOT committed / not in git history; local-disk exposure only)
- CWE/OWASP: CWE-798 Use of Hard-coded Credentials, CWE-312 Cleartext Storage of Sensitive Information / OWASP A05:2021
- File:line: `.env.local:4` (`NEXTAUTH_SECRET`), `.env.local:9` (`GOOGLE_CLIENT_SECRET`), `.env.local:8` (`GOOGLE_CLIENT_ID`)

```
NEXTAUTH_SECRET=<REDACTED — real 32-byte base64 value present on disk>
...
GOOGLE_CLIENT_SECRET=<REDACTED — real Google OAuth client secret, "GOCSPX-…" prefix>
```

Description: `.env.local` holds what appear to be **real, currently-usable** dev credentials: the NextAuth session-signing key and a Google OAuth client secret (the `GOCSPX-` prefix indicates a genuine Google secret). I verified these are **not** exposed via source control: `git ls-files` tracks only `.env.example`; `git check-ignore` confirms `.env` and `.env.local` are ignored; and `.env.local` has no git history. `.dockerignore` also excludes `.env`/`.env.local`, so they are not copied into the image build context.

Exploit scenario: The values are safe from repo/image leakage today, but they exist in cleartext on the developer host. If this file is ever shared (backup, screen-share, misconfigured sync), `NEXTAUTH_SECRET` allows forging valid session JWTs and `GOOGLE_CLIENT_SECRET` allows impersonating the OAuth client.

Impact: Session forgery / OAuth client impersonation **if** the file leaks; contained today by gitignore + dockerignore.

Fix recommendation (describe only): Rotate both secrets (they have been written to disk in cleartext); source them from a secrets manager for local dev; keep the existing gitignore/dockerignore protections.

Confidence: **High** (values read; git/dockerignore status verified). Real values are redacted per policy.

---

## WEB-007 — Server secrets passed as Docker build `ARG`/`ENV`

- Severity: **Low**
- CWE/OWASP: CWE-522 / CWE-200 / OWASP A05:2021
- File:line: `Dockerfile:18-28` (esp. `:25` `ENV NEXTAUTH_SECRET`, `:28` `ENV GOOGLE_CLIENT_SECRET`)

```dockerfile
ARG NEXTAUTH_SECRET
ARG GOOGLE_CLIENT_SECRET
...
ENV NEXTAUTH_SECRET=$NEXTAUTH_SECRET
...
ENV GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
```

Description: `NEXTAUTH_SECRET` and `GOOGLE_CLIENT_SECRET` (server-only secrets) are threaded through build `ARG`→`ENV` in the **builder** stage. The final `runner` stage is a separate `FROM` and does not re-declare them, so they are not in the shipped image's environment; but they are baked into the builder image's layers/history. `NEXT_PUBLIC_*` build args are expected (they are inlined into the client bundle by design).

Exploit scenario: If the builder image or its `docker history` is cached, pushed, or otherwise retained, the server secrets can be recovered from the build layers.

Impact: Potential secret disclosure from build artifacts (not from the runtime image).

Fix recommendation (describe only): Provide server-only secrets via BuildKit `RUN --mount=type=secret` (or inject at runtime), reserving build-time `ARG` for `NEXT_PUBLIC_*` values that must be inlined.

Confidence: **Medium** (final runtime image does not carry these ENVs; risk is limited to the build environment).

---

## WEB-008 — CLI-login device-code exchange: weak state check + code↔identity binding delegated to backend

- Severity: **Informational** (web-tier behavior is safe; residual risk is cross-component / backend)
- CWE/OWASP: CWE-352 CSRF, CWE-287 Improper Authentication / OWASP A01:2021
- File:line: `lib/cliLogin.ts:21`; `app/cli-login/page.tsx:35-53`

`lib/cliLogin.ts:19-22`:
```ts
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (state.length < 8 || state.length > 256) return null
  return { port, state }
```
`app/cli-login/page.tsx:38-53`:
```ts
        const res = await fetch(apiUrl('/cli/exchange'), {
          method: 'POST',
          headers: { ..., Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ state: params.state }),
        })
        ...
        const redirect = buildLoopbackRedirect(params.port, code, params.state)
        ...
        window.location.href = redirect
```

Description: When an authenticated user opens `/cli-login?port=&state=`, the page auto-exchanges the Google id_token for a device `code` and redirects it to `http://127.0.0.1:<port>/callback`. Positive aspects: the redirect host is hard-coded to `127.0.0.1` (`buildLoopbackRedirect`, no open redirect), and the code is delivered to the victim's **own** loopback, so an attacker on another machine cannot capture it. Weaknesses: `state` is only validated as 8–256 chars client-side (entropy is the backend's responsibility), and the exchange fires automatically on page load (CSRF-like trigger).

Exploit scenario: Cross-machine capture is not possible via this flow (loopback delivery). A residual **auth-code-injection** risk exists only if the backend/CLI also let a waiting CLI retrieve the code by `state` (polling) rather than solely via the loopback that initiated it — that binding lives in rayu-backend/CLI, out of this scope.

Impact: None demonstrable in the web tier; potential account linking abuse if the backend does not bind the code to the authenticated identity + originating request.

Fix recommendation (describe only): On the backend, bind the device code to the authenticated user and a PKCE-style verifier, require high-entropy state, and make the code redeemable only through the loopback that started the flow; consider an explicit user confirmation step instead of auto-exchange.

Confidence: **Medium** (web behavior verified; cross-component risk noted, not proven).

---

## WEB-009 — Decorative client-only promo code on `/plans`

- Severity: **Informational**
- CWE/OWASP: CWE-602 Client-Side Enforcement (no security impact) 
- File:line: `app/plans/page.tsx:269-277`

```tsx
  const PROMO_CODE = 'free-top-feature';
  ...
  const handlePromoApply = (e: React.FormEvent) => {
    e.preventDefault();
    if (promoInput.trim().toLowerCase() === PROMO_CODE) {
      setPromoStatus('success');
    } else { setPromoStatus('invalid'); }
  };
```

Description: The marketing `/plans` page contains a hard-coded promo string that only toggles a success **message** ("Enjoy free Basic…"). It performs **no** API call and grants **no** entitlement. Real promo redemption happens on `/billing` against backend `POST /payments/promo/preview|claim` (`app/billing/page.tsx`), where the client sends only `{planCode, code}` and the backend computes/validates everything.

Exploit scenario: None — the "success" state is cosmetic and confers nothing.

Impact: Misleading UX; a discoverable string that implies a benefit it does not deliver.

Fix recommendation (describe only): Remove the fake promo or wire it to the backend preview endpoint; do not imply entitlement client-side.

Confidence: **High**.

---

## POSITIVE CONTROLS (verified good)

- **Not vulnerable to CVE-2025-29927 (Next.js middleware auth bypass).** Installed version is `next 15.5.19` (`package-lock.json:5281`), past the 15.2.3 fix. Declared range is `^15.1.6` (`package.json:15`). The bypass is moot anyway since `middleware.ts` performs no authorization.
- **Prices/amounts are backend-authoritative (no price tampering).** Billing sends only `{planCode, promoCode?}` and reads `amountCents` from the server (`app/billing/page.tsx` `initiatePayment`); `lib/plans.ts` renders server `priceCents` ("Prices come from the backend … never hardcoded here"); the dashboard top-up posts a `credits` quantity and the server returns `amountCents` (`app/dashboard/page.tsx` `buyCredits`). Verified in `lib/plans.test.ts` ("price from DB").
- **`dangerouslySetInnerHTML` is only static JSON-LD.** `app/layout.tsx:92,97` serialize static objects from `app/structured-data.ts`; `app/page.tsx:69` is a static `SoftwareApplication` schema. No attacker-controlled input reaches these sinks.
- **Docs/Changelog markdown rendering is safe.** `app/docs/DocsRenderer.tsx` uses `react-markdown` v10 + `remark-gfm` with **no** `rehype-raw`/`allowDangerousHtml`, so embedded HTML is not rendered; content is trusted local `.md` (`getDocContent`, filesystem). The `[slug]` route is doubly guarded against path traversal: `export const dynamicParams = false` + an explicit `docs.some((d) => d.slug === slug)` allowlist before `getDocContent` (`app/docs/[slug]/page.tsx:50-52`).
- **No XSS sink in dynamic content.** User/backend-supplied strings (feedback `f.message` at `app/admin/feedback/page.tsx`, chat `msg.text`, all admin tables, `Charts.tsx` labels via SVG `<text>/<title>`) are rendered through React JSX auto-escaping; no `innerHTML`/`eval`/`new Function` anywhere (grep clean).
- **No open redirect.** All `signIn` `callbackUrl` values are same-origin/relative (`/dashboard`, `/admin`, `window.location.href`); the CLI callback host is hard-coded to `127.0.0.1` (`lib/cliLogin.ts` `buildLoopbackRedirect`, asserted in `lib/cliLogin.test.ts`).
- **Provider API keys are write-only + masked.** `ProviderKeyView` exposes only `maskedKey` (`app/admin/types.ts`); the providers page uses `type="password"` inputs and clears plaintext from state after save (`app/admin/providers/page.tsx`); comments confirm the secret is "never returned".
- **No web API route accepts `userId`/amount from the client.** The only route handler is `app/api/auth/[...nextauth]/route.ts`; all data access is bearer-token scoped to the backend.
- **Secrets kept out of VCS and image context.** `git ls-files` tracks only `.env.example`; `git check-ignore` confirms `.env`/`.env.local` ignored; `.dockerignore` excludes `.env`/`.env.local`. Google **refresh_token** is stored only on the server-side JWT, never added to the client session (`auth.ts` `jwt` vs `session`).

---

## FILES READ (line-by-line)

Config / infra:
- `auth.ts`, `middleware.ts`, `next.config.mjs`, `Dockerfile`, `.dockerignore`, `.gitignore`, `.env`, `.env.local`, `.env.example`, `package.json`, `types/next-auth.d.ts`
- `package-lock.json` (targeted: `next`/`next-auth` resolved versions)

App routes / pages:
- `app/layout.tsx`, `app/page.tsx`, `app/providers.tsx`, `app/structured-data.ts`, `app/sitemap.ts`
- `app/api/auth/[...nextauth]/route.ts`
- `app/sign-in/page.tsx`, `app/sign-up/page.tsx`
- `app/cli-login/page.tsx`, `app/cli-login/layout.tsx`
- `app/dashboard/page.tsx`, `app/dashboard/layout.tsx`
- `app/billing/page.tsx`, `app/billing/layout.tsx`
- `app/credits/page.tsx`, `app/credits/layout.tsx`
- `app/plans/page.tsx`, `app/plans/layout.tsx`
- `app/docs/page.tsx`, `app/docs/[slug]/page.tsx`, `app/docs/getDocs.ts`, `app/docs/DocsRenderer.tsx`, `app/docs/DocsLayout.tsx`, `app/docs/layout.tsx`
- `app/changelog/page.tsx`, `app/changelog/layout.tsx`
- `app/chatbot/page.tsx`, `app/chatbot/TerminalChat.tsx`
- `app/components/NavAuth.tsx`, `app/components/GithubStars.tsx`, `app/components/HeroCTA.tsx`, `app/components/HeroTerminal.tsx`

Admin:
- `app/admin/layout.tsx`, `app/admin/AdminProvider.tsx`, `app/admin/AdminShell.tsx`, `app/admin/page.tsx`
- `app/admin/analytics/page.tsx`, `app/admin/users/page.tsx`, `app/admin/users/[id]/page.tsx`, `app/admin/plans/page.tsx`, `app/admin/promo-codes/page.tsx`, `app/admin/providers/page.tsx`, `app/admin/payments/page.tsx`, `app/admin/feedback/page.tsx`
- `app/admin/models/page.tsx` (redirect), `app/admin/credit-settings/page.tsx` (redirect)
- `app/admin/types.ts`, `app/admin/providerName.ts`, `app/admin/contextWindow.ts`, `app/admin/gatewayError.ts`

Lib / components:
- `lib/config.ts`, `lib/useRayuToken.ts`, `lib/cliLogin.ts`, `lib/dashboard.ts`, `lib/plans.ts`, `lib/gatewayNotify.ts`, `lib/utils.ts`
- `components/admin/ui.tsx`, `components/Charts.tsx`, `components/KhqrCard.tsx`, `components/ui/pricing-section.tsx`
- `scripts/copy-docs.js` (build-time doc copier; no runtime/untrusted-input surface)

Tests read in full: `lib/cliLogin.test.ts`, `lib/plans.test.ts`, `app/admin/gatewayError.test.ts`.

## NOT READ (with reasons)

- `node_modules/`, `.next/`, `next-env.d.ts`, `package-lock.json` (beyond version lookups), `tsconfig.tsbuildinfo`, `.vercel/`, `public/` assets — excluded by audit scope / generated artifacts / not source.
- `.rayu/` (rayu-web local dir) — tooling state, out of source scope.
- Unit tests not opened line-by-line: `lib/dashboard.test.ts`, `lib/gatewayNotify.test.ts`, `app/admin/contextWindow.test.ts`, `app/admin/providerName.test.ts`. Reason: these exercise pure helper functions whose implementations were fully read (`lib/dashboard.ts`, `lib/gatewayNotify.ts`, `app/admin/contextWindow.ts`, `app/admin/providerName.ts`); test code is not shipped to production and processes no untrusted runtime input.
- Non-code config not security-relevant to this scope: `postcss.config.js`, `tailwind.config.js`, `jest.config.json` (build/style/test tooling; no secrets or sinks).

## Cross-scope dependencies (flagged, not in web scope)

The web tier delegates ALL authorization and all money/credit computation to **rayu-backend** and **rayu-gateway**. The following must be confirmed there (outside this audit): role enforcement on every `/admin/*` and `/me` endpoint; server-side re-validation of promo `claim`/`preview` (that `isFree`/discount cannot be forged by a client sending an arbitrary `code`); IDOR protection on `/payments/:id/status`, `/admin/users/:id/*`; device-code↔identity binding for `/cli/exchange`; and refresh-token rotation/revocation for `/cli/refresh`.
