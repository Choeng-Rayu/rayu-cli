// Context-aware ceiling for a single Read.
//
// WHY THIS EXISTS
// limits.ts enforces two PER-CALL caps (total file size, output tokens). Neither
// knows anything about the conversation, so N reads that each pass their
// individual gate can still collectively overflow the context window: 20 files ×
// 25k tokens = 500k tokens of tool_result. The symptom is a session that reads a
// handful of files and then dies on "Prompt is too long" (or auto-compacts away
// the very content it just fetched, and re-reads it).
//
// The fix is to make the per-call token cap a function of what is LEFT rather
// than a constant: as the transcript grows, each Read is allowed a smaller slice,
// so the existing MaxFileReadTokenExceededError fires EARLY with an actionable
// "use offset/limit" message instead of the request failing wholesale after the
// content is already committed to history.
//
// Estimation only — roughTokenCountEstimationForMessages is a local character
// heuristic, never an API round-trip, because this runs on every Read.
import { getSdkBetas } from '../../bootstrap/state.js'
import { roughTokenCountEstimationForMessages } from '../../services/tokenEstimation.js'
import type { ToolUseContext } from '../../Tool.js'
import { getContextWindowForModel } from '../../utils/context.js'

/**
 * Fraction of the REMAINING context a single Read may consume. One read taking
 * a quarter of the remaining headroom still lets the model read several more
 * files (and leaves room for its own reasoning + the next tool results) before
 * auto-compact has to intervene.
 */
export const READ_CONTEXT_SHARE = 0.25

/**
 * Never shrink the cap below this. A Read that can only return a few hundred
 * tokens is worse than useless — the model burns a turn and learns nothing — so
 * below this point we stop adapting and let auto-compact do its job.
 */
export const MIN_ADAPTIVE_READ_TOKENS = 4_000

/**
 * Headroom withheld from the estimate for the system prompt, tool schemas and
 * the model's own output, none of which are in `context.messages`.
 */
export const CONTEXT_RESERVE_TOKENS = 30_000

/**
 * The effective `maxTokens` for one Read: the configured cap, lowered when the
 * conversation has grown enough that honoring it in full would crowd out the
 * rest of the session.
 *
 * Returns `configuredMaxTokens` unchanged when the context window is unknown or
 * still mostly empty, so the common case is byte-for-byte the previous behavior.
 */
export function clampReadTokensToRemainingContext(
  configuredMaxTokens: number,
  context: Pick<ToolUseContext, 'messages' | 'options'>,
): number {
  const contextWindow = safeContextWindow(context.options.mainLoopModel)
  if (!contextWindow) return configuredMaxTokens

  const used = roughTokenCountEstimationForMessages(context.messages)
  const remaining = contextWindow - used - CONTEXT_RESERVE_TOKENS
  if (remaining <= 0) return MIN_ADAPTIVE_READ_TOKENS

  const share = Math.floor(remaining * READ_CONTEXT_SHARE)
  return Math.max(
    MIN_ADAPTIVE_READ_TOKENS,
    Math.min(configuredMaxTokens, share),
  )
}

/**
 * getContextWindowForModel reads model capability config (and can throw for an
 * unknown/hand-edited model id). A Read must never fail because the context
 * window could not be resolved, so failure degrades to "no clamp".
 */
function safeContextWindow(model: string): number | undefined {
  try {
    const window = getContextWindowForModel(model, getSdkBetas())
    return Number.isFinite(window) && window > 0 ? window : undefined
  } catch {
    return undefined
  }
}
