// OpenAI Responses API adapter (POST /responses).
//
// Presents the subset of the Anthropic SDK surface that claude.ts uses —
// `client.beta.messages.create(params, opts)` for both the non-streaming case
// (returns a BetaMessage) and the streaming case (`stream:true` →
// `.withResponse()` → { data: AsyncIterable<BetaRawMessageStreamEvent>,
// request_id, response }) — and translates to/from the Responses API.
//
// WHY A SECOND OPENAI ADAPTER
// /responses is a different protocol from /chat/completions, not a variant of it:
//   • input is a flat ITEM list (messages, function_call, function_call_output,
//     reasoning) rather than a message list with a parallel tool_calls array
//   • tools are flat ({type:'function', name, …}) not nested under `function`
//   • output is an ITEM array, so text/tool-calls/reasoning are separate items
//   • streaming uses ~50 semantic SSE event types instead of one delta shape
//   • reasoning models return an opaque `reasoning` item that must be REPLAYED
//     on the next turn or the model loses its chain of thought
// The IR-side parsing both adapters share lives in openaiShared.ts.
//
// Shapes below follow the OpenAI Responses reference. Key invariants used here:
//   - usage appears ONLY on `response.completed`
//   - deltas are additive; the matching `.done` event carries the authoritative
//     final string
//   - unknown event types must be ignored for forward compatibility
//
// SECURITY: `store:false` is always sent so the provider does not retain
// conversation content server-side. The API key is sent only to the configured
// base URL and is never logged.
import OpenAI, {
  APIConnectionError as OpenAIAPIConnectionError,
  APIError as OpenAIAPIError,
} from 'openai'
import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIError as AnthropicAPIError,
} from '@anthropic-ai/sdk/index.js'
import { reportIssue } from 'src/utils/rayuDiagnostics.js'
import { providerAcceptsImages } from 'src/utils/model/providerCapabilities.js'
import {
  blocksToText,
  imageBlockToUrl,
  systemToText,
  thinkingToReasoningEffort,
  toolSpecs,
} from './openaiShared.js'

type AnyObj = Record<string, unknown>

/** The Anthropic beta.messages.create params this adapter consumes. */
type BetaParams = {
  model: string
  max_tokens?: number
  system?: string | Array<{ type: string; text?: string }>
  messages: Array<AnyObj>
  tools?: Array<AnyObj>
  tool_choice?: AnyObj
  temperature?: number
  stream?: boolean
  thinking?: AnyObj
  metadata?: AnyObj
}

