import {
  MEDIA_COMPACT_BUDGET_BYTES,
  MEDIA_COMPACT_BUDGET_BYTES_FIRST_PARTY,
  REQUEST_MESSAGES_BUDGET_BYTES,
  REQUEST_MESSAGES_BUDGET_BYTES_FIRST_PARTY,
} from '../constants/apiLimits.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../types/message.js'

/**
 * The byte budget above which accumulated base64 media triggers compaction.
 *
 * Reads an optional `RAYU_MEDIA_COMPACT_BUDGET_BYTES` env override, mirroring the
 * other autocompact threshold overrides (CLAUDE_CODE_AUTO_COMPACT_WINDOW etc.) —
 * useful when a downstream gateway enforces a smaller request cap than the
 * first-party 32MB. Lives here, not in autoCompact.ts, so the error classifier
 * can share it without the errors → autoCompact → claude → errors import cycle.
 */
export function getMediaCompactBudgetBytes(firstParty = false): number {
  const override = process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES
  if (override) {
    const parsed = parseInt(override, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return firstParty
    ? MEDIA_COMPACT_BUDGET_BYTES_FIRST_PARTY
    : MEDIA_COMPACT_BUDGET_BYTES
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
    if (message.type === 'attachment') {
      // An @-mentioned / re-injected image or PDF lives on an attachment message
      // and only becomes an image block inside normalizeMessagesForAPI. Skipping
      // it here made the budget read 0 bytes for media that is fully on the wire.
      bytes += attachmentMediaBytes(message.attachment)
      continue
    }
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

/** base64 bytes an attachment will inline once normalized (file image / PDF). */
function attachmentMediaBytes(attachment: unknown): number {
  if (typeof attachment !== 'object' || attachment === null) return 0
  const a = attachment as { type?: unknown; content?: unknown }
  if (a.type !== 'file' || typeof a.content !== 'object' || a.content === null) {
    return 0
  }
  const c = a.content as { type?: unknown; file?: { base64?: unknown } }
  if (c.type !== 'image' && c.type !== 'pdf') return 0
  return typeof c.file?.base64 === 'string' ? c.file.base64.length : 0
}

/**
 * Serialized-`messages` ceiling for one request. Reads an optional
 * `RAYU_REQUEST_BODY_BUDGET_BYTES` override (same parsing rules as the media
 * budget above), which always wins. Otherwise `firstParty` picks the direct
 * Anthropic cap (32MB) over the rayu-hosted gateway's (8 MiB).
 */
export function getRequestMessagesBudgetBytes(firstParty = false): number {
  const override = process.env.RAYU_REQUEST_BODY_BUDGET_BYTES
  if (override) {
    const parsed = parseInt(override, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return firstParty
    ? REQUEST_MESSAGES_BUDGET_BYTES_FIRST_PARTY
    : REQUEST_MESSAGES_BUDGET_BYTES
}

export const SHED_IMAGE_PLACEHOLDER =
  '[image omitted from this request to stay under the request size limit]'
export const SHED_DOCUMENT_PLACEHOLDER =
  '[document omitted from this request to stay under the request size limit]'

type ApiMessage = UserMessage | AssistantMessage

/**
 * Make an already-normalized request fit the body budget by replacing the
 * OLDEST base64 image/document blocks with a text placeholder.
 *
 * Why this is needed even with media-byte auto-compact: every turn re-sends
 * the whole post-compact history, and auto-compact decides on estimates (a
 * flat 2000 tokens per image; a budget it can only act on by summarizing). A
 * resumed session, or one on a 1M-context model whose token threshold is never
 * reached, would otherwise send every old screenshot with a one-word "hi" and
 * be 413'd by the gateway. This runs on the exact messages about to be sent, so
 * it covers every caller of queryModel — main loop, subagents, and the
 * compaction fork, which reuses the main history verbatim.
 *
 * The HUMAN's last message is never touched: the model must see an image the
 * user just pasted. Everything else is eligible, oldest first — including tool
 * results, which are ALSO `type: 'user'` in this array and therefore cannot be
 * found by "last user message". Protecting them was wrong in both directions:
 * a huge screenshot in the latest tool result was never shed (the request still
 * 413'd), while a mid-turn paste stopped being the "last user message" as soon
 * as a tool result landed, so the user's own image could be shed silently.
 * Tool results are shed only after every older block, so the model still gets a
 * just-produced screenshot unless nothing else can be freed.
 *
 * If the human's own message alone is over budget, nothing is shed and the 413
 * handler gives "try with a smaller file" advice.
 *
 * Pure: the input array and its messages are not mutated.
 */
export function shedMediaToFitRequestBudget(
  messages: ApiMessage[],
  budgetBytes: number,
): { messages: ApiMessage[]; shedCount: number; shedBytes: number; totalBytes: number } {
  // Buffer.byteLength, not string .length: the latter counts UTF-16 units, so
  // CJK/emoji text would be under-measured by up to 3x.
  let total = 0
  for (const m of messages) {
    total += Buffer.byteLength(JSON.stringify(m.message.content ?? ''), 'utf8')
  }
  if (total <= budgetBytes) {
    return { messages, shedCount: 0, shedBytes: 0, totalBytes: total }
  }

  let protectedIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPromptMessage(messages[i]!)) {
      protectedIdx = i
      break
    }
  }

  let shedCount = 0
  let shedBytes = 0
  const replace = (block: unknown): unknown => {
    if (total <= budgetBytes) return block
    const bytes = mediaBlockBytes(block)
    if (bytes === 0) return block
    const text =
      (block as { type: string }).type === 'image'
        ? SHED_IMAGE_PLACEHOLDER
        : SHED_DOCUMENT_PLACEHOLDER
    total -= bytes - text.length
    shedCount++
    shedBytes += bytes
    return { type: 'text', text }
  }

  const out = messages.map((msg, idx) => {
    if (total <= budgetBytes) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg
    // Protection is per BLOCK, not per message: the prompt's own top-level media
    // is untouchable, but media nested in a tool_result inside that same message
    // (a mid-turn paste merged with its tool result) is still fair game.
    const protectTopLevel = idx === protectedIdx
    let changed = false
    const next = content.map(block => {
      const b = block as { type?: unknown; content?: unknown }
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        const nested = b.content.map(replace)
        if (nested.some((n, i) => n !== (b.content as unknown[])[i])) {
          changed = true
          return { ...b, content: nested }
        }
        return block
      }
      if (protectTopLevel) return block
      const r = replace(block)
      if (r !== block) changed = true
      return r
    })
    return changed
      ? ({ ...msg, message: { ...msg.message, content: next } } as typeof msg)
      : msg
  })

  return { messages: out, shedCount, shedBytes, totalBytes: total }
}

/**
 * True for the USER'S prompt message — the turn whose own images must survive
 * (its top-level media is what protects them; see the caller).
 *
 * Neither "no tool_result" nor "not isMeta" decides this on its own, because
 * normalization produces messages that break both assumptions:
 *
 *  - A tool-result message can carry an injected text sibling ("Tool loaded.",
 *    from normalizeMessagesForAPI / relocateToolReferenceSiblings). Testing
 *    "has some non-tool_result block" alone classified that synthetic message as
 *    the prompt and shed the user's real image.
 *  - Conversely, mergeUserMessages preserves `isMeta`, so a prompt submitted with
 *    a synthetic caveat prefix — and a mid-turn paste queued behind a tool
 *    result — become ONE message that may be meta AND contain a tool_result.
 *    Its TOP-LEVEL image is still the user's: tool output is normalized into a
 *    tool_result, so a top-level media block is always user input.
 */
function isPromptMessage(message: ApiMessage): boolean {
  if (message.type !== 'user') return false
  const content = message.message.content
  if (typeof content === 'string') {
    return !message.isMeta && content.trim().length > 0
  }
  if (content.length === 0) return false
  const hasTopLevelMedia = content.some(
    block => block.type === 'image' || block.type === 'document',
  )
  const hasToolResult = content.some(block => block.type === 'tool_result')
  // A tool-result message carrying injected text ("Tool loaded.") is synthetic,
  // however many text siblings it has — but one that also carries a TOP-LEVEL
  // image is a mid-turn paste merged with its tool result, and that image is the
  // user's.
  if (hasToolResult && !hasTopLevelMedia) return false
  return !message.isMeta || hasTopLevelMedia
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
