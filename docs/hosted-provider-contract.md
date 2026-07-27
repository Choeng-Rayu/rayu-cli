# Rayu-hosted provider contract (gateway ↔ CLI)

How the Rayu gateway serves **rayu-hosted** models, and what the CLI can rely on.
Written for the rayu-cli provider migration: **nothing in this document requires
CLI changes to keep working today** — the "CLI guidance" sections describe
behaviour the CLI *may* adopt to improve the user experience.

Audience: whoever is migrating `rayu/src/services/api/rayuHosted/*`.

---

## 1. One ingress, one wire format

The CLI talks to the gateway in **Anthropic Messages** format, and only that:

```
POST {RAYU_GATEWAY}/anthropic/v1/messages
Authorization: Bearer <rayu access token>       # the user's Rayu JWT, not a provider key
```

This is unchanged from today (`rayuHostedAnthropicBaseURL()` → the Anthropic SDK
appends `/v1/messages`). Anthropic Messages is the gateway's **canonical internal
format**: whatever the real upstream speaks, the CLI sends and receives Anthropic
Messages, including the SSE event stream.

### Token counting

```
POST {RAYU_GATEWAY}/anthropic/v1/messages/count_tokens   →  {"input_tokens": N}
```

The Anthropic SDK calls this (`messages.countTokens()`) to draw `/context` and to
decide when to compact. The gateway answers it **locally**:

- **free** — no credit reserve, no ledger row, no daily-turn burn, no concurrency
  slot. Counting is metadata about the user's own conversation; billing it would
  charge a user for the CLI's bookkeeping.
- **no upstream call** — most hosted providers have no equivalent endpoint (the
  OpenAI/GenAI formats have none at all), so proxying would fail for them and
  would add a round trip per context section.
- **an estimate**, advertised as `x-rayu-token-count: estimate`. It is stable and
  errs slightly high (see `internal/tokencount`); a client that thinks it has
  slightly less room compacts a little early, which is harmless.

Before this endpoint existed the gateway returned `404`, and the SDK's fallback
was to measure by sending a real `max_tokens=1` completion — roughly twenty
**billed** requests per `/context`, which also saturated the plan's concurrency
cap and made the command fail. Current CLI builds additionally refuse that
fallback on the hosted path, so an older gateway degrades to a local estimate
instead of spending credits.

### Retired endpoint

`POST {RAYU_GATEWAY}/v1/chat/completions` is **retired** and answers
`410 Gone` with an actionable message. Older published CLI builds may still call
it; they get a clear error rather than a confusing 404. `GET {RAYU_GATEWAY}/v1/models`
is **not** retired and still lists the caller's models.

### Upstream formats (gateway-side, transparent to the CLI)

An admin registers each provider with the wire format it speaks. The gateway
translates Anthropic Messages to/from that format:

| Provider format      | Upstream shape                                        |
| -------------------- | ----------------------------------------------------- |
| `anthropic_messages` | Anthropic Messages (relayed byte-for-byte, no translation) |
| `openai_chat`        | OpenAI-compatible `POST /v1/chat/completions`         |
| `openai_responses`   | OpenAI `POST /v1/responses`                           |
| `genai`              | Google Gemini `…/v1beta/models/{model}:streamGenerateContent` |

The CLI never sees which one was used, and must not depend on it. Provider
*names* remain visible (`provider` in the entitlements payload) for display and
diagnostics only.

---

## 2. Model catalog and capabilities

Two endpoints expose the catalog. Both now carry **per-model capability flags**.

