// Per-(provider, model) image capability.
//
// THE PROBLEM THIS SOLVES
// Rayu had no model-level vision knowledge at all. The only signal was
// `RayuProvider.supportsImage`, a PROVIDER-wide boolean settable solely through
// /connect → Custom, which produced two bad outcomes:
//
//   - Unset (the default for every built-in provider): an image is sent to
//     `deepseek-chat`, the provider answers 400, and the turn is LOST. The image
//     is now in history, so every following turn to the same model fails the
//     same way (see errors.getModelImageUnsupportedErrorMessage).
//   - Set to false: openaiAdapter / openaiResponsesAdapter drop the image parts
//     SILENTLY. The user sees a confident answer and has no idea the model never
//     saw the image — the worse of the two failures.
//
// It also cannot be correct in principle: one provider routinely serves both
// kinds of model (DeepSeek serves text-only `deepseek-chat` next to vision
// `deepseek-vl`; a Bedrock / Azure / Vertex entry serves several families at
// once), so only a (provider, model) pair can answer.
//
// PRECEDENT FOLLOWED
// The table shape is KNOWN_MODEL_CONTEXT in rayuConfig.ts: Array<RegExp>, most
// specific first, first match wins. The lazy-`require()` import style is
// providerCapabilities.ts's, for the same reason — this module sits between the
// model layer and the request layer, which import each other's leaves.
//
// 'unknown' IS A FIRST-CLASS ANSWER
// New model ids appear constantly, so the tables will always be incomplete.
// Guessing 'no' for an unlisted model would block images on a perfectly capable
// one. Unlisted therefore means 'unknown', and the caller sends the image and
// relies on the reactive recovery path (strip → warn → retry) if the provider
// rejects it. Only a POSITIVE 'no' triggers the proactive warning.

/** What we know about a model's ability to accept image input. */
export type ImageSupport = 'yes' | 'no' | 'unknown'

/**
 * Models known to accept image input. Checked BEFORE the text-only table so a
 * specific vision variant beats a broad family rule (`deepseek-vl` must not be
 * caught by a generic `deepseek` text pattern).
 */
const KNOWN_VISION_MODELS: RegExp[] = [
  // Anthropic Claude — every Claude 3+ model is multimodal, on any transport
  // (first-party, Bedrock, Vertex, Azure, Copilot, OpenRouter).
  [/claude-3|claude-[4-9]|claude-(opus|sonnet|haiku)/i],
  // Google Gemini — multimodal across 1.5 / 2 / 2.5 / 3.x, plus the bare id and
  // the catalog's `models/` prefix.
  [/gemini/i],
  // OpenAI vision-capable: 4o family, 4.1 family, 4-turbo, gpt-5, o-series
  // reasoning models. Anchored so `gpt-4o` is not confused with `o4`.
  [/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5/i],
  [/(?:^|[/_-])(o1|o3|o4)(?:[.\-_]|$)/i],
  // Explicit vision variants across open-weight families.
  [/deepseek[-_.]?vl/i],
  [/qwen[-_.]?(?:\d[\w.]*)?[-_.]?vl/i],
  [/glm-(?:4\.[56]v|5v|4v)/i],
  [/llama[-_.]?3\.2[-_.]?\d+b?[-_.]?vision|llama[-_.]?(?:3\.2|4)[-_.]?vision/i],
  [/llama[-_.]?4/i], // Llama 4 Scout / Maverick are natively multimodal
  [/pixtral|llava|moondream|internvl|minicpm[-_.]?v|cogvlm|idefics/i],
  [/mistral[-_.]?(?:small[-_.]?3\.[12]|medium[-_.]?3)/i], // multimodal Mistral releases
  [/nova[-_.]?(?:lite|pro|premier)/i], // Amazon Nova (Bedrock) multimodal tiers
  [/grok[-_.]?(?:\d[\w.]*)?[-_.]?vision|grok-[4-9]/i],
  [/step[-_.]?1o|step[-_.]?3/i],
  [/kimi[-_.]?(?:latest[-_.]?)?vision|kimi[-_.]?k?2\.[56]/i],
  [/minimax[-_.]?vl|minimax[-_.]?m[23]/i],
  [/phi[-_.]?[34][-_.]?(?:vision|multimodal)/i],
  [/gemma[-_.]?3/i], // Gemma 3 (4b+) accepts images
].map(([re]) => re as RegExp)

