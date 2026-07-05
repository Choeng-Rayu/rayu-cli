// Regression coverage for the DeepSeek Web provider adapter.
//
// DESIGN (per explicit product direction): forward ONLY the user's current,
// literal message to DeepSeek Web — no client-side history flattening, no
// tools, no system prompt, no instructions. Continuity across turns is
// DeepSeek's OWN job: its session (chat_session_id) plus server-side thread
// linking (parent_message_id, chained from the previous turn's
// response_message_id) carry context — not this client reconstructing a
// transcript. This file covers three concerns:
//   1. No duplicate response (thinking suppressed, no doubled closing tail).
//   2. extractUserPrompt sends ONLY the latest user message, stripped of any
//      harness-injected scaffolding riding inside that single message's text
//      (<available-deferred-tools>, <system-reminder> — tool lists, skill
//      catalogs, IDE/RAYU.md context, etc.), and nothing else.
//   3. parent_message_id chaining: the response_message_id DeepSeek reports
//      via the `event: ready` SSE frame is persisted and sent back as the
//      NEXT turn's parent_message_id, instead of always null.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// The real WASM PoW solver only succeeds against a genuine DeepSeek-issued
// challenge/salt/signature (it validated as null against arbitrary test
// strings even at low difficulty) — that's the server's business logic, not
// something a unit test should depend on. Mock the solver module so tests
// exercise the SSE parsing / stream-shaping logic under test without paying
// for (or depending on) the real WASM puzzle.
mock.module('../src/services/api/deepseekWeb/deepseekWebPow.ts', () => ({
  solvePowChallenge: async () => 'mocked-pow-response-base64',
}))

let dir: string
let originalFetch: typeof fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-dsweb-'))
  process.env.RAYU_CONFIG_DIR = dir
  originalFetch = globalThis.fetch
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.DEEPSEEK_OAUTH_WEB_TOKEN
  delete process.env.DEEPSEEK_OAUTH_WEB_COOKIE
  globalThis.fetch = originalFetch
})

/**
 * A realistic chat.deepseek.com SSE payload: an `event: ready` frame (with
 * response_message_id, needed for the next turn's parent_message_id), a
 * thinking_content trace, the final content, then FINISHED.
 */
function deepseekSSE(opts?: { responseMessageId?: number }): string {
  const readyLine =
    opts?.responseMessageId !== undefined
      ? `event: ready\ndata: ${JSON.stringify({ request_message_id: 1, response_message_id: opts.responseMessageId })}\n\n`
      : ''
  const lines = [
    { p: 'response/thinking_content', v: 'Let me ' },
    { v: 'think about this...' },
    { p: 'response/content', v: 'Hey ' },
    { v: 'Rayu! 👋' },
    { p: 'response/status', v: 'FINISHED' },
  ]
  return (
    readyLine +
    lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('') +
    'data: [DONE]\n\n'
  )
}

function fakeChallenge() {
  return {
    algorithm: 'sha3_256',
    challenge: 'test-challenge',
    salt: 'test-salt',
    difficulty: 14,
    expire_at: 9999999999,
    signature: 'sig',
    target_path: '/api/v0/chat/completion',
  }
}

function installFetchMock(sse: string | (() => string)) {
  const calls: string[] = []
  const bodies: unknown[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    calls.push(u)
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
    if (u.endsWith('/chat_session/create')) {
      return new Response(
        JSON.stringify({ data: { biz_data: { id: 'sess-1' } } }),
        { status: 200 },
      )
    }
    if (u.endsWith('/chat/create_pow_challenge')) {
      return new Response(
        JSON.stringify({ data: { biz_data: { challenge: fakeChallenge() } } }),
        { status: 200 },
      )
    }
    if (u.endsWith('/chat/completion')) {
      const body = typeof sse === 'function' ? sse() : sse
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }) as unknown as typeof fetch
  return { calls, bodies }
}

