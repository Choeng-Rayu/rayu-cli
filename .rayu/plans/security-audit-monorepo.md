# Security Audit — Full Rayu Monorepo

## Improved Prompt

Act as a senior **security auditor** (defensive security, authorized review). Perform a deep, file-by-file vulnerability analysis of the entire Rayu monorepo across four projects:

1. `rayu/` — the CLI (TypeScript + Bun + React/Ink)
2. `rayu-backend/` — accounts/billing API (NestJS + Prisma + MySQL)
3. `rayu-gateway/` — streaming AI gateway (Go 1.24 + chi + Redis)
4. `rayu-web/` — marketing site + dashboard (Next.js 15 + NextAuth)

This is an **authorized defensive audit** of the user's own codebase. Output is a structured vulnerability report with severity, file:line, evidence, exploit scenario, and a concrete fix recommendation for each finding. **Do not write or modify code.** Do not produce exploit tooling. The deliverable is a report.

## Scope (explicit)

Audit every file under these four roots. Do NOT audit `node_modules/`, `dist/`, `build/`, `next-env.d.ts`, generated Prisma client, `.next/`, lockfiles, or vendored third-party SDKs. Focus on **first-party** code.

Where a finding depends on third-party behavior, cite the SDK and the first-party misuse, not the SDK itself.

## CRITICAL RULES (per RAYU.md)

### Rule 1: NO ASSUMPTIONS — Read the Code
Do NOT guess vulnerability classes from file names. For every finding:
- ✅ READ the actual file and quote the exact line(s) that introduce the risk (`file:line`).
- ✅ Trace the data flow from an untrusted boundary (HTTP request, stdin, file path, env, third-party API response, Telegram message, MCP tool input, webhook payload, OAuth redirect) to the sink (SQL query, shell exec, file write, HTML render, signed-JWT issuer, redirect response, secret store).
- ✅ Confirm the sink is actually reachable with attacker-controlled input; if a guard exists, show why it is bypassable or insufficient.
- ✅ Check `ORIGIN_MANIFEST.md` (CLI side) for provenance — original Rayu code is higher-risk for novel bugs; derivative Claude Code code may carry known upstream issues.
- ❌ DON'T report a vulnerability from a filename or a "this looks bad" pattern. If you cannot read the code and trace the path, do not report it.
- ❌ DON'T report findings the framework already prevents (e.g. Prisma parameterized queries by default — only report if raw queries / `$queryRaw` / string-interpolated SQL are used).

### Rule 2: Search Before Concluding
- Use Grep/Glob to find every instance of a risky pattern across all four projects before finalizing a finding, so you report the full blast radius, not the first hit.
- Cross-reference: a secret that is read in the gateway must be checked in the backend too (the `RAYU_JWT_SECRET` is shared across both — a mismatch causes silent 401s, and a leak in either compromises both).

### Rule 3: Follow Project Conventions & Architecture
Per the top-level RAYU.md architecture:
- `RAYU_JWT_SECRET` **must be identical** in `rayu-backend` and `rayu-gateway` — verify it is not logged, not sent to clients, not used in a way that leaks timing.
- Provider keys live **only in the gateway's env**, never in the DB or CLI — verify this invariant holds across the codebase.
- The gateway reads MySQL independently and shares only the JWT secret with the backend — verify the gateway's MySQL user has least-privilege scope (no writes to backend-only tables).
- The CLI stores the Rayu JWT in `~/.rayu/rayu-auth.json` — verify file permissions, redaction in logs, and refresh-token handling.
- Feature flags are compile-time DCE — do NOT report `feature('FLAG')` as a runtime security control; it is build-time only.

## Audit Checklist (per project)

### A. rayu/ — CLI
Attack surface to inspect:
- **Permission system** (`src/utils/permissions/` — 20+ files: `bashClassifier.ts`, `bypassPermissionsKillswitch.ts`, `classifierDecision.ts`, shell rule matching, shadowed rule detection): look for rule bypass, dangerous-pattern false-negatives, `--dangerously-skip-permissions`-equivalent paths, and TOCTOU on permission checks.
- **Bash tool** (`src/tools/BashTool/` and the bash classifier): command injection via shell rule matching, glob expansion, sandbox escape, CWD traversal, and any path that lets an attacker run `rm -rf`, force-push, `git reset --hard`, or kill processes without confirmation.
- **File tools** (Read/Write/Edit/Glob/Grep): path traversal (`..` outside workspace), symlink following, writing to dotfiles or auth files, race conditions between check and write.
- **Web tools** (WebFetch/WebSearch): SSRF, redirect-to-internal, prompt-injection from fetched content leaking into tool calls.
- **MCP** (`src/services/mcp/`): tool-name shadowing of built-in tools, malicious MCP server registration, `vscodeSdkMcp.ts`, `xaaIdpLogin.ts`, OAuth port handling (`oauthPort.ts`), elicitation handler input validation.
- **Auth / token storage** (`src/services/rayuAuth/`, `~/.rayu/rayu-auth.json` handling, `secureStorage`): plaintext tokens, world-readable files, token leakage in logs/errors/analytics, refresh-token reuse.
- **Telegram bridge** (`src/telegram/`, `src/commands/telegram-bot/`): unauthenticated pairing, message spoofing, command injection from Telegram text, `linkedBotUsername` re-pair race.
- **Skills** (`src/skills/`): malicious skill install (`InstallSkill`), skill-driven tool calls bypassing permissions.
- **Analytics / telemetry** (`src/services/analytics/`): PII leakage, event content leaking prompts/secrets.
- **Image/Video gen tools** (`src/tools/ImageGenTool/`, `VideoGenTool/`): prompt injection, asset-URL SSRF (`upload-asset-from-url`, `nvidiaImageClient`, `vertexImageClient`), and the `data:` URI handling.
- **Deep links / process user input / computer-use / native installer / powershell / shell** utilities: injection vectors.
- **Ink renderer & input parsing**: ANSI injection from tool output that could spoof UI or hide malicious content.
- **Cron / scheduling / remote / teleport / buddy / coordinator**: command execution triggered by remote input.

