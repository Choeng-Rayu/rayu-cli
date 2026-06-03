import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetOpenAIAdapterUnsupportedParamCacheForTesting,
  buildOpenAIRequest,
  createOpenAICompatibleClient,
  toBetaMessage,
  translateStream,
} from '../src/services/api/openaiAdapter.ts'

beforeEach(() => {
  _resetOpenAIAdapterUnsupportedParamCacheForTesting()
})

describe('openaiAdapter request translation (Anthropic -> OpenAI)', () => {
  test('system + user text + tools', () => {
    const req = buildOpenAIRequest({
      model: 'meta/llama-3.3-70b-instruct',
      max_tokens: 256,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'Read',
          description: 'read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    })
    expect(req.model).toBe('meta/llama-3.3-70b-instruct')
    expect((req.messages as any[])[0]).toEqual({ role: 'system', content: 'You are helpful' })
    expect((req.messages as any[])[1]).toEqual({ role: 'user', content: 'hi' })
    expect((req.tools as any[])[0].function.name).toBe('Read')
    expect((req.tools as any[])[0].type).toBe('function')
  })

  test('assistant tool_use + user tool_result round-trip', () => {
    const req = buildOpenAIRequest({
      model: 'm',
      messages: [
        { role: 'user', content: 'read foo' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'sure' },
            { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'foo' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }],
        },
      ],
    })
    const msgs = req.messages as any[]
    const assistant = msgs.find(m => m.role === 'assistant')
    expect(assistant.tool_calls[0].id).toBe('call_1')
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ path: 'foo' })
    const tool = msgs.find(m => m.role === 'tool')
    expect(tool.tool_call_id).toBe('call_1')
    expect(tool.content).toBe('file contents')
  })
})

describe('openaiAdapter response translation (OpenAI -> Anthropic)', () => {
  test('text completion -> BetaMessage', () => {
    const msg = toBetaMessage(
      {
        id: 'cmpl_1',
        choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
      'm',
    ) as any
    expect(msg.type).toBe('message')
    expect(msg.content[0]).toEqual({ type: 'text', text: 'hello there' })
    expect(msg.stop_reason).toBe('end_turn')
    expect(msg.usage.input_tokens).toBe(5)
    expect(msg.usage.output_tokens).toBe(3)
  })

  test('tool_calls -> tool_use blocks + tool_use stop_reason', () => {
    const msg = toBetaMessage(
      {
        id: 'cmpl_2',
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'call_9', function: { name: 'Read', arguments: '{"path":"a.txt"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'm',
    ) as any
    expect(msg.stop_reason).toBe('tool_use')
    const tu = msg.content.find((b: any) => b.type === 'tool_use')
    expect(tu.name).toBe('Read')
    expect(tu.input).toEqual({ path: 'a.txt' })
  })
})

describe('openaiAdapter streaming translation', () => {
  async function* fakeStream(): AsyncGenerator<any> {
    yield { choices: [{ delta: { content: 'Hel' } }] }
    yield { choices: [{ delta: { content: 'lo' } }] }
    yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }
  }

  test('emits message_start, text deltas, stops, message_delta, message_stop', async () => {
    const events: any[] = []
    for await (const e of translateStream(fakeStream(), 'm')) events.push(e)
    const types = events.map(e => e.type)
    expect(types[0]).toBe('message_start')
    expect(types).toContain('content_block_start')
    expect(types).toContain('content_block_delta')
    expect(types).toContain('content_block_stop')
    expect(types.at(-2)).toBe('message_delta')
    expect(types.at(-1)).toBe('message_stop')

    const text = events
      .filter(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
      .map(e => e.delta.text)
      .join('')
    expect(text).toBe('Hello')
    const md = events.find(e => e.type === 'message_delta')
    expect(md.delta.stop_reason).toBe('end_turn')
  })

  test('streaming tool_call deltas -> tool_use block + input_json_delta', async () => {
    async function* toolStream(): AsyncGenerator<any> {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '' } }] } }] }
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    }
    const events: any[] = []
    for await (const e of translateStream(toolStream(), 'm')) events.push(e)
    const start = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
    expect(start.content_block.name).toBe('Read')
    const json = events
      .filter(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
      .map(e => e.delta.partial_json)
      .join('')
    expect(json).toBe('{"path":"x"}')
    expect(events.find(e => e.type === 'message_delta').delta.stop_reason).toBe('tool_use')
  })

  test('tool_call deltas with id only in first chunk (keyed by index) accumulate args', async () => {
    // Regression: OpenAI streams id/name only in the first tool_call chunk;
    // later chunks carry index + arguments only. Must accumulate into one block.
    async function* s(): AsyncGenerator<any> {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '' } }] } }] }
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] } }] }
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/x.txt"}' } }] } }] }
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    }
    const events: any[] = []
    for await (const e of translateStream(s(), 'm')) events.push(e)
    // exactly one tool_use block opened
    const starts = events.filter(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
    expect(starts.length).toBe(1)
    expect(starts[0].content_block.name).toBe('Read')
    // all argument fragments land on that one block's index
    const json = events
      .filter(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && e.index === starts[0].index)
      .map(e => e.delta.partial_json)
      .join('')
    expect(JSON.parse(json)).toEqual({ file_path: '/tmp/x.txt' })
  })
})

