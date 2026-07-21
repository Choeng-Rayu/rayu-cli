// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getCanonicalName } from './model/model.js'
import { isClaudeModelOrAlias } from './model/aliases.js'
import { resolveAntModel } from './model/antModels.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import {
  getAPIProvider,
  isOpenAICompatibleActive,
  isRayuAnthropicCompatibleActive,
  isRayuNonAnthropicActive,
} from './model/providers.js'
import { getSettingsWithErrors } from './settings/settings.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * Build-time gate (feature) + runtime gate (GrowthBook). The build flag
 * controls code inclusion in external builds; the GB flag controls rollout.
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

/**
 * Check if text contains the "ultrathink" keyword.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Find positions of "ultrathink" keyword in text (for UI highlighting/notification)
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // Fresh /g literal each call — String.prototype.matchAll copies lastIndex
  // from the source regex, so a shared instance would leak state from
  // hasUltrathinkKeyword's .test() into this call on the next render.
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

// TODO(inigo): add support for probing unknown models via API error detection
// Provider-aware thinking support detection (aligns with modelSupportsISP in betas.ts)
export function modelSupportsThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Rayu: OpenAI-compatible providers (NVIDIA, DeepSeek, local, …) support
  // extended thinking. Other non-Anthropic providers (Bedrock/Vertex/Kiro/…)
  // also do for their NON-Claude models — but native Claude models on those
  // providers must use the canonical per-family gating below, so e.g. Bedrock
  // Haiku is correctly excluded instead of being sent unsupported thinking
  // params that make Bedrock 400. (Explicit 3P override above still wins.)
  if (
    isOpenAICompatibleActive() ||
    (isRayuNonAnthropicActive() && !isClaudeModelOrAlias(model))
  ) {
    return true
  }
  if (process.env.USER_TYPE === 'ant') {
    if (resolveAntModel(model.toLowerCase())) {
      return true
    }
  }
  // IMPORTANT: Do not change thinking support without notifying the model
  // launch DRI and research. This can greatly affect model quality and bashing.
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 1P and Foundry: all Claude 4+ models (including Haiku 4.5)
  if (provider === 'foundry' || provider === 'anthropic') {
    return !canonical.includes('claude-3-')
  }
  // 3P (Bedrock/Vertex): only Opus 4+ and Sonnet 4+
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports adaptive thinking.
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Rayu: OpenAI-compatible providers support adaptive thinking — the OpenAI
  // adapter translates the thinking param into the provider's own reasoning
  // field, so adaptive is fine. Explicit 3P override above still takes precedence.
  if (isOpenAICompatibleActive()) {
    return true
  }
  // Rayu: third-party Anthropic-compatible endpoints (LongCat, Ollama Cloud) send
  // the NATIVE Anthropic wire format, but `thinking:{type:'adaptive'}` is a
  // Claude-only extension they don't understand — sending it produces NO thinking
  // output (no live thinking stream). They DO support the standard
  // `{type:'enabled',budget_tokens}` form, so return false here to take that path.
  if (isRayuAnthropicCompatibleActive()) {
    return false
  }
  // Rayu: other non-Anthropic kinds (Bedrock/Vertex/Kiro/Copilot/rayu-hosted)
  // keep adaptive thinking for their NON-Claude models. Native Claude models on
  // those providers fall through to the canonical 4.6-only gating below, so
  // Bedrock Haiku/older Claude don't claim adaptive thinking they can't do.
  if (isRayuNonAnthropicActive() && !isClaudeModelOrAlias(model)) {
    return true
  }
  const canonical = getCanonicalName(model)
  // Supported by a subset of Claude 4 models
  if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
    return true
  }
  // Exclude any other known legacy models (allowlist above catches 4-6 variants first)
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  // IMPORTANT: Do not change adaptive thinking support without notifying the
  // model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Newer models (4.6+) are all trained on adaptive thinking and MUST have it
  // enabled for model testing. DO NOT default to false for first party, otherwise
  // we may silently degrade model quality.

  // Default to true for unknown model strings on 1P and Foundry (because Foundry
  // is a proxy). Do not default to true for other 3P as they have different formats
  // for their model strings.
  const provider = getAPIProvider()
  return provider === 'anthropic' || provider === 'foundry'
}

export function shouldEnableThinkingByDefault(): boolean {
  const rawMaxThinkingTokens = process.env.MAX_THINKING_TOKENS
  if (rawMaxThinkingTokens) {
    const parsed = parseInt(rawMaxThinkingTokens, 10)
    // A malformed (non-numeric) value is treated as unset — fall through to the
    // settings default rather than silently forcing thinking off.
    if (!Number.isNaN(parsed)) {
      return parsed > 0
    }
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // IMPORTANT: Do not change default thinking enabled value without notifying
  // the model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Enable thinking by default unless explicitly disabled.
  return true
}
