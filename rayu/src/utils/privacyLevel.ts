/**
 * Privacy level controls how much nonessential network traffic and telemetry
 * RAYU generates.
 *
 * Levels are ordered by restrictiveness:
 *   default < no-telemetry < essential-traffic
 *
 * - default:            Everything enabled.
 * - no-telemetry:       Analytics/telemetry disabled (Datadog, 1P events, feedback survey).
 * - essential-traffic:  ALL nonessential network traffic disabled
 *                       (telemetry + auto-updates, grove, release notes, model capabilities, etc.).
 *
 * The resolved level is the most restrictive signal from:
 *   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC  →  essential-traffic
 *   DISABLE_TELEMETRY                         →  no-telemetry
 */

type PrivacyLevel = 'default' | 'no-telemetry' | 'essential-traffic'

export function getPrivacyLevel(): PrivacyLevel {
  if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return 'essential-traffic'
  }
  if (process.env.DISABLE_TELEMETRY) {
    return 'no-telemetry'
  }
  // Rayu: when an OpenAI-compatible provider is active, suppress ALL
  // nonessential traffic so the CLI never reaches out to Anthropic hosts
  // (feature flags, telemetry, auto-update, grove, release notes, model caps).
  // Opt back in with RAYU_TELEMETRY=1.
  if (process.env.RAYU_TELEMETRY !== '1' && rayuOpenAICompatibleActive()) {
    return 'essential-traffic'
  }
  // Rayu: telemetry/analytics are OFF by default (no first-party Anthropic
  // backend to talk to). Opt back in explicitly with RAYU_TELEMETRY=1.
  if (process.env.RAYU_TELEMETRY !== '1') {
    return 'no-telemetry'
  }
  return 'default'
}

/** Lazily probe the active provider kind without a static import cycle. */
function rayuOpenAICompatibleActive(): boolean {
  if (process.env.RAYU_OPENAI_COMPATIBLE === '1') {
    return true
  }
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isOpenAICompatibleActive } =
      require('./model/providers.js') as typeof import('./model/providers.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    return isOpenAICompatibleActive()
  } catch {
    return false
  }
}

/**
 * True when all nonessential network traffic should be suppressed.
 * Equivalent to the old `process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` check.
 */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

/**
 * True when telemetry/analytics should be suppressed.
 * True at both `no-telemetry` and `essential-traffic` levels.
 */
export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== 'default'
}

/**
 * Returns the env var name responsible for the current essential-traffic restriction,
 * or null if unrestricted. Used for user-facing "unset X to re-enable" messages.
 */
export function getEssentialTrafficOnlyReason(): string | null {
  if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
  }
  return null
}