export type OpenAIResponsesConfig = {
  apiKey: string
  baseURL: string
  maxRetries?: number
  providerId?: string
  /** Extra default headers (Azure `api-key`, editor headers, …). */
  headers?: Record<string, string>
  /** Custom fetch for dynamic credentials (Azure/OAuth/gateway routing). */
  fetch?: typeof fetch
  /** Azure requires an api-version query parameter on every call. */
  queryParams?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Request translation: Anthropic IR → Responses input items
// ---------------------------------------------------------------------------

/**
 * Reasoning items must be replayed verbatim on subsequent turns so a reasoning
 * model keeps its chain of thought. The IR has nowhere to put an opaque provider
 * blob, so thinking blocks carry it in `signature` — the same channel the Gemini
 * adapter uses for `thought_signature` (see gemini/genaiTranslate.ts).
 */
function reasoningItemFromThinking(block: AnyObj): AnyObj | null {
  const sig = block.signature
  if (typeof sig !== 'string' || !sig) return null
  try {
    const parsed = JSON.parse(sig) as AnyObj
    if (parsed && parsed.type === 'reasoning') return parsed
  } catch {
    // Not one of ours (e.g. a real Anthropic signature) — nothing to replay.
  }
  return null
}

/** Encode a Responses reasoning item into an IR thinking-block signature. */
export function reasoningItemToSignature(item: AnyObj): string {
  return JSON.stringify(item)
}

/** Translate the IR message list into a Responses `input` item array. */
export function translateInput(params: BetaParams): AnyObj[] {
  const input: AnyObj[] = []

  for (const msg of params.messages) {
    const role = msg.role as string
    const content = msg.content

    if (role === 'user') {
      // Tool results are their own items and must NOT stay nested in the user
      // message, so they are hoisted out first.
      const blocks = Array.isArray(content) ? (content as AnyObj[]) : []
      const toolResults = blocks.filter(b => b?.type === 'tool_result')
      for (const tr of toolResults) {
        input.push({
          type: 'function_call_output',
          call_id: String(tr.tool_use_id ?? ''),
          output: toolResultOutput(tr),
        })
      }
      const parts: AnyObj[] = []
      const text = blocksToText(content)
      if (text) parts.push({ type: 'input_text', text })
      // A user-defined provider may declare its endpoint text-only; sending image
      // parts there is a 400, so drop them rather than fail the turn.
      if (providerAcceptsImages(params.model)) {
        for (const b of blocks) {
          const url = imageBlockToUrl(b)
          if (url) parts.push({ type: 'input_image', image_url: url, detail: 'auto' })
        }
      }
      if (parts.length) {
        input.push({ type: 'message', role: 'user', content: parts })
      }
      continue
    }

    if (role === 'assistant') {
      const blocks = Array.isArray(content) ? (content as AnyObj[]) : []
      // Replay reasoning first: the API requires it to precede the output it
      // produced, matching the order the model emitted them.
      for (const b of blocks) {
        if (b?.type !== 'thinking') continue
        const item = reasoningItemFromThinking(b)
        if (item) input.push(item)
      }
      const text = blocksToText(content)
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      for (const b of blocks) {
        if (b?.type !== 'tool_use') continue
        input.push({
          type: 'function_call',
          call_id: String(b.id ?? ''),
          name: String(b.name ?? ''),
          arguments: JSON.stringify(b.input ?? {}),
        })
      }
      continue
    }
  }

  return input
}

/** A tool result's content flattened to the string the API expects. */
function toolResultOutput(block: AnyObj): string {
  const content = block.content
  if (typeof content === 'string') return content
  const text = blocksToText(content)
  if (text) return text
  // Non-text results (images) have no text form; send a stable placeholder so
  // the call is still closed out rather than dropped.
  return Array.isArray(content) && content.length
    ? '[non-text tool result]'
    : ''
}

/** Map an IR tool_choice to the Responses equivalent. */
function translateToolChoice(tc: AnyObj | undefined): unknown {
  if (!tc) return undefined
  switch (tc.type) {
    case 'any':
      return 'required'
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'tool':
      return tc.name
        ? { type: 'function', name: String(tc.name) }
        : 'required'
    default:
      return undefined
  }
}

/** Build the Responses request body from the Anthropic IR. */
export function buildResponsesRequest(params: BetaParams): AnyObj {
  const specs = toolSpecs(params.tools)
  const instructions = systemToText(params.system)
  const effort = thinkingToReasoningEffort(params.thinking)

  const req: AnyObj = {
    model: params.model,
    input: translateInput(params),
    // SECURITY/PRIVACY: never let the provider retain conversation content.
    store: false,
    ...(instructions ? { instructions } : {}),
    ...(params.max_tokens ? { max_output_tokens: params.max_tokens } : {}),
    ...(specs
      ? {
          tools: specs.map(s => ({
            type: 'function',
            name: s.name,
            description: s.description,
            parameters: s.parameters,
            // Responses defaults to strict schemas, which rejects the permissive
            // JSON Schemas Rayu tools use (optional fields, unions).
            strict: false,
          })),
        }
      : {}),
    ...(effort
      ? {
          reasoning: { effort, summary: 'auto' },
          // Needed to get the reasoning item back so it can be replayed.
          include: ['reasoning.encrypted_content'],
        }
      : {}),
  }
  const choice = translateToolChoice(params.tool_choice)
  if (choice !== undefined) req.tool_choice = choice
  // Reasoning models reject an explicit temperature; others accept the IR value.
  if (!effort && typeof params.temperature === 'number') {
    req.temperature = params.temperature
  }
  return req
}

// ---------------------------------------------------------------------------
// Response translation: Responses → Anthropic IR
// ---------------------------------------------------------------------------

/** Map a Responses terminal status to an Anthropic stop_reason. */
export function mapStopReason(
  status: string | undefined,
  incompleteReason: string | undefined,
  sawToolCall: boolean,
): string {
  if (status === 'incomplete') {
    return incompleteReason === 'max_output_tokens' ? 'max_tokens' : 'end_turn'
  }
  if (sawToolCall) return 'tool_use'
  return 'end_turn'
}

/**
 * Map Responses `usage` to the Anthropic usage shape the CLI's cost/context
 * accounting expects, where `input_tokens` is the GENUINELY-NEW (uncached)
 * prompt and cache reads are reported separately.
 *
 * Responses reports `input_tokens` as the TOTAL prompt INCLUDING the cached
 * prefix, with the cached portion under `input_tokens_details.cached_tokens`, so
 * the two are split here. `input_tokens + cache_read_input_tokens` still equals
 * the reported total, so no token is double-counted or lost.
 */
export function mapResponsesUsage(usage: AnyObj | undefined): AnyObj {
  const total = Math.max(0, (usage?.input_tokens as number) ?? 0)
  const output = Math.max(0, (usage?.output_tokens as number) ?? 0)
  const cached = Math.max(
    0,
    ((usage?.input_tokens_details as AnyObj | undefined)
      ?.cached_tokens as number) ?? 0,
  )
  const cacheRead = Math.min(total, cached)
  return {
    input_tokens: Math.max(0, total - cacheRead),
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
  }
}

/** Build a complete Anthropic BetaMessage from a non-streaming Response. */
export function toBetaMessage(response: AnyObj, model: string): AnyObj {
  const content: AnyObj[] = []
  let sawToolCall = false

  for (const item of (response.output as AnyObj[]) ?? []) {
    if (!item || typeof item !== 'object') continue
    switch (item.type) {
      case 'reasoning': {
        const summary = ((item.summary as AnyObj[]) ?? [])
          .map(s => (s?.text as string) ?? '')
          .filter(Boolean)
          .join('\n')
        const inner = ((item.content as AnyObj[]) ?? [])
          .map(s => (s?.text as string) ?? '')
          .filter(Boolean)
          .join('\n')
        const thinking = inner || summary
        // Always emit the block when there is a replayable item, even with no
        // visible text, so the next turn can send the reasoning back.
        content.push({
          type: 'thinking',
          thinking,
          signature: reasoningItemToSignature(item),
        })
        break
      }
      case 'message': {
        for (const part of (item.content as AnyObj[]) ?? []) {
          if (part?.type === 'output_text' && typeof part.text === 'string') {
            content.push({ type: 'text', text: part.text })
          } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
            content.push({ type: 'text', text: part.refusal })
          }
        }
        break
      }
      case 'function_call': {
        sawToolCall = true
        content.push({
          type: 'tool_use',
          id: String(item.call_id ?? item.id ?? ''),
          name: String(item.name ?? ''),
          input: parseArgs(item.arguments),
        })
        break
      }
      default:
        // Hosted tool calls (web_search_call, code_interpreter_call, …) have no
        // IR equivalent; ignore them rather than fabricating content.
        break
    }
  }

  return {
    id: String(response.id ?? 'msg_responses'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(
      response.status as string | undefined,
      ((response.incomplete_details as AnyObj | undefined)?.reason as string) ??
        undefined,
      sawToolCall,
    ),
    stop_sequence: null,
    usage: mapResponsesUsage(response.usage as AnyObj | undefined),
  }
}

function parseArgs(raw: unknown): AnyObj {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as AnyObj) : {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Streaming: Responses SSE events → Anthropic stream events
// ---------------------------------------------------------------------------

/**
 * Translate the Responses event stream into the Anthropic event sequence
 * claude.ts consumes.
 *
 * Content blocks are indexed in the order their items appear, so a reasoning
 * item, the assistant text and each tool call each get their own block index —
 * exactly as the native Anthropic stream would emit them.
 */
export async function* translateResponsesStream(
  events: AsyncIterable<AnyObj>,
  model: string,
): AsyncGenerator<AnyObj> {
  let started = false
  let blockIndex = -1
  /** Responses item_id → the Anthropic block index it maps to. */
  const openBlocks = new Map<string, number>()
  let sawToolCall = false
  let finalUsage: AnyObj | undefined
  let status: string | undefined
  let incompleteReason: string | undefined

  const ensureStart = function* (id: string): Generator<AnyObj> {
    if (started) return
    started = true
    yield {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }
  }

  const closeBlock = function* (itemId: string): Generator<AnyObj> {
    const idx = openBlocks.get(itemId)
    if (idx === undefined) return
    openBlocks.delete(itemId)
    yield { type: 'content_block_stop', index: idx }
  }

  for await (const ev of events) {
    const type = ev?.type
    if (typeof type !== 'string') continue

    switch (type) {
      case 'response.created':
      case 'response.in_progress':
      case 'response.queued': {
        const resp = ev.response as AnyObj | undefined
        yield* ensureStart(String(resp?.id ?? 'msg_responses'))
        break
      }

      case 'response.output_item.added': {
        const item = ev.item as AnyObj | undefined
        if (!item) break
        yield* ensureStart('msg_responses')
        const itemId = String(item.id ?? `item_${blockIndex + 1}`)
        if (item.type === 'reasoning') {
          blockIndex += 1
          openBlocks.set(itemId, blockIndex)
          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '' },
          }
        } else if (item.type === 'message') {
          blockIndex += 1
          openBlocks.set(itemId, blockIndex)
          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          }
        } else if (item.type === 'function_call') {
          sawToolCall = true
          blockIndex += 1
          openBlocks.set(itemId, blockIndex)
          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: String(item.call_id ?? item.id ?? ''),
              name: String(item.name ?? ''),
              input: {},
            },
          }
        }
        break
      }

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const idx = openBlocks.get(String(ev.item_id ?? ''))
        if (idx === undefined) break
        const delta = ev.delta
        if (typeof delta !== 'string' || !delta) break
        yield {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'thinking_delta', thinking: delta },
        }
        break
      }

      case 'response.output_text.delta': {
        const idx = openBlocks.get(String(ev.item_id ?? ''))
        if (idx === undefined) break
        const delta = ev.delta
        if (typeof delta !== 'string' || !delta) break
        yield {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: delta },
        }
        break
      }

      case 'response.function_call_arguments.delta': {
        const idx = openBlocks.get(String(ev.item_id ?? ''))
        if (idx === undefined) break
        const delta = ev.delta
        if (typeof delta !== 'string' || !delta) break
        yield {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: delta },
        }
        break
      }

      case 'response.output_item.done': {
        const item = ev.item as AnyObj | undefined
        const itemId = String(item?.id ?? ev.item_id ?? '')
        // A reasoning item is only replayable once complete, and the signature
        // rides on the thinking block — emit it as a final signature_delta.
        if (item?.type === 'reasoning') {
          const idx = openBlocks.get(itemId)
          if (idx !== undefined) {
            yield {
              type: 'content_block_delta',
              index: idx,
              delta: {
                type: 'signature_delta',
                signature: reasoningItemToSignature(item),
              },
            }
          }
        }
        yield* closeBlock(itemId)
        break
      }

      case 'response.completed':
      case 'response.incomplete': {
        const resp = ev.response as AnyObj | undefined
        status = (resp?.status as string) ?? (type === 'response.incomplete' ? 'incomplete' : 'completed')
        incompleteReason = (resp?.incomplete_details as AnyObj | undefined)
          ?.reason as string | undefined
        // Usage is authoritative ONLY here.
        finalUsage = resp?.usage as AnyObj | undefined
        break
      }

      case 'response.failed':
      case 'error': {
        const resp = ev.response as AnyObj | undefined
        const err = (resp?.error as AnyObj | undefined) ?? (ev as AnyObj)
        const message =
          (err?.message as string) ?? 'OpenAI Responses request failed'
        throw new AnthropicAPIError(
          undefined,
          { error: { message, type: (err?.code as string) ?? 'api_error' } },
          message,
          undefined,
        )
      }

      default:
        // Unknown / forward-compatible events (content_part.added,
        // reasoning_summary_part.added, obfuscation fields, hosted tool events)
        // carry no IR content of their own.
        break
    }
  }

  // Close anything the provider left open (a truncated stream).
  for (const [, idx] of [...openBlocks.entries()]) {
    yield { type: 'content_block_stop', index: idx }
  }
  openBlocks.clear()

  if (!started) {
    yield* ensureStart('msg_responses')
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: mapStopReason(status, incompleteReason, sawToolCall),
      stop_sequence: null,
    },
    usage: mapResponsesUsage(finalUsage),
  }
  yield { type: 'message_stop' }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Normalize an OpenAI SDK error into the Anthropic error the CLI handles. */