### B. rayu-backend/ — API (NestJS + Prisma + MySQL)
- **Auth** (`src/auth/` — `auth.controller.ts`, `auth.service.ts`, `oauth.service.ts`, `code-store.service.ts`, `rayu-auth.guard.ts`, `roles.decorator.ts`, `roles.guard.ts`): JWT validation, OAuth state/PKCE, code-store replay, role escalation, IDOR on `@CurrentUser()`.
- **Admin** (`src/admin/`): the `admin@rayucode.com` + `LOCAL_ADMIN_PASSWORD` local password login — verify it is disabled in prod, rate-limited, not loggable. Verify admin SSO does not allow account takeover.
- **Payments** (`src/payments/` — ABA, Bakong, top-up): webhook signature verification (ABA Telegram listener!), amount-matching replay, KHQR TTL bypass, idempotency, currency confusion, promo-code brute force, refund clawback.
- **Promo** (`src/promo/`): redemption race (`usedCount` increment under concurrency), plan-scoping bypass, date-window bypass, one-per-user enforcement.
- **Settings / AppSettings** (`src/settings/`): admin-only writes enforced; `creditsPerDollar` / `minTopupCents` cannot be set to negative or cause integer overflow.
- **Models / providers / providerkeys**: secrets never returned to clients; capability flags cannot be flipped by non-admins.
- **Telegram** (`src/telegram/`): bot pairing, inbound message authenticity, cursor replay.
- **Usage / feedback**: IDOR, mass data exfiltration via pagination, unauthenticated endpoints.
- **Prisma**: every `$queryRaw` / `$executeRaw` / string-built SQL — SQL injection. Mass-assignment via unchecked DTOs. Missing tenant scoping on `userId`.
- **DTOs / validation**: every controller — missing `class-validator` rules, type coercion, `parseInt` without bounds, file upload size/type.
- **main.ts / config**: CORS, helmet, rate limiting, body size, request logging redaction.
- **Seed**: secrets in `seed.ts`.

### C. rayu-gateway/ — Streaming Gateway (Go + chi + Redis)
- **Auth** (`internal/auth/jwt.go`, `middleware.go`): JWT signature verification, `exp`/`nbf` enforcement, alg confusion (HS vs RS), kid traversal, claims tampering, replay.
- **Secretbox** (`internal/secretbox/`): key handling, nonce reuse, timing leaks, decryption failure modes.
- **Provider keys** (`internal/providerkeys/`): key rotation race, multi-key round-robin leakage to logs, circuit-breaker bypass.
- **Proxy** (`internal/proxy/`): SSRF via upstream URL, request smuggling, header injection, streaming buffer overflow, upstream response tampering, `Host` header trust.
- **Server** (`internal/server/`): the `/v1/models` and `/v1/chat/completions` routes — auth, rate limits, model allowlist, image-block rejection path, error message leakage (model names, user IDs).
- **Credits / entitlements** (`internal/credits/`, `internal/entitlements/`): negative-balance bypass, race between reserve and settle, Redis TTL tied to `currentPeriodEnd` — verify the TTL cannot be extended by client input.
- **Eventqueue / store**: MySQL pool starvation, unbounded queue growth, replay.
- **Translate / tokencount**: prompt content leakage in logs, tokenizer ReDoS.
- **Circuit breaker**: configuration that can be permanently tripped by an attacker.
- **httpx / config / configbus / providercfg**: env var handling, secret logging, dynamic config injection.