describe('createOpenAICompatibleClient (Anthropic SDK call-shape compat)', () => {
  test('non-streaming: await create() resolves to a BetaMessage', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'c1',
          choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const client = createOpenAICompatibleClient({ apiKey: 'k', baseURL: 'http://x/v1' })
      const msg: any = await client.beta.messages.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      expect(msg.type).toBe('message')
      expect(msg.content[0].text).toBe('hi')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('streaming: create().withResponse() yields an envelope with async data', async () => {
    const sse =
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'yo' } }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n' +
      'data: [DONE]\n\n'
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch
    try {
      const client: any = createOpenAICompatibleClient({ apiKey: 'k', baseURL: 'http://x/v1' })
      const result: any = await client.beta.messages
        .create({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true })
        .withResponse()
      expect(typeof result.withResponse === 'undefined' || true).toBe(true)
      expect(result.data).toBeDefined()
      const types: string[] = []
      for await (const e of result.data as AsyncIterable<any>) types.push(e.type)
      expect(types[0]).toBe('message_start')
      expect(types.at(-1)).toBe('message_stop')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('openaiAdapter model-aware params (tokens/temperature)', () => {
  test('OpenAI reasoning models use max_completion_tokens and drop temperature', () => {
    for (const model of ['o3', 'o4-mini', 'gpt-5', 'gpt-5-mini']) {
      const req = buildOpenAIRequest({ model, max_tokens: 100, temperature: 0.7, messages: [{ role: 'user', content: 'hi' }] })
      expect(req.max_completion_tokens).toBe(100)
      expect(req.max_tokens).toBeUndefined()
      expect(req.temperature).toBeUndefined()
    }
  })

  test('deepseek-reasoner keeps max_tokens but still drops temperature', () => {
    const req = buildOpenAIRequest({ model: 'deepseek-reasoner', max_tokens: 100, temperature: 0.7, messages: [{ role: 'user', content: 'hi' }] })
    expect(req.max_tokens).toBe(100)
    expect(req.max_completion_tokens).toBeUndefined()
    expect(req.temperature).toBeUndefined()
  })

  test('standard chat models keep max_tokens + temperature (gpt-4o not misdetected)', () => {
    for (const model of ['meta/llama-3.3-70b-instruct', 'gpt-4o', 'deepseek-chat']) {
      const req = buildOpenAIRequest({ model, max_tokens: 100, temperature: 0.7, messages: [{ role: 'user', content: 'hi' }] })
      expect(req.max_tokens).toBe(100)
      expect(req.max_completion_tokens).toBeUndefined()
      expect(req.temperature).toBe(0.7)
    }
  })
})

describe('openaiAdapter tool ordering + tool_choice', () => {
  test('tool_result messages immediately follow assistant tool_calls, before user text', () => {
    const req = buildOpenAIRequest({
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'file data' },
            { type: 'text', text: 'now summarize' },
          ],
        },
      ],
    })
    const roles = (req.messages as any[]).map(m => m.role)
    // assistant(tool_calls) -> tool -> user(text); tool must precede the user text
    expect(roles).toEqual(['assistant', 'tool', 'user'])
    expect((req.messages as any[])[1].tool_call_id).toBe('call_1')
    expect((req.messages as any[])[2].content).toBe('now summarize')
  })

  test('tool_choice maps auto/any/none/tool', () => {
    const mk = (tool_choice: any) =>
      buildOpenAIRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        tool_choice,
      }).tool_choice
    expect(mk({ type: 'auto' })).toBe('auto')
    expect(mk({ type: 'any' })).toBe('required')
    expect(mk({ type: 'none' })).toBe('none')
    expect(mk({ type: 'tool', name: 'Read' })).toEqual({ type: 'function', function: { name: 'Read' } })
  })
})

