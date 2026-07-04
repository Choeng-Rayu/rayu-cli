// Regression coverage for the DeepSeek Web duplicate-response bug: the SSE
// parser used to emit a separate `thinking` content block ahead of the final
// `text` block, and claude.ts's generic (and otherwise correct) streaming
// consumer turns EACH content_block_stop into its own rendered assistant
// message — so every DeepSeek Web turn appeared as two chat bubbles (one for
// the reasoning trace, one for the actual answer) instead of one. DeepSeek Web
// is a chatbot-only provider with no way for the user to toggle a visible
// reasoning trace, so the fix is to never stream the thinking block out at all
// (it is still requested server-side via thinking_enabled:true for answer
// quality — just never surfaced as its own message).
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
 * A realistic chat.deepseek.com SSE payload: a thinking_content trace
 * followed by the final content, then FINISHED — exactly the shape that
 * triggered the duplicate-bubble bug before the fix.
 */
function deepseekSSE(): string {
  const lines = [
    { p: 'response/thinking_content', v: 'Let me ' },
    { v: 'think about this...' },
    { p: 'response/content', v: 'Hey ' },
    { v: 'Rayu! 👋' },
    { p: 'response/status', v: 'FINISHED' },
  ]
  return (
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

function installFetchMock(sse: string) {
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
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }) as unknown as typeof fetch
  return { calls, bodies }
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
})

describe('DeepSeek Web: multi-turn context is preserved (regression: second turn forgot the first)', () => {
  test('the outgoing prompt for turn 2 includes turn 1, not just the latest message', async () => {
    const sse =
      [
        { p: 'response/content', v: "Since this is the very first message..." },
        { p: 'response/status', v: 'FINISHED' },
      ]
        .map((l) => `data: ${JSON.stringify(l)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    const { bodies } = installFetchMock(sse)
    const { createDeepseekWebClient } = await import(
      '../src/services/api/deepseekWeb/deepseekWebClient.ts'
    )
    const client = createDeepseekWebClient(
      { apiKey: 'user-token', defaultModel: 'deepseek-v4-pro-1m' },
      3,
    )

    // Reproduces the exact reported bug: the caller (the CLI's own history)
    // hands the client the FULL conversation on every turn — this is turn 2,
    // so `messages` already contains turn 1's user line + the assistant's
    // reply, exactly like claude.ts assembles messages for every provider.
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

    const completionBody = bodies.find(
      (b): b is { prompt: string } =>
        !!b && typeof (b as { prompt?: unknown }).prompt === 'string',
    )
    expect(completionBody).toBeDefined()
    const prompt = completionBody!.prompt

    // The flattened prompt must carry the EARLIER turn (the user's name and
    // the assistant's greeting), not just the latest question — this is what
    // was missing before the fix, causing "you haven't told me [your name]".
    expect(prompt).toContain("rayu")
    expect(prompt).toContain('Good to meet you')
    expect(prompt).toContain('what is my name')
    // Turns appear in order: turn 1 before turn 2.
    expect(prompt.indexOf('rayu')).toBeLessThan(
      prompt.indexOf('what is my name'),
    )
  })

  test('still requests exactly one completion call per turn (history flattening is not re-sent as separate requests)', async () => {
    const sse =
      [
        { p: 'response/content', v: 'ok' },
        { p: 'response/status', v: 'FINISHED' },
      ]
        .map((l) => `data: ${JSON.stringify(l)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    const { calls } = installFetchMock(sse)
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
        { role: 'user', content: 'turn one' },
        { role: 'assistant', content: [{ type: 'text', text: 'reply one' }] },
        { role: 'user', content: 'turn two' },
      ],
    })
    expect(calls.filter((u) => u.endsWith('/chat/completion')).length).toBe(1)
  })

  test('single-turn conversation (no history yet) still sends just that message, unprefixed by empty turns', async () => {
    const sse =
      [
        { p: 'response/content', v: 'hi there' },
        { p: 'response/status', v: 'FINISHED' },
      ]
        .map((l) => `data: ${JSON.stringify(l)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    const { bodies } = installFetchMock(sse)
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
    const completionBody = bodies.find(
      (b): b is { prompt: string } =>
        !!b && typeof (b as { prompt?: unknown }).prompt === 'string',
    )
    expect(completionBody!.prompt).toBe('User: hello bro')
  })
})
