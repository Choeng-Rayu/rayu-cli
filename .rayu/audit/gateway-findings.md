# rayu-gateway — Defensive Security Audit (READ-ONLY)

- **Scope:** `/home/rayu/rayu-cli/rayu-gateway/` only (Go 1.24 + chi + Redis + MySQL).
- **Method:** Manual source review, tracing untrusted input (HTTP body/headers/query on `/v1/*`, JWT claims, upstream provider responses, MySQL rows, Redis values, env) to sinks. Every finding cites `file:line` and a verbatim excerpt actually read. No source file was modified.
- **Date:** 2026-08-01
- **Severity key:** Critical = unauth RCE / auth bypass / secret disclosure / fund loss; High = authenticated RCE / IDOR / major leak; Medium = limited leak / DoS; Low = hardening; Informational = best practice.
- **Result:** No Critical/High confirmed. The gateway is defensively well-built (atomic credit Lua, sanitized error relay, parameterized SQL, HMAC-asserted JWT, masked keys, admin gating). Confirmed issues are 3 Medium, 2 Low, plus informational notes.

---

## GW-001 — Authenticated SSRF on `/v1/proxy`: DNS-rebinding TOCTOU + no upstream allow-list

- **Severity:** Medium
- **CWE:** CWE-918 (SSRF), CWE-441 (Confused Deputy / open proxy), CWE-367 (TOCTOU)
- **File:line:** `internal/server/server.go:167`, `:1024`, `:1294`, `:1312`, `:1320`, `:1332`

`/v1/proxy` is registered OUTSIDE the Bearer-auth group and is reachable by ANY valid Rayu access token (not admin-gated):

```go
// server.go:167
r.HandleFunc("/v1/proxy", s.handleProxy)
```

The upstream target is fully client-controlled (`X-Rayu-Upstream-URL`) and is guarded only by `validateUpstreamURL`:

```go
// server.go:1294
var validateUpstreamURL = func(raw string) error {
	...
	if u.Scheme != "https" {
		return errors.New("upstream must be https")
	}
	host := u.Hostname()
	...
	if isPrivateHost(host) {
		return errors.New("upstream host not allowed")
	}
	return nil
}
```

`isPrivateHost` resolves DNS at validation time:

```go
// server.go:1312
func isPrivateHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return isPrivateIP(ip)
	}
	// Hostname: resolve and reject if any A/AAAA record is private.
	ips, err := net.LookupIP(host)   // server.go:1320
	...
}
```

The request is then dialed by a SEPARATE resolution inside `proxy.Forward` (the transport resolves the host again):

```go
// server.go:1024
status, wrote, ferr := proxy.Forward(r.Context(), w, r.Method, upstream, forwardableHeaders(r.Header), body)
```

- **Description / bypass:** The validation `net.LookupIP` (server.go:1320) and the actual dial in `proxy.Forward` (which calls `http.NewRequestWithContext` + `Client.Do`, proxy.go:391-400) perform **two independent DNS lookups**. An attacker who controls DNS for `evil.example` with a low TTL can return a public IP for the validation lookup and a private/loopback IP (e.g. `169.254.169.254`, `10.0.0.x`, `127.0.0.1`) for the connection lookup — a classic rebinding TOCTOU that defeats the private-host check. Separately, there is **no allow-list**: any authenticated user may relay arbitrary requests to ANY public HTTPS host, i.e. the endpoint is an authenticated open forward-proxy originating from Rayu's egress IPs. `r.Method` and body are forwarded verbatim (server.go:1024), so arbitrary-method requests can be issued.
- **Exploit scenario:** Paid user sets `X-Rayu-Token: <their JWT>`, `X-Rayu-Upstream-URL: https://rebind.attacker.tld/latest/meta-data/…` where `rebind.attacker.tld` first resolves public (passes validation) then rebinds to an internal address; the gateway dials the internal host. Also usable to originate scans/requests to arbitrary third parties from Rayu's IP space.
- **Impact:** Blind SSRF from the gateway's network position (internal port/endpoint probing, state-changing internal POSTs), and abuse of Rayu as an authenticated relay. Response exfiltration is **limited** because the URL is forced to `https` and Go verifies TLS by default (an internal host presenting a cert that does not match the attacker hostname fails the handshake), so plaintext metadata endpoints and cert-mismatched internal HTTPS services return no readable body — this is why the rating is Medium, not High.
- **Fix recommendation (describe only):** Resolve the host once, pin the connection to a validated IP (custom `DialContext` that re-checks the resolved IP against the private-range denylist at dial time, eliminating the second lookup), reject on any private result including CGNAT/multicast; consider an explicit allow-list of legitimate provider hosts for the BYO path; reject URLs containing userinfo.
- **Confidence:** High (the two-lookup TOCTOU and absence of an allow-list are certain from the code). Medium on real-world exfiltration due to the TLS mitigation above.
- **Notes:** `isPrivateIP` here (server.go:1332) is weaker than `providercfg.IsPrivateIP` — it omits `IsMulticast()` and the 100.64.0.0/10 CGNAT range that the hosted-path validator covers; align them. The hosted path is NOT affected: its upstream URL is built only from the admin-controlled provider row + `UpstreamModelID` (see Positive Controls).

