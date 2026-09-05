# Rayu Endpoints & Model Fetch

> How Rayu-CLI discovers, filters, and refreshes the model catalog for both
> authentication paths — Rayu OAuth (Auth) and Rayu API Key.

Rayu offers two ways to access its hosted models. Both ultimately reach the same
gateway and the same admin-configured model catalog, but they authenticate
differently and fetch their model lists from different endpoints. This document
explains both paths in full.

---

## The two Rayu providers

| | Rayu Auth (OAuth) | Rayu API Key |
|---|---|---|
| **Provider id** | `rayu-hosted` | `rayu` |
| **Kind** | `rayu-hosted` | `anthropic-compatible` |
| **Credential** | Rayu account JWT (from `/login`) | `rayu_sk_live_…` API key |
| **Chat endpoint** | `{gateway}/anthropic/v1/messages` (JWT-injecting fetch) | `{gateway}/anthropic/v1/messages` (key as Bearer) |
| **Model catalog endpoint** | `GET {backend}/me/entitlements` | `GET {gateway}/v1/models` |
| **Registered by** | Auto on `/login` | `/connect` wizard or `RAYU_API_KEY` env |
| **Display name** | `Rayu` | `Rayu API Key` |

They are deliberately separate providers so a user can have both configured
without either clobbering the other's credential — the same reasoning as
`anthropic` vs `claude-subscription`.

---

## Path 1 — Rayu Auth (OAuth / JWT)

### Authentication flow

```
User → Google OAuth (rayu-web) → rayu-backend /api/auth/oauth/google
  → issues Rayu JWT (signed with RAYU_JWT_SECRET)
  → CLI stores JWT in ~/.rayu/rayu-auth.json
```

### Model fetch flow

```
CLI → GET {backend}/me/entitlements  (Authorization: Bearer <JWT>)
  → backend resolves user's active plan
  → backend queries hosted_models WHERE enabled=true AND provider.enabled=true
  → returns TWO lists:
      • allowedModels  — plan-filtered subset (drives entitlement/gating)
      • hostedModels   — full enabled catalog (shown to ALL signed-in users)
```

### Backend query (`models.service.ts`)

```typescript
// All enabled models (the catalog shown to every signed-in user)
findEnabled(): Promise<HostedModelWithProvider[]> {
  return this.prisma.hostedModel.findMany({
    where: { enabled: true, provider: { enabled: true } },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: WITH_PROVIDER,
  })
}

// Plan-allowed subset (drives entitlement)
async findAllowedForPlan(planCode: string) {
  const all = await this.findEnabled()
  return all.filter((m) => this.allowedCodes(m).includes(planCode))
}
```

### Entitlements response shape

```json
{
  "plan": { "code": "pro", "name": "Pro", "priceCents": 2900 },
  "allowedModels": [
    { "code": "deepseek-v4-pro", "label": "DeepSeek V4 Pro",
      "contextWindow": 131072, "supportsReasoning": true, "supportsImage": false,
      "supportsTools": true, "creditMultiplier": 1.0 }
  ],
  "hostedModels": [
    { "code": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", ... },
    { "code": "deepseek-v4-flash", "label": "DeepSeek V4 Flash", ... }
  ]
}
```

### How the CLI uses it (`rayuHostedProvider.ts`)

```typescript
// Visibility uses the full catalog; usability uses the entitled subset.
const catalog = ent?.hostedModels ?? ent?.allowedModels ?? []
const entitled = ent?.allowedModels ?? []
const models = catalog.map((m) => m.code)
```

- `hostedModels` present → shows ALL enabled models (Free users see them but are
  gated on use; a model is usable iff it also appears in `allowedModels`).
- `hostedModels` absent (older backend) → falls back to `allowedModels`
  (plan-filtered only).

### Model ordering

Models are returned in `ORDER BY sortOrder ASC, id ASC`. The admin dashboard's
reorder UI sets `sortOrder = index × 10`. The CLI preserves this order exactly —
no client-side sorting.

### Auto-refresh

