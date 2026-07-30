import { describe, expect, test } from 'bun:test'
import {
  buildResponsesRequest,
  mapResponsesUsage,
  mapStopReason,
  reasoningItemToSignature,
  toBetaMessage,
  translateInput,
  translateResponsesStream,
} from '../src/services/api/openaiResponsesAdapter.ts'

// The OpenAI Responses adapter: Anthropic Messages IR ⇄ POST /responses.
//
// Shapes follow the OpenAI Responses reference. The invariants these tests pin:
//   • input is a flat ITEM list (message / function_call / function_call_output /
//     reasoning), not a message list with a parallel tool_calls array
//   • tools are FLAT ({type:'function', name, …}), not nested under `function`
//   • usage appears ONLY on response.completed
//   • reasoning items must round-trip so a reasoning model keeps its chain of
//     thought across turns
//   • unknown event types are ignored (forward compatibility)

type AnyObj = Record<string, unknown>

async function collect(events: AnyObj[]): Promise<AnyObj[]> {
  async function* gen() {
    for (const e of events) yield e
  }
  const out: AnyObj[] = []
  for await (const ev of translateResponsesStream(gen(), 'gpt-5.5')) {
    out.push(ev as AnyObj)
  }
  return out
}

describe('request translation', () => {
  test('system → instructions, max_tokens → max_output_tokens, store:false', () => {
    const req = buildResponsesRequest({
      model: 'gpt-5.5',
      system: 'You are Rayu.',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(req.instructions).toBe('You are Rayu.')
    expect(req.max_output_tokens).toBe(4096)
    // PRIVACY: conversation content must never be retained server-side.
    expect(req.store).toBe(false)
    expect(req.model).toBe('gpt-5.5')
  })

  test('system text blocks are flattened', () => {
    const req = buildResponsesRequest({
      model: 'gpt-5.5',
      system: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
      messages: [],
    })
    expect(req.instructions).toBe('line one\nline two')
  })

  test('tools are FLAT function specs (not nested under `function`)', () => {
    const req = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
        // Anthropic SERVER tools have a versioned type and no input_schema —
        // neither OpenAI format can express them, so they are dropped rather
        // than emitted as a phantom callable function.
        { type: 'advisor_20260301' },
      ],
    })
    const tools = req.tools as AnyObj[]
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.name).toBe('Read')
    expect(tools[0]!.function).toBeUndefined()
    // Rayu's schemas are permissive (optional fields, unions), which the
    // Responses strict mode rejects.
    expect(tools[0]!.strict).toBe(false)
  })

  test('thinking maps to reasoning.effort and requests the replayable item', () => {
    const adaptive = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [],
      thinking: { type: 'adaptive' },
    })
    expect((adaptive.reasoning as AnyObj).effort).toBe('medium')
    expect(adaptive.include).toEqual(['reasoning.encrypted_content'])
    // Reasoning models reject an explicit temperature.
    expect('temperature' in adaptive).toBe(false)

    const high = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [],
      thinking: { type: 'enabled', budget_tokens: 32_000 },
    })
    expect((high.reasoning as AnyObj).effort).toBe('high')

    const low = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [],
      thinking: { type: 'enabled', budget_tokens: 1_024 },
    })
    expect((low.reasoning as AnyObj).effort).toBe('low')

    const off = buildResponsesRequest({
      model: 'gpt-4.1',
      messages: [],
      thinking: { type: 'disabled' },
      temperature: 0.7,
    })
    expect(off.reasoning).toBeUndefined()
    expect(off.temperature).toBe(0.7)
  })

  test('tool_choice maps to the Responses vocabulary', () => {
    const mk = (tc: AnyObj) =>
      buildResponsesRequest({ model: 'm', messages: [], tool_choice: tc })
        .tool_choice
    expect(mk({ type: 'auto' })).toBe('auto')
    expect(mk({ type: 'any' })).toBe('required')
    expect(mk({ type: 'none' })).toBe('none')
    expect(mk({ type: 'tool', name: 'Read' })).toEqual({
      type: 'function',
      name: 'Read',
    })
  })

  test('a full tool round-trip becomes ordered input items', () => {
    const input = translateInput({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'read foo.txt' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading it.' },
            { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'foo.txt' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' },
          ],
        },
      ],
    })
    expect(input.map(i => i.type)).toEqual([
      'message', // user turn
      'message', // assistant text
      'function_call', // the tool call
      'function_call_output', // the result, hoisted out of the user message
    ])
    expect(input[2]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'Read',
      arguments: JSON.stringify({ path: 'foo.txt' }),
    })
    expect(input[3]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'file contents',
    })
  })

  test('images become input_image parts', () => {
    const input = translateInput({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
            },
          ],
        },
      ],
    })
    const parts = input[0]!.content as AnyObj[]
    expect(parts[0]).toEqual({ type: 'input_text', text: 'what is this?' })
    expect(parts[1]).toMatchObject({
      type: 'input_image',
      image_url: 'data:image/png;base64,AAA',
    })
  })

  test('a reasoning item round-trips so the model keeps its chain of thought', () => {
    const item = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'opaque-blob',
      summary: [{ type: 'summary_text', text: 'thinking…' }],
    }
    // The adapter parks the item on the thinking block's `signature`, the same
    // channel the Gemini adapter uses for thought_signature.
    const signature = reasoningItemToSignature(item)
    const input = translateInput({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'thinking…', signature },
            { type: 'text', text: 'Hello.' },
          ],
        },
        { role: 'user', content: 'again' },
      ],
    })
    // Reasoning must precede the output it produced.
    expect(input.map(i => i.type)).toEqual([
      'message',
      'reasoning',
      'message',
      'message',
    ])
    expect(input[1]).toEqual(item)
  })

  test('a foreign signature (real Anthropic thinking) is not replayed', () => {
    const input = translateInput({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x', signature: 'EqoBCkgIARABGAI...' },
            { type: 'text', text: 'hi' },
          ],
        },
      ],
    })
    expect(input.map(i => i.type)).toEqual(['message'])
  })
})

