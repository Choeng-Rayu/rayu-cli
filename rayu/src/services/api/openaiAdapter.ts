// Rayu OpenAI-compatible adapter.
//
// Presents the subset of the Anthropic SDK surface that src/services/api/claude.ts
// uses — `client.beta.messages.create(params, opts)` for both the non-streaming
// case (returns a BetaMessage) and the streaming case (`stream: true` →
// `.withResponse()` → { data: AsyncIterable<BetaRawMessageStreamEvent>,
// request_id, response }) — and translates to/from the OpenAI
// `/chat/completions` API (OpenAI, NVIDIA NIM, OpenRouter, local servers).
//
// SECURITY: the API key is read from the Rayu provider config / env and sent
// only to the user-configured base URL; it is never logged. Translation
// failures are recorded via rayuDiagnostics for later improvement.
import OpenAI, {
  APIConnectionError as OpenAIAPIConnectionError,
  APIError as OpenAIAPIError,
} from 'openai'
import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIError as AnthropicAPIError,
} from '@anthropic-ai/sdk/index.js'
import { reportBug, reportIssue } from 'src/utils/rayuDiagnostics.js'
import { hashPair } from 'src/utils/hash.js'
import type { ProviderFeatureMode } from 'src/utils/rayuConfig.js'

type AnyObj = Record<string, unknown>

/** Minimal shape of the Anthropic beta.messages.create params we consume. */
type BetaParams = {
  model: string
  max_tokens?: number
  system?: string | Array<{ type: string; text?: string }>
  messages: Array<AnyObj>
  tools?: Array<AnyObj>
  tool_choice?: AnyObj
  temperature?: number
  stream?: boolean
  metadata?: AnyObj
}

type BuildOpenAIRequestOptions = {
  promptCacheKey?: boolean
  reasoningEffort?: string
}

// ---------------------------------------------------------------------------
// Request translation: Anthropic → OpenAI chat/completions
// ---------------------------------------------------------------------------

function systemToText(system: BetaParams['system']): string | undefined {
  if (!system) return undefined
  if (typeof system === 'string') return system
  return system
    .map(b => (typeof b === 'string' ? b : (b.text ?? '')))
    .join('\n')
}

function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && (b as AnyObj).type === 'text')
    .map(b => (b as AnyObj).text as string)
    .join('\n')
}

/**
 * Translate one Anthropic image block → an OpenAI `image_url` content part.
 * Supports base64 sources ({type:'base64',media_type,data}) and url sources.
 * Returns null for non-image / unrecognized blocks.
 */
function imageBlockToOpenAI(block: AnyObj): AnyObj | null {
  if (!block || block.type !== 'image') return null
  const src = (block.source as AnyObj) ?? {}
  if (src.type === 'base64' && src.data) {
    const mt = (src.media_type as string) ?? 'image/png'
    return { type: 'image_url', image_url: { url: `data:${mt};base64,${src.data}` } }
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url as string } }
  }
  return null
}

/** Collect OpenAI image_url parts from an Anthropic blocks array. */
function imagePartsFrom(content: unknown): AnyObj[] {
  if (!Array.isArray(content)) return []
  const parts: AnyObj[] = []
  for (const b of content as AnyObj[]) {
    const img = imageBlockToOpenAI(b)
    if (img) parts.push(img)
  }
  return parts
}

