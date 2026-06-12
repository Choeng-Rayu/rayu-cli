// Rayu AWS Bedrock Converse adapter.
//
// Presents the subset of the Anthropic SDK surface that src/services/api/claude.ts
// uses — `client.beta.messages.create(params, opts)` for both the non-streaming
// case (returns a BetaMessage) and the streaming case (`stream: true` →
// `.withResponse()` → { data: AsyncIterable<BetaRawMessageStreamEvent>,
// request_id, response }) — and translates to/from the AWS Bedrock Converse /
// ConverseStream API via @aws-sdk/client-bedrock-runtime.
//
// Why Converse: it is model-agnostic across ALL Bedrock models (Claude, Kimi,
// DeepSeek, GLM, …) and natively separates reasoning (`reasoningContent`) from
// text and returns structured `toolUse` blocks — unlike the OpenAI-compatible
// Bedrock surface, which leaks some open-weight models' native reasoning/tool
// token formats. The AWS SDK handles SigV4 / bearer-token auth and the AWS
// event-stream framing, so this adapter only does Anthropic ↔ Converse mapping.
//
// SECURITY: the Bedrock API key / AWS credentials are read from the provider
// config / env by createBedrockRuntimeClient and are never logged here.
import {
  APIError as AnthropicAPIError,
  APIConnectionError as AnthropicAPIConnectionError,
} from '@anthropic-ai/sdk/index.js'
import { createBedrockRuntimeClient } from 'src/utils/model/bedrock.js'
import { reportIssue } from 'src/utils/rayuDiagnostics.js'

type AnyObj = Record<string, unknown>

type BetaParams = {
  model: string
  max_tokens?: number
  system?: string | Array<{ type: string; text?: string }>
  messages: Array<AnyObj>
  tools?: Array<AnyObj>
  tool_choice?: AnyObj
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  thinking?: { type?: string; budget_tokens?: number }
}

export type BedrockConverseConfig = {
  /** Bedrock API key (bearer token). Optional — falls back to AWS credentials. */
  apiKey?: string
  /** AWS region (e.g. us-east-1). */
  region?: string
  maxRetries?: number
}

// ---------------------------------------------------------------------------
// Request translation: Anthropic → Converse
// ---------------------------------------------------------------------------

function systemToConverse(system: BetaParams['system']): AnyObj[] | undefined {
  if (!system) return undefined
  const text =
    typeof system === 'string'
      ? system
      : system.map(b => (typeof b === 'string' ? b : (b.text ?? ''))).join('\n')
  return text ? [{ text }] : undefined
}

/** Map an Anthropic media_type to a Converse image `format`. */
function imageFormat(mediaType: string | undefined): string {
  const mt = (mediaType ?? 'image/png').toLowerCase()
  if (mt.includes('jpeg') || mt.includes('jpg')) return 'jpeg'
  if (mt.includes('gif')) return 'gif'
  if (mt.includes('webp')) return 'webp'
  return 'png'
}

/** An Anthropic base64 image block → a Converse image content block. */
function imageBlockToConverse(block: AnyObj): AnyObj | null {
  if (!block || block.type !== 'image') return null
  const src = (block.source as AnyObj) ?? {}
  if (src.type === 'base64' && typeof src.data === 'string') {
    return {
      image: {
        format: imageFormat(src.media_type as string),
        source: { bytes: Buffer.from(src.data, 'base64') },
      },
    }
  }
  return null
}

/** Anthropic tool_result.content → Converse toolResult.content items. */
function toolResultContent(content: unknown): AnyObj[] {
  if (typeof content === 'string') return [{ text: content }]
  if (!Array.isArray(content)) return [{ text: '' }]
  const out: AnyObj[] = []
  for (const item of content as AnyObj[]) {
    if (item?.type === 'text' && typeof item.text === 'string') out.push({ text: item.text })
    else {
      const img = imageBlockToConverse(item)
      if (img) out.push(img)
    }
  }
  return out.length ? out : [{ text: '' }]
}