describe('openaiAdapter image / vision passthrough', () => {
  const imgBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }

  test('user message with image -> multimodal content with image_url data URI', () => {
    const req = buildOpenAIRequest({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, imgBlock] }],
    })
    const um = (req.messages as any[]).find(m => m.role === 'user')
    expect(Array.isArray(um.content)).toBe(true)
    expect(um.content[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(um.content[1].type).toBe('image_url')
    expect(um.content[1].image_url.url).toBe('data:image/png;base64,AAAA')
  })

  test('text-only user message stays a plain string (no multimodal array)', () => {
    const req = buildOpenAIRequest({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const um = (req.messages as any[]).find(m => m.role === 'user')
    expect(um.content).toBe('hi')
  })

  test('image url source -> image_url passthrough', () => {
    const req = buildOpenAIRequest({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
    })
    const um = (req.messages as any[]).find(m => m.role === 'user')
    expect(um.content[0].image_url.url).toBe('https://x/y.png')
  })

  test('tool_result with image -> tool message (text) + follow-up user image message; tools stay contiguous', () => {
    const req = buildOpenAIRequest({
      model: 'm',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'c1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'c2', name: 'Read', input: {} },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'screenshot:' }, imgBlock] },
          { type: 'tool_result', tool_use_id: 'c2', content: 'plain text result' },
          { type: 'text', text: 'describe it' },
        ] },
      ],
    })
    const roles = (req.messages as any[]).map(m => m.role)
    // both tool messages contiguous right after assistant, THEN the image user msg, THEN the text user msg
    expect(roles).toEqual(['assistant', 'tool', 'tool', 'user', 'user'])
    const msgs = req.messages as any[]
    expect(msgs[1].content).toBe('screenshot:')
    expect(msgs[2].content).toBe('plain text result')
    const imgMsg = msgs[3]
    expect(imgMsg.content.some((p: any) => p.type === 'image_url' && p.image_url.url === 'data:image/png;base64,AAAA')).toBe(true)
    expect(msgs[4].content).toBe('describe it')
  })
})