/** Translate Anthropic messages[] → OpenAI messages[] (incl tool calls/results). */
function translateMessages(params: BetaParams): AnyObj[] {
  const out: AnyObj[] = []
  const sys = systemToText(params.system)
  if (sys) out.push({ role: 'system', content: sys })

  for (const msg of params.messages) {
    const role = msg.role as string
    const content = msg.content

    if (role === 'assistant') {
      const toolCalls: AnyObj[] = []
      let text = ''
      if (Array.isArray(content)) {
        for (const block of content as AnyObj[]) {
          if (block.type === 'text') text += block.text as string
          else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            })
          }
        }
      } else if (typeof content === 'string') {
        text = content
      }
      // Content must be a STRING (not null). OpenAI/NVIDIA accept null content
      // alongside tool_calls, but Gemini's OpenAI-compatibility layer rejects
      // null fields ("Value is not a string: null") and returns 400 (no body)
      // on every later request once a tool-call turn is in history. '' is valid
      // for all of them.
      const m: AnyObj = {
        role: 'assistant',
        content: text,
      }
      if (toolCalls.length) m.tool_calls = toolCalls
      out.push(m)
      continue
    }

    if (role === 'user') {
      if (Array.isArray(content)) {
        const toolResults = (content as AnyObj[]).filter(
          b => b.type === 'tool_result',
        )
        const others = (content as AnyObj[]).filter(
          b => b.type !== 'tool_result',
        )
        // OpenAI requires `tool` messages to immediately follow the assistant
        // message that made the tool_calls — emit them (contiguously) BEFORE any
        // user text. `tool` role content must be a string, so images returned by
        // a tool are re-emitted as a follow-up user message (below).
        const toolImages: AnyObj[] = []
        for (const tr of toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content:
              typeof tr.content === 'string'
                ? tr.content
                : blocksToText(tr.content),
          })
          toolImages.push(...imagePartsFrom(tr.content))
        }
        if (toolImages.length) {
          out.push({
            role: 'user',
            content: [
              { type: 'text', text: 'Images returned by the previous tool call(s):' },
              ...toolImages,
            ],
          })
        }
        // Remaining user content: use a multimodal array when images are present,
        // otherwise a plain string (keeps simple/text-only providers happy).
        const text = blocksToText(others)
        const images = imagePartsFrom(others)
        if (images.length) {
          const parts: AnyObj[] = []
          if (text) parts.push({ type: 'text', text })
          parts.push(...images)
          out.push({ role: 'user', content: parts })
        } else if (text) {
          out.push({ role: 'user', content: text })
        }
      } else {
        out.push({ role: 'user', content: String(content ?? '') })
      }
      continue
    }

    out.push({ role, content: blocksToText(content) })
  }
  return out
}

/** Translate Anthropic tools[] → OpenAI tools[] (function schema). */
function translateTools(tools?: Array<AnyObj>): AnyObj[] | undefined {
  if (!tools?.length) return undefined
  return tools
    .filter(t => {
      if (!t) return false
      // Already OpenAI-shaped function tools pass through.
      if (t.function) return true
      // Anthropic server tools (advisor, web_search, tool_search, etc.) carry a
      // `type` like 'advisor_20260301' and have no JSON input_schema. They have
      // no OpenAI equivalent — drop them instead of emitting a phantom empty
      // function the model could try to call.
      if (typeof t.type === 'string' && t.type !== 'custom' && !t.input_schema) {
        return false
      }
      return !!t.name
    })
    .map(t => {
      if (t.function) return t // already OpenAI-shaped
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.input_schema ?? { type: 'object', properties: {} },
        },
      }
    })
}

// OpenAI reasoning families (o1/o3/o4/gpt-5) reject `max_tokens` — they require
// `max_completion_tokens`. Matched as a path/segment token so e.g. `gpt-4o`
// (contains no standalone o3/o4) and `llama-3` are unaffected.
const NEEDS_MAX_COMPLETION_RE = /(?:^|[/_-])(o1|o3|o4|gpt-5)(?:[.\-_]|$)/i
// Broader reasoning detection (adds gpt-oss / deepseek-reasoner / *-reasoning /
// *-thinking) used only to drop `temperature`, which reasoning models reject or
// ignore (they allow the default only).
const REASONING_RE =
  /(?:^|[/_-])(o1|o3|o4|gpt-5|gpt-oss)(?:[.\-_]|$)|reason|thinking/i

export function usesMaxCompletionTokens(model: string): boolean {
  return NEEDS_MAX_COMPLETION_RE.test(model)
}
export function isReasoningModel(model: string): boolean {
  return REASONING_RE.test(model)
}

/** Translate Anthropic tool_choice → OpenAI tool_choice. */
function translateToolChoice(tc: AnyObj | undefined): unknown {
  if (!tc) return undefined
  switch (tc.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return tc.name
        ? { type: 'function', function: { name: tc.name } }
        : 'required'
    default:
      return undefined
  }
}