/**
 * Translate Anthropic messages[] → Converse messages[]. tool_result blocks live
 * in Anthropic USER messages and map to Converse user `toolResult` blocks; the
 * assistant `thinking` block maps to `reasoningContent`, `tool_use` to `toolUse`.
 */
function toConverseMessages(messages: BetaParams['messages']): AnyObj[] {
  const out: AnyObj[] = []
  for (const msg of messages) {
    const role = msg.role as string
    const content = msg.content
    const blocks: AnyObj[] = []

    if (typeof content === 'string') {
      if (content) blocks.push({ text: content })
    } else if (Array.isArray(content)) {
      for (const b of content as AnyObj[]) {
        if (b.type === 'text' && b.text) {
          blocks.push({ text: b.text as string })
        } else if (b.type === 'thinking' && b.thinking) {
          blocks.push({
            reasoningContent: {
              reasoningText: {
                text: b.thinking as string,
                ...(typeof b.signature === 'string' && b.signature
                  ? { signature: b.signature }
                  : {}),
              },
            },
          })
        } else if (b.type === 'tool_use') {
          blocks.push({
            toolUse: { toolUseId: b.id, name: b.name, input: b.input ?? {} },
          })
        } else if (b.type === 'tool_result') {
          blocks.push({
            toolResult: {
              toolUseId: b.tool_use_id,
              content: toolResultContent(b.content),
              status: b.is_error ? 'error' : 'success',
            },
          })
        } else {
          const img = imageBlockToConverse(b)
          if (img) blocks.push(img)
        }
      }
    }

    if (blocks.length === 0) continue
    // Converse roles are 'user' | 'assistant'. Anthropic only emits those two.
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content: blocks })
  }
  return out
}

/** Anthropic tools[] → Converse toolConfig.tools[] (drop server tools w/o schema). */
function toConverseTools(tools?: Array<AnyObj>): AnyObj[] | undefined {
  if (!tools?.length) return undefined
  const specs = tools
    .filter(t => {
      if (!t) return false
      // Anthropic server tools (web_search, etc.) carry a `type` and no
      // input_schema — no Converse equivalent, drop them.
      if (typeof t.type === 'string' && t.type !== 'custom' && !t.input_schema) return false
      return !!t.name
    })
    .map(t => ({
      toolSpec: {
        name: t.name,
        description: (t.description as string) ?? '',
        inputSchema: { json: t.input_schema ?? { type: 'object', properties: {} } },
      },
    }))
  return specs.length ? specs : undefined
}

function toConverseToolChoice(tc: AnyObj | undefined): AnyObj | undefined {
  if (!tc) return undefined
  switch (tc.type) {
    case 'auto':
      return { auto: {} }
    case 'any':
      return { any: {} }
    case 'tool':
      return tc.name ? { tool: { name: tc.name } } : { any: {} }
    default:
      return undefined // 'none' has no Converse equivalent — omit
  }
}

/** True when the model id is a Claude/Anthropic model (extended-thinking param). */
function isClaudeModel(model: string): boolean {
  return /claude|anthropic/i.test(model)
}