describe('non-streaming response translation', () => {
  test('builds an Anthropic message from the output item array', () => {
    const msg = toBetaMessage(
      {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{ type: 'summary_text', text: 'pondering' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello!' }],
          },
          {
            type: 'function_call',
            call_id: 'call_9',
            name: 'Read',
            arguments: '{"path":"a.txt"}',
          },
        ],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens: 7,
        },
      },
      'gpt-5.5',
    )
    expect(msg.role).toBe('assistant')
    const content = msg.content as AnyObj[]
    expect(content[0]).toMatchObject({ type: 'thinking', thinking: 'pondering' })
    expect(content[1]).toEqual({ type: 'text', text: 'Hello!' })
    expect(content[2]).toMatchObject({
      type: 'tool_use',
      id: 'call_9',
      name: 'Read',
      input: { path: 'a.txt' },
    })
    // A tool call ends the turn as tool_use, not end_turn.
    expect(msg.stop_reason).toBe('tool_use')
  })

  test('a refusal is surfaced as text rather than dropped', () => {
    const msg = toBetaMessage(
      {
        id: 'r',
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'refusal', refusal: 'I cannot.' }] },
        ],
      },
      'gpt-5.5',
    )
    expect(msg.content).toEqual([{ type: 'text', text: 'I cannot.' }])
  })

  test('hosted tool calls with no IR equivalent are ignored', () => {
    const msg = toBetaMessage(
      {
        id: 'r',
        status: 'completed',
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'completed' },
          { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
        ],
      },
      'gpt-5.5',
    )
    expect(msg.content).toEqual([{ type: 'text', text: 'done' }])
  })

  test('malformed tool arguments degrade to an empty object', () => {
    const msg = toBetaMessage(
      {
        id: 'r',
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'c', name: 'X', arguments: '{not json' },
        ],
      },
      'gpt-5.5',
    )
    expect((msg.content as AnyObj[])[0]).toMatchObject({ input: {} })
  })
})

