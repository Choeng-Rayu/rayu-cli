# Claude Paid Subscription Login (Pro / Max Plan) via /connect

## Improved Prompt

As a senior software engineer, add a **"Login with Claude (Pro plan / Max plan)"** auth path to the RAYU CLI. This path must be reachable from the **`/connect`** command (NOT from `/login`). When the user runs `/connect`, alongside the existing "pick a provider + API key" flow, they must see an option to sign in with their Claude.ai paid subscription (Pro plan or Max plan). Selecting it runs the Anthropic OAuth (PKCE) flow, stores the resulting Anthropic OAuth tokens, and wires the CLI to use that subscription as the active auth method for Claude models — separate from the existing Rayu JWT (`/login`) path.

A **complete reference implementation already exists** in `/home/rayu/rayu-cli/rayu/un-use-code/`. The CLI must learn from it and port the working pieces into the live `src/` tree. Do NOT reinvent the OAuth flow from scratch.

## Reference Material Already in the Repo (verified by reading the code)

### `un-use-code/services/oauth/index.ts` — `OAuthService` class
- Implements the OAuth 2.0 authorization-code flow with PKCE.
- `startOAuthFlow(authURLHandler, options)` — options include `loginWithClaudeAi`, `inferenceOnly`, `expiresIn`, `orgUUID`, `loginHint`, `loginMethod`, `skipBrowserOpen`. These flags select between the **Claude.ai auth** (paid subscription) path and the **Console auth** (API key) path.
- Internally: builds PKCE `codeVerifier` + `codeChallenge` + `state`, starts a localhost callback listener, builds two auth URLs (manual-paste and automatic-browser), waits for the auth code, exchanges it for tokens via `client.exchangeCodeForTokens`, fetches the user profile (`subscriptionType`, `rateLimitTier`, `rawProfile`) via `client.fetchProfileInfo`, and returns `OAuthTokens` containing `accessToken`, `refreshToken`, `expiresAt`, `scopes`, `subscriptionType`, `rateLimitTier`, `profile`, and `tokenAccount` (uuid + email + orgUuid).
- Has a manual fallback: `handleManualAuthCodeInput({ authorizationCode, state })` for headless/non-browser environments.

### `un-use-code/services/oauth/auth-code-listener.ts` — `AuthCodeListener` class
- Temporary localhost HTTP server that captures the OAuth redirect at `/callback?code=...&state=...`.
- Validates `state` (CSRF), captures the auth code, and (for the automatic flow) holds the pending `ServerResponse` so the success/error redirect can be sent back to the browser.
- `handleSuccessRedirect(scopes)` chooses between `CLAUDEAI_SUCCESS_URL` and `CONSOLE_SUCCESS_URL` based on scopes (via `shouldUseClaudeAIAuth(scopes)` from `./client.js` and `getOauthConfig()` from `../../constants/oauth.js`).

### `un-use-code/services/oauth/crypto.ts` — PKCE helpers
- `generateCodeVerifier`, `generateCodeChallenge`, `generateState`.

### `un-use-code/commands/login/login.tsx` — full login command wiring
- Wraps `ConsoleOAuthFlow` in a `Dialog`, then on success runs the standard post-login refresh sequence: `resetCostState`, `refreshRemoteManagedSettings`, `refreshPolicyLimits`, `resetUserCache`, `refreshGrowthBookAfterAuthChange`, `clearTrustedDeviceToken`, `enrollTrustedDevice`, permission killswitch re-checks, and bumps `authVersion` so auth-dependent hooks (MCP servers, etc.) re-fetch. **This is the post-success contract — the new `/connect` Claude-login path must run the equivalent refresh sequence.**

### Missing reference files (stripped from `un-use-code/`)
The reference `index.ts` and `auth-code-listener.ts` import from `./client.js` and `./types.js`, which are not present in `un-use-code/`. Those modules own: `buildAuthUrl`, `exchangeCodeForTokens`, `fetchProfileInfo`, `parseScopes`, `shouldUseClaudeAIAuth` (all in `client.ts`), and the types `OAuthProfileResponse`, `OAuthTokenExchangeResponse`, `OAuthTokens`, `RateLimitTier`, `SubscriptionType` (in `types.ts`). The agent must reconstruct these from the call sites in `index.ts`/`auth-code-listener.ts` and from Anthropic's public OAuth endpoints (the same ones Claude Code uses). Use `getOauthConfig()` from `constants/oauth.ts` for endpoints/URLs — check whether `src/constants/oauth.ts` already exists in the live tree; if it does, reuse it; if not, port the constants from `un-use-code/constants/oauth.ts` (referenced by `auth-code-listener.ts`).

