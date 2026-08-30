/**
 * The OpenCode adapter, driven against a REAL loopback HTTP + SSE server.
 *
 * OpenCode is the one adapter that speaks HTTP rather than stdio, so the fake is
 * a `Bun.serve` on 127.0.0.1 implementing the endpoints the adapter actually
 * calls. That exercises the parts a mocked `fetch` would not: the hand-rolled
 * SSE reader against a genuine `ReadableStream`, the health-shape check that
 * stops another service on the port being mistaken for OpenCode, and the
 * loopback-only guard.
 *
 * The decision that most needs protecting: `stop()` on an ADOPTED server only
 * disconnects. Killing a server RAYU does not own would close the TUI the user is
 * sitting in front of.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createOpenCodeAdapter,
  OPENCODE_PROVIDER,
} from '../src/externalAgents/adapters/opencode/OpenCodeAdapter.ts'
import {
  createOpenCodeClient,
  discoverOpenCodeServer,
  OpenCodeHttpError,
  probeOpenCodePort,
} from '../src/externalAgents/adapters/opencode/httpClient.ts'
import { resetEventBus, subscribeToEvents } from '../src/externalAgents/core/eventBus.ts'
import { resetAgentManager } from '../src/externalAgents/core/AgentManager.ts'
import { resetAdapterRegistry } from '../src/externalAgents/core/adapterRegistry.ts'
import type { AgentInstanceId, ExternalAgentEvent } from '../src/externalAgents/core/types.ts'
import type { AgentHandle } from '../src/externalAgents/core/adapter.ts'

const AGENT = 'opencode:agent_01' as AgentInstanceId
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms))

type FakeServer = {
  readonly port: number
  /** Push one bus event down the open SSE stream. */
  emit(event: unknown): void
  readonly requests: { method: string; path: string; body?: unknown }[]
  stop(): void
}

/**
 * A fake OpenCode server.
 *
 * `health` is configurable so the "another service on this port" case can be
 * exercised — the adapter must refuse a response that does not look like
 * OpenCode.
 */
function startFakeOpenCode(
  options: {
    health?: unknown
    sessions?: { id: string; title?: string; time?: { updated?: number } }[]
    failPrompt?: boolean
  } = {},
): FakeServer {
  const requests: FakeServer['requests'] = []
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  let sessions = options.sessions ?? []
  let created = 0

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      let body: unknown
      if (request.method === 'POST') {
        body = await request.json().catch(() => undefined)
      }
      requests.push({ method: request.method, path, body })

      if (path === '/global/health') {
        return Response.json(
          options.health ?? { healthy: true, version: '0.1.0-fake' },
        )
      }
      if (path === '/event') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.add(controller)
            // A comment heartbeat: must be skipped silently, not logged as an error.
            controller.enqueue(encoder.encode(': ping\n\n'))
          },
          cancel(controller) {
            controllers.delete(controller as never)
          },
        })
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (path === '/session' && request.method === 'GET') {
        return Response.json(sessions)
      }
      if (path === '/session' && request.method === 'POST') {
        const id = `sess_fake_${++created}`
        sessions = [...sessions, { id, time: { updated: Date.now() } }]
        return Response.json({ id })
      }
      if (path.endsWith('/prompt_async')) {
        return options.failPrompt
          ? new Response('model unavailable', { status: 503 })
          : Response.json({ ok: true })
      }
      if (path.endsWith('/abort')) return Response.json({ ok: true })
      if (path.includes('/permissions/')) return Response.json({ ok: true })
      return Response.json({})
    },
  })

  return {
    // `Bun.serve().port` is typed optional, but a listening server always has one.
    port: server.port!,
    emit(event) {
      const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
      for (const controller of controllers) {
        try {
          controller.enqueue(payload)
        } catch {
          controllers.delete(controller)
        }
      }
    },
    requests,
    stop() {
      for (const controller of controllers) {
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }
      controllers.clear()
      server.stop(true)
    },
  }
}

let dir: string
let events: ExternalAgentEvent[]
let unsubscribe: (() => void) | undefined
const servers: FakeServer[] = []
const handles: AgentHandle[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-opencode-'))
  process.env.RAYU_CONFIG_DIR = join(dir, 'config')
  resetAdapterRegistry()
  resetAgentManager()
  resetEventBus()
  events = []
  unsubscribe = subscribeToEvents(event => events.push(event))
})

