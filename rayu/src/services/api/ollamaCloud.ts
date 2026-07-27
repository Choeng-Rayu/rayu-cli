// Ollama Cloud model + context discovery. Ollama Cloud (ollama.com) serves the
// account's hosted models behind a Bearer API key. Chat runs through the NATIVE
// Anthropic Messages API (kind:'anthropic-compatible' → createAnthropicMessagesClient,
// baseURL https://ollama.com → POST /v1/messages), but MODEL LISTING uses
// Ollama's own endpoints:
//   • GET  {host}/v1/models   (OpenAI-compatible) → { data: [{ id }] }
//   • GET  {host}/api/tags     (native fallback)    → { models: [{ model, name }] }
//   • POST {host}/api/show      (per model)          → { model_info: { "<arch>.context_length": N } }
//
// This module is intentionally dependency-free (primitive params, no rayu
// imports) so rayuConfig/rayuProviders can import it without an import cycle.
// Docs: https://docs.ollama.com/api/anthropic-compatibility

/** Stable provider id for the Ollama Cloud preset (distinct from local 'ollama'). */
export const OLLAMA_CLOUD_PROVIDER_ID = 'ollama-cloud'

/** Ollama Cloud host. The Anthropic SDK appends /v1/messages for chat. */
export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com'

/** Trim trailing slashes so `${host}/v1/models` never doubles up. */
function hostOf(baseURL?: string): string {
  return (baseURL || OLLAMA_CLOUD_BASE_URL).replace(/\/+$/, '')
}

function bearer(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

/**
 * Fetch the model ids available to the user's Ollama Cloud account. Tries the
 * OpenAI-compatible `/v1/models` first (its `id` is the exact string to send in
 * the Anthropic `model` field, e.g. `gpt-oss:120b-cloud`), then falls back to
 * the native `/api/tags`. Returns a deduped, sorted list, or [] on failure.
 */
export async function fetchOllamaCloudModels(
  apiKey: string | undefined,
  baseURL?: string,
): Promise<string[]> {
  const host = hostOf(baseURL)
  const headers = bearer(apiKey)
  const ids = new Set<string>()

  try {
    const res = await fetch(`${host}/v1/models`, { headers, signal: AbortSignal.timeout(15_000) })
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      for (const m of json.data ?? []) {
        if (typeof m.id === 'string' && m.id) ids.add(m.id)
      }
    }
  } catch {
    // fall through to the native tags endpoint
  }

  if (ids.size === 0) {
    try {
      const res = await fetch(`${host}/api/tags`, { headers, signal: AbortSignal.timeout(15_000) })
      if (res.ok) {
        const json = (await res.json()) as { models?: Array<{ model?: string; name?: string }> }
        for (const m of json.models ?? []) {
          const id = m.model || m.name
          if (typeof id === 'string' && id) ids.add(id)
        }
      }
    } catch {
      // return whatever we have (possibly empty)
    }
  }

  return [...ids].sort()
}

/**
 * Fetch each model's real context window from Ollama's `POST /api/show`
 * (`model_info` carries an arch-prefixed `<arch>.context_length`, e.g.
 * `qwen3.context_length`). Best-effort + bounded concurrency; models whose show
 * call fails/omits the field are left out so the caller falls back to the
 * known-model context table. Returns a { modelId: contextTokens } map.
 */
export async function fetchOllamaCloudModelContexts(
  apiKey: string | undefined,
  baseURL: string | undefined,
  models: string[],
): Promise<Record<string, number>> {
  const host = hostOf(baseURL)
  const headers = { 'Content-Type': 'application/json', ...bearer(apiKey) }
  const out: Record<string, number> = {}
  const CONCURRENCY = 4
  let next = 0

  async function worker(): Promise<void> {
    while (next < models.length) {
      const model = models[next++]
      try {
        const res = await fetch(`${host}/api/show`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) continue
        const json = (await res.json()) as { model_info?: Record<string, unknown> }
        for (const [k, v] of Object.entries(json.model_info ?? {})) {
          if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) {
            out[model] = v
            break
          }
        }
      } catch {
        // best-effort — skip this model, fall back to the known-model table
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(models.length, 1)) }, worker),
  )
  return out
}