### Current state in the live `src/` tree (verified)
- `src/components/ConsoleOAuthFlow.tsx` is a **24-line STUB** that prints "OAuth login is not supported in Rayu." — this is the file to replace.
- `src/commands/connect/connect.tsx` currently does: `RayuProviderSetup` → `SearchableModelPicker`. No Claude.ai / paid-subscription path exists.
- The existing `/login` command goes through rayu-backend (Google OAuth → Rayu JWT). The new path is **separate**: it produces **Anthropic OAuth tokens** tied to the user's Claude.ai Pro/Max subscription, not a Rayu JWT.

## CRITICAL RULES (per RAYU.md / AGENTS.md)

### Rule 1: NO ASSUMPTIONS — Read the Code First
Do NOT guess the OAuth endpoints, scopes, or token response shape. Before writing:
- ✅ READ every file under `un-use-code/services/oauth/` and `un-use-code/commands/login/`. The `index.ts` and `auth-code-listener.ts` show the exact contract `client.ts` and `types.ts` must satisfy — reconstruct those two modules from their call sites.
- ✅ READ `un-use-code/constants/oauth.ts` (referenced as `../../constants/oauth.js`) to learn the exact endpoint URLs, client IDs, scopes, and success URLs. Port them into the live `src/constants/` (check `src/constants/oauth.ts` first — extend if it exists, don't duplicate).
- ✅ READ the live `src/commands/connect/connect.tsx`, `src/components/RayuProviderSetup.tsx`, `src/components/SearchableModelPicker.tsx` to understand the existing connect UX so the new Claude-login option slots in cleanly.
- ✅ READ `src/services/rayuAuth/` (especially `rayuSession.ts`, `rayuEntitlements.ts`, `rayuHostedProvider.ts`) to see how the CLI currently stores auth tokens and routes requests to `rayu-gateway`. The Anthropic OAuth tokens must be stored in a **separate** credential slot (e.g. `~/.rayu/claude-oauth.json` or a new field in the auth store) — do NOT clobber the Rayu JWT.
- ✅ READ `src/services/api/claude.ts` to learn how Claude calls currently authenticate. The new path must inject the Anthropic OAuth `access_token` as the `Authorization: Bearer` for Claude calls (auto-refreshing via `refresh_token` when `expiresAt` passes), and must NOT send the request through `rayu-gateway` (the Pro/Max subscription is billed by Anthropic, not by Rayu credits).
- ✅ Check `ORIGIN_MANIFEST.md` for provenance of the files you touch.
- ❌ DON'T assume the upstream Claude Code OAuth endpoints — verify them from `un-use-code/constants/oauth.ts` (and, only if needed, Anthropic's public docs).
- ❌ DON'T reuse the Rayu JWT for Claude subscription calls. The two auth paths are distinct.
- ❌ DON'T strip the existing provider+API-key flow from `/connect`. The Claude-login option is **additive**.

### Rule 2: Search Before Writing
- Grep the live tree for any existing OAuth/PKCE helpers (`CodeVerifier`, `CodeChallenge`, `AuthCodeListener`, `OAuthService`, `claude.ai`, `console.anthropic`) — some may already be partially ported. Reuse before creating.
- Grep for `subscriptionType`, `rateLimitTier`, `Pro`, `Max` in `src/` to see if any tier-handling already exists.
- Check `src/utils/secureStorage/` (or wherever the CLI stores `~/.rayu/rayu-auth.json`) for the right place to persist the Anthropic OAuth tokens securely.

### Rule 3: Follow Project Conventions
- TypeScript + Bun, ES modules, dynamic `import()` for lazy loading.
- Do NOT convert feature-gated `require()` to static `import` — `feature('FLAG')` is compile-time DCE.
- New command path inside `/connect` must not require a new entry in `src/commands.ts` (it extends the existing `/connect`). New components/services go under existing directories.
- Token storage must use the same secure-storage patterns as the existing Rayu auth path (no plaintext tokens in world-readable files).

## Goal

A user with a Claude.ai Pro or Max subscription can:
1. Run `/connect`.
2. See a "Login with Claude (Pro plan / Max plan)" option alongside the existing provider+API-key flow.
3. Pick it → browser opens Anthropic's OAuth consent → user authorizes → CLI receives tokens (access, refresh, scopes, subscriptionType, rateLimitTier, profile, account).
4. The CLI stores the Anthropic OAuth tokens in a dedicated slot, runs the standard post-login refresh sequence (mirroring `un-use-code/commands/login/login.tsx`), and switches the active Claude auth to those tokens.
5. Subsequent Claude model calls authenticate with the stored `access_token`, auto-refresh via `refresh_token` on expiry, and skip `rayu-gateway` (Anthropic bills the subscription directly).
6. `/connect` continues to show the subscription status (plan + rate-limit tier) and offer a logout/forget option.

