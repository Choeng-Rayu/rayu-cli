# Rayu observability & request correlation runbook

This is the operator guide for the model-fidelity + observability changes. It
explains the request-id correlation flow, the gateway/edge log lines, and how to
diagnose the two production issues that motivated this work:

1. `API Error: Connection error` with **no matching gateway log**.
2. A user selects **Sonnet** but the gateway routes **Opus** (`model=""`).

---

## 1. Correlation ids (CLI → edge → gateway)

Every gateway-routed request now carries stable ids the whole chain logs, so a
single failing request can be joined across layers with `grep`:

| Header | Meaning |
|---|---|
| `X-Rayu-Request-Id` | one physical HTTP attempt |
| `X-Rayu-Logical-Request-Id` | stable across retries of the same logical request (turn) |
| `X-Rayu-Intended-Model` | the model the user/subagent selected (canonical) |
| `X-Rayu-Resolved-Model` | the model actually on the wire (Bedrock URL path / body) |
| `X-Rayu-Query-Source` | `repl_main_thread`, `agent:*`, `compact`, … (attribution) |

All `X-Rayu-*` headers are **stripped by the gateway before the upstream/provider
hop** (`forwardableHeaders`), so they never reach AWS/DeepSeek/etc.

### Join edge ↔ gateway
- **Edge (Caddy)** emits JSON access logs to stdout (captured by Coolify/Docker),
  with `rayu_request_id` and `rayu_logical_id` fields.
- **Gateway** logs `reqid=<X-Rayu-Request-Id>` on every `proxy:` line.

```bash
# One request across both layers (Coolify: use the service log views):
docker compose logs caddy   | grep "<request-id>"
docker compose logs gateway | grep "<request-id>"
```

If a request appears in the **edge** log with a 5xx/timeout but **not** in the
gateway log, it failed at the edge (TLS, body timeout, upstream dial) and never
reached Go — this is the "connection error with no gateway log" class. If it
appears in **neither**, it failed before Caddy (client DNS/network, or Cloudflare
in front of the origin).

---

## 2. Gateway `proxy:` log lines

```
proxy: user=20 reqid=… source=repl_main_thread provider=bedrock-anthropic \
       intended="claude-sonnet-4-6" actual="us.anthropic.claude-sonnet-4-6-v1" \
       -> https://bedrock-runtime…/invoke-with-response-stream (status=200)
```

- `actual` is parsed from the **Bedrock URL path** (the SDK puts the model there,
  not in the JSON body — that is why old logs showed `model=""`).
- `intended` vs `actual` lets you confirm fidelity at a glance.

### Model-fidelity mismatch
```
proxy: MODEL FIDELITY MISMATCH user=20 reqid=… intended="claude-sonnet-4-6" actual="…opus-4-6…"
```
- **Logged always.** If `source=repl_main_thread`, that is a real "selected Sonnet
  → routed Opus" bug. If `source=agent:*`, it is a subagent legitimately using a
  different model.
- Set `RAYU_ENFORCE_MODEL_FIDELITY=1` (gateway env) to **hard-reject** mismatches
  with `409` + `X-Rayu-Model-Fidelity: mismatch` before the upstream call. Start
  in log-only mode, confirm no false positives, then enable enforcement.

### Body-read failures (the 59.9s / 92-byte 400)
```
proxy: body read timeout   user=20 after=59.9s status=408 …   # slow/stalled upload
proxy: body read too large user=20 …             status=413 …
proxy: body read unreadable user=20 …            status=400 …
```
Set `RAYU_PROXY_BODY_READ_TIMEOUT=<seconds>` to bound a stalled body read (408).
**Do not** add a global write timeout — it would truncate SSE streams.

### Stream interruption (previously hidden as 200)
```
proxy: stream interrupted user=20 reqid=… status=200 wrote=true: <err>
```
Upstream/connection broke mid-stream after headers were sent. The CLI shows a
truncated/"connection dropped" error; this line explains it and the daily turn is
refunded.

---

## 2b. Hosted path logs (`/anthropic/v1/messages`, `/v1/chat/completions`)

This is the path your GLM-5.2 / hosted traffic uses. Every line now carries
`reqid=` + `source=` (the CLI feature that issued the request) + the model.

