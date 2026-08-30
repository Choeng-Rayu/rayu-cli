/**
 * Transport layer: JSONL framing, the JSON-RPC peer, and the child environment
 * allowlist.
 *
 * Framing bugs here do not surface as errors — they surface as an agent that
 * silently hangs — so the chunk-boundary and oversized-line cases are tested
 * directly against a real `PassThrough` rather than a hand-rolled fake stream.
 */
import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'stream'
import {
  createJsonLineReader,
  DEFAULT_MAX_LINE_BYTES,
} from '../src/externalAgents/transport/jsonLines.ts'
import {
  buildChildEnv,
  isForwardableEnvName,
} from '../src/externalAgents/transport/childEnv.ts'
import {
  createJsonRpcPeer,
  CODEX_SERVER_OVERLOADED,
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcClosedError,
  JsonRpcError,
  JsonRpcTimeoutError,
} from '../src/externalAgents/transport/jsonRpcStdio.ts'

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// JSONL framing
// ---------------------------------------------------------------------------

describe('json line reader', () => {
  function harness(maxLineBytes?: number) {
    const input = new PassThrough()
    const values: unknown[] = []
    const errors: string[] = []
    const closes: string[] = []
    const reader = createJsonLineReader({
      input,
      label: 'test',
      maxLineBytes,
      onValue: v => values.push(v),
      onError: e => errors.push(e.message),
      onClose: r => closes.push(r),
    })
    return { input, values, errors, closes, reader }
  }

  test('parses one object per line', async () => {
    const h = harness()
    h.input.write('{"a":1}\n{"a":2}\n')
    await tick()
    expect(h.values).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('reassembles an object split across chunks', async () => {
    // The failure mode this whole module exists to prevent: parsing per-chunk
    // corrupts every message larger than the pipe buffer.
    const h = harness()
    h.input.write('{"method":"session/upd')
    await tick()
    expect(h.values).toEqual([])
    h.input.write('ate","params":{"n":1}}\n')
    await tick()
    expect(h.values).toEqual([{ method: 'session/update', params: { n: 1 } }])
  })

  test('splits multiple objects arriving in a single chunk', async () => {
    const h = harness()
    h.input.write('{"i":1}\n{"i":2}\n{"i":3}\n')
    await tick()
    expect(h.values).toHaveLength(3)
  })

  test('holds an unterminated line until a newline arrives', async () => {
    // Guessing that a quiet buffer is complete would eventually parse a
    // half-received message, which is worse than waiting.
    const h = harness()
    h.input.write('{"partial":true}')
    await tick(20)
    expect(h.values).toEqual([])
  })

  test('flushes the unterminated tail when the stream ends', async () => {
    // Some CLIs omit the final newline on exit, and that last line is often the
    // `result` message that matters most.
    const h = harness()
    h.input.write('{"result":"final"}')
    h.input.end()
    await tick()
    expect(h.values).toEqual([{ result: 'final' }])
    expect(h.closes).toEqual(['stream ended'])
  })

  test('ignores blank lines and trailing whitespace', async () => {
    const h = harness()
    h.input.write('\n\n  {"a":1}  \n\n')
    await tick()
    expect(h.values).toEqual([{ a: 1 }])
    expect(h.errors).toEqual([])
  })

  test('handles CRLF line endings', async () => {
    const h = harness()
    h.input.write('{"a":1}\r\n{"a":2}\r\n')
    await tick()
    expect(h.values).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('reports an unparseable line and keeps reading', async () => {
    // One bad message must not stop the stream, or the agent appears to hang
    // from that point on.
    const h = harness()
    h.input.write('not json\n{"good":true}\n')
    await tick()
    expect(h.errors.some(e => e.includes('unparseable JSON line'))).toBe(true)
    expect(h.values).toEqual([{ good: true }])
  })

  test('a throwing consumer is reported, not allowed to kill the loop', async () => {
    const input = new PassThrough()
    const seen: unknown[] = []
    const errors: string[] = []
    createJsonLineReader({
      input,
      onValue: v => {
        seen.push(v)
        if ((v as { boom?: boolean }).boom) throw new Error('consumer blew up')
      },
      onError: e => errors.push(e.message),
    })
    input.write('{"boom":true}\n{"boom":false}\n')
    await tick()
    expect(errors.some(e => e.includes('consumer threw'))).toBe(true)
    expect(seen).toHaveLength(2)
  })

  test('discards a runaway buffer instead of growing without bound', async () => {
    const h = harness(64)
    h.input.write('x'.repeat(200))
    await tick()
    expect(h.errors.some(e => e.includes('exceeded 64 bytes'))).toBe(true)
    // The buffer was reset, so a subsequent well-formed line still parses.
    h.input.write('{"recovered":true}\n')
    await tick()
    expect(h.values).toEqual([{ recovered: true }])
  })

  test('default line cap is 32MB', () => {
    expect(DEFAULT_MAX_LINE_BYTES).toBe(32 * 1024 * 1024)
  })

  test('close is idempotent and stops delivery', async () => {
    const h = harness()
    h.reader.close('done')
    h.reader.close('again')
    expect(h.closes).toEqual(['done'])
    expect(h.reader.closed).toBe(true)
    h.input.write('{"late":true}\n')
    await tick()
    expect(h.values).toEqual([])
  })

  test('a stream error is reported and closes the reader', async () => {
    const h = harness()
    h.input.emit('error', new Error('EPIPE'))
    await tick()
    expect(h.errors.some(e => e.includes('stream error'))).toBe(true)
    expect(h.reader.closed).toBe(true)
  })

  test('parses a large single line under the cap', async () => {
    const h = harness()
    const big = 'y'.repeat(200_000)
    h.input.write(`${JSON.stringify({ diff: big })}\n`)
    await tick()
    expect((h.values[0] as { diff: string }).diff).toHaveLength(200_000)
  })

  test('parses non-object JSON values', async () => {
    // The reader deliberately knows nothing about message semantics.
    const h = harness()
    h.input.write('123\n"text"\ntrue\n[1,2]\n')
    await tick()
    expect(h.values).toEqual([123, 'text', true, [1, 2]])
  })
})

// ---------------------------------------------------------------------------
// Child environment allowlist
// ---------------------------------------------------------------------------

describe('child env allowlist', () => {
  test('forwards PATH and HOME so the child can function', () => {
    // A child with no PATH cannot resolve its own subprocesses and a child with
    // no HOME cannot find its credential store; both look like RAYU bugs.
    const env = buildChildEnv()
    expect(env.PATH).toBe(process.env.PATH!)
    expect(env.HOME).toBe(process.env.HOME!)
  })

  test('does not forward provider credentials from the ambient environment', () => {
    const saved = { ...process.env }
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-secret'
      process.env.OPENAI_API_KEY = 'sk-oai-secret'
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret'
      process.env.RAYU_GATEWAY_TOKEN = 'gw-secret'
      const env = buildChildEnv()
      const serialized = JSON.stringify(env)
      expect(serialized).not.toContain('sk-ant-secret')
      expect(serialized).not.toContain('sk-oai-secret')
      expect(serialized).not.toContain('aws-secret')
      expect(serialized).not.toContain('gw-secret')
    } finally {
      process.env = saved
    }
  })

  test('refuses a credential-shaped name even when an adapter asks for it', () => {
    // NEVER_FORWARD is the backstop against a future contributor widening the
    // `forward` list.
    const saved = { ...process.env }
    try {
      process.env.SOME_API_KEY = 'leaked'
      process.env.MY_TOKEN = 'leaked'
      const env = buildChildEnv({ forward: ['SOME_API_KEY', 'MY_TOKEN'] })
      expect(env.SOME_API_KEY).toBeUndefined()
      expect(env.MY_TOKEN).toBeUndefined()
    } finally {
      process.env = saved
    }
  })

  test('forwards a named non-secret variable', () => {
    const saved = { ...process.env }
    try {
      process.env.CODEX_HOME = '/home/u/.codex'
      expect(buildChildEnv({ forward: ['CODEX_HOME'] }).CODEX_HOME).toBe(
        '/home/u/.codex',
      )
    } finally {
      process.env = saved
    }
  })

  test('a forwarded name that is absent is simply omitted', () => {
    const env = buildChildEnv({ forward: ['DEFINITELY_NOT_SET_12345'] })
    expect('DEFINITELY_NOT_SET_12345' in env).toBe(false)
  })

  test('set values win over forwarded ones', () => {
    const saved = { ...process.env }
    try {
      process.env.CLAUDE_CONFIG_DIR = '/ambient'
      const env = buildChildEnv({
        forward: ['CLAUDE_CONFIG_DIR'],
        set: { CLAUDE_CONFIG_DIR: '/explicit' },
      })
      expect(env.CLAUDE_CONFIG_DIR).toBe('/explicit')
    } finally {
      process.env = saved
    }
  })

  test('an explicit set is honoured even for a credential-shaped name', () => {
    // The allowlist governs FORWARDING. An explicit set is the adapter's own
    // considered choice, e.g. handing an adopted server its own bearer token.
    const env = buildChildEnv({ set: { AGENT_API_KEY: 'chosen' } })
    expect(env.AGENT_API_KEY).toBe('chosen')
  })

  test('does not forward proxy variables', () => {
    // Routing a foreign agent's traffic through RAYU's proxy is the user's
    // decision to make in that agent's config, not RAYU's to make silently.
    const saved = { ...process.env }
    try {
      process.env.HTTPS_PROXY = 'http://proxy:8080'
      process.env.http_proxy = 'http://proxy:8080'
      const env = buildChildEnv()
      expect(env.HTTPS_PROXY).toBeUndefined()
      expect(env.http_proxy).toBeUndefined()
    } finally {
      process.env = saved
    }
  })

  test.each([
    ['ANTHROPIC_API_KEY', false],
    ['OPENAI_BASE_URL', false],
    ['AWS_REGION', false],
    ['GITHUB_TOKEN', false],
    ['DB_PASSWORD', false],
    ['SERVICE_CREDENTIALS', false],
    ['CODEX_HOME', true],
    ['CLAUDE_CONFIG_DIR', true],
    ['PATH', true],
    ['NO_COLOR', true],
  ])('isForwardableEnvName(%s) === %s', (name, expected) => {
    expect(isForwardableEnvName(name)).toBe(expected)
  })

  test('returns a fresh object each call', () => {
    const a = buildChildEnv()
    const b = buildChildEnv()
    expect(a).not.toBe(b)
    a.MUTATED = 'yes'
    expect(b.MUTATED).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// JSON-RPC peer
// ---------------------------------------------------------------------------

describe('json-rpc stdio peer', () => {
  type Harness = ReturnType<typeof peerHarness>

  function peerHarness(
    options: Partial<Parameters<typeof createJsonRpcPeer>[0]> = {},
  ) {
    const toChild = new PassThrough()
    const fromChild = new PassThrough()
    const written: Record<string, unknown>[] = []
    toChild.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (line.trim()) written.push(JSON.parse(line))
      }
    })
    const notifications: { method: string; params?: unknown }[] = []
    const closes: string[] = []
    const peer = createJsonRpcPeer({
      output: toChild,
      input: fromChild,
      label: 'test-peer',
      onNotification: n => notifications.push(n),
      onClose: r => closes.push(r),
      ...options,
    })
    return { peer, written, notifications, closes, fromChild, toChild }
  }

  /** Answer whatever request the peer most recently wrote. */
  function reply(h: Harness, result: unknown, index = -1): void {
    const sent = h.written.at(index)!
    h.fromChild.write(`${JSON.stringify({ id: sent.id, result })}\n`)
  }

  test('correlates a response to its request by id', async () => {
    const h = peerHarness()
    const promise = h.peer.request('initialize', { v: 1 })
    await tick()
    expect(h.written[0]!.method).toBe('initialize')
    expect(h.written[0]!.params).toEqual({ v: 1 })
    reply(h, { ok: true })
    expect(await promise).toEqual({ ok: true })
  })

  test('omits jsonrpc version by default (Codex) and includes it on request (ACP)', async () => {
    const codex = peerHarness()
    void codex.peer.request('m').catch(() => {})
    await tick()
    expect(codex.written[0]!.jsonrpc).toBeUndefined()

    const acp = peerHarness({ includeJsonRpcVersion: true })
    void acp.peer.request('m').catch(() => {})
    await tick()
    expect(acp.written[0]!.jsonrpc).toBe('2.0')
  })

  test('interleaved responses resolve the right callers', async () => {
    const h = peerHarness()
    const first = h.peer.request('a')
    const second = h.peer.request('b')
    await tick()
    // Answer out of order — correlation is by id, not arrival order.
    reply(h, 'B', -1)
    reply(h, 'A', -2)
    expect(await first).toBe('A')
    expect(await second).toBe('B')
  })

  test('an error response rejects with the code intact', async () => {
    const h = peerHarness()
    const promise = h.peer.request('turn/steer', {}, { retry: false })
    await tick()
    h.fromChild.write(
      `${JSON.stringify({
        id: h.written[0]!.id,
        error: { code: -32602, message: 'ActiveTurnNotSteerable' },
      })}\n`,
    )
    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonRpcError)
    expect((error as JsonRpcError).code).toBe(-32602)
    expect((error as JsonRpcError).method).toBe('turn/steer')
    expect((error as Error).message).toContain('ActiveTurnNotSteerable')
  })

  test('notifications reach onNotification as one envelope', async () => {
    const h = peerHarness()
    h.fromChild.write(
      '{"method":"session/update","params":{"sessionUpdate":"plan"}}\n',
    )
    await tick()
    expect(h.notifications).toEqual([
      { method: 'session/update', params: { sessionUpdate: 'plan' } },
    ])
  })

  test('a server request with no handler still gets an answer', async () => {
    // An unanswered server request blocks the agent's turn forever.
    const h = peerHarness()
    h.fromChild.write('{"id":99,"method":"fs/read_text_file","params":{}}\n')
    await tick()
    const answer = h.written.find(m => m.id === 99)!
    expect(answer).toBeDefined()
    expect((answer.error as { code: number }).code).toBe(
      JSON_RPC_METHOD_NOT_FOUND,
    )
  })

  test('a handled server request replies with the handler result', async () => {
    const seen: unknown[] = []
    const h = peerHarness({
      onServerRequest: async req => {
        seen.push(req)
        return { outcome: { outcome: 'selected', optionId: 'allow' } }
      },
    })
    h.fromChild.write(
      '{"id":7,"method":"session/request_permission","params":{"x":1}}\n',
    )
    await tick(15)
    expect(seen).toEqual([
      { id: 7, method: 'session/request_permission', params: { x: 1 } },
    ])
    const answer = h.written.find(m => m.id === 7)!
    expect(answer.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
  })

  test('a throwing server-request handler returns a JSON-RPC error, not silence', async () => {
    const h = peerHarness({
      onServerRequest: async () => {
        throw new Error('cannot express that decision')
      },
    })
    h.fromChild.write('{"id":8,"method":"session/request_permission"}\n')
    await tick(15)
    const answer = h.written.find(m => m.id === 8)!
    expect((answer.error as { code: number }).code).toBe(-32603)
    expect((answer.error as { message: string }).message).toContain(
      'cannot express',
    )
  })

  test('times out rather than hanging forever', async () => {
    const h = peerHarness({ requestTimeoutMs: 20 })
    const error = await h.peer
      .request('slow', undefined, { retry: false })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonRpcTimeoutError)
    expect((error as Error).message).toContain('20ms')
  })

  test('a late reply after a timeout is reported, not fatal', async () => {
    const errors: string[] = []
    const h = peerHarness({
      requestTimeoutMs: 15,
      onTransportError: e => errors.push(e.message),
    })
    await h.peer.request('slow', undefined, { retry: false }).catch(() => {})
    reply(h, 'too late')
    await tick()
    expect(errors.some(e => e.includes('response for unknown id'))).toBe(true)
    expect(h.peer.closed).toBe(false)
  })

  test('close settles every pending request instead of leaving callers hanging', async () => {
    const h = peerHarness()
    const first = h.peer.request('a', undefined, { retry: false })
    const second = h.peer.request('b', undefined, { retry: false })
    await tick()
    h.peer.close('child exited')
    const errors = await Promise.all([
      first.catch((e: unknown) => e),
      second.catch((e: unknown) => e),
    ])
    for (const error of errors) {
      expect(error).toBeInstanceOf(JsonRpcClosedError)
      expect((error as Error).message).toContain('child exited')
    }
  })

  test('the stream ending closes the peer and settles pending work', async () => {
    const h = peerHarness()
    const promise = h.peer.request('a', undefined, { retry: false })
    await tick()
    h.fromChild.end()
    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonRpcClosedError)
    expect(h.peer.closed).toBe(true)
    expect(h.closes).toHaveLength(1)
  })

  test('a request after close rejects immediately', async () => {
    const h = peerHarness()
    h.peer.close()
    const error = await h.peer.request('a').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JsonRpcClosedError)
    expect((error as Error).message).toContain('already closed')
  })

  test('close is idempotent', () => {
    const h = peerHarness()
    h.peer.close('first')
    h.peer.close('second')
    expect(h.closes).toEqual(['first'])
  })

  test('writes after close are dropped silently', async () => {
    const h = peerHarness()
    h.peer.close()
    h.peer.notify('ignored')
    await tick()
    expect(h.written).toEqual([])
  })

  test('retries a retryable code and eventually succeeds', async () => {
    const h = peerHarness({ maxRetries: 2 })
    const promise = h.peer.request('thread/start')
    await tick()
    // Fail the first attempt with the documented overload code.
    h.fromChild.write(
      `${JSON.stringify({
        id: h.written[0]!.id,
        error: { code: CODEX_SERVER_OVERLOADED, message: 'Server overloaded' },
      })}\n`,
    )
    // Backoff is 250ms + jitter for attempt 0.
    await tick(700)
    expect(h.written).toHaveLength(2)
    reply(h, { thread: { id: 'th_1' } })
    expect(await promise).toEqual({ thread: { id: 'th_1' } })
  }, 10_000)

  test('does not retry a non-retryable code', async () => {
    const h = peerHarness({ maxRetries: 3 })
    const promise = h.peer.request('turn/steer')
    await tick()
    h.fromChild.write(
      `${JSON.stringify({
        id: h.written[0]!.id,
        error: { code: -32602, message: 'ActiveTurnNotSteerable' },
      })}\n`,
    )
    await promise.catch(() => {})
    await tick(600)
    expect(h.written).toHaveLength(1)
  })

  test('retry: false skips the retry loop entirely', async () => {
    const h = peerHarness()
    const promise = h.peer.request('m', undefined, { retry: false })
    await tick()
    h.fromChild.write(
      `${JSON.stringify({
        id: h.written[0]!.id,
        error: { code: CODEX_SERVER_OVERLOADED, message: 'overloaded' },
      })}\n`,
    )
    await promise.catch(() => {})
    await tick(600)
    expect(h.written).toHaveLength(1)
  })

  test('notify writes no id, so no response is awaited', async () => {
    const h = peerHarness()
    h.peer.notify('session/cancel', { sessionId: 's1' })
    await tick()
    expect(h.written[0]).toEqual({
      method: 'session/cancel',
      params: { sessionId: 's1' },
    })
    expect('id' in h.written[0]!).toBe(false)
  })

  test('respond and respondWithError write bare envelopes', async () => {
    const h = peerHarness()
    h.peer.respond(1, { ok: true })
    h.peer.respondWithError(2, { code: -1, message: 'nope' })
    await tick()
    expect(h.written[0]).toEqual({ id: 1, result: { ok: true } })
    expect(h.written[1]).toEqual({ id: 2, error: { code: -1, message: 'nope' } })
  })

  test('a malformed inbound message is reported, not fatal', async () => {
    const errors: string[] = []
    const h = peerHarness({ onTransportError: e => errors.push(e.message) })
    h.fromChild.write('{"neither":"id nor method"}\n')
    h.fromChild.write('42\n')
    await tick()
    expect(errors.some(e => e.includes('neither id nor method'))).toBe(true)
    expect(errors.some(e => e.includes('not a JSON object'))).toBe(true)
    expect(h.peer.closed).toBe(false)
  })

  test('id 0 and null id are distinguished correctly', async () => {
    // `id: null` is a notification-shaped message in practice; `id: 0` is a real
    // response id and must not be treated as absent.
    const h = peerHarness()
    h.fromChild.write('{"id":0,"result":"zero"}\n')
    h.fromChild.write('{"id":null,"method":"notif"}\n')
    await tick()
    expect(h.notifications.map(n => n.method)).toEqual(['notif'])
  })
})
