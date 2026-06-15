// Kiro model catalog + Anthropic⇄Kiro id mapping, ported from kirocc-fork's
// internal/models/models.go. Kiro uses DOT-notation Claude ids upstream
// (claude-sonnet-4.6) while Rayu/Anthropic use DASH notation (claude-sonnet-4-6).
// There is no live /models endpoint — the list is curated.

export type KiroModelMapping = {
  /** Anthropic-form id (dash notation), possibly with a `[1m]` suffix. */
  anthropic: string
  /** Kiro SKU sent upstream as `modelId` (dot notation). */
  kiro: string
  /** Kiro SKU for the 1M-context / thinking variant, if a distinct one exists. */
  kiro1m?: string
  /** Per-model context-window override (tokens); 0/undefined = use default. */
  contextWindowSize?: number
}

/** Suffix that advertises the 1M context window / thinking opt-in. */
export const KIRO_THINKING_SUFFIX = '[1m]'

export const KIRO_DEFAULT_CONTEXT_WINDOW = 200_000
export const KIRO_THINKING_CONTEXT_WINDOW = 1_000_000

/** Default model id (Kiro dot-notation). */
export const KIRO_DEFAULT_MODEL = 'claude-sonnet-4.6'
/** Default model id in Anthropic dash-notation, echoed back in responses. */
export const KIRO_DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6'

// Ordered list — exact key matching against both `anthropic` and `kiro` fields
// (first match wins). Order matters: specific entries precede legacy aliases
// that share the same Kiro value.
const MODEL_MAP_ORDERED: KiroModelMapping[] = [
  { anthropic: 'claude-opus-4-8[1m]', kiro: 'claude-opus-4.8', kiro1m: 'claude-opus-4.8' },
  { anthropic: 'claude-opus-4-8', kiro: 'claude-opus-4.8', kiro1m: 'claude-opus-4.8' },
  { anthropic: 'claude-opus-4-7[1m]', kiro: 'claude-opus-4.7', kiro1m: 'claude-opus-4.7' },
  { anthropic: 'claude-opus-4-6[1m]', kiro: 'claude-opus-4.6', kiro1m: 'claude-opus-4.6' },
  { anthropic: 'claude-opus-4-7', kiro: 'claude-opus-4.7', kiro1m: 'claude-opus-4.7' },
  { anthropic: 'claude-sonnet-4-6', kiro: 'claude-sonnet-4.6', kiro1m: 'claude-sonnet-4.6-1m' },
  { anthropic: 'claude-sonnet-4.5', kiro: 'claude-sonnet-4.5', kiro1m: 'claude-sonnet-4.5-1m' },
  { anthropic: 'claude-opus-4-6', kiro: 'claude-opus-4.6', kiro1m: 'claude-opus-4.6' },
  { anthropic: 'claude-opus-4.5', kiro: 'claude-opus-4.5' },
  { anthropic: 'claude-haiku-4.5', kiro: 'claude-haiku-4.5' },
]

export type KiroResolved = {
  /** Kiro SKU to send upstream as `modelId` (never `[1m]`-suffixed). */
  kiroModel: string
  /** Whether thinking mode is enabled for this request. */
  thinking: boolean
  /** Context window (tokens). */
  contextWindowSize: number
  /** Anthropic-form id to echo back (gets `[1m]` when the window is 1M). */
  anthropicModel: string
}

/**
 * Map an Anthropic or Kiro model id to the Kiro SKU + thinking flag + context
 * window + the Anthropic-form id to echo back. Two-tier lookup:
 *  1. exact match against `anthropic`/`kiro` (preserves always-1M aliases like
 *     `claude-opus-4-7[1m]`);
 *  2. strip a trailing `[1m]` (treated as a thinking opt-in) and retry.
 * Ported from models.go Resolve().
 */
export function resolveKiroModel(model: string, context1M = false): KiroResolved {
  let matchedWindowSize = 0
  let matchedKiro1M = ''
  let matchedAnthropic = ''
  let matched = false
  let kiroModel = ''
  let thinking = false

  // Tier 1: exact match (no strip).
  for (const m of MODEL_MAP_ORDERED) {
    if (model === m.anthropic || model === m.kiro) {
      kiroModel = m.kiro
      matchedKiro1M = m.kiro1m ?? ''
      matchedWindowSize = m.contextWindowSize ?? 0
      matchedAnthropic = m.anthropic
      matched = true
      break
    }
  }

  // Tier 2: strip `[1m]` (thinking opt-in) and retry.
  if (!matched && model.endsWith(KIRO_THINKING_SUFFIX)) {
    const before = model.slice(0, -KIRO_THINKING_SUFFIX.length)
    model = before
    thinking = true
    for (const m of MODEL_MAP_ORDERED) {
      if (model === m.anthropic || model === m.kiro) {
        kiroModel = m.kiro
        matchedKiro1M = m.kiro1m ?? ''
        matchedWindowSize = m.contextWindowSize ?? 0
        matchedAnthropic = m.anthropic
        matched = true
        break
      }
    }
  }

  if (context1M) thinking = true

  let anthropicModel: string
  if (!matched) {
    if (model.startsWith('claude-')) {
      kiroModel = model
      anthropicModel = model
    } else {
      // Non-claude fallback → default.
      kiroModel = KIRO_DEFAULT_MODEL
      anthropicModel = KIRO_DEFAULT_ANTHROPIC_MODEL
    }
  } else {
    anthropicModel = matchedAnthropic
  }

  // A mapping where kiro1m === kiro means the model always uses 1M context.
  let contextWindowSize: number
  if (matchedKiro1M === kiroModel && matchedKiro1M !== '') {
    contextWindowSize = KIRO_THINKING_CONTEXT_WINDOW
  } else if (thinking && matchedKiro1M !== '') {
    kiroModel = matchedKiro1M
    contextWindowSize = KIRO_THINKING_CONTEXT_WINDOW
  } else if (matchedWindowSize > 0) {
    contextWindowSize = matchedWindowSize
  } else {
    contextWindowSize = KIRO_DEFAULT_CONTEXT_WINDOW
  }

  if (
    contextWindowSize === KIRO_THINKING_CONTEXT_WINDOW &&
    !anthropicModel.endsWith(KIRO_THINKING_SUFFIX)
  ) {
    anthropicModel += KIRO_THINKING_SUFFIX
  }

  return { kiroModel, thinking, contextWindowSize, anthropicModel }
}

/** Deduplicated list of all Kiro model ids (dot notation). */
export function listKiroModels(): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const m of MODEL_MAP_ORDERED) {
    if (!seen.has(m.kiro)) {
      seen.add(m.kiro)
      result.push(m.kiro)
    }
  }
  return result
}