function completionBodies(bodies: unknown[]): Array<{
  chat_session_id?: string
  parent_message_id?: number | null
  prompt?: string
}> {
  return bodies.filter(
    (b): b is { chat_session_id?: string; parent_message_id?: number | null; prompt?: string } =>
      !!b && typeof (b as { prompt?: unknown }).prompt === 'string',
  )
}

/**
 * Mocks the exact real-world failure this suite regression-tests: DeepSeek
 * answers a /chat/completion request with HTTP 200 but a plain JSON error
 * body (content-type: application/json, NOT text/event-stream) instead of an
 * SSE stream — {"code":0,"msg":"","data":{"biz_code":26,"biz_msg":"invalid
 * message id","biz_data":null}} — captured live when a cached
 * parent_message_id from a prior turn's `event: ready` frame was no longer
 * valid on DeepSeek's server. `errorOnceThenSSE` controls whether subsequent
 * completion calls (the retry) get a real SSE stream instead.
 */
function installBizErrorFetchMock(opts: {
  errorOnceThenSSE?: string
  alwaysError?: boolean
}) {
  const calls: string[] = []
  const bodies: unknown[] = []
  let completionCallCount = 0
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    calls.push(u)
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
    if (u.endsWith('/chat_session/create')) {
      return new Response(
        JSON.stringify({ data: { biz_data: { id: 'sess-1' } } }),
        { status: 200 },
      )
    }
    if (u.endsWith('/chat/create_pow_challenge')) {
      return new Response(
        JSON.stringify({ data: { biz_data: { challenge: fakeChallenge() } } }),
        { status: 200 },
      )
    }
    if (u.endsWith('/chat/completion')) {
      completionCallCount++
      const isFirstCall = completionCallCount === 1
      if (opts.alwaysError || (isFirstCall && opts.errorOnceThenSSE !== undefined)) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: '',
            data: { biz_code: 26, biz_msg: 'invalid message id', biz_data: null },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(opts.errorOnceThenSSE ?? deepseekSSE(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }) as unknown as typeof fetch
  return { calls, bodies, completionCallCount: () => completionCallCount }
}

describe('DeepSeek Web: no duplicate response (thinking is swallowed, not streamed)', () => {
  test('streaming surface yields exactly ONE content_block_start/stop pair (text), never a thinking block', async () => {
    const { calls } = installFetchMock(deepseekSSE())
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )

    const { data: stream } = await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'hello bro' }],
      stream: true,
    }).withResponse()

    const starts: Array<{ index: number; type: string }> = []
    const stops: number[] = []
    let textOut = ''
    let thinkingOut = ''
    let messageStarts = 0
    let messageStops = 0

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          messageStarts++
          break
        case 'content_block_start':
          starts.push({ index: event.index, type: event.content_block.type })
          break
        case 'content_block_delta':
          if (event.delta.type === 'text_delta' && event.delta.text) {
            textOut += event.delta.text
          }
          if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
            thinkingOut += event.delta.thinking
          }
          break
        case 'content_block_stop':
          stops.push(event.index)
          break
        case 'message_stop':
          messageStops++
          break
      }
    }

    // Exactly one message lifecycle...
    expect(calls.filter((u) => u.endsWith('/chat/completion')).length).toBe(1)
    expect(messageStarts).toBe(1)
    expect(messageStops).toBe(1)
    // ...and exactly ONE content block: a 'text' block, never 'thinking'.
    expect(starts).toEqual([{ index: 0, type: 'text' }])
    expect(stops).toEqual([0])
    expect(textOut).toBe('Hey Rayu! 👋')
    // The thinking trace must never surface as a streamed delta.
    expect(thinkingOut).toBe('')
  })

  test('non-streaming surface: content has only a text block, no thinking block', async () => {
    installFetchMock(deepseekSSE())
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )

    const message = (await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'hello bro' }],
    })) as {
      content: Array<{ type: string; text?: string; thinking?: string }>
    }

    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toEqual({ type: 'text', text: 'Hey Rayu! 👋' })
  })

  test('a turn with NO thinking_content chunks still yields a single clean text block', async () => {
    const sse =
      [
        { p: 'response/content', v: 'Just an answer.' },
        { p: 'response/status', v: 'FINISHED' },
      ]
        .map((l) => `data: ${JSON.stringify(l)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    installFetchMock(sse)
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    const message = (await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'hi' }],
    })) as { content: Array<{ type: string; text?: string }> }
    expect(message.content).toEqual([{ type: 'text', text: 'Just an answer.' }])
  })

  test('exact event sequence has no duplicated closing tail (regression: FINISHED used to be followed by a second, redundant content_block_stop/message_delta/message_stop from the post-loop cleanup)', async () => {
    installFetchMock(deepseekSSE())
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    const { data: stream } = await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'hello bro' }],
      stream: true,
    }).withResponse()

    const types: string[] = []
    for await (const event of stream) {
      types.push(event.type)
    }

    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta', // "Hey "
      'content_block_delta', // "Rayu! 👋"
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  test('the internal __ready bookkeeping event never reaches the Anthropic-shaped surface claude.ts consumes', async () => {
    installFetchMock(deepseekSSE({ responseMessageId: 42 }))
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    const { data: stream } = await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }).withResponse()

    const types: string[] = []
    for await (const event of stream) types.push(event.type)
    expect(types).not.toContain('__ready')
  })
})

describe('DeepSeek Web: forward ONLY the current user message (no history, no tools, no instructions)', () => {
  test('single message: sends exactly the raw text, no Role prefix, no wrapping', async () => {
    const { bodies } = installFetchMock(
      [
        { p: 'response/content', v: 'hi there' },
        { p: 'response/status', v: 'FINISHED' },
      ]
        .map((l) => `data: ${JSON.stringify(l)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
    )
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'hello bro' }],
    })
    const [body] = completionBodies(bodies)
    expect(body!.prompt).toBe('hello bro')
  })

  // Regression: this used to flatten the ENTIRE conversation (all prior
  // user/assistant turns) into one big "Role: text" blob. Per explicit
  // product direction, DeepSeek Web must see ONLY the current message —
  // continuity across turns is DeepSeek's own session/thread job, not this
  // client's.
  test('multi-turn conversation history: only the LATEST user message is sent, prior turns are ignored entirely', async () => {
    const { bodies } = installFetchMock(
      [
        { p: 'response/content', v: 'ok' },
        { p: 'response/status', v: 'FINISHED' },
      ]
        .map((l) => `data: ${JSON.stringify(l)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
    )
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [
        { role: 'user', content: "hello bro I'm rayu and you" },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hey Rayu! 👋 Good to meet you!' }],
        },
        { role: 'user', content: 'now tell me again what is my name?' },
      ],
    })
    const [body] = completionBodies(bodies)
    // Only the CURRENT message — no "rayu", no assistant reply, no Role
    // prefixes, no earlier turn at all.
    expect(body!.prompt).toBe('now tell me again what is my name?')
  })

  // Regression: the harness (claude.ts / messages.ts) injects
  // <available-deferred-tools> and <system-reminder> blocks as literal text
  // inside otherwise-real user-message content (tool/skill catalogs, RAYU.md
  // contents, IDE file-open notices, etc.) — normal and expected for
  // Anthropic/OpenAI-shaped providers. DeepSeek Web has no such concept, so
  // even the ONE message actually forwarded must have this scaffolding
  // stripped out of its own text.
  test('strips <available-deferred-tools> and <system-reminder> noise embedded in the current message, forwarding only the human text', async () => {
    const { bodies } = installFetchMock(
      [
        { p: 'response/content', v: 'ok' },
        { p: 'response/status', v: 'FINISHED' },
      ]
        .map((l) => `data: ${JSON.stringify(l)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
    )
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )

    const injectedMessage =
      '<available-deferred-tools>\nAskUserQuestion\nWebFetch\nWebSearch\nmcp__Canva__export-design\n</available-deferred-tools>\n\n' +
      '<system-reminder>\nThe following skills are available via the Skill tool...\n- update-config: ...\n- simplify: ...\n</system-reminder>\n\n' +
      'hello bro I\'m rayu and you\n\n' +
      '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# claudeMd\n...(RAYU.md contents)...\n</system-reminder>'

    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: injectedMessage }],
    })

    const [body] = completionBodies(bodies)
    const prompt = body!.prompt!

    expect(prompt).toContain("hello bro I'm rayu and you")
    expect(prompt).not.toContain('available-deferred-tools')
    expect(prompt).not.toContain('AskUserQuestion')
    expect(prompt).not.toContain('mcp__Canva__export-design')
    expect(prompt).not.toContain('system-reminder')
    expect(prompt).not.toContain('update-config')
    expect(prompt).not.toContain('claudeMd')
    // Only the real human text remains — no Role prefix (single-message mode).
    expect(prompt).toBe("hello bro I'm rayu and you")
  })

  test('no tools/tool_choice/system fields are ever sent to DeepSeek Web, even if the caller supplied them', async () => {
    const { bodies } = installFetchMock(
      [
        { p: 'response/content', v: 'ok' },
        { p: 'response/status', v: 'FINISHED' },
      ]
        .map((l) => `data: ${JSON.stringify(l)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
    )
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      system: 'You are a helpful coding assistant with access to tools.',
      tools: [{ name: 'BashTool', description: 'run shell commands' }],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: 'explain this code' }],
    })
    const [body] = completionBodies(bodies)
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
    expect(body).not.toHaveProperty('system')
    expect(body!.prompt).toBe('explain this code')
  })
})

describe('DeepSeek Web: session continuity via parent_message_id (DeepSeek carries context, not the client)', () => {
  test('the FIRST turn of a fresh session sends parent_message_id: null', async () => {
    const { bodies } = installFetchMock(deepseekSSE({ responseMessageId: 100 }))
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'turn one' }],
    })
    const [body] = completionBodies(bodies)
    expect(body!.parent_message_id).toBeNull()
  })

  test("the SECOND turn sends the FIRST turn's response_message_id as parent_message_id", async () => {
    let turn = 0
    const { bodies } = installFetchMock(() => {
      turn++
      return deepseekSSE({ responseMessageId: turn === 1 ? 100 : 200 })
    })
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )

    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'turn one' }],
    })
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'turn two' }],
    })

    const [firstBody, secondBody] = completionBodies(bodies)
    expect(firstBody!.parent_message_id).toBeNull()
    expect(secondBody!.parent_message_id).toBe(100) // chained from turn 1's ready frame
    expect(secondBody!.prompt).toBe('turn two') // and STILL only the current message
  })

  test('reuses the same chat_session_id across turns', async () => {
    let turn = 0
    const { bodies } = installFetchMock(() => {
      turn++
      return deepseekSSE({ responseMessageId: turn * 100 })
    })
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'turn one' }],
    })
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'turn two' }],
    })
    const [firstBody, secondBody] = completionBodies(bodies)
    expect(firstBody!.chat_session_id).toBe('sess-1')
    expect(secondBody!.chat_session_id).toBe('sess-1')
  })

  test('a ready frame with no response_message_id (malformed/missing) does not crash — next turn falls back to null', async () => {
    let turn = 0
    const { bodies } = installFetchMock(() => {
      turn++
      // Turn 1: no `event: ready` frame at all (older/odd server behavior).
      if (turn === 1) {
        return [
          { p: 'response/content', v: 'ok' },
          { p: 'response/status', v: 'FINISHED' },
        ]
          .map((l) => `data: ${JSON.stringify(l)}\n\n`)
          .join('') + 'data: [DONE]\n\n'
      }
      return deepseekSSE({ responseMessageId: 999 })
    })
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'turn one' }],
    })
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'turn two' }],
    })
    const [firstBody, secondBody] = completionBodies(bodies)
    expect(firstBody!.parent_message_id).toBeNull()
    // No ready frame on turn 1 → nothing to chain from → turn 2 still null.
    expect(secondBody!.parent_message_id).toBeNull()
  })
})

describe('DeepSeek Web: recovers from a stale parent_message_id instead of hanging silently (regression)', () => {
  // Root cause of the reported "paste a big file and it just doesn't
  // respond" bug: DeepSeek sometimes answers /chat/completion with HTTP 200
  // but a plain JSON error body — {"data":{"biz_code":26,"biz_msg":"invalid
  // message id"}} — content-type application/json, NOT text/event-stream —
  // when the cached parent_message_id from a PREVIOUS turn's `event: ready`
  // frame is no longer valid on DeepSeek's server (captured live after a
  // large pasted message). response.ok is true (200), so the request
  // reached parseSSEStream, which correctly found zero "\n\n"-delimited SSE
  // blocks in the flat JSON body and yielded NOTHING — no thrown error, no
  // visible message: the turn looked frozen with zero feedback.
  test('detects the biz_code error shape and retries ONCE with parent_message_id reset to null — yields a real answer instead of an empty stream', async () => {
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )

    // Turn 1: succeeds normally and persists response_message_id=100.
    installFetchMock(deepseekSSE({ responseMessageId: 100 }))
    const m1 = (await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'turn one' }],
    })) as { content: Array<{ type: string; text?: string }> }
    expect(m1.content).toEqual([{ type: 'text', text: 'Hey Rayu! 👋' }])

    // Turn 2: the cached parent_message_id (100) is now "stale" on
    // DeepSeek's side — first completion call errors, the retry (with
    // parent_message_id forced to null) succeeds.
    const { bodies, completionCallCount } = installBizErrorFetchMock({
      errorOnceThenSSE: deepseekSSE({ responseMessageId: 200 }),
    })
    const m2 = (await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'turn two (this used to hang)' }],
    })) as { content: Array<{ type: string; text?: string }> }

    // The turn recovered and produced a real answer — NOT an empty stream.
    expect(m2.content).toEqual([{ type: 'text', text: 'Hey Rayu! 👋' }])
    expect(completionCallCount()).toBe(2) // 1 failed attempt + 1 successful retry

    const attempts = completionBodies(bodies)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.parent_message_id).toBe(100) // the stale value that failed
    expect(attempts[1]!.parent_message_id).toBeNull() // the retry that succeeded
    // The retry still forwards the SAME single message, nothing else.
    expect(attempts[1]!.prompt).toBe('turn two (this used to hang)')
  })

  test('a biz_code error on a FRESH session (parent_message_id already null) is a real failure, not a retry loop — throws with a clear message', async () => {
    const { completionCallCount } = installBizErrorFetchMock({ alwaysError: true })
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    let thrown: unknown
    try {
      await client.beta.messages.create({
        model: 'deepseek-v4-pro-1m',
        messages: [{ role: 'user', content: 'first ever turn' }],
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/biz_code 26.*invalid message id/)
    // Exactly one attempt — parent_message_id was already null, so there is
    // nothing to reset and retry; retrying again would loop forever against
    // a server that keeps rejecting the same way.
    expect(completionCallCount()).toBe(1)
  })

  test('a non-SSE, non-biz_code response (unexpected shape) surfaces a clear error instead of silently yielding nothing', async () => {
    let completionCalls = 0
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url)
      if (u.endsWith('/chat_session/create')) {
        return new Response(JSON.stringify({ data: { biz_data: { id: 'sess-1' } } }), { status: 200 })
      }
      if (u.endsWith('/chat/create_pow_challenge')) {
        return new Response(
          JSON.stringify({ data: { biz_data: { challenge: fakeChallenge() } } }),
          { status: 200 },
        )
      }
      if (u.endsWith('/chat/completion')) {
        completionCalls++
        return new Response('<html>upstream WAF block page</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as typeof fetch

    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    let thrown: unknown
    try {
      await client.beta.messages.create({
        model: 'deepseek-v4-pro-1m',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/expected an SSE stream/)
    expect(completionCalls).toBe(1) // no retry for an unrecognized shape
  })
})

describe('DeepSeek Web: repeated identical messages are NOT silently deduped (regression: user retyping "hello bro" got a stale replayed reply instead of a fresh answer)', () => {
  // Root cause: a cross-CALL text-based dedup ("same prompt within 5s ->
  // replay the previous buffered reply instead of contacting DeepSeek")
  // existed to guard against the SDK/harness touching both .then() and
  // .withResponse() on the SAME logical call object — but that scenario is
  // already fully handled by create()'s own per-object ensurePromise()
  // cache. The cross-call dedup instead silently broke the ordinary case of
  // a user typing the same short message twice in a row (e.g. "hello bro"
  // three times, testing or just chatting): the SECOND identical message,
  // sent within 5 seconds, never reached DeepSeek at all — it silently
  // replayed the FIRST message's buffered reply. In the interactive TUI this
  // presented as replies appearing/disappearing seemingly at random for
  // repeated short messages. Fixed by removing the cross-call dedup/replay
  // mechanism entirely: every real create() call now always makes its own
  // network request.
  test('two separate turns with IDENTICAL text, seconds apart, each independently call DeepSeek and get their own answer', async () => {
    let completionCallCount = 0
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url)
      if (u.endsWith('/chat_session/create')) {
        return new Response(JSON.stringify({ data: { biz_data: { id: 'sess-1' } } }), { status: 200 })
      }
      if (u.endsWith('/chat/create_pow_challenge')) {
        return new Response(
          JSON.stringify({ data: { biz_data: { challenge: fakeChallenge() } } }),
          { status: 200 },
        )
      }
      if (u.endsWith('/chat/completion')) {
        completionCallCount++
        const n = completionCallCount
        const sse =
          [
            { p: 'response/content', v: `Reply number ${n}` },
            { p: 'response/status', v: 'FINISHED' },
          ]
            .map((l) => `data: ${JSON.stringify(l)}\n\n`)
            .join('') + 'data: [DONE]\n\n'
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as typeof fetch

    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )

    // Turn 1: the user types "hello bro" and the turn fully completes.
    const m1 = (await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'hello bro' }],
    })) as { content: Array<{ type: string; text?: string }> }
    expect(m1.content).toEqual([{ type: 'text', text: 'Reply number 1' }])

    // Turn 2: ~1s later (well inside the OLD 5s dedup window), the SAME
    // literal text is sent again as a genuinely separate, new turn — this is
    // exactly what happened in the reported bug (retyping "hello bro").
    await new Promise((r) => setTimeout(r, 50))
    const m2 = (await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: 'hello bro' }],
    })) as { content: Array<{ type: string; text?: string }> }

    // MUST be a fresh answer from a real second network call — NOT a replay
    // of turn 1's reply.
    expect(completionCallCount).toBe(2)
    expect(m2.content).toEqual([{ type: 'text', text: 'Reply number 2' }])
    expect(m2.content).not.toEqual(m1.content)
  })

  test('three rapid identical messages ("hello bro" x3) each get their own independent reply, none silently dropped', async () => {
    let completionCallCount = 0
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url)
      if (u.endsWith('/chat_session/create')) {
        return new Response(JSON.stringify({ data: { biz_data: { id: 'sess-1' } } }), { status: 200 })
      }
      if (u.endsWith('/chat/create_pow_challenge')) {
        return new Response(
          JSON.stringify({ data: { biz_data: { challenge: fakeChallenge() } } }),
          { status: 200 },
        )
      }
      if (u.endsWith('/chat/completion')) {
        completionCallCount++
        const n = completionCallCount
        const sse =
          [
            { p: 'response/content', v: `Yo #${n}` },
            { p: 'response/status', v: 'FINISHED' },
          ]
            .map((l) => `data: ${JSON.stringify(l)}\n\n`)
            .join('') + 'data: [DONE]\n\n'
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }) as unknown as typeof fetch

    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )

    const replies: string[] = []
    for (let i = 0; i < 3; i++) {
      const m = (await client.beta.messages.create({
        model: 'deepseek-v4-pro-1m',
        messages: [{ role: 'user', content: 'hello bro' }],
      })) as { content: Array<{ type: string; text?: string }> }
      replies.push(m.content[0]?.text ?? '')
    }

    expect(completionCallCount).toBe(3)
    expect(replies).toEqual(['Yo #1', 'Yo #2', 'Yo #3'])
  })
})