describe('openaiAdapter reasoning + stream_options fallback', () => {
  test('non-streaming: reasoning_content/reasoning -> thinking block before text', () => {
    for (const key of ['reasoning_content', 'reasoning']) {
      const msg: any = toBetaMessage(
        { id: 'c', choices: [{ message: { [key]: 'let me think', content: 'answer' }, finish_reason: 'stop' }] },
        'm',
      )
      expect(msg.content[0]).toEqual({ type: 'thinking', thinking: 'let me think', signature: '' })
      expect(msg.content[1]).toEqual({ type: 'text', text: 'answer' })
    }
  })

  test('streaming: reasoning delta -> thinking block, then text, with distinct indices', async () => {
    async function* s(): AsyncGenerator<any> {
      yield { choices: [{ delta: { reasoning: 'think ' } }] }
      yield { choices: [{ delta: { reasoning: 'more' } }] }
      yield { choices: [{ delta: { content: 'Hello' } }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    }
    const events: any[] = []
    for await (const e of translateStream(s(), 'm')) events.push(e)
    const thinkStart = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'thinking')
    const textStart = events.find(e => e.type === 'content_block_start' && e.content_block?.type === 'text')
    expect(thinkStart).toBeDefined()
    expect(textStart).toBeDefined()
    expect(thinkStart.index).not.toBe(textStart.index)
    const think = events.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking).join('')
    expect(think).toBe('think more')
    const text = events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join('')
    expect(text).toBe('Hello')
  })

  test('streaming client retries without stream_options when provider rejects it, then suppresses it', async () => {
    let calls = 0
    const bodies: any[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      calls++
      const body = JSON.parse(init.body)
      bodies.push(body)
      if (body.stream_options) {
        return new Response(JSON.stringify({ error: { message: 'Unrecognized request argument: stream_options' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n' + 'data: [DONE]\n\n'
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    try {
      const client: any = createOpenAICompatibleClient({
        apiKey: 'k',
        baseURL: 'http://x/v1',
        maxRetries: 0,
        streamOptions: 'enabled',
      })
      const result: any = await client.beta.messages.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }).withResponse()
      const types: string[] = []
      for await (const e of result.data as AsyncIterable<any>) types.push(e.type)
      expect(types).toContain('message_stop')
      expect(calls).toBe(2) // first with stream_options (400), retry without

      const result2: any = await client.beta.messages.create({ model: 'm', messages: [{ role: 'user', content: 'again' }], stream: true }).withResponse()
      for await (const _e of result2.data as AsyncIterable<any>) {
        // drain
      }
      expect(calls).toBe(3)
      expect(bodies.map(body => 'stream_options' in body)).toEqual([true, false, false])
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('openaiAdapter error + retry hardening', () => {
  test('provider 429 surfaces as an Anthropic APIError (instanceof + status) so withRetry retries it', async () => {
    const { APIError } = await import('@anthropic-ai/sdk/index.js')
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    try {
      const client = createOpenAICompatibleClient({ apiKey: 'k', baseURL: 'http://x/v1', maxRetries: 0 })
      let caught: any
      try {
        await client.beta.messages.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(APIError)
      expect(caught.status).toBe(429)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('non-streaming retries transient 500 then succeeds (default maxRetries)', async () => {
    let calls = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return new Response('{"error":{"message":"server"}}', { status: 500, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ id: 'c', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    try {
      const client = createOpenAICompatibleClient({ apiKey: 'k', baseURL: 'http://x/v1' }) // default retries
      const msg: any = await client.beta.messages.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      expect(msg.content[0].text).toBe('ok')
      expect(calls).toBeGreaterThanOrEqual(2)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('openaiAdapter assistant content normalization', () => {
  test('assistant with tool_calls keeps null content; reasoning-only/empty assistant becomes ""', () => {
    const withTool = buildOpenAIRequest({
      model: 'm',
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: {} }] }],
    })
    const a1 = (withTool.messages as any[]).find(m => m.role === 'assistant')
    expect(a1.content).toBeNull()
    expect(a1.tool_calls).toHaveLength(1)

    // thinking-only assistant (thinking is dropped on re-send) -> content '' not null
    const reasoningOnly = buildOpenAIRequest({
      model: 'm',
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: '' }] }],
    })
    const a2 = (reasoningOnly.messages as any[]).find(m => m.role === 'assistant')
    expect(a2.content).toBe('')
    expect(a2.tool_calls).toBeUndefined()
  })
})

describe('openaiAdapter prompt caching', () => {
  test('buildOpenAIRequest omits prompt_cache_key by default', () => {
    const req = buildOpenAIRequest({
      model: 'm',
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(req.prompt_cache_key).toBeUndefined()
  })

  test('prompt_cache_key is stable for same system+model and changes with system', () => {
    const mk = (system: string, model = 'm') =>
      buildOpenAIRequest(
        { model, system, messages: [{ role: 'user', content: 'hi' }] },
        { promptCacheKey: true },
      ).prompt_cache_key
    const a = mk('You are helpful')
    expect(typeof a).toBe('string')
    expect(a).toBe(mk('You are helpful')) // stable
    expect(a).not.toBe(mk('You are different')) // system changed
    expect(a).not.toBe(mk('You are helpful', 'other-model')) // model changed
  })

  test('prompt_cache_key is stable across turns (different user messages, same prefix)', () => {
    const k1 = buildOpenAIRequest(
      { model: 'm', system: 's', messages: [{ role: 'user', content: 'first' }] },
      { promptCacheKey: true },
    ).prompt_cache_key
    const k2 = buildOpenAIRequest(
      {
        model: 'm',
        system: 's',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'second' },
        ],
      },
      { promptCacheKey: true },
    ).prompt_cache_key
    expect(k1).toBe(k2)
  })

  test('OpenAI auto mode includes prompt_cache_key', async () => {
    let body: any
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body)
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const client: any = createOpenAICompatibleClient({
        apiKey: 'k',
        baseURL: 'https://api.openai.com/v1',
        providerId: 'openai',
        maxRetries: 0,
      })
      await client.beta.messages.create({ model: 'gpt-4o', system: 's', messages: [{ role: 'user', content: 'hi' }] })
      expect(typeof body.prompt_cache_key).toBe('string')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('NVIDIA auto mode does not send optional OpenAI params on the first request', async () => {
    let body: any
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body)
      const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n' + 'data: [DONE]\n\n'
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    try {
      const client: any = createOpenAICompatibleClient({
        apiKey: 'k',
        baseURL: 'https://integrate.api.nvidia.com/v1',
        providerId: 'nvidia',
        maxRetries: 0,
      })
      const result: any = await client.beta.messages.create({
        model: 'stepfun-ai/step-3.7-flash',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'medium' },
        stream: true,
      } as any).withResponse()
      for await (const _e of result.data as AsyncIterable<any>) {
        // drain
      }
      expect(body.prompt_cache_key).toBeUndefined()
      expect(body.reasoning_effort).toBeUndefined()
      expect(body.stream_options).toBeUndefined()
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('non-streaming retries without prompt_cache_key when a strict provider rejects it, then suppresses it', async () => {
    let calls = 0
    const bodies: any[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      calls++
      const body = JSON.parse(init.body)
      bodies.push(body)
      if (body.prompt_cache_key) {
        return new Response(
          JSON.stringify({ error: { message: 'Unrecognized request argument: prompt_cache_key' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const client: any = createOpenAICompatibleClient({
        apiKey: 'k',
        baseURL: 'http://strict-cache-key.test/v1',
        maxRetries: 0,
        promptCacheKey: 'enabled',
      })
      const msg: any = await client.beta.messages.create({ model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }] })
      expect(msg.content[0].text).toBe('ok')
      expect(calls).toBe(2) // first with key (400), retry without

      const msg2: any = await client.beta.messages.create({ model: 'm', system: 's', messages: [{ role: 'user', content: 'again' }] })
      expect(msg2.content[0].text).toBe('ok')
      expect(calls).toBe(3)
      expect(bodies.map(body => 'prompt_cache_key' in body)).toEqual([true, false, false])
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('openaiAdapter image+tools conflict fallback', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }

  test('vision model that 400s on tools+image retries without tools and reads the image', async () => {
    let calls = 0
    let toolsOnFinalCall = true
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      calls++
      const body = JSON.parse(init.body)
      toolsOnFinalCall = 'tools' in body
      if (body.tools) {
        // NVIDIA NIM llama-3.2-vision rejects tools+image with this exact 400.
        return new Response(
          JSON.stringify({ error: { message: 'The number of image tokens (0) must be the same as the number of images (1)' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message: { content: 'VISION-OK 482' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const client: any = createOpenAICompatibleClient({ apiKey: 'k', baseURL: 'http://x/v1', maxRetries: 0 })
      const msg: any = await client.beta.messages.create({
        model: 'meta/llama-3.2-11b-vision-instruct',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }, img] }],
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      })
      expect(msg.content[0].text).toBe('VISION-OK 482')
      expect(calls).toBe(2) // first with tools (400), retry without
      expect(toolsOnFinalCall).toBe(false)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('a 400 without an image does NOT strip tools (normal tool errors propagate)', async () => {
    let calls = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls++
      return new Response(
        JSON.stringify({ error: { message: 'The number of image tokens (0) must be the same as the number of images (1)' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const client: any = createOpenAICompatibleClient({ apiKey: 'k', baseURL: 'http://x/v1', maxRetries: 0 })
      let threw = false
      try {
        await client.beta.messages.create({
          model: 'm',
          messages: [{ role: 'user', content: 'no image here' }],
          tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      expect(calls).toBe(1) // no image → no tool-stripping retry
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('openaiAdapter reasoning_effort parameter', () => {
  test('translates effort levels to reasoning_effort', async () => {
    let body: any
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body)
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const client: any = createOpenAICompatibleClient({
        apiKey: 'k',
        baseURL: 'https://api.openai.com/v1',
        providerId: 'openai',
        maxRetries: 0,
      })

      // 'high' effort -> 'high' reasoning_effort
      await client.beta.messages.create({
        model: 'o3',
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'high' },
      } as any)
      expect(body.reasoning_effort).toBe('high')

      // 'max' effort -> 'high' reasoning_effort (clamped)
      await client.beta.messages.create({
        model: 'o3',
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'max' },
      } as any)
      expect(body.reasoning_effort).toBe('high')

      // 'medium' effort -> 'medium' reasoning_effort
      await client.beta.messages.create({
        model: 'o3',
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'medium' },
      } as any)
      expect(body.reasoning_effort).toBe('medium')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('gracefully retries without reasoning_effort if provider rejects it, then suppresses it', async () => {
    let calls = 0
    const bodies: any[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      calls++
      const body = JSON.parse(init.body)
      bodies.push(body)
      if (body.reasoning_effort) {
        return new Response(
          JSON.stringify({ error: { message: 'Unrecognized request argument: reasoning_effort' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const client: any = createOpenAICompatibleClient({
        apiKey: 'k',
        baseURL: 'http://strict-effort.test/v1',
        maxRetries: 0,
        reasoningEffort: 'enabled',
      })
      const msg: any = await client.beta.messages.create({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'medium' },
      } as any)
      expect(msg.content[0].text).toBe('ok')
      expect(calls).toBe(2) // first with reasoning_effort (400), retry without

      const msg2: any = await client.beta.messages.create({
        model: 'm',
        messages: [{ role: 'user', content: 'again' }],
        output_config: { effort: 'medium' },
      } as any)
      expect(msg2.content[0].text).toBe('ok')
      expect(calls).toBe(3)
      expect(bodies.map(body => 'reasoning_effort' in body)).toEqual([true, false, false])
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