Accepted request:
```
anthropic: user=2 reqid=… source=repl_main_thread model=glm-5.2 intended="glm-5.2" stream=true reserved=…
hosted done: user=2 reqid=… source=repl_main_thread model=glm-5.2 billable=… via=plan tokens(…)
```

Rejections now name the reason **and** the source — this is what identifies a
wrong background-model call:
```
reject: user=2 reqid=… source=tool_use_summary model="claude-haiku-4-5-20251001" intended="…" not allowed for plan=pro; allowed=[glm-5.2,deepseek-v4-pro,…]
reject: user=2 reqid=… source=… model="…" provider="…" is disabled
reject: user=2 reqid=… source=… model="…" reason=credit_limit(period_limit) reset=…s
reject: user=2 reqid=… source=… model="…" daily turn limit reached (N/M)
hosted reject: user=2 reqid=… source=… reason=body_timeout|invalid_json|account_suspended|…
```
- **`source=`** tells you WHICH CLI feature fired it (`repl_main_thread` = main
  turn; `agent:*` = subagent; `tool_use_summary`/`compact`/`web_fetch`/… =
  background/utility). A `claude-haiku-4-5-20251001` reject with `source=tool_use_summary`
  while the user is on GLM-5.2 is a background task using the wrong model.
- **`allowed=[…]`** is the plan's actual model allow-list, so you can confirm
  what the plan accepts without a DB query.

Auth failures now log a reason (so silent `401` storms are explained):
```
auth: 401 POST /anthropic/v1/messages reqid=… reason=missing_bearer_token
auth: 401 POST /anthropic/v1/messages reqid=… reason=invalid_token: token is expired
```
`token is expired` ⇒ the CLI should have refreshed; a signature/malformed error ⇒ re-login / wrong `RAYU_JWT_SECRET`.

## 2c. Startup logs

On boot the gateway now prints its runtime mode and the full hosted catalog, so
you can confirm what it will accept:
```
config: model_fidelity_enforce=false proxy_body_read_timeout=0s
catalog: 7 hosted models: glm-5.2→glm-5.2:cloud[rayu-ollama], deepseek-v4-pro→deepseek-v4-pro[deepseek], …
```
An empty catalog is called out explicitly (`catalog: 0 hosted models loaded — every hosted request will 403`).

## 3. Daily-turn accounting (retry-safe)

Turn reservation is keyed by `X-Rayu-Logical-Request-Id`, and turns are refunded
on upstream non-2xx / interruption, so CLI retries of one logical request consume
**at most one** daily turn. A genuine daily-cap block returns `429` +
`X-Rayu-Limit: daily_turn_limit`; the CLI surfaces "daily request limit" and does
NOT retry it.

---

## 4. Env flags summary (gateway)

| Env | Default | Effect |
|---|---|---|
| `RAYU_ENFORCE_MODEL_FIDELITY` | off | hard-reject family-mismatched proxy requests (409) |
| `RAYU_PROXY_BODY_READ_TIMEOUT` | `0` | seconds before a stalled body read → 408 |

Both are passed through in `deploy/docker-compose.yml` from the `.env` file.

---

## 5. Staging validation matrix

Run each and confirm the expected log line + client behavior:

| Scenario | Expect |
|---|---|
| Select Sonnet (Bedrock), send a turn | `intended="claude-sonnet-4-6" actual="…sonnet…"`, `status=200`, no MISMATCH |
| Select Opus (Bedrock) | `actual="…opus-4-6…"`, no MISMATCH |
| Select Haiku (Bedrock) | `status=200` (no more 400s); payload has no thinking/effort |
| Force `modelOverrides` Sonnet→Opus in CLI settings | CLI drops the override + logs a warning; wire model stays Sonnet |
| `RAYU_ENFORCE_MODEL_FIDELITY=1` + forced mismatch header | gateway `409` + `MODEL FIDELITY MISMATCH` |
| Induce a slow body (`RAYU_PROXY_BODY_READ_TIMEOUT=5`, stall upload) | `408` + `body read timeout` line |
| Bedrock 429 storm | one `429` per attempt, turns refunded, CLI backs off per Retry-After |