### D. rayu-web/ — Next.js 15 + NextAuth
- **NextAuth** (`auth.ts`): Google OAuth state, callback URL allowlist, JWT secret handling, session cookie flags, `authorized` callback injection.
- **Middleware** (`middleware.ts`): auth bypass, path traversal in redirects, open redirect.
- **API routes** (`app/api/`): CSRF, server-action CSRF, IDOR, unauthenticated endpoints, mass-assignment.
- **Server actions / app router**: SSRF in fetch calls, XSS via `dangerouslySetInnerHTML`, unsafe `href` from user input, `next/headers` misuse.
- **Admin pages** (`app/admin/`): role enforcement server-side (not just client), secret exposure in client bundle.
- **Billing / credits / plans / dashboard** pages: IDOR on user IDs in URL/body, price tampering, displaying secrets.
- **CLI login** (`app/cli-login/`): the flow that exchanges a web session for a CLI JWT — replay, CSRF, device-code leakage.
- **Public pages** (`app/docs/`, `app/changelog/`, `structured-data.ts`): XSS in user-generated content (changelog, feedback).
- **Dockerfile / next.config.mjs / middleware**: CSP, HSTS, X-Content-Type-Options, Referrer-Policy, source-map exposure in prod.

### E. Cross-cutting (all four + deploy/)
- **Secrets**: grep every repo for hardcoded API keys, JWT secrets, private keys, `sk_live_`, `STRIPE_SECRET_KEY`, `RAYU_JWT_SECRET`, `NVIDIA_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_SECRET`. Verify `.env.example` has placeholders, not real values.
- **Logging**: verify secrets, tokens, prompts, and PII are redacted in every logger call across all four projects.
- **Dependencies**: flag known-vulnerable versions in `package.json` / `go.mod` (do not run `npm audit` blindly — name specific high-severity CVEs and the version pin).
- **deploy/** (`Caddyfile`, `docker-compose*.yml`): exposed ports, missing TLS, secrets in compose env, container privilege, shared `RAYU_JWT_SECRET` handling.
- **Rate limiting / DoS**: identify endpoints with no rate limit (login, OTP, top-up create, webhook, chat completions).
- **TLS / cert pinning**: CLI → gateway, gateway → providers, web → backend.
- **Integer / money overflow**: `amountCents`, `credits`, `creditsPerDollar` multiplication — Go and TS integer limits.
- **Time / TTL**: KHQR TTL, ABA grace window, Redis TTL, JWT exp — clock skew and negative duration handling.

## Output Format (the deliverable)

Produce a single markdown report with these sections:

1. **Executive Summary** — counts by severity (Critical / High / Medium / Low / Informational), top 5 risks, blast-radius summary.
2. **Per-project findings** — for each of the four projects, a list of findings. Each finding has:
   - **ID** (e.g. `BE-001`, `GW-004`, `CLI-012`, `WEB-007`)
   - **Title**
   - **Severity** (Critical / High / Medium / Low / Informational)
   - **CWE / OWASP category** (where applicable)
   - **File:line** (exact location, with a 1–3 line code excerpt)
   - **Description** — what is wrong
   - **Exploit scenario** — concrete steps an attacker would take, the untrusted input they control, and the sink reached
   - **Impact** — what breaks if exploited (auth bypass, RCE, secret leak, credit theft, data loss)
   - **Fix recommendation** — concrete, minimal, actionable (do not write the fix code — describe it)
   - **Confidence** (Confirmed / Likely / Needs-triage) and **Notes** (assumptions, things that mitigate)
3. **Cross-cutting findings** — secrets, logging, dependencies, deploy, TLS, rate-limiting, money math.
4. **Positive findings** — explicitly note controls that are correctly implemented (so they are not "fixed" later by accident).
5. **Triage matrix** — a table mapping each finding → exploitability → fix effort → recommended priority.
6. **Methodology & Limitations** — what was reviewed, what was out of scope, what could not be confirmed without runtime testing.

## Constraints

- **Read-only audit.** Do not edit, run, or deploy anything. Do not produce exploit code or PoC payloads beyond the minimal example needed to explain a finding.
- **No false positives by guessing.** If a sink is guarded and you cannot show a bypass, report it as Informational/Needs-triage at most.
- **Severity calibration:** Critical = unauthenticated RCE / auth bypass / secret disclosure / fund loss; High = authenticated RCE / IDOR / significant data leak; Medium = limited data leak / DoS / privilege edge; Low = hardening / information leak; Informational = best-practice gap.
- **Confidentiality:** The report itself may contain file paths and short code excerpts (these are the user's own files). Do **not** include any real secret values found — redact as `REDACTED` and report the location.
- **Verify each finding against the live code at the time of the audit.** If you cannot read a file, say so; do not infer.

## Acceptance Criteria

- [ ] Every first-party file under the four project roots has been read or explicitly scoped out with a reason.
- [ ] Each finding has a confirmed `file:line`, a traced untrusted-input → sink path, and a concrete fix recommendation.
- [ ] Severity is calibrated and consistent across projects.
- [ ] No finding is reported from a filename guess; every Critical/High has a code excerpt and an exploit scenario.
- [ ] Real secrets (if any are found in source) are reported with redacted values and exact locations.
- [ ] The report calls out controls that are correctly implemented so they are not regressed.
- [ ] A triage matrix maps every finding to priority, exploitability, and fix effort.