---

## GW-002 — Unbounded buffering of upstream provider responses (non-streaming) → memory-exhaustion DoS

- **Severity:** Medium
- **CWE:** CWE-400 (Uncontrolled Resource Consumption), CWE-770 (Allocation Without Limits)
- **File:line:** `internal/proxy/anthropic.go:272`, `internal/translate/openai_chat.go:525`, `internal/translate/openai_responses.go:487`, `internal/translate/genai.go:621`

The non-streaming `Complete` path for every translating/passthrough adapter reads the entire upstream body into memory with no size limit:

```go
// proxy/anthropic.go:272  (CompleteAnthropic)
respBody, _ = io.ReadAll(resp.Body)
```
```go
// translate/openai_chat.go:525  (openAIChat.Complete)
respBody, _ := io.ReadAll(resp.Body)
```
```go
// translate/openai_responses.go:487  and  translate/genai.go:621 — identical pattern
respBody, _ := io.ReadAll(resp.Body)
```

This is provably an oversight, because the Bedrock adapter — and the SSE reader — DO bound the read:

```go
// translate/bedrock.go:49
const maxUpstreamBody = 8 << 20 // 8 MiB
// translate/bedrock.go:207
respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
```
```go
// translate/sse.go:47 — streaming path is bounded per line
const maxSSELineBytes = 1 << 20
```

- **Description:** "Upstream provider responses" is an untrusted boundary (per scope). A hosted upstream that is compromised, buggy, or MITM'd (no response-size ceiling) can return a multi-GB body on a `/anthropic/v1/messages` non-streaming request; `io.ReadAll` buffers all of it. The `bedrock.go` author capped this exact risk ("so a misbehaving upstream…", bedrock.go:47) but the cap was not applied to the other four adapters.
- **Exploit scenario:** A single oversized/streamed-without-EOF response on a Complete call inflates gateway RSS; concurrent Complete calls (per-user concurrency default is 3; global `RAYU_MAX_INFLIGHT` defaults to unlimited) multiply it, OOM-killing the process and taking down all users.
- **Impact:** Process-wide availability loss (DoS) triggered by upstream behaviour rather than by client rate.
- **Fix recommendation (describe only):** Wrap each `Complete` read in `io.LimitReader(resp.Body, maxUpstreamBody)` (reuse the existing 8 MiB constant) and treat truncation as a provider error; likewise bound the verbatim `bufio.Reader.ReadBytes('\n')` line growth in `StreamAnthropic` (proxy/anthropic.go) the way `sse.go` already does with `maxSSELineBytes`.
- **Confidence:** High (code fact). Medium on likelihood, since the hosted upstream is admin-configured; the risk is a hostile/compromised/faulty provider or MITM.
- **Notes:** The BYO `/v1/proxy` path is NOT affected — `proxy.Forward` streams in 32 KiB chunks (proxy.go:415) rather than buffering.

---

## GW-003 — Live secrets stored in on-disk `.env` with group/other-readable permissions (incl. AES master key)

- **Severity:** Medium
- **CWE:** CWE-312 (Cleartext Storage of Sensitive Information), CWE-732 (Incorrect Permission Assignment for Critical Resource)
- **File:line:** `/home/rayu/rayu-cli/rayu-gateway/.env` — mode `-rw-rw-r--` (0664). Values REDACTED.

