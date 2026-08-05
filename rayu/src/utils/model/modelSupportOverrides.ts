import memoize from 'lodash-es/memoize.js'
import { getAPIProvider } from './providers.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

const TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

/**
 * Env-var tier: a 3p model capability override for a model that matches one of
 * the pinned ANTHROPIC_DEFAULT_*_MODEL env vars. Memoized because env vars do not
 * change during a session.
 */
const envCapabilityOverride = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    if (getAPIProvider() === 'anthropic') {
      return undefined
    }
    const m = model.toLowerCase()
    for (const tier of TIERS) {
      const pinned = process.env[tier.modelEnvVar]
      const capabilities = process.env[tier.capabilitiesEnvVar]
      if (!pinned || capabilities === undefined) continue
      if (m !== pinned.toLowerCase()) continue
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    return undefined
  },
  (model, capability) => `${model.toLowerCase()}:${capability}`,
)

/**
 * Config tier: a user-defined provider can DECLARE that its endpoint has no
 * reasoning support (the `supportsThinking` toggle in /connect → Custom). When it
 * says no, every reasoning-adjacent parameter is suppressed, because sending
 * `thinking` or `output_config.effort` to an endpoint that does not implement them
 * is a 400.
 *
 * Only the NEGATIVE case is an override. A provider that declares support (or says
 * nothing) falls through to the normal per-format/per-family rules, which already
 * answer correctly — so this never *grants* a capability the wire format lacks.
 *
 * NOT memoized: `/connect` can change the config mid-session.
 */
function providerDeclaredOverride(
  model: string,
  capability: ModelCapabilityOverride,
): boolean | undefined {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { resolveRequestShape } =
      require('./providerCapabilities.js') as typeof import('./providerCapabilities.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const provider = resolveRequestShape(model).provider
    if (provider?.supportsThinking === false) {
      // Every listed capability is a reasoning parameter.
      void capability
      return false
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a capability override for a model, or undefined to let the normal rules
 * decide. Tiers, in order: pinned-env-var declarations, then a user-defined
 * provider's declared capabilities.
 */
export function get3PModelCapabilityOverride(
  model: string,
  capability: ModelCapabilityOverride,
): boolean | undefined {
  const fromEnv = envCapabilityOverride(model, capability)
  if (fromEnv !== undefined) return fromEnv
  return providerDeclaredOverride(model, capability)
}