describe('usage mapping', () => {
  test('splits the cached prefix out of the total prompt', () => {
    // Responses reports input_tokens as the TOTAL including the cached prefix.
    // Collapsing it all into input_tokens would price the resent conversation at
    // the full input rate on every agentic turn.
    expect(
      mapResponsesUsage({
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 800 },
        output_tokens: 50,
      }),
    ).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 800,
    })
  })

  test('no cache details → the whole prompt is fresh input', () => {
    expect(mapResponsesUsage({ input_tokens: 10, output_tokens: 2 })).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })

  test('missing usage yields zeros rather than NaN', () => {
    expect(mapResponsesUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })

  test('cached_tokens is clamped to the reported total', () => {
    const u = mapResponsesUsage({
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 999 },
      output_tokens: 1,
    })
    expect(u.cache_read_input_tokens).toBe(50)
    expect(u.input_tokens).toBe(0)
  })
})

describe('stop reason mapping', () => {
  test('max_output_tokens becomes max_tokens', () => {
    expect(mapStopReason('incomplete', 'max_output_tokens', false)).toBe('max_tokens')
  })
  test('other incomplete reasons end the turn', () => {
    expect(mapStopReason('incomplete', 'content_filter', false)).toBe('end_turn')
  })
  test('a tool call ends the turn as tool_use', () => {
    expect(mapStopReason('completed', undefined, true)).toBe('tool_use')
  })
})