- **On login**: `syncRayuHostedProvider()` is called with the fresh entitlements.
- **Background**: `getCachedEntitlements()` kicks a rate-limited (30s cooldown)
  background refresh on every read.
- **On `/model` open**: `SearchableModelPicker` calls `refreshHostedCatalog()`
  which re-fetches entitlements and re-renders only if the catalog changed.

---

## Path 2 — Rayu API Key

### Authentication flow

```
User → rayucode.com/dashboard/api-keys → creates rayu_sk_live_… key
  → pastes key into /connect → CLI sends it as Bearer to gateway
```

### Model fetch flow

```
CLI → GET {gateway}/v1/models  (Authorization: Bearer <key>)
  → gateway resolves user's identity from the key
  → gateway resolves user's active plan
  → gateway filters: enabled model + enabled provider + plan-allowed + key-allowlist
  → returns OpenAI list shape with capabilities
```

### Gateway query (`store.rs`)

```rust
// Loads ALL hosted_models rows (no WHERE — filtering happens in Rust)
let rows = sqlx::query(
    r#"SELECT m.*, p.*
    FROM hosted_models m
    JOIN providers p ON p.id = m.provider_id
    ORDER BY m.sortOrder, m.id"#,
)
```

### Gateway filtering (`entitlements.rs`)

```rust
pub fn allowed_models(models: &[HostedModel], plan_code: &str) -> Vec<HostedModel> {
    models
        .iter()
        .filter(|m| {
            m.enabled
                && m.provider.enabled    // ← matches backend's findEnabled()
                && m.allowed_plan_codes.iter().any(|pc| pc == plan_code)
        })
        .cloned()
        .collect()
}
```

Then `visible_chat_models()` applies the API key's own allowlist on top:

```rust
fn visible_chat_models<'a>(ent: &Entitlement, api_key: Option<&ApiKeyContext>) -> Vec<&HostedModel> {
    ent.allowed_models
        .iter()
        .filter(|m| api_key.is_none_or(|ak| ak.allows_model(&m.code)))
        .collect()
}
```

### `/v1/models` response shape

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-pro",
      "object": "model",
      "created": 1700000000,
      "owned_by": "rayu",
      "label": "DeepSeek V4 Pro",
      "supportsReasoning": true,
      "supportsImage": false,
      "supportsTools": true,
      "contextWindow": 131072
    }
  ]
}
```

### How the CLI uses it (`rayuApiKeyCatalog.ts`)

```typescript
export function parseRayuCatalog(payload: unknown) {
  // Sanitize every id, dedupe, preserve gateway order (no .sort())
  return {
    models: entries.map(e => e.code),
    modelLabels: hostedModelLabels(entries),
    modelContextWindows: hostedContextWindows(entries),
  }
}
```

### Model ordering

The gateway returns models in `ORDER BY m.sortOrder, m.id`. The CLI preserves
this order — no client-side sorting. This matches the Auth path exactly.

### Auto-refresh

- **On connect**: `RayuApiKeyInput.submit()` fetches the catalog and persists it.
- **On `/model` open**: `SearchableModelPicker` calls `refreshRayuApiKeyCatalog()`
  which re-fetches from the gateway and re-renders only if the catalog changed.
- **Background**: `refreshActiveProviderModels()` calls `refreshRayuApiKeyCatalog()`
  when the provider is active.

---

## Filtering rules (both paths)

A model appears in the catalog **only if** ALL of these are true:

| Rule | Auth path | API key path |
|------|-----------|--------------|
| Model `enabled = true` | ✅ backend `findEnabled()` | ✅ gateway `allowed_models()` |
| Provider `enabled = true` | ✅ backend `findEnabled()` | ✅ gateway `m.provider.enabled` |
| Model's `allowedPlanCodes` includes user's plan | ✅ backend `findAllowedForPlan()` | ✅ gateway `allowed_models()` |
| API key's `allowed_models` includes the model | N/A (no key) | ✅ gateway `visible_chat_models()` |

An **empty** `allowedPlanCodes` means **NOBODY** for chat models — a model must
be explicitly granted to a plan. (The opposite rule applies to media models,
where empty means EVERY plan.)

---

## Per-key controls

An API key can further narrow the catalog via the dashboard:

| Control | Effect on `/v1/models` |
|---------|----------------------|
| **Model allowlist** | Only listed models appear (intersected with plan) |
| **Empty allowlist** | No restriction — full plan catalog |
| **Credit cap** | Doesn't affect listing; enforced on request path |
| **Rate limit (RPM)** | Doesn't affect listing; enforced on request path |

A key allowlist is a **narrowing**, never a grant: it cannot add a model the
plan doesn't include.

---

## Stale-default pruning

Both paths prune the user's chosen default/small model if the admin removes it
from the catalog. Holding on to a removed code would send every request to a
model the gateway now rejects (403 "model not available"), which reads like a
CLI bug rather than a catalog change.

```typescript
// rayuHostedProvider.ts
const inCatalog = (code?: string): boolean =>
  !!code && models.includes(code)