describe('DeepSeek Web: IDE/harness internal fork prompts are never forwarded as if the human typed them (regression)', () => {
  // Root cause: the IDE/TUI "prompt suggestion" feature (predicting the
  // user's likely next message) runs as a SEPARATE background agent fork
  // whose message list is [...the real conversation so far, ONE internal
  // instruction message ("[SUGGESTION MODE: ...]  ... Reply with ONLY the
  // suggestion, no quotes or explanation.")]. extractUserPrompt's "walk
  // backward for the last user message" picked up that internal instruction
  // as if it were the human's real chat input and forwarded it verbatim to
  // DeepSeek Web — which then tried to answer/comply with harness-internal
  // meta-instructions instead of anything the user actually asked. Fixed by
  // detecting this structurally-distinct whole-message pattern and skipping
  // it, falling back to the real human message earlier in the conversation.
  const SUGGESTION_MODE_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into RAYU.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Claude offers options → suggest the one the user would likely pick, based on conversation
Claude asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`

  test('skips the whole suggestion-mode fork prompt and forwards the real human message from earlier in the conversation instead', async () => {
    const { bodies } = installFetchMock(deepseekSSE())
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )

    // Reproduces the exact fork shape: real conversation so far, PLUS the
    // internal suggestion-mode instruction appended as the final "user"
    // message (this is what promptSuggestion.ts's runForkedAgent actually
    // sends: forkContextMessages + [createUserMessage({ content: prompt })]).
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [
        { role: 'user', content: 'hello bro how are you?' },
        { role: 'assistant', content: [{ type: 'text', text: 'Doing great!' }] },
        { role: 'user', content: 'can you read my codebase?' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: "I can't directly access your files." }],
        },
        { role: 'user', content: SUGGESTION_MODE_PROMPT },
      ],
    })

    const [body] = completionBodies(bodies)
    const prompt = body!.prompt!
    // The internal instruction must NEVER be forwarded...
    expect(prompt).not.toContain('SUGGESTION MODE')
    expect(prompt).not.toContain('NEVER SUGGEST')
    expect(prompt).not.toContain('Reply with ONLY the suggestion')
    // ...instead the real, most recent HUMAN message is sent.
    expect(prompt).toBe('can you read my codebase?')
  })

  test('if EVERY user message is an internal fork prompt (no real human turn at all), falls back to the default greeting rather than forwarding the instruction', async () => {
    const { bodies } = installFetchMock(deepseekSSE())
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    await client.beta.messages.create({
      model: 'deepseek-v4-pro-1m',
      messages: [{ role: 'user', content: SUGGESTION_MODE_PROMPT }],
    })
    const [body] = completionBodies(bodies)
    expect(body!.prompt).toBe('Hello')
  })

  test('a legitimate short human message is NEVER mistaken for an internal fork prompt (no false positives)', async () => {
    const { bodies } = installFetchMock(deepseekSSE())
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )
    // A real user genuinely typing about suggestions/formatting must still
    // go through — the detector requires the exact "[SUGGESTION MODE:"
    // prefix OR 2+ of the specific internal meta-phrases together, not any
    // single overlapping word.
    const realMessages = [
      'can you suggest a better variable name?',
      'never suggest using var in this codebase please',
      'what format should I use for dates here?',
    ]
    for (const text of realMessages) {
      const { bodies: b } = installFetchMock(deepseekSSE())
      await client.beta.messages.create({
        model: 'deepseek-v4-pro-1m',
        messages: [{ role: 'user', content: text }],
      })
      const [body] = completionBodies(b)
      expect(body!.prompt).toBe(text)
    }
  })
})