export function buildOpenAIRequest(
  params: BetaParams,
  options: BuildOpenAIRequestOptions = {},
): AnyObj {
  const req: AnyObj = {
    model: params.model,
    messages: translateMessages(params),
  }
  if (typeof params.max_tokens === 'number') {
    if (usesMaxCompletionTokens(params.model)) {
      req.max_completion_tokens = params.max_tokens
    } else {
      req.max_tokens = params.max_tokens
    }
  }
  // Reasoning models only support the default temperature; sending one 400s.
  if (typeof params.temperature === 'number' && !isReasoningModel(params.model)) {
    req.temperature = params.temperature
  }
  const tools = translateTools(params.tools)
  if (tools) {
    req.tools = tools
    const toolChoice = translateToolChoice(params.tool_choice)
    if (toolChoice !== undefined) req.tool_choice = toolChoice
  }
  if (options.promptCacheKey) {
    // Stable cache key for providers with prompt/prefix routing (OpenAI):
    // same system+model -> same key across turns, so the cached prefix is
    // more likely to be reused instead of re-processed.
    req.prompt_cache_key = hashPair(systemToText(params.system) ?? '', params.model)
  }
  if (options.reasoningEffort) {
    req.reasoning_effort = options.reasoningEffort
  }
  return req
}

// ---------------------------------------------------------------------------
// Response translation: OpenAI → Anthropic
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    default:
      return 'end_turn'
  }
}