/** Build the Converse request body (without modelId-derived transport bits). */
export function toConverseInput(
  params: BetaParams,
  opts: { includeReasoningConfig?: boolean } = {},
): AnyObj {
  const messages = toConverseMessages(params.messages)
  const system = systemToConverse(params.system)
  const tools = toConverseTools(params.tools)
  const toolChoice =
    params.tool_choice?.type === 'none' ? undefined : toConverseToolChoice(params.tool_choice)

  const inferenceConfig: AnyObj = {}
  if (typeof params.max_tokens === 'number') inferenceConfig.maxTokens = params.max_tokens
  if (typeof params.temperature === 'number') inferenceConfig.temperature = params.temperature
  if (typeof params.top_p === 'number') inferenceConfig.topP = params.top_p
  if (params.stop_sequences?.length) inferenceConfig.stopSequences = params.stop_sequences

  const input: AnyObj = {
    modelId: params.model,
    messages,
    ...(system ? { system } : {}),
    ...(Object.keys(inferenceConfig).length ? { inferenceConfig } : {}),
    ...(tools ? { toolConfig: { tools, ...(toolChoice ? { toolChoice } : {}) } } : {}),
  }

  // Extended thinking: Claude on Bedrock Converse takes a model-specific
  // `reasoning_config` via additionalModelRequestFields. Non-Claude reasoning
  // models (Kimi K2 Thinking, DeepSeek-R1, …) emit reasoningContent by default,
  // so we don't send the field for them (avoids ValidationException). The
  // includeReasoningConfig flag lets the caller retry without it on a 400.
  const wantThinking = !!params.thinking && params.thinking.type !== 'disabled'
  if (opts.includeReasoningConfig && wantThinking && isClaudeModel(params.model)) {
    const max = params.max_tokens ?? 8192
    const budget = params.thinking?.budget_tokens ?? 4096
    input.additionalModelRequestFields = {
      reasoning_config: {
        type: 'enabled',
        budget_tokens: Math.max(1024, Math.min(budget, max - 1)),
      },
    }
  }
  return input
}

// ---------------------------------------------------------------------------
// Response translation: Converse → Anthropic
// ---------------------------------------------------------------------------

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens'
    case 'tool_use':
      return 'tool_use'
    case 'stop_sequence':
      return 'stop_sequence'
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

function mapUsage(usage: AnyObj | undefined): AnyObj {
  return {
    input_tokens: (usage?.inputTokens as number) ?? 0,
    output_tokens: (usage?.outputTokens as number) ?? 0,
    cache_creation_input_tokens: (usage?.cacheWriteInputTokens as number) ?? 0,
    cache_read_input_tokens: (usage?.cacheReadInputTokens as number) ?? 0,
  }
}

