// Single source of truth for "which API keys may this provider's client use?".
//
// Rayu can store several API keys per provider so a rate-limited key rolls over
// to the next one (see keyRotation.ts). Whether a provider is ALLOWED to use
// more than one key depends on two independent gates:
//
//   1. supportsMultiApiKey(providerId) — the provider must be a BYO-user-key
//      provider on the allowlist (NVIDIA / OpenRouter / Ollama Cloud, plus any
//      opt-ins via RAYU_MULTI_KEY_PROVIDERS). OAuth / managed-credential
//      providers (Kiro, Copilot, Vertex, Bedrock, rayu-hosted, first-party
//      Anthropic) are NEVER multi-key.
//   2. isMultiApiKeyAllowed() — the paid (Basic-plan) entitlement gate.
//
// When either gate fails the list is capped to the FIRST key, so a Free user
// effectively uses one key even if several are stored.
//
// This logic was previously duplicated in four places inside client.ts (the
// active openai-compatible path, the active anthropic-compatible path, and both
// of those again in the per-provider subagent routing path). Any divergence
// between those copies silently changed which keys a request could use, so it
// now lives here and is imported by every client builder.
//
// SECURITY: the returned values are SECRETS read from the 0600 provider config.
// They must never be logged, echoed to the UI, or included in diagnostics.
import type { RayuProvider } from '../../utils/rayuConfig.js'

/**
 * Resolve the ordered API-key list a client may rotate through for `provider`.
 *
 * - `envKeyOverride` (used only by the OpenAI-compatible path for
 *   `RAYU_OPENAI_API_KEY`) takes absolute precedence and is always a SINGLE key,
 *   matching the previous behavior for CI/test overrides.
 * - Otherwise the provider's stored keys are resolved via `getProviderApiKeys`
 *   (which prefers `apiKeys`, falls back to `apiKey`, trims and de-dupes) and
 *   then capped to one key unless BOTH multi-key gates pass.
 *
 * Returns `[]` when the provider has no key configured. Callers that need a
 * single key use `keys[0] ?? ''` exactly as before.
 *
 * Imports are dynamic to preserve the existing lazy-loading behavior and avoid
 * static import cycles (rayuConfig ↔ rayuProviders ↔ services/*).
 */
export async function resolveProviderApiKeys(
  provider: RayuProvider | undefined,
  envKeyOverride?: string,
): Promise<string[]> {
  if (envKeyOverride) {
    return [envKeyOverride]
  }
  const { getProviderApiKeys } = await import('../../utils/rayuConfig.js')
  const { supportsMultiApiKey } = await import('../../utils/rayuProviders.js')
  const { isMultiApiKeyAllowed } = await import(
    '../rayuAuth/multiApiKeyFeature.js'
  )
  const keys = getProviderApiKeys(provider)
  if (!supportsMultiApiKey(provider?.id) || !isMultiApiKeyAllowed()) {
    return keys.slice(0, 1)
  }
  return keys
}
