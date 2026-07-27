import { describe, expect, test } from 'bun:test'
import {
  BEDROCK_ANTHROPIC_VERSION,
  bedrockInvokeURL,
  bedrockRuntimeBaseURL,
  eventStreamToSSE,
  makeBedrockAnthropicFetch,
  toBedrockRequestBody,
} from '../src/services/api/bedrockAnthropic.ts'
import { encodeEventStreamFrame } from '../src/services/api/awsEventStream.ts'

// Claude on Bedrock over the native Anthropic Messages format. The shapes here
// were verified against the live us-east-1 endpoint (see
// test/bedrockAnthropicLive.test.ts for the end-to-end run):
//   POST /model/{id}/invoke                      → Anthropic JSON
//   POST /model/{id}/invoke-with-response-stream  → application/vnd.amazon.eventstream
//     whose frame payloads are {"bytes":"<base64 of one Anthropic SSE event>"}

const REGION = 'us-east-1'
const BASE = bedrockRuntimeBaseURL(REGION)
const MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

function frameFor(event: unknown): Uint8Array {
  const inner = new TextEncoder().encode(JSON.stringify(event))
  const outer = JSON.stringify({ bytes: btoa(String.fromCharCode(...inner)) })
  return encodeEventStreamFrame('chunk', new TextEncoder().encode(outer))
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch)
      c.close()
    },
  })
}

describe('URL rewriting', () => {
  test('base URL is region-scoped', () => {
    expect(bedrockRuntimeBaseURL('eu-west-1')).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com',
    )
    // Empty region falls back to the AWS SDK's own default.
    expect(bedrockRuntimeBaseURL('')).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com',
    )
  })

  test('streaming and non-streaming use different invoke endpoints', () => {
    expect(bedrockInvokeURL(BASE, MODEL, false)).toBe(
      `${BASE}/model/${MODEL}/invoke`,
    )
    expect(bedrockInvokeURL(BASE, MODEL, true)).toBe(
      `${BASE}/model/${MODEL}/invoke-with-response-stream`,
    )
  })

  test('the model id keeps its dots and colon (verified accepted unencoded)', () => {
    const url = bedrockInvokeURL(BASE, MODEL, false)
    expect(url).toContain('global.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(url).not.toContain('%3A')
  })
})

describe('request body translation', () => {
  test('moves the model into the URL and injects anthropic_version', () => {
    const { body, model, stream } = toBedrockRequestBody(
      JSON.stringify({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(model).toBe(MODEL)
    expect(stream).toBe(false)
    const parsed = JSON.parse(body) as Record<string, unknown>
    // Bedrock rejects a `model` field in the body — it lives in the path.
    expect('model' in parsed).toBe(false)
    expect(parsed.anthropic_version).toBe(BEDROCK_ANTHROPIC_VERSION)
    expect(parsed.max_tokens).toBe(16)
  })

  test('stream:true selects the streaming endpoint and is dropped from the body', () => {
    const { body, stream } = toBedrockRequestBody(
      JSON.stringify({ model: MODEL, stream: true, messages: [] }),
    )
    expect(stream).toBe(true)
    expect('stream' in (JSON.parse(body) as object)).toBe(false)
  })
})

describe('event-stream → SSE transcoding', () => {
  test('each frame becomes one Anthropic SSE event', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_1', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]
    const sse = eventStreamToSSE(streamOf(...events.map(frameFor)))
    const text = await new Response(sse).text()
    for (const e of events) {
      expect(text).toContain(`event: ${e.type}\n`)
    }
    expect(text).toContain('"text":"OK"')
    // Well-formed SSE: blank-line separated records.
    expect(text.endsWith('\n\n')).toBe(true)
  })

  test('frames split across chunk boundaries are reassembled', async () => {
    const frame = frameFor({ type: 'message_stop' })
    const cut = Math.floor(frame.length / 2)
    const sse = eventStreamToSSE(
      streamOf(frame.subarray(0, cut), frame.subarray(cut)),
    )
    const text = await new Response(sse).text()
    expect(text).toContain('event: message_stop')
  })

  test('an undecodable frame is skipped rather than killing the stream', async () => {
    const junk = encodeEventStreamFrame(
      'chunk',
      new TextEncoder().encode('not json'),
    )
    const sse = eventStreamToSSE(
      streamOf(junk, frameFor({ type: 'message_stop' })),
    )
    const text = await new Response(sse).text()
    expect(text).toContain('event: message_stop')
  })
})

describe('the Bedrock fetch wrapper', () => {
  function capturingFetch(response: Response) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const f = (async (input: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return response
    }) as unknown as typeof fetch
    return { f, calls }
  }

  test('rewrites a /v1/messages POST and attaches the bearer credential', async () => {
    const { f, calls } = capturingFetch(
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
    )
    const bedrockFetch = makeBedrockAnthropicFetch({
      apiKey: 'bedrock-secret',
      region: REGION,
      inner: f,
    })
    await bedrockFetch(`${BASE}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, messages: [], max_tokens: 8 }),
      headers: { 'x-api-key': 'should-be-removed', 'anthropic-version': '2023-06-01' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/model/${MODEL}/invoke`)
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('authorization')).toBe('Bearer bedrock-secret')
    // Anthropic-only headers Bedrock rejects are stripped.
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('anthropic-version')).toBeNull()
    // Never follow a redirect to another host with a credential attached.
    expect(calls[0]!.init.redirect).toBe('error')
  })

  test('a streaming response is converted to text/event-stream', async () => {
    const body = streamOf(frameFor({ type: 'message_stop' }))
    const { f } = capturingFetch(
      new Response(body, {
        headers: { 'content-type': 'application/vnd.amazon.eventstream' },
      }),
    )
    const bedrockFetch = makeBedrockAnthropicFetch({
      apiKey: 'k',
      region: REGION,
      inner: f,
    })
    const res = await bedrockFetch(`${BASE}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, stream: true, messages: [] }),
    })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toContain('event: message_stop')
  })

  test('an error response is passed through untouched (already Anthropic-shaped)', async () => {
    const { f } = capturingFetch(
      new Response(JSON.stringify({ message: 'boom' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const bedrockFetch = makeBedrockAnthropicFetch({
      apiKey: 'k',
      region: REGION,
      inner: f,
    })
    const res = await bedrockFetch(`${BASE}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, messages: [] }),
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('boom')
  })

  test('SECURITY: refuses to send the credential to an unexpected host', async () => {
    const { f, calls } = capturingFetch(new Response('{}'))
    const bedrockFetch = makeBedrockAnthropicFetch({
      apiKey: 'k',
      region: REGION,
      inner: f,
    })
    await expect(
      bedrockFetch('https://evil.example/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: MODEL, messages: [] }),
      }),
    ).rejects.toThrow(/unexpected host/)
    expect(calls).toHaveLength(0)
  })

  test('a non-Messages request passes through unchanged', async () => {
    const { f, calls } = capturingFetch(new Response('{}'))
    const bedrockFetch = makeBedrockAnthropicFetch({
      apiKey: 'k',
      region: REGION,
      inner: f,
    })
    await bedrockFetch(`${BASE}/v1/models`, { method: 'GET' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/models`)
  })
})