`.env` (present in the working tree) contains real-looking, live credentials:

- `.env:2` `RAYU_JWT_SECRET=…` (value REDACTED) — the HS256 key that mints every access token; whoever holds it can forge an admin token (see GW-004).
- `.env:3` `DATABASE_URL=mysql://rayu:…@127.0.0.1:3306/rayu` (password REDACTED).
- `.env:5` `DEEPSEEK_API_KEY=…`, `.env:7` `LONGCAT_API_KEY=…`, `.env:9` `OLLAMA_API_KEY=…` (multiple keys) — REDACTED.
- `.env:20` `RAYU_PROVIDER_SECRET=…` (value REDACTED) — the **AES-256-GCM master key** that decrypts every provider API key stored in MySQL (`internal/secretbox`).

- **Description:** The file mode is `0664`, so any other local user/process (group + others) can read all of the above. The `RAYU_PROVIDER_SECRET` is the single key that opens ALL encrypted `provider_api_keys` rows; its disclosure defeats the entire at-rest encryption design. The provider keys (DeepSeek/LongCat/Ollama) are third-party credentials with direct financial value.
- **Exploit scenario:** A co-tenant/low-priv account on the host reads `.env`, obtains `RAYU_PROVIDER_SECRET` + the DB URL, dumps `provider_api_keys`, and decrypts every stored provider key; or forges an admin JWT with `RAYU_JWT_SECRET`.
- **Impact:** Disclosure of the master decryption key and live provider/JWT/DB secrets to any local reader.
- **Fix recommendation (describe only):** Restrict to `0600` owned by the service user; prefer a secrets manager / injected container env over a file; **rotate** `RAYU_PROVIDER_SECRET`, `RAYU_JWT_SECRET`, `DATABASE_URL` password, and all provider keys, since they have been exposed in a group-readable file. Note the dead env keys (`DEEPSEEK_API_KEY`, `OLLAMA_*`, `RAYU_DISABLED_PROVIDERS`) are no longer read by the gateway (config now lives in MySQL, per `internal/config/config.go`), so they are exposure with no operational benefit and should be removed.
- **Confidence:** High.
- **Notes (mitigating positives):** `.env` **is** excluded from git (`.gitignore`) and from the Docker image (`.dockerignore` lists `.env`/`.env.*`, so the Dockerfile `COPY . .` does not bake it into an image layer). The `RAYU_JWT_SECRET` value string begins `local-dev-only-…`, suggesting a dev machine — but the provider keys and `RAYU_PROVIDER_SECRET` do not look like placeholders. Treat as live and rotate.

---

## GW-004 — JWT: expiry not required and role trusted from claims without DB re-check / revocation

- **Severity:** Low
- **CWE:** CWE-613 (Insufficient Session Expiration), CWE-863 (Incorrect Authorization)
- **File:line:** `internal/auth/jwt.go:30-46`, `internal/server/server.go:281` (and identical admin checks at `reload.go:71`, `providertest.go`)

```go
// auth/jwt.go:30
parsed, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
	if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
		return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
	}
	return []byte(secret), nil
}, jwt.WithValidMethods([]string{"HS256"}))
...
role, _ := mc["role"].(string)
return &Claims{UserID: int64(sub), Role: role}, nil
```

Admin gating consumes that claim verbatim, e.g.:

```go
// server.go:281 (handleProviderHealth); same shape in reload.go:71, providertest.go
if claims.Role != "admin" && claims.Role != "superadmin" {
	httpx.WriteError(w, http.StatusForbidden, "admin only")
	return
}
```