function mapUsage(usage: AnyObj | undefined): AnyObj {
  return {
    input_tokens: (usage?.prompt_tokens as number) ?? 0,
    output_tokens: (usage?.completion_tokens as number) ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

/** Build a full Anthropic BetaMessage from an OpenAI completion response. */
export function toBetaMessage(completion: AnyObj, model: string): AnyObj {
  const choice = (completion.choices as AnyObj[])?.[0] ?? {}
  const msg = (choice.message as AnyObj) ?? {}
  const content: AnyObj[] = []
  // Reasoning models surface hidden reasoning as `reasoning_content` (DeepSeek)
  // or `reasoning` (Qwen/Doubleword/OpenRouter). Expose it as a thinking block.
  const reasoning = (msg.reasoning_content ?? msg.reasoning) as string | undefined
  if (typeof reasoning === 'string' && reasoning.length) {
    content.push({ type: 'thinking', thinking: reasoning, signature: '' })
  }
  if (msg.content) content.push({ type: 'text', text: msg.content as string })
  let toolCallIdx = 0
  for (const tc of (msg.tool_calls as AnyObj[]) ?? []) {
    const fn = (tc.function as AnyObj) ?? {}
    let input: unknown = {}
    try {
      input = JSON.parse((fn.arguments as string) || '{}')
    } catch (e) {
      reportBug(
        'openai_adapter.tool_args_parse_failed',
        'failed to parse tool_call arguments from provider response',
        { tool: fn.name, error: e instanceof Error ? e.message : String(e) },
      )
    }
    // Some providers (notably Gemini's OpenAI-compat layer) return tool_calls
    // with an empty id; replying with an empty tool_call_id then 400s. Ensure a
    // stable non-empty id so the tool_use/tool_result round-trip is valid.
    const id =
      typeof tc.id === 'string' && tc.id.length > 0
        ? tc.id
        : `call_${Date.now()}_${toolCallIdx}`
    toolCallIdx++
    content.push({ type: 'tool_use', id, name: fn.name, input })
  }
  return {
    id: (completion.id as string) ?? `rayu_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason as string),
    stop_sequence: null,
    usage: mapUsage(completion.usage as AnyObj),
  }
}

// ---------------------------------------------------------------------------
// Streaming translation: OpenAI SSE deltas → Anthropic stream events
// ---------------------------------------------------------------------------

type StreamEvent = { type: string } & AnyObj

export async function* translateStream(
  openaiStream: AsyncIterable<AnyObj>,
  model: string,
): AsyncGenerator<StreamEvent> {
  const messageId = `rayu_${Date.now()}`
  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: mapUsage(undefined),
    },
  }

  let thinkingIndex: number | null = null
  let textIndex: number | null = null
  let finishReason: string | null = null
  let usage: AnyObj | undefined
  const toolIndexByOaIndex = new Map<number, number>()
  let nextIndex = 0

  for await (const chunk of openaiStream) {
    const choice = (chunk.choices as AnyObj[])?.[0]
    if (!choice) {
      if (chunk.usage) usage = chunk.usage as AnyObj
      continue
    }
    const delta = (choice.delta as AnyObj) ?? {}

    // Reasoning (thinking) deltas — emitted before content by reasoning models.
    const reasoning = (delta.reasoning_content ?? delta.reasoning) as
      | string
      | undefined
    if (typeof reasoning === 'string' && reasoning.length) {
      if (thinkingIndex === null) {
        thinkingIndex = nextIndex++
        yield {
          type: 'content_block_start',
          index: thinkingIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      }
    }

    if (typeof delta.content === 'string' && delta.content.length) {
      if (textIndex === null) {
        textIndex = nextIndex++
        yield {
          type: 'content_block_start',
          index: textIndex,
          content_block: { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: delta.content },
      }
    }

    for (const tc of (delta.tool_calls as AnyObj[]) ?? []) {
      // OpenAI streaming identifies a tool call by its stable `index` across
      // deltas; `id`/`name` arrive only in the first chunk. Key on index so
      // later argument-only chunks append to the same block (keying on id
      // would split one call in two and drop the arguments).
      const oaIndex = (tc.index as number) ?? 0
      let index = toolIndexByOaIndex.get(oaIndex)
      if (index === undefined) {
        index = nextIndex++
        toolIndexByOaIndex.set(oaIndex, index)
        const fn = (tc.function as AnyObj) ?? {}
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: (tc.id as string) ?? `call_${oaIndex}`,
            name: (fn.name as string) ?? '',
            input: {},
          },
        }
      }
      const args = ((tc.function as AnyObj)?.arguments as string) ?? ''
      if (args) {
        yield {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: args },
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason as string
    if (chunk.usage) usage = chunk.usage as AnyObj
  }

  if (thinkingIndex !== null) yield { type: 'content_block_stop', index: thinkingIndex }
  if (textIndex !== null) yield { type: 'content_block_stop', index: textIndex }
  for (const index of toolIndexByOaIndex.values()) {
    yield { type: 'content_block_stop', index }
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
    usage: mapUsage(usage),
  }
  yield { type: 'message_stop' }
}

// ---------------------------------------------------------------------------
// Adapter client
// ---------------------------------------------------------------------------

export type OpenAICompatibleConfig = {
  apiKey: string
  baseURL: string
  headers?: Record<string, string>
  maxRetries?: number
  providerId?: string
  promptCacheKey?: ProviderFeatureMode
  reasoningEffort?: ProviderFeatureMode
  streamOptions?: ProviderFeatureMode
  /**
   * Custom fetch passed to the OpenAI SDK. Used for providers whose auth can't
   * be a static apiKey — e.g. Vertex AI, where a fresh OAuth bearer token must
   * be injected per request. When set, clients are cached by providerId+baseURL
   * (not by apiKey) since the credential is dynamic.
   */
  fetch?: typeof fetch
}

type OptionalRequestParam = 'prompt_cache_key' | 'stream_options' | 'reasoning_effort'

const unsupportedOptionalParams = new Map<string, Set<OptionalRequestParam>>()
const clientCache = new Map<
  string,
  ReturnType<typeof createOpenAICompatibleClientUncached>
>()

export function _resetOpenAIAdapterUnsupportedParamCacheForTesting(): void {
  unsupportedOptionalParams.clear()
  clientCache.clear()
}

function providerModelCacheKey(baseURL: string, model: string): string {
  return `${baseURL.replace(/\/+$/, '').toLowerCase()}\n${model}`
}

function isOptionalParamUnsupported(
  baseURL: string,
  model: string,
  param: OptionalRequestParam,
): boolean {
  return unsupportedOptionalParams
    .get(providerModelCacheKey(baseURL, model))
    ?.has(param) ?? false
}

function markOptionalParamUnsupported(
  baseURL: string,
  model: string,
  param: OptionalRequestParam,
): void {
  const key = providerModelCacheKey(baseURL, model)
  const params = unsupportedOptionalParams.get(key) ?? new Set<OptionalRequestParam>()
  params.add(param)
  unsupportedOptionalParams.set(key, params)
}

function isOpenAIHost(
  config: Pick<OpenAICompatibleConfig, 'baseURL' | 'providerId'>,
): boolean {
  if (config.providerId?.toLowerCase() === 'openai') return true
  try {
    return new URL(config.baseURL).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

function providerModeAllows(
  mode: ProviderFeatureMode | undefined,
  autoAllowed: boolean,
): boolean {
  if (mode === 'enabled') return true
  if (mode === 'disabled') return false
  return autoAllowed
}

function shouldUsePromptCacheKey(config: OpenAICompatibleConfig): boolean {
  return providerModeAllows(config.promptCacheKey, isOpenAIHost(config))
}

function shouldUseReasoningEffort(
  config: OpenAICompatibleConfig,
  model: string,
): boolean {
  return providerModeAllows(
    config.reasoningEffort,
    isOpenAIHost(config) && usesMaxCompletionTokens(model),
  )
}

function shouldUseStreamOptions(config: OpenAICompatibleConfig): boolean {
  return providerModeAllows(config.streamOptions, isOpenAIHost(config))
}

function optionalParamsIn(req: AnyObj): OptionalRequestParam[] {
  const params: OptionalRequestParam[] = []
  if ('prompt_cache_key' in req) params.push('prompt_cache_key')
  if ('stream_options' in req) params.push('stream_options')
  if ('reasoning_effort' in req) params.push('reasoning_effort')
  return params
}

function withoutOptionalParams(
  req: AnyObj,
  params: Iterable<OptionalRequestParam>,
): AnyObj {
  const next = { ...req }
  for (const param of params) {
    delete next[param]
  }
  return next
}

function errorText(e: unknown): string {
  const err = e as AnyObj
  const parts = [String(err?.message ?? '')]
  const detail = err?.error
  if (typeof detail === 'string') {
    parts.push(detail)
  } else if (detail && typeof detail === 'object') {
    for (const value of Object.values(detail as AnyObj)) {
      if (typeof value === 'string') parts.push(value)
    }
  }
  return parts.join(' ')
}

function rejectedOptionalParams(
  e: unknown,
  candidates: OptionalRequestParam[],
): Set<OptionalRequestParam> {
  const status = (e as AnyObj)?.status
  const rejected = new Set<OptionalRequestParam>()
  if (status !== 400 || candidates.length === 0) return rejected

  const msg = errorText(e)
  if (/stream_options|include_usage/i.test(msg)) {
    if (candidates.includes('stream_options')) rejected.add('stream_options')
  }
  if (/prompt_cache_key/i.test(msg)) {
    if (candidates.includes('prompt_cache_key')) rejected.add('prompt_cache_key')
  }
  if (/reasoning_effort/i.test(msg)) {
    if (candidates.includes('reasoning_effort')) rejected.add('reasoning_effort')
  }
  if (rejected.size > 0) return rejected

  if (
    /unrecognized|unexpected|unknown|unsupported|invalid.*(param|argument)|extra_forbidden/i.test(
      msg,
    )
  ) {
    for (const param of candidates) rejected.add(param)
  }

  return rejected
}

/** True when the (translated) request carries at least one image part. */
function requestHasImage(req: AnyObj): boolean {
  const msgs = req.messages as AnyObj[] | undefined
  return (
    Array.isArray(msgs) &&
    msgs.some(
      m =>
        Array.isArray(m.content) &&
        (m.content as AnyObj[]).some(p => p?.type === 'image_url'),
    )
  )
}

/**
 * Some vision models (e.g. NVIDIA `llama-3.2-*-vision`) reject a request that
 * carries BOTH tools and an image — NVIDIA NIM returns 400 "The number of image
 * tokens (0) must be the same as the number of images (1)". The agent always
 * sends tools, so pasted/Read images would always fail. Retrying without tools
 * lets the model actually read the image (it just can't call a tool that turn).
 */
function isImageToolConflict(e: unknown, req: AnyObj): boolean {
  if ((e as AnyObj)?.status !== 400 || !req.tools || !requestHasImage(req)) {
    return false
  }
  const msg = String((e as AnyObj)?.message ?? '')
  return /image token|number of images|image.*not.*support|do not support tools|tools?.*not.*support.*(image|vision)|vision.*not.*support.*tool/i.test(
    msg,
  )
}

/** Drop tools/tool_choice for an image-only fallback retry. */
function withoutTools(req: AnyObj): AnyObj {
  const { tools: _tools, tool_choice: _tc, ...rest } = req as AnyObj
  return rest
}

/**
 * Re-shape an error thrown by the OpenAI SDK as the equivalent Anthropic SDK
 * error. The shared retry/error layer (withRetry.ts, errors.ts) recognizes
 * provider 429 / 5xx / connection failures only via `instanceof` checks against
 * @anthropic-ai/sdk classes — without this, OpenAI-path errors never retry and
 * surface with the wrong shape.
 */
function normalizeError(e: unknown): unknown {
  if (e instanceof OpenAIAPIConnectionError) {
    return new AnthropicAPIConnectionError({
      message: e.message,
      cause: (e as { cause?: Error }).cause,
    })
  }
  if (e instanceof OpenAIAPIError) {
    return AnthropicAPIError.generate(
      e.status as number | undefined,
      e.error as object | undefined,
      e.message,
      e.headers as Headers | undefined,
    )
  }
  return e
}

/**
 * Build an object that quacks like the Anthropic SDK client for the call sites
 * in claude.ts. Only `beta.messages.create` is implemented.
 *
 * The SDK's create() returns an APIPromise: awaitable AND carrying a
 * `.withResponse()` method. The streaming call site does
 * `await client.beta.messages.create({stream:true}).withResponse()` while the
 * non-streaming site does `await client.beta.messages.create(params)`. So
 * create() must return synchronously a thenable that also exposes
 * withResponse(); a plain async fn (Promise without withResponse) breaks the
 * streaming path.
 */
export function createOpenAICompatibleClient(config: OpenAICompatibleConfig) {
  const cacheKey = openAIClientCacheKey(config)
  const cached = clientCache.get(cacheKey)
  if (cached) return cached
  const client = createOpenAICompatibleClientUncached(config)
  clientCache.set(cacheKey, client)
  return client
}

function stableHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return ''
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
    ),
  )
}

function openAIClientCacheKey(config: OpenAICompatibleConfig): string {
  return JSON.stringify({
    providerId: config.providerId ?? '',
    baseURL: config.baseURL.replace(/\/+$/, ''),
    // Dynamic-credential clients (custom fetch, e.g. Vertex OAuth) have no
    // stable apiKey to hash, so key them on providerId+baseURL only. Static
    // providers continue to key on the apiKey hash so a key change rebuilds.
    keyHash: config.fetch
      ? 'dynamic'
      : hashPair(config.apiKey || 'unset', 'openai-compatible-client'),
    headers: stableHeaders(config.headers),
    maxRetries: config.maxRetries ?? 2,
    promptCacheKey: config.promptCacheKey ?? 'auto',
    reasoningEffort: config.reasoningEffort ?? 'auto',
    streamOptions: config.streamOptions ?? 'auto',
  })
}

function createOpenAICompatibleClientUncached(config: OpenAICompatibleConfig) {
  const client = new OpenAI({
    apiKey: config.apiKey || 'unset',
    baseURL: config.baseURL,
    // Retry transient 408/409/429/5xx at the SDK level by default. The main
    // query path passes 0 here and retries via withRetry.ts instead (which now
    // recognizes our normalized Anthropic-shaped errors).
    maxRetries: config.maxRetries ?? 2,
    defaultHeaders: config.headers,
    // Dynamic-credential providers (e.g. Vertex OAuth) inject a fresh bearer
    // token via a custom fetch wrapper instead of a static apiKey.
    ...(config.fetch ? { fetch: config.fetch } : {}),
  })

  async function runNonStreaming(
    req: AnyObj,
    model: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const request = { ...req, stream: false }
    try {
      const completion = (await client.chat.completions.create(
        request as never,
        { signal },
      )) as unknown as AnyObj
      return toBetaMessage(completion, model)
    } catch (e) {
      const rejected = rejectedOptionalParams(e, optionalParamsIn(request))
      if (rejected.size > 0) {
        for (const param of rejected) {
          markOptionalParamUnsupported(config.baseURL, model, param)
        }
        try {
          const completion = (await client.chat.completions.create(
            withoutOptionalParams(request, rejected) as never,
            { signal },
          )) as unknown as AnyObj
          return toBetaMessage(completion, model)
        } catch (e2) {
          reportIssue(
            'openai_adapter.request_failed',
            'OpenAI-compatible request failed',
            { model, status: (e2 as AnyObj)?.status, error: e2 instanceof Error ? e2.message : String(e2) },
          )
          throw normalizeError(e2)
        }
      }
      if (isImageToolConflict(e, request)) {
        try {
          const completion = (await client.chat.completions.create(
            withoutTools(request) as never,
            { signal },
          )) as unknown as AnyObj
          return toBetaMessage(completion, model)
        } catch (e2) {
          reportIssue(
            'openai_adapter.request_failed',
            'OpenAI-compatible request failed',
            { model, status: (e2 as AnyObj)?.status, error: e2 instanceof Error ? e2.message : String(e2) },
          )
          throw normalizeError(e2)
        }
      }
      reportIssue(
        'openai_adapter.request_failed',
        'OpenAI-compatible request failed',
        { model, status: (e as AnyObj)?.status, error: e instanceof Error ? e.message : String(e) },
      )
      throw normalizeError(e)
    }
  }

  async function runStreamingWithResponse(
    req: AnyObj,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ data: AsyncGenerator<StreamEvent>; request_id: null; response: Response }> {
    const base = { ...req, stream: true }
    const includeStreamOptions =
      shouldUseStreamOptions(config) &&
      !isOptionalParamUnsupported(config.baseURL, model, 'stream_options')
    const request = includeStreamOptions
      ? { ...base, stream_options: { include_usage: true } }
      : base
    let oaStream: AsyncIterable<AnyObj>
    try {
      oaStream = (await client.chat.completions.create(
        request as never,
        { signal },
      )) as unknown as AsyncIterable<AnyObj>
    } catch (e) {
      const rejected = rejectedOptionalParams(e, optionalParamsIn(request))
      if (rejected.size > 0) {
        for (const param of rejected) {
          markOptionalParamUnsupported(config.baseURL, model, param)
        }
        try {
          oaStream = (await client.chat.completions.create(
            withoutOptionalParams(request, rejected) as never,
            { signal },
          )) as unknown as AsyncIterable<AnyObj>
        } catch (e2) {
          throw normalizeError(e2)
        }
      } else if (isImageToolConflict(e, request)) {
        try {
          oaStream = (await client.chat.completions.create(
            withoutTools(request) as never,
            { signal },
          )) as unknown as AsyncIterable<AnyObj>
        } catch (e2) {
          throw normalizeError(e2)
        }
      } else {
        reportIssue(
          'openai_adapter.stream_failed',
          'OpenAI-compatible streaming request failed',
          {
            model,
            status: (e as AnyObj)?.status,
            error: e instanceof Error ? e.message : String(e),
          },
        )
        throw normalizeError(e)
      }
    }
    return {
      data: translateStream(oaStream, model),
      request_id: null,
      response: new Response(null, { status: 200 }),
    }
  }

  function create(params: BetaParams, opts?: AnyObj): unknown {
    const outputConfig = (params as AnyObj).output_config as AnyObj | undefined
    const effort = outputConfig?.effort as string | undefined
    const hasReasoningEffort =
      !!effort &&
      shouldUseReasoningEffort(config, params.model) &&
      !isOptionalParamUnsupported(
        config.baseURL,
        params.model,
        'reasoning_effort',
      )
    const req = buildOpenAIRequest(params, {
      promptCacheKey:
        shouldUsePromptCacheKey(config) &&
        !isOptionalParamUnsupported(
          config.baseURL,
          params.model,
          'prompt_cache_key',
        ),
      reasoningEffort: hasReasoningEffort
        ? (effort === 'max' ? 'high' : effort)
        : undefined,
    })
    const signal = opts?.signal as AbortSignal | undefined

    // Lazy hybrid: a thenable whose non-streaming request only fires if the
    // caller actually awaits it, plus a withResponse() that runs the streaming
    // path. This avoids firing a wasted non-streaming request on the streaming
    // call site (which only calls .withResponse()).
    return {
      then(
        onFulfilled?: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) {
        return runNonStreaming(req, params.model, signal).then(
          onFulfilled,
          onRejected,
        )
      },
      catch(onRejected?: (e: unknown) => unknown) {
        return runNonStreaming(req, params.model, signal).catch(onRejected)
      },
      withResponse: () => runStreamingWithResponse(req, params.model, signal),
    }
  }

  return {
    beta: { messages: { create } },
    messages: { create },
  }
}