defaultModel: inCatalog(existing?.defaultModel) ? existing?.defaultModel : preferredCode

// rayuConfig.ts (refreshRayuApiKeyCatalog)
if (!cur.defaultModel || !result.models.includes(cur.defaultModel)) {
  cur.defaultModel = fallback.defaultModel
}
```

---

## Config persistence

Both providers store their catalog in `~/.rayu/providers.json`:

```json
{
  "id": "rayu",
  "kind": "anthropic-compatible",
  "baseURL": "https://gateway.rayucode.com/anthropic",
  "apiKey": "rayu_sk_live_...",
  "models": ["deepseek-v4-pro", "deepseek-v4-flash"],
  "fetchedModels": ["deepseek-v4-pro", "deepseek-v4-flash"],
  "modelLabels": { "deepseek-v4-pro": "DeepSeek V4 Pro" },
  "modelContextWindows": { "deepseek-v4-pro": 131072 },
  "defaultModel": "deepseek-v4-pro",
  "smallFastModel": "deepseek-v4-flash"
}
```

- `models` — the catalog in display order (what `/model` shows).
- `fetchedModels` — same list, tracked separately for refresh detection.
- `modelLabels` — admin display names, keyed by model id.
- `modelContextWindows` — admin context windows in tokens, keyed by model id.

---

## Error handling

| Failure | Auth path | API key path |
|---------|-----------|--------------|
| Network error | Keep cached catalog, log diagnostic | Keep cached catalog, log diagnostic |
| 401 (bad JWT/key) | Remove provider, prompt re-login | Remove provider, prompt re-enter key |
| 403 (account inactive) | Keep cache, surface error | Keep cache, surface error |
| 503 (gateway DB down) | Keep cache, don't blame user | Keep cache, don't blame user |
| Empty catalog | Remove provider (no models to show) | Keep cache, let `/model` refresh later |

Both paths **never throw** and **never empty the cache** on a transient failure —
an offline launch or a gateway blip must not wipe the model list.

---

## Quick reference — API endpoints

### Backend (rayu-backend, NestJS)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/me/entitlements` | Rayu JWT | Plan, features, allowedModels, hostedModels |

### Gateway (rayu-gateway-rust)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/anthropic/v1/messages` | JWT or API key | Chat (Anthropic Messages format) |
| POST | `/v1/chat/completions` | API key | Chat (OpenAI format) |
| GET | `/v1/models` | API key | Available chat models for the caller's plan |
| GET | `/v1/models?media=image` | API key | Available image-generation models |
| GET | `/v1/models?media=video` | API key | Available video-generation models |
| GET | `/v1/credits` | API key | Credit balance and usage |

---

## See also

- [Providers](./03-providers.md) — connecting providers, `/connect`, API keys
- [Models](./04-models.md) — searchable `/model` picker, context windows
- [API Keys](./14-api-keys.md) — the external API key product (for your own apps)
- [Credits & limits](./credits-and-limits.md) — plans, credits, per-model charges