/** Build an Anthropic BetaMessage from a non-streaming Converse response. */
export function toBetaMessageFromConverse(response: AnyObj, model: string): AnyObj {
  const output = (response.output as AnyObj) ?? {}
  const message = (output.message as AnyObj) ?? {}
  const blocks = (message.content as AnyObj[]) ?? []
  const content: AnyObj[] = []
  for (const block of blocks) {
    if (block.reasoningContent) {
      const rt = ((block.reasoningContent as AnyObj).reasoningText as AnyObj) ?? {}
      if (typeof rt.text === 'string' && rt.text.length) {
        content.push({
          type: 'thinking',
          thinking: rt.text,
          signature: (rt.signature as string) ?? '',
        })
      }
    } else if (typeof block.text === 'string' && block.text.length) {
      content.push({ type: 'text', text: block.text })
    } else if (block.toolUse) {
      const tu = block.toolUse as AnyObj
      content.push({ type: 'tool_use', id: tu.toolUseId, name: tu.name, input: tu.input ?? {} })
    }
  }
  return {
    id: `rayu_bedrock_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(response.stopReason as string),
    stop_sequence: null,
    usage: mapUsage(response.usage as AnyObj),
  }
}

type StreamEvent = { type: string } & AnyObj

/** Translate a Converse stream (AWS SDK events) → Anthropic stream events. */
export async function* translateConverseStream(
  stream: AsyncIterable<AnyObj>,
  model: string,
): AsyncGenerator<StreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: `rayu_bedrock_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }

  // Converse carries its own contentBlockIndex per block; reuse it as the
  // Anthropic index. Text/reasoning blocks have no explicit start event, so we
  // open them lazily on the first delta; tool_use blocks open on contentBlockStart.
  const started = new Set<number>()
  const blockType = new Map<number, 'text' | 'thinking' | 'tool_use'>()
  let stopReason = 'end_turn'
  let usage: AnyObj = { input_tokens: 0, output_tokens: 0 }

  const ensureStart = function* (index: number, type: 'text' | 'thinking' | 'tool_use', toolUse?: AnyObj): Generator<StreamEvent> {
    if (started.has(index)) return
    started.add(index)
    blockType.set(index, type)
    const content_block =
      type === 'tool_use'
        ? { type: 'tool_use', id: toolUse?.toolUseId, name: toolUse?.name, input: {} }
        : type === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' }
    yield { type: 'content_block_start', index, content_block }
  }

  for await (const event of stream) {
    if (event.contentBlockStart) {
      const cb = event.contentBlockStart as AnyObj
      const index = (cb.contentBlockIndex as number) ?? 0
      const tu = (cb.start as AnyObj)?.toolUse as AnyObj | undefined
      if (tu) yield* ensureStart(index, 'tool_use', tu)
      continue
    }

    if (event.contentBlockDelta) {
      const cbd = event.contentBlockDelta as AnyObj
      const index = (cbd.contentBlockIndex as number) ?? 0
      const delta = (cbd.delta as AnyObj) ?? {}

      const reasoning = delta.reasoningContent as AnyObj | undefined
      if (reasoning && (typeof reasoning.text === 'string' || typeof reasoning.signature === 'string')) {
        yield* ensureStart(index, 'thinking')
        if (typeof reasoning.text === 'string' && reasoning.text.length) {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: reasoning.text },
          }
        }
        if (typeof reasoning.signature === 'string' && reasoning.signature.length) {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'signature_delta', signature: reasoning.signature },
          }
        }
        continue
      }

      if (typeof delta.text === 'string' && delta.text.length) {
        yield* ensureStart(index, 'text')
        yield {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: delta.text },
        }
        continue
      }

      const toolUse = delta.toolUse as AnyObj | undefined
      if (toolUse && typeof toolUse.input === 'string') {
        // The block was opened by contentBlockStart; stream its partial JSON.
        if (!started.has(index)) yield* ensureStart(index, 'tool_use', {})
        yield {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: toolUse.input },
        }
      }
      continue
    }

    if (event.contentBlockStop) {
      const index = ((event.contentBlockStop as AnyObj).contentBlockIndex as number) ?? 0
      if (started.has(index)) yield { type: 'content_block_stop', index }
      continue
    }

    if (event.messageStop) {
      stopReason = mapStopReason((event.messageStop as AnyObj).stopReason as string)
      continue
    }

    if (event.metadata) {
      usage = mapUsage((event.metadata as AnyObj).usage as AnyObj)
      continue
    }

    // Stream-time exceptions surfaced as event members.
    const exception =
      (event.internalServerException as AnyObj) ??
      (event.modelStreamErrorException as AnyObj) ??
      (event.throttlingException as AnyObj) ??
      (event.validationException as AnyObj) ??
      (event.serviceUnavailableException as AnyObj)
    if (exception) {
      throw new Error((exception.message as string) ?? 'Bedrock Converse stream error')
    }
  }

  // Close any blocks that never received an explicit contentBlockStop.
  for (const index of started) {
    yield { type: 'content_block_stop', index }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  }
  yield { type: 'message_stop' }
}

// ---------------------------------------------------------------------------
// Error normalization (AWS SDK error → Anthropic-shaped, so withRetry.ts treats
// 429/5xx/connection failures uniformly with the other providers).
// ---------------------------------------------------------------------------

function normalizeError(e: unknown): unknown {
  const err = e as AnyObj
  const status = (err?.$metadata as AnyObj)?.httpStatusCode as number | undefined
  const name = err?.name as string | undefined
  if (name === 'TimeoutError' || /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(String(err?.message ?? ''))) {
    return new AnthropicAPIConnectionError({
      message: String(err?.message ?? 'connection error'),
      cause: e as Error,
    })
  }
  if (typeof status === 'number') {
    return AnthropicAPIError.generate(status, { error: err }, String(err?.message ?? ''), undefined)
  }
  return e
}