function toAnthropicError(e: unknown, model: string, providerId?: string): never {
  if (e instanceof OpenAIAPIConnectionError) {
    throw new AnthropicAPIConnectionError({ message: e.message, cause: e })
  }
  if (e instanceof OpenAIAPIError) {
    reportIssue(
      'openai_responses.request_failed',
      'OpenAI Responses request failed',
      { provider: providerId, model, status: e.status, error: e.message },
    )
    throw new AnthropicAPIError(
      e.status,
      { error: { message: e.message, type: e.name } },
      e.message,
      undefined,
    )
  }
  throw e
}

/**
 * Build a client that speaks the Responses API but presents the Anthropic
 * `beta.messages.create` surface claude.ts depends on.
 */
export function createOpenAIResponsesClient(config: OpenAIResponsesConfig) {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: config.maxRetries ?? 0,
    ...(config.headers ? { defaultHeaders: config.headers } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.queryParams ? { defaultQuery: config.queryParams } : {}),
  })

  async function runNonStreaming(
    req: AnyObj,
    model: string,
    signal?: AbortSignal,
  ): Promise<AnyObj> {
    try {
      const res = (await client.responses.create(
        req as never,
        signal ? { signal } : undefined,
      )) as unknown as AnyObj
      return toBetaMessage(res, model)
    } catch (e) {
      return toAnthropicError(e, model, config.providerId)
    }
  }

  async function runStreaming(
    req: AnyObj,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ data: AsyncIterable<AnyObj>; request_id: string | undefined; response: Response }> {
    try {
      const stream = await client.responses.create(
        { ...req, stream: true } as never,
        signal ? { signal } : undefined,
      )
      const events = stream as unknown as AsyncIterable<AnyObj>
      return {
        data: translateResponsesStream(events, model),
        request_id: undefined,
        // claude.ts only reads headers off this for diagnostics; the SDK's
        // streaming helper does not expose the raw Response.
        response: new Response(null, { status: 200 }),
      }
    } catch (e) {
      return toAnthropicError(e, model, config.providerId)
    }
  }

  function create(params: BetaParams, opts?: AnyObj) {
    const req = buildResponsesRequest(params)
    const signal = opts?.signal as AbortSignal | undefined
    // Lazy hybrid (same contract as the Chat adapter): a thenable whose
    // non-streaming request only fires if awaited, plus withResponse() for the
    // streaming path — so the streaming call site never fires a wasted request.
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
      withResponse: () => runStreaming(req, params.model, signal),
    }
  }

  return {
    beta: { messages: { create } },
    messages: { create },
  }
}