## Required Plan (write in detail)

### 1. Discovery & Audit (no code yet)
- Read every file under `un-use-code/services/oauth/` and `un-use-code/commands/login/`. Document the exact contract `client.ts` and `types.ts` must satisfy (function signatures, return shapes, endpoint URLs, scopes, success URLs).
- Read `un-use-code/constants/oauth.ts` (and any sibling constants) to extract the Anthropic OAuth endpoints, client IDs, scopes, and success URLs. Confirm which values are env-overridable.
- Audit the live `src/` tree: list which OAuth pieces already exist (if any), which `src/constants/oauth.ts` fields exist, and which `src/services/rayuAuth/` and `src/services/api/claude.ts` hooks must change to accept Anthropic OAuth tokens as an auth source.
- Decide the credential slot: extend the existing `~/.rayu/rayu-auth.json` schema, add a new `~/.rayu/claude-oauth.json`, or use `src/utils/secureStorage/`. Justify the choice and ensure the Rayu JWT is not clobbered.

### 2. Port the OAuth Reference (file-by-file, DCE-safe)
- `src/services/oauth/crypto.ts` — port `generateCodeVerifier`, `generateCodeChallenge`, `generateState` from `un-use-code/services/oauth/crypto.ts`. (Reuse if already present.)
- `src/services/oauth/auth-code-listener.ts` — port `AuthCodeListener` from `un-use-code/services/oauth/auth-code-listener.ts` (the localhost redirect-capture server). Reuse `getOauthConfig()` for success URLs; do not hardcode URLs.
- `src/services/oauth/client.ts` — reconstruct from the call sites in `index.ts` and `auth-code-listener.ts`: `buildAuthUrl({ codeChallenge, state, port, loginWithClaudeAi, inferenceOnly, orgUUID, loginHint, loginMethod, isManual })`, `exchangeCodeForTokens(authorizationCode, state, codeVerifier, port, isManual, expiresIn)`, `fetchProfileInfo(accessToken)` returning `{ subscriptionType, rateLimitTier, rawProfile }`, `parseScopes(scopeString)`, `shouldUseClaudeAIAuth(scopes)`. Use the endpoints from `src/constants/oauth.ts`.
- `src/services/oauth/types.ts` — define `OAuthTokens`, `OAuthTokenExchangeResponse`, `OAuthProfileResponse`, `SubscriptionType` (`'pro' | 'max' | ...`), `RateLimitTier`. Pin to the shapes the reference `index.ts` consumes.
- `src/services/oauth/index.ts` — port `OAuthService` (the `startOAuthFlow`, `waitForAuthorizationCode`, `handleManualAuthCodeInput`, `formatTokens`, `cleanup` methods) from `un-use-code/services/oauth/index.ts`. Keep the `loginWithClaudeAi` / `inferenceOnly` / `skipBrowserOpen` options — they select the Pro/Max subscription path.
- `src/constants/oauth.ts` — port/extend from `un-use-code/constants/oauth.ts` (endpoints, client IDs, scopes, `CLAUDEAI_SUCCESS_URL`, `CONSOLE_SUCCESS_URL`). Env-overridable where appropriate.

### 3. /connect UX Changes
- `src/components/ConsoleOAuthFlow.tsx` — replace the current 24-line stub with the real OAuth flow UI (browser-open instructions, manual-paste fallback, in-progress spinner, error/cancel handling). Mirror the UX from `un-use-code/commands/login/login.tsx` (which wraps `ConsoleOAuthFlow` in a `Dialog`).
- `src/components/RayuProviderSetup.tsx` (or a new sibling) — add a "Login with Claude (Pro plan / Max plan)" entry alongside the existing provider list. Selecting it launches `OAuthService.startOAuthFlow({ loginWithClaudeAi: true })` and renders `ConsoleOAuthFlow` for the redirect.
- `src/commands/connect/connect.tsx` — wire the new entry into the existing setup→model flow. On OAuth success, transition to the model picker (pre-populated with the Claude models available to the subscription tier).
- Add a "Subscription status" view (plan + rate-limit tier + logout/forget) reachable from `/connect` when the user is already logged in with Claude.