`GET {RAYU_GATEWAY}/v1/models` (gateway):

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-pro",
      "object": "model",
      "label": "DeepSeek V4 Pro",
      "owned_by": "rayu",
      "supportsReasoning": true,
      "supportsImage": false,
      "contextWindow": 1000000
    }
  ]
}
```

`GET {RAYU_BACKEND}/api/me/entitlements` (backend) — `allowedModels[]` (usable on
the current plan) and `hostedModels[]` (full visible catalog):

```json
{
  "code": "deepseek-v4-pro",
  "label": "DeepSeek V4 Pro",
  "provider": "deepseek",
  "creditMultiplier": 1,
  "cacheReadCreditMultiplier": null,
  "cacheWriteCreditMultiplier": null,
  "supportsReasoning": true,
  "supportsImage": false,
  "contextWindow": 1000000
}
```

Both flags are **admin-managed per model** and authoritative:

- `supportsImage` — the model accepts image content blocks.
- `supportsReasoning` — the model supports extended thinking (`thinking`).
- `contextWindow` — the model's context window in **tokens**, or `null` when the
  admin has not set one.

Existing models were migrated **permissively** (both capability flags `true`) so
nothing that worked before started failing at the migration; admins tighten them
per model in the dashboard. Treat a `true` flag as "not known to be unsupported".

### The hosted catalog is server-driven (no client-side model list)

For the **rayu-hosted** provider the CLI hardcodes nothing about the catalog:

- the **model list** is whatever the payload contains — a model added in the
  dashboard appears in `/model` on the next entitlements refresh (~30s cooldown,
  plus login), and a removed one disappears;
- a stored `defaultModel` / `smallFastModel` that is no longer in the catalog is
  **dropped**, so a deleted model can't keep receiving every request;
- the **context window** comes from `contextWindow` only. The CLI's built-in
  known-model table is deliberately **not** consulted for hosted models: matching
  an admin's model code against hardcoded patterns is how a brand-new model would
  silently inherit some other model's window.

When `contextWindow` is `null`, the CLI records a low-severity diagnostic and
falls back to its documented default window (`RAYU_CONTEXT_TOKENS` still
overrides everything). So: **set the context window when adding a model** —
otherwise auto-compaction budgets against the generic default rather than the
model's real capacity.

BYO-key providers are unaffected and keep using the CLI's own model table.

---

## 3. Capability errors

If a request needs a capability the selected model does not have, the gateway
rejects it **before contacting the upstream and before charging any credit or
daily turn**. The response is a normal Anthropic error envelope plus a stable
machine-readable code:

```
HTTP/1.1 400 Bad Request
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Model \"deepseek-v4-pro\" cannot read images. Switch to a model with image support, or remove the image from your message.",
    "rayu_code": "model_no_image_support"
  }
}
```

| `error.rayu_code`          | Status | Meaning                                              |
| -------------------------- | ------ | ---------------------------------------------------- |
| `model_no_image_support`   | 400    | Request contained image content; model can't read images. |
| `model_no_thinking_support` | 400    | Request asked for extended thinking; model has none. |

Rules the CLI can rely on:

- **Match on `error.rayu_code`, never on the message text.** Wording will change;
  the codes will not.
- **400 means permanent.** Retrying the identical request can never succeed.
  Changing model (or removing the attachment / thinking) will.
- **Nothing was billed.** No credits, no daily turn.

### CLI guidance (optional, no changes required today)

Recommended UX, in order of preference:

1. **Pre-flight warning.** The catalog already carries the flags, so when the
   user attaches an image to a model with `supportsImage: false`, warn *before*
   sending: *"deepseek-v4-pro can't read images — switch model with `/model`, or
   send without the attachment?"* and offer the model switch.
2. **Post-flight fallback.** If a request is rejected with a capability code,
   surface the gateway's `message` as-is (it names the model and the fix) and
   offer to switch to a model whose flag is `true`.
3. **Do not retry** a capability rejection, and do not silently drop the image or
   the thinking request — the user should know their input was not fully used.

---

## 4. Other error shapes on the hosted path

Unchanged by this work; listed so the migration has one reference.

| Condition                        | Status | Body marker                                    | Retry? |
| -------------------------------- | ------ | ---------------------------------------------- | ------ |
| Not signed in / bad token        | 401    | `error.type: authentication_error`             | no     |
| Account suspended/banned         | 403    | message names the status                       | no     |
| Model not on the user's plan     | 403    | `model not available on your plan: <code>`     | no     |
| Free plan, no hosted access      | 403    | `code: plan_upgrade_required` (CLI-generated)  | no     |
| Daily turn limit                 | 429    | `reason: daily_turn_limit`, `resetSeconds`     | after reset |
| Credit limit                     | 429    | `reason: credit_limit…`, `resetSeconds`        | after reset |
| Capability mismatch              | 400    | `error.rayu_code` (see above)                  | no     |
| Upstream rejected the request    | 400/413/422 | upstream's real message, relayed          | no     |
| Provider disabled / misconfigured / no key | 503 / 500 | generic "model temporarily unavailable" | later |
| Provider down or overloaded      | 502    | `error.type: provider_unavailable`             | later |
| Gateway at capacity              | 503    | `gateway busy, please retry`, `Retry-After`    | yes    |
| Retired OpenAI ingress           | 410    | message asks the user to update rayu-cli       | no     |

Provider-side failures are deliberately **sanitized**: the gateway never relays an
upstream provider's raw error body (which can leak provider identity, quota
details, or upgrade URLs). Request-content errors (400/413/422) *are* relayed,
because they describe the caller's own request.

---

## 5. Billing and usage (informational)

- Credits are metered from the **upstream's reported usage**, normalized into
  Anthropic's buckets: fresh input, cache-read input, cache-write input, output.
- Every translating adapter maps its provider's usage into those same buckets, so
  a model's `creditMultiplier` means the same thing regardless of wire format.
- `creditMultiplier` is credits per 1M tokens; cache-read/write multipliers apply
  the provider's cache discount when the provider reports one.
- Credit headers on hosted responses and `GET /v1/credits` are unchanged.

---

## 6. Adding a provider (operator flow)

1. Admin dashboard → **Providers** → add: name, label, format, base URL, key env
   var name, optional endpoint path override, capability defaults.
2. Set that **environment variable** on the gateway (the API key is never stored
   in the database — the row only names the variable). A comma-separated value
   means multiple keys, which the gateway rotates and fails over across.
3. Admin dashboard → **Models** → add models pointing at that provider, with
   their upstream model id, credit charge, plan access, capability flags, and
   **context window** (typed as `200K` / `1M` / a raw token count). The CLI picks
   the model AND its window up automatically — nothing about the catalog is
   hardcoded in the client.
4. The gateway picks up registry changes on its next config refresh (~30s). A
   restart is only needed when introducing a *new* environment variable.

`GET {RAYU_GATEWAY}/v1/_provider-health` (admin token only) reports, per
provider: format, resolved endpoint, `keyPresent`, `keyCount`, a masked key
fingerprint, `enabled`, `routable`, and `configError` if the row was refused.
The key itself is never returned by any endpoint.

---

## 7. Rollout of this migration (one-time)

Order matters: the gateway reads the `providers` table, so the schema must exist
before the new gateway starts.

1. **Migrate the database** — `npx prisma migrate deploy` in `rayu-backend`.
   Migration `0000000000009_providers` creates `providers`, derives one row per
   provider already in `hosted_models` (reproducing the routing the env registry
   produced), links every model by FK, then drops `hosted_models.provider` and
   `upstreamBaseUrl`. Existing models keep hitting the same upstreams; no data is
   re-entered.
2. **Deploy the backend** (seeds/repairs provider rows on boot, non-destructively)
   then **the gateway**.
3. **Prune the retired gateway env vars** — `RAYU_PROVIDERS`,
   `RAYU_DISABLED_PROVIDERS`, `OLLAMA_PROVIDER_NAME`. They are now ignored; the
   provider table replaced them. Keep the `*_API_KEY` variables: those are still
   the only place secrets live. `deploy/.env.example` and
   `rayu-gateway/.env.example` show the reduced set.
4. **Check the boot log.** The gateway prints the resolved registry once:

   ```
   providers: 3 in registry: deepseek[anthropic_messages]→https://api.deepseek.com/anthropic/v1/messages DEEPSEEK_API_KEY=sk-dee…7890(36)×1 (ok) | longcat[…]=<unset>×0 (NO KEY) | …
   providers: "longcat" is NOT routable — env var LONGCAT_API_KEY is unset
   ```

   Keys are always masked. A provider whose row is invalid or whose key is missing
   is reported per line and refused at request time (503, no credits charged) —
   startup never fails because of one bad row.
5. **Verify in the dashboard**: Providers page badges should read *routable* for
   every provider you expect to serve traffic.

### What changes for clients

`POST /v1/chat/completions` now answers `410 Gone` with an "update rayu-cli"
message. Current CLI builds use `/anthropic/v1/messages` and are unaffected; the
410 exists so an out-of-date client gets a clear instruction instead of a 404.
Watch for `retired endpoint:` log lines to see whether old clients are still in
the field.
