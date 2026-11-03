/**
 * The REAL engine, from source, headless over stream-json (the protocol Rayucode
 * speaks), against a fixture Anthropic Messages endpoint that publishes each request's
 * charge the way the Rayu gateway does: a `rayu` member on `message_delta`, or on a
 * non-streaming body. Only the model is fake; SSE parsing, `claude.ts`, the charge
 * accounting and the result frames are the engine's own.
 *
 * The endpoint is an anthropic-compatible provider rather than a signed-in Rayu
 * session because the wire shape is identical and it needs no account; the Rayu
 * API-key provider is exactly this configuration pointed at the gateway.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')

export type Frame = Record<string, any>

/** How the fixture answers one `POST /v1/messages`. */
export type FixtureReply =
  | { kind: 'stream'; sse: string; delayMs?: number }
  | { kind: 'json'; body: unknown }
  | { kind: 'status'; status: number }

export type CreditsEngine = {
  /** Every stdout frame the engine wrote, in order. */
  frames: Frame[]
  /** Sends a user prompt; returns the index of the first frame after it. */
  prompt: (text: string) => number
  /** The first `result` frame at or after `from`. */
  nextResult: (from: number, timeoutMs?: number) => Promise<Frame>
  /** Waits until the engine reports idle after `from` and stays quiet briefly. */
  waitForIdle: (from: number, timeoutMs?: number) => Promise<void>
  close: () => Promise<void>
}

export function sse(events: Array<[string, Frame]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function messageStart(model: string): [string, Frame] {
  // A unique id per reply, as a real provider sends. The engine merges consecutive
  // assistant messages that share an id, which folds separate turns into one.
  return ['message_start', { type: 'message_start', message: { id: `msg_fixture_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } }]
}

function messageEnd(stopReason: string, rayu: Frame | undefined): Array<[string, Frame]> {
  return [
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 }, ...(rayu && { rayu }) }],
    ['message_stop', { type: 'message_stop' }],
  ]
}

/** A streamed text answer, charged `rayu` (omit it for a provider that publishes nothing). */
export function textStream(model: string, text: string, rayu?: Frame): string {
  return sse([
    messageStart(model),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ...messageEnd('end_turn', rayu),
  ])
}

/** A streamed tool call, charged `rayu`. */
export function toolUseStream(model: string, call: { id: string; name: string; input: Frame }, rayu?: Frame): string {
  return sse([
    messageStart(model),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ...messageEnd('tool_use', rayu),
  ])
}

/** A gateway-shaped charge member. */
export function charge(credits: number): Frame {
  return { billableTokens: Math.round(credits * 1000), tokensPerCredit: 1000, credits }
}

/** The text of a message's content, string or blocks. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block && typeof block === 'object' && typeof (block as Frame).text === 'string' ? (block as Frame).text : ''))
    .join('\n')
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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function startCreditsEngine(
  respond: (body: Frame) => FixtureReply | Promise<FixtureReply>,
): Promise<CreditsEngine> {
  const root = mkdtempSync(join(tmpdir(), 'rayu-turn-credits-'))
  const home = join(root, 'home')
  const configDir = join(root, 'config')
  const project = join(root, 'project')
  for (const dir of [home, configDir, project]) mkdirSync(dir)

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/v1/messages/count_tokens')) return Response.json({ input_tokens: 12 })
      if (path.endsWith('/v1/models')) return Response.json({ data: [{ id: 'test-model', type: 'model' }], has_more: false })
      if (!path.endsWith('/v1/messages') || req.method !== 'POST') return new Response('', { status: 404 })
      const reply = await respond((await req.json()) as Frame)
      if (reply.kind === 'status') return new Response('', { status: reply.status })
      if (reply.kind === 'json') return Response.json(reply.body)
      if (reply.delayMs) await sleep(reply.delayMs)
      return new Response(reply.sse, { headers: { 'content-type': 'text/event-stream' } })
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

  const child = Bun.spawn(
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
        // `session_state_changed: idle` is the engine's "everything, background
        // work included, is done" (Rayucode sets it too).
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tmpdir(), 'rayu-harness-transpiler-cache'),
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const frames: Frame[] = []
  let stderrText = ''
  const write = (frame: Frame) => {
    child.stdin.write(`${JSON.stringify(frame)}\n`)
    child.stdin.flush()
  }
  void readLines(child.stdout, line => {
    let frame: Frame
    try { frame = JSON.parse(line) } catch { return }
    frames.push(frame)
    // Tools ask over stdio; allow them unchanged, as an approving user would.
    if (frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool') {
      write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updatedInput: frame.request?.input ?? {} } } })
    }
  })
  void readLines(child.stderr, line => {
    stderrText = `${stderrText}${line}\n`.slice(-20_000)
  })

  const describe = () => `last frames: ${JSON.stringify(frames.slice(-5)).slice(0, 2000)}\nstderr: ${stderrText.slice(-2000)}`

  return {
    frames,
    prompt(text) {
      const from = frames.length
      write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
      return from
    },
    async nextResult(from, timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = frames.slice(from).find(f => f.type === 'result')
        if (found) return found
        await sleep(50)
      }
      throw new Error(`no result frame within ${timeoutMs}ms.\n${describe()}`)
    },
    async waitForIdle(from, timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs
      const isIdle = (f: Frame) => f.type === 'system' && f.subtype === 'session_state_changed' && f.state === 'idle'
      while (Date.now() < deadline) {
        const idleAt = frames.findIndex((f, i) => i >= from && isIdle(f))
        if (idleAt !== -1) {
          // Quiet after idle proves no further turn was already on its way.
          await sleep(500)
          if (!frames.slice(idleAt + 1).some(f => f.type !== 'system')) return
          from = idleAt + 1
          continue
        }
        await sleep(50)
      }
      throw new Error(`the engine did not go idle within ${timeoutMs}ms.\n${describe()}`)
    },
    async close() {
      child.kill()
      await child.exited
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    },
  }
}