### 4. Token Storage & Auth Wiring
- Persist the `OAuthTokens` (access, refresh, expiresAt, scopes, subscriptionType, rateLimitTier, profile, account) in the chosen slot via `src/utils/secureStorage/` (or the existing auth store). Never log tokens.
- `src/services/api/claude.ts` — accept the stored Anthropic OAuth token as an auth source. When present and not expired, use `Authorization: Bearer <access_token>`. When expired, auto-refresh via `refresh_token` (call `exchangeCodeForTokens`-equivalent refresh endpoint, persist the new tokens, retry once). When the user has Anthropic OAuth tokens, Claude calls must bypass `rayu-gateway` and go directly to Anthropic.
- `src/services/rayuAuth/rayuSession.ts` (or equivalent) — make the new auth source visible to the session's "active auth" resolver so the CLI knows the user is on a Claude Pro/Max subscription (for UI badges, model filtering, and to avoid double-billing through Rayu credits).

### 5. Post-Login Refresh
- Mirror the post-success sequence from `un-use-code/commands/login/login.tsx`: `resetCostState`, `refreshRemoteManagedSettings`, `refreshPolicyLimits`, `resetUserCache`, `clearTrustedDeviceToken`, `enrollTrustedDevice`, permission killswitch re-checks, and bump `authVersion`. Reuse the existing implementations of each — do not duplicate.
- On logout/forget, clear the Anthropic OAuth tokens and re-run the equivalent of `context.onChangeAPIKey()` + `stripSignatureBlocks` so the CLI falls back to the next auth source.

### 6. Decision: Subscription Tier Gating
- Read `subscriptionType` and `rateLimitTier` from the profile. Surface them in the `/connect` status view (e.g. "Logged in with Claude Pro — rate limit tier X").
- If specific models require Max tier (e.g. Opus variants), filter the model picker accordingly. Document the mapping in the plan; do not hardcode model names without verifying against the live `src/constants/` model catalog.

### 7. Verification Plan
- `bun run typecheck`
- `bun run build` (verify no bundle bloat — the OAuth modules must be lazy-loaded from the `/connect` path, not imported at CLI startup)
- `bun test` — add unit tests for: PKCE crypto helpers, `buildAuthUrl` shape, `parseScopes`, token-storage round-trip, refresh-on-expiry path (mock the refresh endpoint).
- Manual: run `/connect`, pick "Login with Claude", complete the OAuth flow with a real Pro/Max account, confirm tokens are persisted, confirm a Claude completion succeeds, confirm a second call after token expiry triggers a refresh, confirm `/connect` shows subscription status, confirm logout clears tokens.
- Manual: confirm the existing Rayu JWT (`/login`) and the new Anthropic OAuth tokens coexist without clobbering each other.
- Manual: confirm headless/manual-paste fallback works when no browser is available.

### 8. Risks
- **Wrong endpoints/scopes** — must match what Anthropic's OAuth actually expects. Verify against `un-use-code/constants/oauth.ts`; if values look stale, flag and confirm with Anthropic's current public OAuth docs before shipping.
- **Token leakage** — never log access/refresh tokens; use `secureStorage`, not plaintext JSON in a world-readable file.
- **Clobbering Rayu JWT** — the two auth paths must be independent; a bug here silently breaks the hosted billing path.
- **Refresh race** — concurrent Claude calls must not trigger multiple simultaneous refreshes. Add a single-flight refresh lock.
- **Bundle bloat** — `OAuthService` + `AuthCodeListener` must be lazy-loaded only when the user picks the Claude-login path in `/connect`.
- **Plan/tier mismatch** — if Anthropic changes plan names or rate-limit tiers, fail gracefully with a clear message, not a crash.
- **DCE** — do NOT convert any feature-gated `require()` in the touched files to static `import`.

## Acceptance Criteria

- [ ] Running `/connect` shows a "Login with Claude (Pro plan / Max plan)" option alongside the existing provider+API-key flow.
- [ ] Selecting it runs the Anthropic OAuth (PKCE) flow and persists Anthropic OAuth tokens (access, refresh, scopes, subscriptionType, rateLimitTier, profile, account) in a dedicated slot separate from the Rayu JWT.
- [ ] Subsequent Claude calls authenticate with the stored `access_token`, auto-refresh on expiry (single-flight), and bypass `rayu-gateway`.
- [ ] `/connect` shows the active subscription status (plan + rate-limit tier) and offers logout/forget.
- [ ] Post-login and post-logout refresh sequences match `un-use-code/commands/login/login.tsx` (reused, not duplicated).
- [ ] Headless/manual-paste fallback works.
- [ ] The existing `/login` (Rayu JWT) path still works and is not clobbered.
- [ ] `bun run typecheck`, `bun run build`, `bun test` all pass; OAuth modules are lazy-loaded.
- [ ] No hardcoded OAuth endpoints/scopes — all come from `src/constants/oauth.ts`.
- [ ] No duplicated logic — `OAuthService`, `AuthCodeListener`, `crypto`, post-login refresh are reused, not re-implemented.