- **Description:** Two hardening gaps: (1) `jwt.Parse` here validates `exp` **only if it is present** — there is no `jwt.WithExpirationRequired()`, so a token minted without an `exp` claim is accepted as non-expiring. (2) `role` (and `plan`) come straight from the signed token and are never re-validated against the database, and there is no token revocation/`jti` check. Account **status** IS re-checked from MySQL on hosted paths (`ent.Active()`), but the **admin role** is not. This is not exploitable without the signing secret (the HMAC assertion + `WithValidMethods(["HS256"])` correctly block `alg=none` and RS256→HMAC confusion — see Positive Controls), but it removes defense-in-depth: a demoted admin keeps admin on the gateway until the token expires, and if `RAYU_JWT_SECRET` leaks (cf. GW-003) a forged admin token may never expire.
- **Exploit scenario:** Backend (out of scope) issues, or an attacker with the leaked secret forges, an access token with `role:"admin"` and no `exp`; the gateway honours it indefinitely for `/v1/_reload`, `/v1/_provider-test`, `/v1/_provider-health`.
- **Impact:** Stale/over-long privilege; no revocation path; no expiry floor.
- **Fix recommendation (describe only):** Add `jwt.WithExpirationRequired()`; enforce a max token age; for admin-only endpoints re-check the role/status against the DB (or a short-TTL cache) rather than trusting the claim; support revocation (`jti` denylist or token version).
- **Confidence:** High on the code facts; the privilege-escalation path depends on a backend/secret condition outside gateway scope.

---

## GW-005 — Client-controlled Redis key segment via `X-Rayu-Logical-Request-Id`

- **Severity:** Low
- **CWE:** CWE-99 (Improper Control of Resource Identifiers)
- **File:line:** `internal/server/server.go:916`, `internal/credits/limiter.go:319`

```go
// server.go:916
logicalID := headerOr(r, "X-Rayu-Logical-Request-Id", reqID)
```
```go
// credits/limiter.go:319
func turnHoldKey(uid int64, logicalID string) string {
	return "turnhold:" + strconv.FormatInt(uid, 10) + ":" + logicalID
}
```

- **Description:** The client-supplied `X-Rayu-Logical-Request-Id` is concatenated into a Redis key with no length/charset validation (used by `ReserveTurnFor`, limiter.go). It is prefixed with the caller's own numeric `uid`, so it **cannot collide with another user's namespace** and cannot become a different key family (prefix is fixed `turnhold:`). The only effect is that a caller can create many distinct hold keys within their own namespace (each with a TTL up to end-of-UTC-day).
- **Exploit scenario:** On an unlimited-turn plan, a user issues many `/v1/proxy` calls each with a unique logical id, accumulating one short-lived Redis key per successful reservation. Bounded by request volume (each request is a full upstream forward), so amplification is weak.
- **Impact:** Minor Redis memory growth confined to the user's own namespace; no cross-user impact, no key confusion.
- **Fix recommendation (describe only):** Cap `logicalID` length and restrict to a safe charset (or hash it) before using it in a key.
- **Confidence:** High (key construction is direct); impact is low by design (uid-scoped).

---

## INFORMATIONAL

- **Circuit breaker shared across trust boundaries (answer to the explicit question).** `proxy.Breakers` (proxy.go:69) is package-level and keyed only by upstream host; it is used by both the untrusted `/v1/proxy` path (via `Forward`→`doWithRetry`) and the hosted path. In principle a user could trip the breaker for a host that is also a real provider host. In practice this is **not demonstrably exploitable**: only transport errors and *exhausted-retry* 502/503/504 count as failures (proxy.go:236-260, `isRetryableStatus` excludes 401/403/429), and a `/v1/proxy` caller using their own valid key against a real path receives normal 2xx/4xx, not 5 consecutive retryable 5xx. Per the audit rule (guard present, bypass not demonstrated) this is downgraded to Informational. Consider namespacing breaker keys by path/trust class.
- **No default global concurrency cap.** `RAYU_MAX_INFLIGHT` defaults to `0` = unlimited (config.go:110, server.go `newInflightLimiter`), so the streaming load-shed valve is off unless configured. Per-user caps (`MaxConcurrentStreams`, default 3; `MaxRequestsPer5h`; daily turns) still apply, so a single user is bounded, but there is no process-wide ceiling by default. Documented as an operator tuning knob.
- **`/v1/proxy` upstream URL logged verbatim.** `validateUpstreamURL` (server.go:1294) does not reject URLs embedding userinfo/query, and `handleProxy` logs `upstream=%s` (server.go:1088). A BYO user who puts a key in the URL (`?api_key=…` / `user:pass@`) logs their own credential. Low impact (self-owned key), but the hosted-path validator (`providercfg.ValidateBaseURL`) rejects userinfo/query — align them.
- **GenAI URL model substitution is not path-escaped.** `genAIEndpoint` (genai.go:95) does `strings.ReplaceAll(path, "{model}", model)` without `url.PathEscape`, unlike Bedrock's `providercfg.Route.EndpointFor` (which does escape). `model` is `UpstreamModelID` (admin-controlled), so this is defense-in-depth only.