afterEach(async () => {
  unsubscribe?.()
  for (const handle of handles.splice(0)) {
    await handle.detach().catch(() => undefined)
  }
  for (const server of servers.splice(0)) server.stop()
  resetAdapterRegistry()
  resetAgentManager()
  resetEventBus()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

function fake(options: Parameters<typeof startFakeOpenCode>[0] = {}): FakeServer {
  const server = startFakeOpenCode(options)
  servers.push(server)
  return server
}

/** Adopt the fake as if the user had started `opencode serve` themselves. */
async function adopt(server: FakeServer): Promise<AgentHandle> {
  const handle = await createOpenCodeAdapter().adopt!({
    agentId: AGENT,
    cwd: dir,
    transport: { kind: 'http', endpoint: `http://127.0.0.1:${server.port}` },
  })
  handles.push(handle)
  return handle
}

const typesOf = () => events.map(e => e.type)

/**
 * Wait until `predicate` holds, polling with a deadline.
 *
 * The fake is a real HTTP server pushing a real SSE stream, so a fixed sleep
 * passes in isolation and flakes under a loaded suite. Polling ties the assertion
 * to the event actually arriving.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick(10)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms; events seen: ${typesOf().join(', ') || '(none)'}`,
  )
}

/** Wait for one normalized event type to arrive. */
const waitForType = (type: ExternalAgentEvent['type']) =>
  waitFor(() => typesOf().includes(type))

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

describe('opencode http client', () => {
  test('probes the health endpoint and reports the version', async () => {
    const server = fake()
    const health = await probeOpenCodePort(server.port)
    expect(health).toMatchObject({ healthy: true, version: '0.1.0-fake' })
  })

  test('a response that does not LOOK like OpenCode is refused', async () => {
    // Another service on this port must not be mistaken for OpenCode.
    const server = fake({ health: { message: 'welcome to some other api' } })
    expect(await probeOpenCodePort(server.port)).toBeNull()
  })

  test('a version-only health response is accepted', async () => {
    const server = fake({ health: { version: '9.9.9' } })
    expect(await probeOpenCodePort(server.port)).toMatchObject({ version: '9.9.9' })
  })

  test('a closed port probes as null rather than throwing', async () => {
    // Port 1 is reserved and never listening.
    expect(await probeOpenCodePort(1, '127.0.0.1', 250)).toBeNull()
  })

  test('discovery finds a server on an explicitly named port', async () => {
    const server = fake()
    const found = await discoverOpenCodeServer(server.port)
    expect(found?.port).toBe(server.port)
  })

  test('an HTTP error carries the status', async () => {
    const server = fake({ failPrompt: true })
    const client = createOpenCodeClient({ port: server.port })
    const error = await client
      .post('/session/x/prompt_async', {})
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpenCodeHttpError)
    expect((error as OpenCodeHttpError & { status: number }).status).toBe(503)
  })

  test('refuses a non-loopback host', async () => {
    // The client is loopback-only by construction: an OpenCode server is a local
    // development tool, and pointing RAYU's credentials at a remote host would be
    // a different and much riskier feature.
    expect(() => createOpenCodeClient({ host: '10.0.0.5', port: 4096 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

describe('opencode adoption', () => {
  test('adopting a running server yields a process-durable handle', async () => {
    const server = fake()
    const handle = await adopt(server)
    expect(handle.provider).toBe(OPENCODE_PROVIDER)
    expect(handle.adoption).toBe('adoptable')
    // The server outlives RAYU, so it can be reconnected to.
    expect(handle.durability).toBe('process-durable')
    expect(handle.transport.kind).toBe('http')
    // Adopted over the network, so RAYU never learns a pid.
    expect(handle.pid).toBeUndefined()
    expect(handle.status().processState).toBe('absent')
  })

  test('adoption creates a session when the server has none', async () => {
    const server = fake({ sessions: [] })
    const handle = await adopt(server)
    expect(String(handle.activeSessionId())).toBe('sess_fake_1')
    expect(server.requests.some(r => r.method === 'POST' && r.path === '/session')).toBe(
      true,
    )
  })

  test('adoption prefers the MOST RECENTLY UPDATED session', async () => {
    // That is the conversation the user is actually looking at.
    const server = fake({
      sessions: [
        { id: 'old', time: { updated: 1_000 } },
        { id: 'newest', time: { updated: 9_000 } },
        { id: 'middle', time: { updated: 5_000 } },
      ],
    })
    const handle = await adopt(server)
    expect(String(handle.activeSessionId())).toBe('newest')
  })

  test('adopting with no server explains the random-port limitation', async () => {
    await expect(
      createOpenCodeAdapter().adopt!({
        agentId: AGENT,
        cwd: dir,
        transport: { kind: 'http', endpoint: 'http://127.0.0.1:1' },
      }),
    ).rejects.toThrow(/random port/)
  })

  test('reconnect refuses when nothing answers', async () => {
    await expect(
      createOpenCodeAdapter().reconnect!({
        agentInstanceId: AGENT,
        provider: 'opencode',
        slot: 'agent_01',
        adoption: 'adoptable',
        durability: 'process-durable',
        capabilities: {
          terminal: 'none',
          messages: 'full',
          sessions: 'full',
          process: 'none',
          permissions: 'full',
        },
        transport: { kind: 'http', endpoint: 'http://127.0.0.1:1' },
        cwd: dir,
        ownerPid: process.pid,
        ownerSessionId: 'x',
        processState: 'absent',
        connectionState: 'disconnected',
        agentState: 'idle',
        createdAt: 1,
        updatedAt: 1,
      } as never),
    ).rejects.toThrow(/no OpenCode server/)
  })
})

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

describe('opencode event stream', () => {
  test('cumulative text snapshots arrive as INCREMENTS', async () => {
    // The server sends the part's full text each time; emitting each snapshot
    // verbatim would render H, He, Hel, … into the transcript.
    const server = fake()
    await adopt(server)

    server.emit({
      type: 'message.part.updated',
      properties: { part: { id: 'p1', type: 'text', text: 'Hel' } },
    })
    server.emit({
      type: 'message.part.updated',
      properties: { part: { id: 'p1', type: 'text', text: 'Hello there' } },
    })
    await waitFor(() => events.filter(e => e.type === 'agent_message').length === 2)

    const texts = events
      .filter(e => e.type === 'agent_message')
      .map(e => (e as { text: string }).text)
    expect(texts).toEqual(['Hel', 'lo there'])
  })

  test('a completed edit tool reports a file change', async () => {
    const server = fake()
    await adopt(server)
    server.emit({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 't1',
          type: 'tool',
          tool: 'edit',
          state: { status: 'completed', input: { filePath: '/src/a.ts' }, output: 'ok' },
        },
      },
    })
    await waitForType('file_changed')
    expect(typesOf()).toContain('tool_started')
    expect(typesOf()).toContain('tool_output')
    expect(typesOf()).toContain('file_changed')
  })

  test('session.idle completes the task', async () => {
    const server = fake()
    await adopt(server)
    server.emit({ type: 'session.idle', properties: {} })
    await waitForType('task_completed')
    expect(typesOf()).toContain('task_completed')
  })

  test('a provider error stays alive rather than failing the task', async () => {
    const server = fake()
    await adopt(server)
    server.emit({
      type: 'session.error',
      properties: { error: { name: 'ProviderRateLimitError', message: 'slow down' } },
    })
    await waitForType('agent_error')
    const error = events.find(e => e.type === 'agent_error')
    expect(error).toBeDefined()
    if (error?.type === 'agent_error') expect(error.providerFault).toBe(true)
    expect(typesOf()).not.toContain('task_failed')
  })

  test('a permission request carries the id needed to reply', async () => {
    const server = fake()
    const handle = await adopt(server)
    server.emit({
      type: 'permission.updated',
      properties: {
        permission: { id: 'perm_1', type: 'bash', title: 'run npm install' },
      },
    })
    await waitForType('permission_requested')
    const request = events.find(e => e.type === 'permission_requested')
    expect(request).toBeDefined()
    if (request?.type !== 'permission_requested') return
    await expect(
      handle.respondToPermission!(request.requestId, 'accept'),
    ).resolves.toBeUndefined()
    expect(server.requests.some(r => r.path.includes('/permissions/'))).toBe(true)
  })

  test('heartbeats and unknown events are ignored silently', async () => {
    const server = fake()
    await adopt(server)
    server.emit({ type: 'bus.brand.new', properties: {} })
    server.emit({ type: 'server.connected', properties: {} })
    // Nothing should arrive; a short settle is the only way to assert absence.
    await tick(120)
    expect(events.filter(e => e.type !== 'agent_started')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('opencode operations', () => {
  test('send posts the prompt and marks the agent working', async () => {
    const server = fake()
    const handle = await adopt(server)
    const result = await handle.send({ text: 'refactor auth' })
    expect(result.turnId).toBe('turn_1')
    expect(handle.status().agentState).toBe('working')
    const posted = server.requests.find(r => r.path.endsWith('/prompt_async'))!
    expect(JSON.stringify(posted.body)).toContain('refactor auth')
  })

  test('a failing prompt surfaces the HTTP status', async () => {
    const server = fake({ failPrompt: true })
    const handle = await adopt(server)
    await expect(handle.send({ text: 'x' })).rejects.toThrow(/503/)
  })

  test('interrupt aborts the session', async () => {
    const server = fake()
    const handle = await adopt(server)
    await handle.send({ text: 'long work' })
    await handle.interrupt!('turn_1')
    expect(handle.status().agentState).toBe('interrupted')
    expect(server.requests.some(r => r.path.endsWith('/abort'))).toBe(true)
  })

  test('listSessions reports titles and update times', async () => {
    const server = fake({
      sessions: [{ id: 's1', title: 'auth work', time: { updated: 42 } }],
    })
    const handle = await adopt(server)
    expect(
      (await handle.listSessions!()).map(s => ({
        agentSessionId: String(s.agentSessionId),
        title: s.title,
        updatedAt: s.updatedAt,
      })),
    ).toEqual([{ agentSessionId: 's1', title: 'auth work', updatedAt: 42 }])
  })

  test('resumeSession switches session on the same server', async () => {
    const server = fake({ sessions: [{ id: 's1' }, { id: 's2' }] })
    const handle = await adopt(server)
    await handle.resumeSession!('s2' as never)
    expect(String(handle.activeSessionId())).toBe('s2')
  })

  test('stop on an ADOPTED server only DISCONNECTS', async () => {
    // Terminating a server RAYU does not own would close the TUI the user is
    // sitting in front of.
    const server = fake()
    const handle = await adopt(server)
    await handle.stop()
    expect(handle.status().connectionState).toBe('disconnected')
    // Not killed: RAYU never owned the process.
    expect(handle.status().processState).not.toBe('killed')
    // The server is still answering.
    expect(await probeOpenCodePort(server.port)).not.toBeNull()
  })

  test('detach closes the stream without touching the server', async () => {
    const server = fake()
    const handle = await adopt(server)
    await handle.detach()
    expect(handle.status().connectionState).toBe('disconnected')
    expect(await probeOpenCodePort(server.port)).not.toBeNull()
  })

  test('the server going away is reported as a disconnect', async () => {
    const server = fake()
    await adopt(server)
    server.stop()
    servers.length = 0
    await waitForType('agent_disconnected')
    expect(events.some(e => e.type === 'agent_disconnected')).toBe(true)
  })

  test('capabilities reflect what the HTTP API can actually do', async () => {
    const server = fake()
    const handle = await adopt(server)
    // OpenCode is the ONE provider that can genuinely drive the user's TUI: it
    // exposes /tui/append-prompt and /tui/submit-prompt. So terminal:'full' is
    // honest here, and the method really exists — no invariant violation.
    expect(handle.capabilities.terminal).toBe('full')
    expect(typeof handle.driveTerminal).toBe('function')
    // The permission endpoint is a genuine reply channel.
    expect(handle.capabilities.permissions).not.toBe('none')
    expect(typeof handle.respondToPermission).toBe('function')
  })

  test('steer folds another prompt into the running turn', async () => {
    // OpenCode accepts a prompt while a session is busy and folds it into the
    // work in progress — genuine steering, unlike Claude Code where a mid-turn
    // message becomes its own turn. So `messages: 'full'` is earned, not assumed.
    const server = fake()
    const handle = await adopt(server)
    expect(handle.capabilities.messages).toBe('full')
    await handle.send({ text: 'first' })
    await handle.steer!('turn_1', { text: 'also this' })
    const prompts = server.requests.filter(r => r.path.endsWith('/prompt_async'))
    expect(prompts).toHaveLength(2)
    expect(JSON.stringify(prompts[1]!.body)).toContain('also this')
  })

  test('driveTerminal stages text and only submits when asked', async () => {
    // submit=false leaves it staged so the user can review before sending, which
    // is the polite default for anything RAYU's model composed on its own.
    const server = fake()
    const handle = await adopt(server)

    await handle.driveTerminal!('a suggestion', false)
    expect(server.requests.some(r => r.path === '/tui/append-prompt')).toBe(true)
    expect(server.requests.some(r => r.path === '/tui/submit-prompt')).toBe(false)

    await handle.driveTerminal!('send it', true)
    expect(server.requests.some(r => r.path === '/tui/submit-prompt')).toBe(true)
  })
})
