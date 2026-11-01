import { MEDIA_COMPACT_BUDGET_BYTES } from '../constants/apiLimits.js'
import type { Message } from '../types/message.js'

/**
 * The byte budget above which accumulated base64 media triggers compaction.
 *
 * Reads an optional `RAYU_MEDIA_COMPACT_BUDGET_BYTES` env override, mirroring the
 * other autocompact threshold overrides (CLAUDE_CODE_AUTO_COMPACT_WINDOW etc.) —
 * useful when a downstream gateway enforces a smaller request cap than the
 * first-party 32MB. Lives here, not in autoCompact.ts, so the error classifier
 * can share it without the errors → autoCompact → claude → errors import cycle.
 */
export function getMediaCompactBudgetBytes(): number {
  const override = process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES
  if (override) {
    const parsed = parseInt(override, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return MEDIA_COMPACT_BUDGET_BYTES
}

/**
 * Estimate the base64 media bytes (images + documents) an API request body
 * carries.
 *
 * WHY THIS EXISTS, SEPARATE FROM THE TOKEN ESTIMATOR
 *
 * `roughTokenCountEstimationForBlock` (services/tokenEstimation.ts) scores every
 * image/document block as a FLAT 2000 tokens. That is deliberately right for the
 * context WINDOW — the server charges ~2000 tokens per image regardless of file
 * size — but it is blind to the request BODY: a base64 image is ~1-1.5MB of wire
 * bytes. So a long session heavy in pasted images sits far under the token-based
 * auto-compact threshold while its serialized body crosses the server's request
 * size cap and is rejected with HTTP 413 ("request too large").
 *
 * The base64 string IS what travels over the wire as the JSON value of
 * `source.data`, so its `.length` is the byte measure (not the decoded size).
 * URL image/document sources carry no inline bytes and contribute 0, which is
 * correct — they are not inlined into the body.
 *
 * Lives in its own dependency-free leaf module (types only) so both the token
 * utilities and the error classifier can import it: errors.ts → tokens.ts is a
 * cycle (tokens → messages → errors), so the estimator cannot live in tokens.ts.
 *
 * Counts top-level image/document blocks and images/documents nested inside
 * tool_result content — the same two shapes `stripImagesFromMessages` handles.
 */
export function estimateMediaBytes(messages: readonly Message[]): number {
  let bytes = 0
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }
    const content = message.message.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      bytes += mediaBlockBytes(block)
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result' &&
        Array.isArray((block as { content?: unknown }).content)
      ) {
        for (const nested of (block as { content: unknown[] }).content) {
          bytes += mediaBlockBytes(nested)
        }
      }
    }
  }
  return bytes
}

/**
 * Media bytes carried by turns BEFORE the most recent user message.
 *
 * This is the media a compaction can safely shed. The current turn's own
 * attachments must be preserved: compaction replaces history with a summary
 * (whose own request strips images), so a total-media trigger would swallow a
 * just-pasted image before the model ever saw it. Triggering only on ACCUMULATED
 * media fixes the reported long-session 413 (images spread through older turns)
 * while leaving a fresh paste untouched — if a single huge paste does exceed the
 * cap, it 413s exactly as it did before this feature and the user gets advice.
 *
 * Falls back to ALL messages when there is no user message (nothing is
 * "current", so any media counts).
 */
export function estimateAccumulatedMediaBytes(
  messages: readonly Message[],
): number {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.type === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx === -1) {
    return estimateMediaBytes(messages)
  }
  return estimateMediaBytes(messages.slice(0, lastUserIdx))
}

/** base64 byte length of a single image/document block, or 0 for anything else. */
function mediaBlockBytes(block: unknown): number {
  if (typeof block !== 'object' || block === null) {
    return 0
  }
  const type = (block as { type?: unknown }).type
  if (type !== 'image' && type !== 'document') {
    return 0
  }
  const source = (block as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) {
    return 0
  }
  const s = source as { type?: unknown; data?: unknown }
  return s.type === 'base64' && typeof s.data === 'string' ? s.data.length : 0
}