---

## SPECIFIC QUESTIONS — DIRECT ANSWERS (with evidence)

- **JWT signing method asserted (HMAC only) / `none` blocked?** Yes. `auth/jwt.go:31` asserts `*jwt.SigningMethodHMAC`; `jwt.go:35` adds `jwt.WithValidMethods([]string{"HS256"})`. `alg=none` and RS256→HMAC confusion are both rejected.
- **Is `exp` enforced?** Validated if present (jwt/v5 default via `parsed.Valid`), but **not required** — no `WithExpirationRequired()` (GW-004).
- **Are claims (userId, role, plan) trusted without DB re-check? Self-escalation?** `role` is trusted from the claim with no DB re-check (GW-004); status is re-checked (`ent.Active()`). Self-escalation is **not** possible without the HMAC secret (signature verification is correct). `plan` is NOT taken from the JWT — it is resolved from MySQL (`store.ActivePlan`, entitlements.go).
- **Any route before/outside auth?** Only `/healthz` (public, static `{"status":"ok"}`, server.go:130) and `/v1/proxy` (server.go:167), which self-authenticates via `X-Rayu-Token` → `auth.VerifyAccessToken` (server.go:894). All other `/v1/*`, `/anthropic/v1/*` routes are inside the `auth.Middleware` group (server.go:135-159). `/v1/_reload`, `/v1/_provider-health`, `/v1/_provider-test` are additionally admin-gated by role (reload.go:71, server.go:281, providertest.go); `/v1/_whoami`, `/v1/_entitlements`, `/v1/models`, `/v1/credits`, `count_tokens` are authenticated-user, non-admin, and return only the caller's own data (no IDOR — they key off `claims.UserID`, never a client-supplied id).
- **SSRF — provider base URL from MySQL / `ALLOW_INSECURE_PROVIDER_BASE_URL` / non-admin influence?** Hosted upstream URL is admin-controlled only (`entitlements.Route` → `providercfg.Build`/`ValidateBaseURL`, https+public unless insecure flag) and is re-validated in the gateway (defense in depth). A non-admin CANNOT influence it — the client picks a model *code*, mapped to admin `UpstreamModelID`, and the URL is `route + UpstreamModelID` (bedrock uses `url.PathEscape`). `ALLOW_INSECURE_PROVIDER_BASE_URL` only relaxes admin input. The non-admin-influenced SSRF is the separate BYO `/v1/proxy` path — see GW-001.
- **Header injection / hop-by-hop / Authorization override in proxy?** Hosted path builds a clean upstream request and sets auth server-side (`x-api-key`/`Bearer`, proxy/anthropic.go:24, translate/sse.go:23) — client headers are NOT forwarded, so a client cannot override the provider key. BYO `/v1/proxy` uses `forwardableHeaders` (server.go:1276) which strips `X-Rayu-*`, `Host`, `Content-Length`, and hop-by-hop headers, and intentionally forwards the caller's OWN `Authorization` (their upstream key). Newline/CRLF injection is prevented by Go's `net/http` header validation. No gateway key is exposed on this path.
- **Credits reserve→settle atomic? Overdraw / negative?** Atomic. `reserveScript` (limiter.go:69) is a single Redis Lua script: it checks `usedp+est<=capp` (plan) or `tb>=est` (top-up) BEFORE `INCRBY`/`DECRBY`, all server-side/atomic — no GET-then-SET race. Concurrency is capped (`MaxConcurrent`). `settle` (limiter.go:121) reconciles est→actual afterward; any overage is bounded by in-flight concurrency (can't yield unbounded free usage), and the durable top-up (`store.TopupBalance`) floors at 0. No unbounded overdraw. (Positive control.)
- **Entitlements TTL / key injection via userId/plan?** TTL derives from `PeriodEnd`, which is DB-sourced (`store.ActivePlan`), NOT client input (server.go `periodTTLSeconds`). Redis keys use the numeric `uid` from the JWT `sub` (`keysFor`, limiter.go:64) — not a client string. No injection via userId/plan. The only client-controlled key segment is `logicalID` (GW-005), which is uid-scoped.
- **Secretbox nonce/key/error handling?** Decrypt-only on the gateway (no nonce generation — the 12-byte IV comes from the stored envelope, so no reuse risk here), key = SHA-256 of the master secret with a 32-char minimum (`secretbox.go:38,60`), GCM authenticated so tampering fails closed, and `Open` returns deliberately vague errors that never echo ciphertext/plaintext/key (secretbox.go:78-83). (Positive control.)
- **Are provider keys ever logged?** No. Grep of all `log.*` with secret-ish operands found only token COUNTS (server.go:681), env var NAMES (main.go:206), reject reasons, and jwt error strings (middleware.go:44) — never a key/header-map/body. Keys are always masked (`secretbox.Mask`, `providercfg.MaskKey`); the provider test also runs `redactSecret` over messages/suggestions (providertest.go). (Positive control.)
- **Do 4xx/5xx leak upstream errors/provider names/key fragments/user IDs/prompts?** No. Hosted failures return the sanitized `WriteProviderUnavailable` envelope (httpx.go:44) except client-fixable 400/413/422, which relay only a 300-char capped `message` field (`UpstreamErrorMessage`, proxy.go). User IDs and prompts are logged server-side only, not returned. (Positive control.)
- **Rate limiting on `/v1/chat/completions` and `/v1/messages`? Unbounded body?** `/v1/chat/completions` is retired (410, server.go:148). `/anthropic/v1/messages` is throttled by per-user credit reserve + daily-turn cap + `MaxConcurrentStreams` (+ optional global inflight valve). Bodies are bounded: `http.MaxBytesReader(w, r.Body, 8 MiB)` on hosted/proxy/count_tokens (server.go:461, :968; counttokens.go:56) and 1 KiB on `/v1/_reload` (reload.go:79). No unbounded *request* read. (Unbounded *upstream response* read is GW-002.)
- **Circuit breaker DoS?** See INFORMATIONAL — shared per-host breaker; not demonstrably exploitable to DoS other users.
- **SQL parameterized? `fmt.Sprintf` near SQL?** All queries in `internal/store/store.go` use `?` placeholders (`UserStatus`, `ActivePlan`, `PlanByCode`, `TopupBalance`, `InsertUsageEvent`, `InsertLedger`, `UpdateProviderKeyState`, etc.). The only `fmt.Sprintf` touching a connection string is DSN assembly from the `DATABASE_URL` env in `config.go:MySQLDSN` (not a query, not untrusted input). No SQL injection. (Positive control.)
- **go.mod known-vulnerable pins?** No CVE asserted with confidence. Versions are current: `golang-jwt/jwt/v5 v5.3.1` (> 5.2.2, so patched against CVE-2025-30204), `go-chi/chi/v5 v5.3.0`, `go-sql-driver/mysql v1.10.0`, `redis/go-redis/v9 v9.20.1`. Nothing flagged.

---

## POSITIVE CONTROLS (verified, with evidence)

- **JWT alg pinning:** `auth/jwt.go:31,35` — HMAC assertion + `WithValidMethods(["HS256"])`; non-access tokens rejected (`jwt.go:43`).
- **Parameterized SQL everywhere:** `internal/store/store.go` (`?` placeholders on every `QueryContext`/`ExecContext`/`QueryRowContext`).
- **Atomic credit accounting:** `credits/limiter.go:69,121,261` — Redis Lua reserve/settle/turn scripts; cap checked before charge.
- **Secretbox is decrypt-only, key ≥32, authenticated, non-leaking errors:** `secretbox/secretbox.go:38,60,78`.
- **Provider keys never logged; masked in health/logs; redacted in test output:** `secretbox.go:Mask`, `providercfg.go:MaskKey`, `providertest.go:redactSecret`.
- **Sanitized upstream error relay (no provider body/name leak):** `httpx/httpx.go:44` (`WriteProviderUnavailable`), `proxy.go:relayUpstreamError`.
- **Hosted upstream request built server-side (no client header/key override):** `proxy/anthropic.go:24`, `translate/sse.go:23`, `forwardableHeaders` strips `X-Rayu-*`/hop-by-hop (`server.go:1276`).
- **Hosted-path SSRF validation (admin input), defense-in-depth re-check in gateway:** `providercfg/providercfg.go:ValidateBaseURL/IsPrivateHost/IsPrivateIP`; bedrock model id `url.PathEscape` (`providercfg.go:EndpointFor`).
- **Request body size caps:** `server.go:461,968`, `counttokens.go:56` (8 MiB via `MaxBytesReader`); `reload.go:79` (1 KiB); `providertest.go` (4 KiB).
- **Bounded upstream reads where applied:** `bedrock.go:49,207,237` (`maxUpstreamBody`), `sse.go:47` (`maxSSELineBytes`).
- **Admin gating on config/health/test endpoints:** `reload.go:71`, `server.go:281`, `providertest.go` (role check + per-admin sliding-window rate limit).
- **CORS is safe for the Bearer model:** `server.go:corsMiddleware` reflects Origin but sets NO `Access-Control-Allow-Credentials`; auth is a Bearer token, not a cookie, so a hostile origin cannot ride ambient credentials.
- **Container hardening:** `Dockerfile` — non-root `USER rayu` (uid 10001), multi-stage, `CGO_ENABLED=0`, `.env`/`.env.*` in `.dockerignore`.
- **Secrets excluded from VCS/image:** `.gitignore` and `.dockerignore` both list `.env`.
- **Resilience valves:** per-host circuit breaker (`circuitbreaker.go`), transient retry (`proxy.go:doWithRetry`), multi-key failover with capped cooldown (`providerkeys.go:MaxCooldown`), bounded async write queue (`eventqueue`), resolve deadline (`entitlements.go:resolveDeadline`).

---

## FILES READ (fully unless noted)

- `cmd/gateway/main.go`
- `internal/config/config.go`
- `internal/auth/jwt.go`, `internal/auth/middleware.go`
- `internal/secretbox/secretbox.go`
- `internal/providercfg/providercfg.go`
- `internal/providerkeys/providerkeys.go`
- `internal/proxy/proxy.go`, `internal/proxy/anthropic.go`
- `internal/server/server.go` (full, in chunks), `capabilities.go`, `counttokens.go`, `reload.go`, `configreload.go`, `providertest.go`, `providerdiagnose.go`
- `internal/credits/credits.go`, `internal/credits/limiter.go`
- `internal/entitlements/entitlements.go`
- `internal/store/store.go`
- `internal/circuitbreaker/circuitbreaker.go`
- `internal/httpx/httpx.go`
- `internal/configbus/configbus.go`
- `internal/translate/translate.go`, `sse.go` (full); `bedrock.go` (Complete/Stream + const, partial), `openai_chat.go` (Complete region), `openai_responses.go` (Complete region), `genai.go` (Complete + endpoint builder, partial)
- `go.mod`, `Dockerfile`, `.env.example`, `.env`, `.gitignore`, `.dockerignore`
- Targeted greps across the whole module: route registrations, `io.ReadAll`, secret-logging patterns, SQL string-building, `maxUpstreamBody`, JWT/limiter anchors.

## NOT READ (and why)

- All `*_test.go` — out of scope except consulted to confirm intended behaviour (e.g. `server_test.go:128` asserts `X-Rayu-Token` is NOT forwarded; `reload_auth_test.go`).
- `internal/store/store_integration_test.go`, `internal/config/config_test.go`, etc. — tests.
- `internal/translate/thinking.go`, `eventstream.go`, `anthropic.go`, and the request-BUILDING halves of `openai_chat.go` / `openai_responses.go` / `genai.go` / `bedrock.go` — read only at the security-relevant boundaries (upstream URL construction confirmed admin-controlled; auth headers set server-side; response reads audited for GW-002). These are format-translation transforms of the user's own prompt into the provider body with no gateway-internal sink; a full line-by-line read was deprioritized after the boundaries were verified and is the main residual gap.
- `internal/eventqueue/eventqueue.go`, `internal/tokencount/tokencount.go` — reviewed by interface/usage from callers (bounded queue drop behaviour; estimate-only token count with 8 MiB body cap) rather than in full; no untrusted-input sink identified.
- `RUNNING.md`, `go.sum` — non-code / lock file.
