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
import OpenAI from 'openai'
import { reportBug, reportIssue } from 'src/utils/rayuDiagnostics.js'

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
      const m: AnyObj = { role: 'assistant', content: text || null }
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
        const text = blocksToText(others)
        if (text) out.push({ role: 'user', content: text })
        for (const tr of toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content:
              typeof tr.content === 'string'
                ? tr.content
                : blocksToText(tr.content),
          })
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
    .filter(t => t && (t.name || t.function))
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

export function buildOpenAIRequest(params: BetaParams): AnyObj {
  const req: AnyObj = {
    model: params.model,
    messages: translateMessages(params),
    max_tokens: params.max_tokens,
  }
  if (typeof params.temperature === 'number') req.temperature = params.temperature
  const tools = translateTools(params.tools)
  if (tools) req.tools = tools
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
  if (msg.content) content.push({ type: 'text', text: msg.content as string })
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
    content.push({ type: 'tool_use', id: tc.id, name: fn.name, input })
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

  let textOpen = false
  let finishReason: string | null = null
  let usage: AnyObj | undefined
  const toolIndexByOaIndex = new Map<number, number>()
  let nextIndex = 1

  for await (const chunk of openaiStream) {
    const choice = (chunk.choices as AnyObj[])?.[0]
    if (!choice) {
      if (chunk.usage) usage = chunk.usage as AnyObj
      continue
    }
    const delta = (choice.delta as AnyObj) ?? {}

    if (typeof delta.content === 'string' && delta.content.length) {
      if (!textOpen) {
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }
        textOpen = true
      }
      yield {
        type: 'content_block_delta',
        index: 0,
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

  if (textOpen) yield { type: 'content_block_stop', index: 0 }
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
  const client = new OpenAI({
    apiKey: config.apiKey || 'unset',
    baseURL: config.baseURL,
    maxRetries: config.maxRetries ?? 0,
    defaultHeaders: config.headers,
  })

  async function runNonStreaming(
    req: AnyObj,
    model: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      const completion = (await client.chat.completions.create(
        { ...req, stream: false } as never,
        { signal },
      )) as unknown as AnyObj
      return toBetaMessage(completion, model)
    } catch (e) {
      reportIssue(
        'openai_adapter.request_failed',
        'OpenAI-compatible request failed',
        { model, error: e instanceof Error ? e.message : String(e) },
      )
      throw e
    }
  }

  async function runStreamingWithResponse(
    req: AnyObj,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ data: AsyncGenerator<StreamEvent>; request_id: null; response: Response }> {
    const oaStream = (await client.chat.completions.create(
      { ...req, stream: true, stream_options: { include_usage: true } } as never,
      { signal },
    )) as unknown as AsyncIterable<AnyObj>
    return {
      data: translateStream(oaStream, model),
      request_id: null,
      response: new Response(null, { status: 200 }),
    }
  }

  function create(params: BetaParams, opts?: AnyObj): unknown {
    const req = buildOpenAIRequest(params)
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