/**
 * Models known to be TEXT-ONLY. Only reached when no vision pattern matched.
 *
 * Every entry here must be a model that genuinely rejects image content — a
 * false positive suppresses images the model could have read, which is a
 * regression, so patterns are kept narrow and family-specific rather than broad.
 */
const KNOWN_TEXT_ONLY_MODELS: RegExp[] = [
  // DeepSeek's chat/reasoner/coder line — the single most common case.
  [/deepseek[-_.]?(?:chat|reasoner|coder|r1|v3|v4|prover|math)/i],
  [/^deepseek(?:-\d)?$/i],
  // Qwen text checkpoints (QwQ reasoning, coder, plain instruct).
  [/qwq|qwen[-_.]?[\d.]+[-_.]?(?:coder|instruct|next|thinking|a\d+b)/i],
  // Llama text checkpoints (3.x without a vision suffix — 3.2-vision is caught
  // by the vision table above).
  [/llama[-_.]?3(?:\.[13])?[-_.]?\d+b/i],
  [/llama[-_.]?3[-_.]?(?:8b|70b|instruct)/i],
  // Mistral text-only line.
  [/mixtral|codestral|devstral|ministral|mistral[-_.]?(?:7b|nemo|large)/i],
  // OpenAI open-weight text models.
  [/gpt-oss/i],
  // GLM text models — the `v` vision variants are caught above.
  [/glm-4(?:\.[567])?(?:-air|-flash|-plus|-turbo)?(?![\dv])/i],
  [/glm-5(?:\.\d)?(?:-turbo|-air)?(?![\dv])/i],
  // Reasoning/text-only assorted.
  [/nemotron/i],
  [/command[-_.]?r|c4ai/i],
  [/longcat/i],
  [/jamba/i],
  [/fugu/i],
  [/embed|rerank|moderation|whisper|tts/i], // not chat models at all
].map(([re]) => re as RegExp)

/**
 * Models this session has SEEN a provider reject image input for.
 *
 * When a provider answers "this model does not support image input" for a model
 * the tables called 'unknown' (or wrongly called 'yes'), the reactive recovery
 * path records it here so the REST of the session warns proactively instead of
 * burning another request to rediscover the same limit.
 *
 * Keyed by MODEL ID ALONE, deliberately. A provider-scoped key
 * (`providerId\u0000model`) was tried first and is a trap: the writer is the
 * transport, which knows its own `config.providerId`, while the reader resolves
 * the provider from the model string — and when those disagree (a routed
 * subagent, or a provider whose id is not the active one) the entry is written
 * under one key and looked up under another, so the memory silently never hits
 * and every turn pays the failed request again. Vision capability is a property
 * of the model in all but pathological cases, and the per-(provider, model)
 * correction already exists in durable form as `modelSupportsImage`.
 *
 * Not persisted: a provider changing its model lineup should not be permanently
 * pinned by one 400 from months ago.
 */
const sessionTextOnly = new Set<string>()

/**
 * Remember that this model rejected image input, for the rest of this session.
 *
 * `providerId` is accepted for call-site clarity and telemetry symmetry but is
 * deliberately NOT part of the key — see sessionTextOnly.
 */
export function rememberModelRejectedImages(
  providerId: string | undefined,
  model: string,
): void {
  void providerId
  if (!model) return
  sessionTextOnly.add(stripRoutingPrefix(model))
}

/**
 * One-shot notice channel from the transport layer up to the query loop.
 *
 * The adapter that discovers a model is text-only sits far below the UI — it has
 * no access to setMessages and must not grow one. So it records the model here
 * and query.ts drains it right after the request, yielding a `'warning'` system
 * message (the same pattern query.ts already uses for the model-fallback
 * notice). A Set, so a turn that somehow retries twice still warns once.
 */
const pendingImageDropNotices = new Set<string>()

/** Record that the model silently lost its images, for the query loop to report. */
export function notePendingImageDropNotice(model: string): void {
  if (model) pendingImageDropNotices.add(stripRoutingPrefix(model))
}

/**
 * Take and clear any pending notices. Returns the user-facing warning strings,
 * already worded — callers just wrap them in a system message.
 */
export function drainImageDropNotices(): string[] {
  if (pendingImageDropNotices.size === 0) return []
  const out = [...pendingImageDropNotices].map(model =>
    imageDroppedWarning(model, { discoveredFromProvider: true }),
  )
  pendingImageDropNotices.clear()
  return out
}

/** Test seam: drop all runtime-learned corrections. */
export function _resetImageCapabilitySessionCacheForTesting(): void {
  sessionTextOnly.clear()
  pendingImageDropNotices.clear()
}