/** A 400 that means our optional reasoning_config field wasn't accepted. */
function isReasoningFieldRejection(e: unknown): boolean {
  const err = e as AnyObj
  const status = (err?.$metadata as AnyObj)?.httpStatusCode as number | undefined
  const msg = String(err?.message ?? '')
  return (
    (status === 400 || err?.name === 'ValidationException') &&
    /reasoning_config|additionalModelRequestFields|reasoning|unsupported|unknown|unexpected/i.test(msg)
  )
}

// ---------------------------------------------------------------------------
// Adapter client (quacks like the Anthropic SDK client for claude.ts)
// ---------------------------------------------------------------------------

const clientCache = new Map<string, ReturnType<typeof createBedrockConverseClientUncached>>()

export function createBedrockConverseClient(config: BedrockConverseConfig) {
  const key = JSON.stringify({ region: config.region ?? '', hasKey: !!config.apiKey, maxRetries: config.maxRetries ?? 2 })
  const cached = clientCache.get(key)
  if (cached) return cached
  const client = createBedrockConverseClientUncached(config)
  clientCache.set(key, client)
  return client
}

export function _resetBedrockConverseClientCacheForTesting(): void {
  clientCache.clear()
}

function createBedrockConverseClientUncached(config: BedrockConverseConfig) {
  // Lazily build (and reuse) the AWS SDK runtime client.
  let runtimePromise: Promise<unknown> | undefined
  const getRuntime = () => {
    if (!runtimePromise) {
      runtimePromise = createBedrockRuntimeClient({ region: config.region, apiKey: config.apiKey })
    }
    return runtimePromise
  }

  async function send(commandName: 'Converse' | 'ConverseStream', params: BetaParams, signal?: AbortSignal): Promise<AnyObj> {
    const runtime = (await getRuntime()) as { send: (cmd: unknown, opts?: AnyObj) => Promise<AnyObj> }
    const sdk = (await import('@aws-sdk/client-bedrock-runtime')) as AnyObj
    const Command = sdk[`${commandName}Command`] as new (input: AnyObj) => unknown
    const sendOnce = (includeReasoningConfig: boolean) => {
      const input = toConverseInput(params, { includeReasoningConfig })
      return runtime.send(new Command(input), signal ? { abortSignal: signal } : undefined)
    }
    try {
      return await sendOnce(true)
    } catch (e) {
      if (isReasoningFieldRejection(e)) {
        // Retry without the optional reasoning_config field.
        try {
          return await sendOnce(false)
        } catch (e2) {
          reportIssue('bedrock_converse.request_failed', 'Bedrock Converse request failed', {
            model: params.model,
            error: e2 instanceof Error ? e2.message : String(e2),
          })
          throw normalizeError(e2)
        }
      }
      reportIssue('bedrock_converse.request_failed', 'Bedrock Converse request failed', {
        model: params.model,
        error: e instanceof Error ? e.message : String(e),
      })
      throw normalizeError(e)
    }
  }

  async function runNonStreaming(params: BetaParams, signal?: AbortSignal): Promise<unknown> {
    const response = await send('Converse', params, signal)
    return toBetaMessageFromConverse(response, params.model)
  }

  async function runStreamingWithResponse(
    params: BetaParams,
    signal?: AbortSignal,
  ): Promise<{ data: AsyncGenerator<StreamEvent>; request_id: null; response: Response }> {
    const response = await send('ConverseStream', params, signal)
    const stream = (response.stream as AsyncIterable<AnyObj>) ?? (async function* () {})()
    return {
      data: translateConverseStream(stream, params.model),
      request_id: null,
      response: new Response(null, { status: 200 }),
    }
  }

  function create(params: BetaParams, opts?: AnyObj): unknown {
    const signal = opts?.signal as AbortSignal | undefined
    return {
      then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return runNonStreaming(params, signal).then(onFulfilled, onRejected)
      },
      catch(onRejected?: (e: unknown) => unknown) {
        return runNonStreaming(params, signal).catch(onRejected)
      },
      withResponse: () => runStreamingWithResponse(params, signal),
    }
  }

  return {
    beta: { messages: { create } },
    messages: { create },
  }
}