describe('streaming translation', () => {
  test('plain text produces a well-formed Anthropic event sequence', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hel' },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'lo' },
      { type: 'response.output_text.done', item_id: 'msg_1', text: 'Hello' },
      { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message' } },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ])
    expect(out.map(e => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect((out[0]!.message as AnyObj).id).toBe('resp_1')
    const text = out
      .filter(e => e.type === 'content_block_delta')
      .map(e => ((e.delta as AnyObj).text as string) ?? '')
      .join('')
    expect(text).toBe('Hello')
    // Usage is taken ONLY from response.completed.
    expect((out.at(-2)!.usage as AnyObj).input_tokens).toBe(5)
  })

  test('reasoning + text get separate indexed blocks, and the item is replayable', async () => {
    const reasoningItem = {
      id: 'rs_1',
      type: 'reasoning',
      encrypted_content: 'blob',
      summary: [{ type: 'summary_text', text: 'because' }],
    }
    const out = await collect([
      { type: 'response.created', response: { id: 'resp_2' } },
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        delta: 'because',
      },
      { type: 'response.output_item.done', item: reasoningItem },
      { type: 'response.output_item.added', item: { id: 'msg_2', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'Answer' },
      { type: 'response.output_item.done', item: { id: 'msg_2', type: 'message' } },
      {
        type: 'response.completed',
        response: { id: 'resp_2', status: 'completed', usage: {} },
      },
    ])
    const starts = out.filter(e => e.type === 'content_block_start')
    expect(starts).toHaveLength(2)
    expect((starts[0]!.content_block as AnyObj).type).toBe('thinking')
    expect(starts[0]!.index).toBe(0)
    expect((starts[1]!.content_block as AnyObj).type).toBe('text')
    expect(starts[1]!.index).toBe(1)

    const thinkingDelta = out.find(
      e => (e.delta as AnyObj)?.type === 'thinking_delta',
    )
    expect((thinkingDelta!.delta as AnyObj).thinking).toBe('because')

    // The completed reasoning item rides out on a signature_delta so the next
    // turn can replay it (translateInput reads it back).
    const sig = out.find(e => (e.delta as AnyObj)?.type === 'signature_delta')
    expect(sig).toBeDefined()
    expect(JSON.parse((sig!.delta as AnyObj).signature as string)).toEqual(
      reasoningItem,
    )
  })

  test('parallel tool calls each get their own block and accumulate arguments', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      {
        type: 'response.output_item.added',
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'Read' },
      },
      {
        type: 'response.output_item.added',
        item: { id: 'fc_2', type: 'function_call', call_id: 'call_b', name: 'Grep' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"path":',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_2',
        delta: '{"q":"x"}',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '"a.txt"}',
      },
      { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call' } },
      { type: 'response.output_item.done', item: { id: 'fc_2', type: 'function_call' } },
      { type: 'response.completed', response: { status: 'completed', usage: {} } },
    ])
    const starts = out.filter(e => e.type === 'content_block_start')
    expect(starts.map(s => (s.content_block as AnyObj).name)).toEqual([
      'Read',
      'Grep',
    ])
    // Interleaved deltas must land on the right block.
    const readArgs = out
      .filter(
        e =>
          e.index === 0 && (e.delta as AnyObj)?.type === 'input_json_delta',
      )
      .map(e => (e.delta as AnyObj).partial_json as string)
      .join('')
    expect(readArgs).toBe('{"path":"a.txt"}')
    expect(out.at(-2)!.delta).toMatchObject({ stop_reason: 'tool_use' })
  })

  test('response.incomplete from max_output_tokens becomes max_tokens', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_item.added', item: { id: 'm', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'm', delta: 'trunc' },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
    ])
    expect(out.at(-2)!.delta).toMatchObject({ stop_reason: 'max_tokens' })
    // An unterminated block is still closed so the consumer isn't left hanging.
    expect(out.filter(e => e.type === 'content_block_stop')).toHaveLength(1)
    expect(out.at(-1)!.type).toBe('message_stop')
  })

  test('response.failed raises a normalized Anthropic API error', async () => {
    async function* gen() {
      yield { type: 'response.created', response: { id: 'r' } }
      yield {
        type: 'response.failed',
        response: { error: { code: 'server_error', message: 'upstream exploded' } },
      }
    }
    await expect(
      (async () => {
        for await (const _ of translateResponsesStream(gen(), 'gpt-5.5')) {
          void _
        }
      })(),
    ).rejects.toThrow(/upstream exploded/)
  })

  test('unknown event types are ignored (forward compatibility)', async () => {
    const out = await collect([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.content_part.added', item_id: 'x' },
      { type: 'response.reasoning_summary_part.added', item_id: 'x' },
      { type: 'response.some.future.event', data: { whatever: true } },
      { type: 'response.output_item.added', item: { id: 'm', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'm', delta: 'ok' },
      { type: 'response.output_item.done', item: { id: 'm', type: 'message' } },
      { type: 'response.completed', response: { status: 'completed', usage: {} } },
    ])
    expect(out.map(e => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  test('a stream with no events still terminates correctly', async () => {
    const out = await collect([])
    expect(out.map(e => e.type)).toEqual([
      'message_start',
      'message_delta',
      'message_stop',
    ])
  })
})

describe('registry wiring', () => {
  test('an explicit wireFormat routes a provider to the Responses adapter', async () => {
    const { resolveClientTarget, resolveWireFormat } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    const provider = {
      id: 'my-openai',
      kind: 'openai-compatible' as const,
      wireFormat: 'openai-responses' as const,
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
    }
    expect<string>(resolveWireFormat(provider, 'gpt-5.5')).toBe('openai-responses')
    expect<string>(resolveClientTarget(provider, 'gpt-5.5')).toBe(
      'openai-responses',
    )
    // Without the override the built-in presets stay on /chat/completions.
    const chat = { ...provider, wireFormat: undefined }
    expect<string>(resolveClientTarget(chat, 'gpt-5.5')).toBe('openai-chat')
  })

  test('the built client presents the Anthropic beta.messages.create surface', async () => {
    const { buildClient } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    const client = (await buildClient(
      {
        id: 'my-openai',
        kind: 'openai-compatible',
        wireFormat: 'openai-responses',
        apiKey: 'sk-test',
        baseURL: 'https://api.openai.com/v1',
      },
      { maxRetries: 0, model: 'gpt-5.5' },
    )) as AnyObj
    const beta = client.beta as AnyObj
    const messages = beta.messages as AnyObj
    expect(typeof messages.create).toBe('function')
    // claude.ts calls .withResponse() for streaming and awaits for non-streaming.
    const pending = (messages.create as (p: AnyObj) => AnyObj)({
      model: 'gpt-5.5',
      messages: [],
      max_tokens: 1,
    })
    expect(typeof pending.withResponse).toBe('function')
    expect(typeof pending.then).toBe('function')
  })
})