/**
 * Strip the `providerId\u0000model` cross-provider routing prefix, if present,
 * so the tables match on the bare model id. Mirrors rayuConfig.decodeModelProvider
 * without importing it (this runs on the request path).
 */
function stripRoutingPrefix(model: string): string {
  const nul = model.indexOf('\u0000')
  return nul === -1 ? model : model.slice(nul + 1)
}

/**
 * Match a bare model id against the built-in tables.
 *
 * Exported for tests and for callers that deliberately want the table answer
 * only, with no provider config involved.
 */
export function imageSupportFromModelTables(model: string): ImageSupport {
  const id = stripRoutingPrefix(model)
  if (!id) return 'unknown'
  for (const re of KNOWN_VISION_MODELS) {
    if (re.test(id)) return 'yes'
  }
  for (const re of KNOWN_TEXT_ONLY_MODELS) {
    if (re.test(id)) return 'no'
  }
  return 'unknown'
}

/**
 * Resolve whether the model that will serve this request accepts image input.
 *
 * Precedence, highest first:
 *   1. `provider.modelSupportsImage[model]` — an explicit per-model declaration
 *      from /connect or a hand-edited providers.json. Both directions honoured.
 *   2. Runtime session correction — the provider already rejected an image for
 *      this exact (provider, model) this session.
 *   3. `provider.supportsImage === false` — the provider-wide "endpoint is
 *      text-only" toggle. Negative only, matching its documented semantics.
 *   4. The built-in model tables (vision checked before text-only).
 *   5. 'unknown'.
 *
 * The provider is resolved by resolveRequestShape, so a subagent routed to a
 * DIFFERENT provider via a `providerId\u0000model` prefix is answered for the
 * provider that will actually serve it.
 */
export function resolveImageSupport(model?: string): ImageSupport {
  if (!model) return 'unknown'
  const bare = stripRoutingPrefix(model)

  let provider: { id?: string; supportsImage?: boolean; modelSupportsImage?: Record<string, boolean> } | undefined
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { resolveRequestShape } =
      require('./providerCapabilities.js') as typeof import('./providerCapabilities.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    provider = resolveRequestShape(model).provider
  } catch {
    // Config unavailable (early boot, tests): fall through to the tables.
  }

  const explicit = provider?.modelSupportsImage?.[bare]
  if (typeof explicit === 'boolean') return explicit ? 'yes' : 'no'

  if (sessionTextOnly.has(bare)) return 'no'

  if (provider?.supportsImage === false) return 'no'

  return imageSupportFromModelTables(bare)
}

/**
 * True unless we positively know the model cannot accept images.
 *
 * 'unknown' deliberately answers true — see the module header on why an
 * incomplete table must not block a capable model.
 */
export function modelAcceptsImages(model?: string): boolean {
  return resolveImageSupport(model) !== 'no'
}

/** A content block carrying image data, in the Anthropic IR. */
function isImageBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'image'
  )
}

/** True when any block in this content array is an image. */
export function contentHasImage(content: unknown): boolean {
  return Array.isArray(content) && content.some(isImageBlock)
}

/**
 * Remove image blocks from a content array, returning the original reference
 * when there was nothing to remove (so callers can cheaply detect a no-op).
 */
export function stripImageBlocks<T>(content: T[]): T[] {
  if (!content.some(isImageBlock)) return content
  return content.filter(block => !isImageBlock(block))
}

/**
 * The single user-facing wording for "this model cannot see the image".
 *
 * Shared by the proactive submit-time path and the reactive 400-recovery path so
 * the two cannot drift into describing the same limitation differently. Rendered
 * at `level: 'warning'` (yellow) and, unlike an 'info' system message, shown even
 * when verbose mode is off.
 *
 * States the three things the user needs: the image was NOT sent, the text WAS,
 * and that this is the model's limit rather than a Rayu failure.
 */
export function imageDroppedWarning(
  model: string,
  opts: { discoveredFromProvider?: boolean } = {},
): string {
  const how = opts.discoveredFromProvider
    ? `The provider rejected the image, so "${model}" cannot accept image input.`
    : `The model "${model}" is text-only and cannot accept image input.`
  return (
    `${how} Your image was not sent — the text was sent on its own. ` +
    `This is a limitation of the model, not of Rayu. ` +
    `Run /model to switch to a vision-capable model, or /connect to correct this ` +
    `model's image capability if Rayu has it wrong.`
  )
}
