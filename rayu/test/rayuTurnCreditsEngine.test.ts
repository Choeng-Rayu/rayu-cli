/**
 * End to end through the REAL engine, from source, headless over stream-json (the
 * protocol Rayucode speaks): a provider that publishes each request's charge the way
 * the Rayu gateway does -- a `rayu` member on `message_delta`, and on a non-streaming
 * body -- must come back as the turn's `rayu_credits` on the `result` frame.
 *
 * Only the model is fake. The SDK's SSE parsing, `claude.ts`, the charge accounting and
 * `QueryEngine`'s result frame are the engine's own. The fixture endpoint is an
 * anthropic-compatible provider rather than a signed-in Rayu session because the wire
 * shape is identical and it needs no account; the Rayu API-key provider is exactly
 * this configuration pointed at the gateway.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

/** What the fixture says each kind of request cost. */
const STREAM_CHARGE = { billableTokens: 443_760, tokensPerCredit: 1000, credits: 443.76 }
const BODY_CHARGE = { billableTokens: 500, tokensPerCredit: 1000, credits: 0.5 }

type Frame = Record<string, any>

let root: string
let server: ReturnType<typeof Bun.serve>
let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
const frames: Frame[] = []
/** Requests answered, by kind, so the expected total is known exactly. */
const answered = { stream: 0, body: 0 }
/** When false the fixture publishes no charge at all, like an older gateway or BYOK. */
let publishCharges = true
/** When true the streaming endpoint answers 404, which sends the engine to its non-streaming fallback. */
let refuseStreaming = false
let stderrText = ''

function sse(events: Array<[string, Frame]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function streamFor(model: string): string {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from the fixture.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 }, ...(publishCharges && { rayu: STREAM_CHARGE }) }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) onLine(line)
      newline = buffer.indexOf('\n')
    }
  }
}

async function nextResult(from: number, timeoutMs = 90_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = frames.slice(from).find(f => f.type === 'result')
    if (found) return found
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`no result frame within ${timeoutMs}ms.\nlast frames: ${JSON.stringify(frames.slice(-5)).slice(0, 2000)}\nstderr: ${stderrText.slice(-2000)}`)
}

function prompt(text: string): number {
  if (!child) throw new Error('the engine is not running')
  const from = frames.length
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })}\n`)
  child.stdin.flush()
  return from
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rayu-turn-credits-'))
  const home = join(root, 'home')
  const configDir = join(root, 'config')
  const project = join(root, 'project')
  for (const dir of [home, configDir, project]) mkdirSync(dir)

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/v1/messages/count_tokens')) return Response.json({ input_tokens: 12 })
      if (path.endsWith('/v1/models')) return Response.json({ data: [{ id: 'test-model', type: 'model' }], has_more: false })
      if (!path.endsWith('/v1/messages') || req.method !== 'POST') return new Response('', { status: 404 })
      const body = (await req.json()) as Frame
      if (body.stream && refuseStreaming) return new Response('', { status: 404 })
      if (body.stream) {
        if (publishCharges) answered.stream++
        return new Response(streamFor(body.model), { headers: { 'content-type': 'text/event-stream' } })
      }
      if (publishCharges) answered.body++
      return Response.json({
        id: 'msg_fixture_body', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
        ...(publishCharges && { rayu: BODY_CHARGE }),
      })
    },
  })

  writeFileSync(join(configDir, 'providers.json'), JSON.stringify({
    activeProvider: 'fixture',
    providers: [{
      id: 'fixture',
      kind: 'anthropic-compatible',
      baseURL: server.url.origin,
      apiKey: 'fixture-key',
      defaultModel: 'test-model',
      fetchedModels: ['test-model'],
      modelContextWindows: { 'test-model': 200_000 },
    }],
  }), { mode: 0o600 })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ alwaysThinkingEnabled: false }))

  child = Bun.spawn(
    [
      process.execPath,
      '--preload', join(ROOT, 'scripts/preload.ts'),
      join(ROOT, 'src/entrypoints/cli.tsx'),
      '--print', '--input-format=stream-json', '--output-format=stream-json', '--verbose',
      '--permission-prompt-tool=stdio',
    ],
    {
      cwd: project,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TMPDIR: tmpdir(),
        LANG: 'C.UTF-8',
        USER_TYPE: 'external',
        RAYU_CONFIG_DIR: configDir,
        RAYU_AUTH_CONFIG_DIR: configDir,
        USE_RAYU_OAUTH: 'false',
        RAYU_EXTERNAL_AGENTS: '0',
        NO_COLOR: '1',
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tmpdir(), 'rayu-harness-transpiler-cache'),
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  void readLines(child.stdout, line => {
    try { frames.push(JSON.parse(line)) } catch { /* not a frame */ }
  })
  void readLines(child.stderr, line => {
    stderrText = `${stderrText}${line}\n`.slice(-20_000)
  })
})

afterAll(async () => {
  child?.kill()
  await child?.exited
  server?.stop(true)
  if (root) rmSync(root, { recursive: true, force: true })
})

test('a charged turn reports what the provider said it cost, and a turn with no charge reports none', async () => {
  const first = await nextResult(prompt('Say hello.'))
  expect(first.subtype).toBe('success')
  expect(answered.stream).toBeGreaterThanOrEqual(1)
  // Every Rayu-billed request in the turn, summed: the main stream plus anything else
  // (a side query is a non-streaming body) that ran before the turn ended.
  const expected = answered.stream * STREAM_CHARGE.credits + answered.body * BODY_CHARGE.credits
  expect(first.rayu_credits).toBeCloseTo(expected, 6)

  // A provider that publishes nothing -- bring-your-own key, or an older gateway --
  // leaves the field off rather than reporting 0, and the first turn's charge does
  // not leak into the second.
  publishCharges = false
  const second = await nextResult(prompt('Say hello again.'))
  expect(second.subtype).toBe('success')
  expect('rayu_credits' in second).toBe(false)
}, 180_000)

test('a request that fell back to non-streaming reports the charge its body carried', async () => {
  publishCharges = true
  refuseStreaming = true
  answered.stream = 0
  answered.body = 0
  const result = await nextResult(prompt('One more time.'))
  expect(result.subtype).toBe('success')
  expect(answered.stream).toBe(0)
  expect(answered.body).toBeGreaterThanOrEqual(1)
  expect(result.rayu_credits).toBeCloseTo(answered.body * BODY_CHARGE.credits, 6)
}, 180_000)
