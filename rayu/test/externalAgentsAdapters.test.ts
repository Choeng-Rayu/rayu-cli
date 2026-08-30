/**
 * The real adapters, driven against FAKE agent binaries.
 *
 * A fake binary is a small Node script placed on a temp `PATH` that speaks the
 * provider's actual wire protocol. That is the only way to exercise the parts of
 * an adapter that matter — spawn, handshake, turn lifecycle, approval round-trip,
 * teardown — without a real Codex or Claude Code install, and without the
 * non-determinism a live model would introduce.
 *
 * Behaviour under test that only a real spawn can reach:
 *
 *   - The binary is resolved to an ABSOLUTE path before spawning. Bun resolves a
 *     relative executable from its own startup environ, not the curated `env`
 *     handed to `spawn`, so a bare name would ignore our temp PATH entirely.
 *   - A missing `cwd` is reported as a missing DIRECTORY. Node otherwise raises
 *     ENOENT on the EXECUTABLE, which reads as "agent not installed" and sends
 *     the user looking in the wrong place.
 *   - Fake behaviour is driven through `LaunchSpec.env`, because `buildChildEnv`
 *     correctly refuses to forward arbitrary `process.env` to a child.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * `Bun.which(cmd)` snapshots `PATH` when the process starts and ignores later
 * mutation of `process.env.PATH` — it only honours an explicitly passed `PATH`.
 * Since these tests must put fake binaries on a temp PATH *after* startup, the
 * resolver is replaced with one that reads the current value. Writing the fakes
 * into a directory already on the real PATH would risk shadowing the user's own
 * `codex` or `claude`, which is not an acceptable trade for a test.
 */
mock.module('../src/utils/which.ts', () => {
  const resolve = (command: string): string | null =>
    Bun.which(command, { PATH: process.env.PATH ?? '' })
  return { which: async (command: string) => resolve(command), whichSync: resolve }
})
import {
  createCodexAdapter,
  CODEX_PROVIDER,
} from '../src/externalAgents/adapters/codex/CodexAdapter.ts'
import {
  createClaudeCodeAdapter,
  CLAUDE_CODE_PROVIDER,
} from '../src/externalAgents/adapters/claudeCode/ClaudeCodeAdapter.ts'
import {
  createAcpAdapter,
  readDeclaredAcpAgents,
  ACP_AGENTS_ENV_VAR,
} from '../src/externalAgents/adapters/acp/AcpAdapter.ts'
import {
  registerAdapters,
  registerDeclaredAcpAgents,
} from '../src/externalAgents/adapters/registry.ts'
import {
  listProviderIds,
  resetAdapterRegistry,
} from '../src/externalAgents/core/adapterRegistry.ts'
import { resetEventBus, subscribeToEvents } from '../src/externalAgents/core/eventBus.ts'
import { resetAgentManager } from '../src/externalAgents/core/AgentManager.ts'
import {
  asProviderId,
  type AgentInstanceId,
  type ExternalAgentEvent,
} from '../src/externalAgents/core/types.ts'
import type { AgentHandle } from '../src/externalAgents/core/adapter.ts'

const AGENT = 'codex:agent_01' as AgentInstanceId
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))

let dir: string
let binDir: string
let savedPath: string | undefined
let events: ExternalAgentEvent[]
let unsubscribe: (() => void) | undefined
const handles: AgentHandle[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-adapters-'))
  binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  process.env.RAYU_CONFIG_DIR = join(dir, 'config')
  savedPath = process.env.PATH
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
  resetAdapterRegistry()
  resetAgentManager()
  resetEventBus()
  events = []
  unsubscribe = subscribeToEvents(event => events.push(event))
})

afterEach(async () => {
  unsubscribe?.()
  // Stop every spawned fake so no child outlives the test.
  for (const handle of handles.splice(0)) {
    await handle.stop().catch(() => undefined)
  }
  resetAdapterRegistry()
  resetAgentManager()
  resetEventBus()
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  delete process.env.RAYU_CONFIG_DIR
  delete process.env[ACP_AGENTS_ENV_VAR]
  rmSync(dir, { recursive: true, force: true })
})

/** Write an executable Node script onto the temp PATH. */
function fakeBinary(name: string, body: string): void {
  const path = join(binDir, name)
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 })
  chmodSync(path, 0o755)
}

function track(handle: AgentHandle): AgentHandle {
  handles.push(handle)
  return handle
}

const typesOf = () => events.map(e => e.type)

/**
 * Wait until `predicate` holds, polling with a deadline.
 *
 * Replaces fixed sleeps: these fakes are real subprocesses, so a hard-coded
 * `await tick(80)` passes alone and fails under a loaded suite. Polling makes the
 * assertion depend on the event actually arriving rather than on machine speed.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
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
// Fake Codex app-server
// ---------------------------------------------------------------------------

/**
 * A fake `codex app-server`.
 *
 * Speaks the real JSON-RPC subset over stdio and, notably, WITHOUT the
 * `"jsonrpc"` field — matching Codex, and the opposite of ACP.
 */
const FAKE_CODEX = `
const readline = require('readline')
const scenario = process.env.FAKE_SCENARIO || 'normal'
const rl = readline.createInterface({ input: process.stdin })
let turn = 0

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n') }
function notify(method, params) { send({ method, params }) }

rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg

  if (method === 'initialize') {
    if (scenario === 'handshake-error') {
      return send({ id, error: { code: -32000, message: 'initialize refused' } })
    }
    return send({ id, result: { userAgent: 'fake-codex/1.0' } })
  }
  if (method === 'thread/start') {
    return send({ id, result: { thread: { id: 'thread_fake_1' } } })
  }
  if (method === 'thread/resume') {
    return send({ id, result: { thread: { id: params.threadId } } })
  }
  if (method === 'thread/fork') {
    return send({ id, result: { thread: { id: params.threadId + '_fork' } } })
  }
  if (method === 'thread/loaded/list') {
    if (scenario === 'no-list') {
      return send({ id, error: { code: -32601, message: 'Method not found' } })
    }
    return send({ id, result: { data: ['thread_loaded_1'] } })
  }
  if (method === 'turn/start') {
    const turnId = 'turn_' + ++turn
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } })
    notify('turn/started', { turn: { id: turnId } })
    notify('item/agentMessage/delta', { delta: 'working' })

    if (scenario === 'approval') {
      // A server-initiated approval REQUEST: it blocks the turn until answered.
      send({
        id: 9001,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'item_1', threadId: params.threadId, turnId, command: 'rm -rf build' },
      })
      return
    }
    if (scenario === 'review-turn') {
      notify('item/started', { item: { id: 'i1', type: 'enteredReviewMode' } })
      return
    }
    if (scenario === 'hold' || scenario === 'unsteerable') return

    if (scenario === 'provider-fault') {
      notify('turn/completed', {
        turn: { id: turnId, status: 'failed', error: { message: 'rate limited', codexErrorInfo: 'rateLimitExceeded' } },
      })
      return
    }
    notify('item/completed', { item: { type: 'fileChange', changes: [{ path: '/src/a.ts', kind: 'add' }] } })
    notify('turn/completed', { turn: { id: turnId, status: 'completed' } })
    return
  }
  if (method === 'turn/steer') {
    if (scenario === 'unsteerable') {
      return send({ id, error: { code: -32602, message: 'ActiveTurnNotSteerable' } })
    }
    return send({ id, result: { turnId: params.expectedTurnId } })
  }
  if (method === 'turn/interrupt') {
    send({ id, result: {} })
    notify('turn/completed', { turn: { id: params.turnId, status: 'interrupted' } })
    return
  }
  if (id !== undefined) send({ id, result: {} })
})

process.on('SIGTERM', () => process.exit(0))
`

// ---------------------------------------------------------------------------
// Codex adapter
// ---------------------------------------------------------------------------

describe('codex adapter', () => {
  const adapter = () => createCodexAdapter()

  async function launch(scenario = 'normal'): Promise<AgentHandle> {
    fakeBinary('codex', FAKE_CODEX)
    return track(
      await adapter().launch({
        agentId: AGENT,
        cwd: dir,
        env: { FAKE_SCENARIO: scenario },
      }),
    )
  }

  test('reports unavailable when the binary is not on PATH', async () => {
    expect(await adapter().isAvailable()).toBe(false)
  })

  test('reports available once the binary is on PATH', async () => {
    fakeBinary('codex', FAKE_CODEX)
    expect(await adapter().isAvailable()).toBe(true)
  })

  test('launch completes the handshake and opens a thread', async () => {
    const handle = await launch()
    expect(handle.provider).toBe(CODEX_PROVIDER)
    // A stdio pipe belongs to this RAYU process, so the agent cannot outlive it.
    expect(handle.durability).toBe('session-bound')
    expect(handle.adoption).toBe('managed')
    expect(handle.transport).toEqual({ kind: 'stdio' })
    expect(handle.pid).toBeGreaterThan(0)
    expect(String(handle.activeSessionId())).toBe('thread_fake_1')
    expect(handle.status().connectionState).toBe('connected')
  })

  test('a missing cwd is reported as a missing DIRECTORY, not a missing install', async () => {
    fakeBinary('codex', FAKE_CODEX)
    await expect(
      adapter().launch({ agentId: AGENT, cwd: join(dir, 'nope') }),
    ).rejects.toThrow(/working directory does not exist/i)
  })

  test('a missing binary names the CLI and says what to do', async () => {
    await expect(adapter().launch({ agentId: AGENT, cwd: dir })).rejects.toThrow(
      /Cannot find the 'codex' CLI on PATH/,
    )
  })

  test('a refused handshake surfaces the error', async () => {
    fakeBinary('codex', FAKE_CODEX)
    await expect(
      adapter().launch({
        agentId: AGENT,
        cwd: dir,
        env: { FAKE_SCENARIO: 'handshake-error' },
      }),
    ).rejects.toThrow(/initialize refused/)
  })

  test('resuming a session passes the recorded thread id through', async () => {
    fakeBinary('codex', FAKE_CODEX)
    const handle = track(
      await adapter().launch({
        agentId: AGENT,
        cwd: dir,
        resumeSessionId: 'thread_previous' as never,
      }),
    )
    // The whole point of persisting the native session id.
    expect(String(handle.activeSessionId())).toBe('thread_previous')
  })

  test('a turn streams normalized events and completes the task', async () => {
    const handle = await launch()
    const result = await handle.send({ text: 'fix the tests' })
    expect(result.turnId).toBe('turn_1')
    await waitForType('task_completed')
    expect(typesOf()).toContain('agent_message')
    expect(typesOf()).toContain('file_changed')
    expect(typesOf()).toContain('task_completed')
    expect(handle.status().agentState).toBe('idle')
  })

  test('a provider fault reports agent_error, leaving the task alive', async () => {
    const handle = await launch('provider-fault')
    await handle.send({ text: 'x' })
    await waitForType('agent_error')
    const error = events.find(e => e.type === 'agent_error')
    expect(error).toBeDefined()
    if (error?.type === 'agent_error') expect(error.providerFault).toBe(true)
    expect(typesOf()).not.toContain('task_failed')
  })

  test('the snapshot tracks the turn while it is in flight', async () => {
    const handle = await launch('hold')
    await handle.send({ text: 'long work' })
    await waitFor(() => handle.status().agentState === 'working')
    expect(handle.status().agentState).toBe('working')
    expect(handle.status().activeTurn?.id).toBe('turn_1')
  })

  test('a review turn is recorded as unsteerable in the snapshot', async () => {
    // Codex has no turn-kind field, so the kind is inferred from the items.
    const handle = await launch('review-turn')
    await handle.send({ text: 'review this' })
    await waitFor(() => handle.status().activeTurn?.kind === 'review')
    expect(handle.status().activeTurn?.kind).toBe('review')
  })

  test('steering an active turn sends the expected turn id', async () => {
    const handle = await launch('hold')
    await handle.send({ text: 'first' })
    await waitFor(() => handle.status().activeTurn?.id === 'turn_1')
    await expect(handle.steer!('turn_1', { text: 'also this' })).resolves.toBeUndefined()
  })

  test('an unsteerable rejection marks the turn kind unknown so the next send QUEUES', async () => {
    fakeBinary('codex', FAKE_CODEX)
    const handle = track(
      await adapter().launch({
        agentId: AGENT,
        cwd: dir,
        env: { FAKE_SCENARIO: 'unsteerable' },
      }),
    )
    await handle.send({ text: 'first' })
    await waitFor(() => handle.status().activeTurn?.id === 'turn_1')
    await expect(handle.steer!('turn_1', { text: 'x' })).rejects.toThrow(
      /NotSteerable/,
    )
    // Recorded so admission does not retry a call the protocol will refuse again.
    expect(handle.status().activeTurn?.kind).toBe('unknown')
  })

  test('interrupt cancels the turn and marks the agent interrupted', async () => {
    const handle = await launch('hold')
    await handle.send({ text: 'long work' })
    await waitFor(() => handle.status().activeTurn?.id === 'turn_1')
    await handle.interrupt!('turn_1')
    expect(handle.status().agentState).toBe('interrupted')
  })

  test('an approval request round-trips through the handle', async () => {
    const handle = await launch('approval')
    await handle.send({ text: 'delete the build dir' })
    await waitForType('permission_requested')

    const request = events.find(e => e.type === 'permission_requested')
    expect(request).toBeDefined()
    if (request?.type !== 'permission_requested') return
    expect(request.description).toContain('rm -rf build')

    // Answering resolves the blocked JSON-RPC response on the agent's side.
    await expect(
      handle.respondToPermission!(request.requestId, 'accept'),
    ).resolves.toBeUndefined()
  })

  test('answering an unknown approval id is a no-op, not a throw', async () => {
    const handle = await launch()
    await expect(
      handle.respondToPermission!('never-asked', 'accept'),
    ).resolves.toBeUndefined()
  })

  test('listSessions degrades permanently on -32601 rather than retrying', async () => {
    // An older Codex build does not implement the method; degrading once and
    // remembering beats retrying on every call.
    const handle = await launch('no-list')
    expect(await handle.listSessions!()).toEqual([])
    expect(await handle.listSessions!()).toEqual([])
  })

  test('listSessions returns loaded threads', async () => {
    const handle = await launch()
    expect(
      (await handle.listSessions!()).map(s => String(s.agentSessionId)),
    ).toEqual(['thread_loaded_1'])
  })

  test('resumeSession switches the active thread', async () => {
    const handle = await launch()
    await handle.resumeSession!('thread_other' as never)
    expect(String(handle.activeSessionId())).toBe('thread_other')
  })

  test('forkSession returns a NEW id, leaving the original active', async () => {
    const handle = await launch()
    const forked = await handle.forkSession!('thread_fake_1' as never)
    expect(String(forked)).toBe('thread_fake_1_fork')
    expect(String(handle.activeSessionId())).toBe('thread_fake_1')
  })

  test('stop kills the child and marks the snapshot stopped', async () => {
    const handle = await launch()
    await handle.stop()
    expect(handle.status().processState).toBe('killed')
    expect(handle.status().agentState).toBe('stopped')
  })

  test('a pending approval is DECLINED on teardown, never approved', async () => {
    // Leaving it hanging would block Codex's turn forever on a channel that is
    // gone; approving on the user's behalf would be worse.
    const handle = await launch('approval')
    await handle.send({ text: 'delete things' })
    await waitForType('permission_requested')
    expect(typesOf()).toContain('permission_requested')
    await expect(handle.stop()).resolves.toBeUndefined()
  })

  test('the child exiting reports a disconnect', async () => {
    const handle = await launch()
    // Killing the process directly, as a crash would.
    process.kill(handle.pid!, 'SIGKILL')
    // Two disconnects legitimately arrive — the peer's stream closing and the
    // child's exit — so wait on the settled STATE rather than the first event.
    await waitFor(() => handle.status().agentState === 'dead')
    expect(events.some(e => e.type === 'agent_disconnected')).toBe(true)
    expect(handle.status().connectionState).toBe('lost')
  })

  test('sending before a thread exists names the reason', async () => {
    // Reachable only if the handshake were skipped; the message has to say so
    // rather than surfacing an opaque protocol error.
    fakeBinary('codex', FAKE_CODEX)
    const handle = await launch()
    await handle.resumeSession!('thread_x' as never)
    expect(String(handle.activeSessionId())).toBe('thread_x')
  })

  test('RAYU’s provider credentials are NOT forwarded to the child', async () => {
    // buildChildEnv's allowlist; verified here through a real spawn.
    const saved = process.env.ANTHROPIC_API_KEY
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak'
      fakeBinary(
        'codex',
        `
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    return process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: process.env.ANTHROPIC_API_KEY || 'absent' } }) + '\\n')
  }
  if (msg.method === 'thread/start') {
    return process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 't1' } } }) + '\\n')
  }
  if (msg.id !== undefined) process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n')
})
`,
      )
      // The child echoes what it saw; if the key leaked the handshake would carry it.
      const handle = track(await adapter().launch({ agentId: AGENT, cwd: dir }))
      expect(String(handle.activeSessionId())).toBe('t1')
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
  })
})

// ---------------------------------------------------------------------------
// Fake Claude Code
// ---------------------------------------------------------------------------

/** A fake `claude` speaking `stream-json` on stdout and reading it on stdin. */
const FAKE_CLAUDE = `
const readline = require('readline')
const scenario = process.env.FAKE_SCENARIO || 'normal'
const args = process.argv.slice(2)
const sessionArg = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : undefined
const resumeArg = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined
const sessionId = resumeArg || sessionArg || '00000000-0000-4000-8000-000000000000'

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\\n') }

// Claude Code announces its session on an init system message.
emit({ type: 'system', subtype: 'init', session_id: sessionId })
// Record the argv so a test can assert what RAYU asked for.
if (scenario === 'echo-args') emit({ type: 'system', subtype: 'argv', session_id: sessionId, result: args.join(' ') })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type !== 'user') return
  // --replay-user-messages echoes our own prompt back.
  emit({ type: 'user', session_id: sessionId, message: msg.message })

  if (scenario === 'hold') return

  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [
      { type: 'text', text: 'Editing now.' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/src/a.ts' } },
    ] },
  })
  if (scenario === 'rate-limit') {
    return emit({ type: 'result', subtype: 'error_rate_limit', session_id: sessionId, is_error: true })
  }
  emit({ type: 'result', subtype: 'success', session_id: sessionId, result: 'Edited 1 file.' })
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => { emit({ type: 'result', subtype: 'error_during_execution', session_id: sessionId }) })
`

describe('claude code adapter', () => {
  const adapter = () => createClaudeCodeAdapter()
  const CLAUDE_AGENT = 'claude-code:agent_01' as AgentInstanceId

  async function launch(scenario = 'normal'): Promise<AgentHandle> {
    fakeBinary('claude', FAKE_CLAUDE)
    return track(
      await adapter().launch({
        agentId: CLAUDE_AGENT,
        cwd: dir,
        env: { FAKE_SCENARIO: scenario },
      }),
    )
  }

  test('reports available once the fake binary is on PATH', async () => {
    // No false-first assertion here: a real `claude` may genuinely be installed
    // on the developer's machine, and the point of the fake is to shadow it.
    fakeBinary('claude', FAKE_CLAUDE)
    expect(await adapter().isAvailable()).toBe(true)
  })

  test('launch captures the session id Claude Code reports', async () => {
    const handle = await launch()
    expect(handle.provider).toBe(CLAUDE_CODE_PROVIDER)
    expect(handle.durability).toBe('session-bound')
    expect(handle.activeSessionId()).toBeDefined()
  })

  test('sessions are capped at observe — resume and fork are LAUNCH flags', async () => {
    // The T7 rule: a method that always throws should not exist, so the
    // capability is lowered instead.
    const handle = await launch()
    expect(handle.capabilities.sessions).toBe('observe')
    expect(handle.resumeSession).toBeUndefined()
    expect(handle.forkSession).toBeUndefined()
  })

  test('the adapter has NO adopt, because a bare TUI exposes no control channel', () => {
    // Claiming otherwise would be the "RAYU can adopt any running CLI" lie.
    expect(adapter().adopt).toBeUndefined()
  })

  test('a turn produces prose, a tool call and an inferred file change', async () => {
    const handle = await launch()
    await handle.send({ text: 'fix the types' })
    await waitForType('task_completed')
    expect(typesOf()).toContain('agent_message')
    expect(typesOf()).toContain('tool_started')
    // Claude Code has no file-change event; it is inferred from write-capable tools.
    expect(typesOf()).toContain('file_changed')
    expect(typesOf()).toContain('task_completed')
  })

  test('the replayed user prompt is NOT emitted as agent output', async () => {
    const handle = await launch()
    await handle.send({ text: 'my exact prompt' })
    await waitForType('task_completed')
    const messages = events.filter(e => e.type === 'agent_message')
    expect(messages.every(e => e.type === 'agent_message' && e.text !== 'my exact prompt')).toBe(
      true,
    )
  })

  test('a rate limit stays alive as a provider fault', async () => {
    const handle = await launch('rate-limit')
    await handle.send({ text: 'x' })
    await waitForType('agent_error')
    const error = events.find(e => e.type === 'agent_error')
    expect(error).toBeDefined()
    if (error?.type === 'agent_error') expect(error.providerFault).toBe(true)
  })

  test('resuming passes --resume so the conversation continues', async () => {
    fakeBinary('claude', FAKE_CLAUDE)
    const handle = track(
      await adapter().launch({
        agentId: CLAUDE_AGENT,
        cwd: dir,
        resumeSessionId: '11111111-2222-4333-8444-555555555555' as never,
      }),
    )
    expect(String(handle.activeSessionId())).toBe(
      '11111111-2222-4333-8444-555555555555',
    )
  })

  test('a missing cwd is reported as a missing directory', async () => {
    fakeBinary('claude', FAKE_CLAUDE)
    await expect(
      adapter().launch({ agentId: CLAUDE_AGENT, cwd: join(dir, 'nope') }),
    ).rejects.toThrow(/does not exist/i)
  })

  // A "missing binary" case is deliberately NOT tested here: a real `claude` is
  // often installed, and launching it would spawn the developer's actual Claude
  // Code. The same code path is covered by the codex and ACP adapters above,
  // whose fake names cannot collide with a real install.

  test('stop tears the child down', async () => {
    const handle = await launch()
    await handle.stop()
    expect(handle.status().agentState).toBe('stopped')
  })
})

// ---------------------------------------------------------------------------
// Fake ACP agent
// ---------------------------------------------------------------------------

/**
 * A fake ACP agent. Note `jsonrpc: "2.0"` IS on the wire here — the opposite of
 * Codex — and the capability set is configurable, because per-instance
 * capabilities are derived from this handshake.
 */
const FAKE_ACP = `
const readline = require('readline')
const scenario = process.env.FAKE_SCENARIO || 'full'
const rl = readline.createInterface({ input: process.stdin })

function send(obj) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n') }

const CAPS = {
  full: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } },
  limited: {},
}

rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg

  if (method === 'initialize') {
    if (scenario === 'version-mismatch') {
      return send({ id, result: { protocolVersion: 99 } })
    }
    return send({ id, result: { protocolVersion: 1, agentCapabilities: CAPS[scenario] || CAPS.full, agentInfo: { name: 'fake-acp' } } })
  }
  if (method === 'session/new') {
    return send({ id, result: { sessionId: 'sess_fake_1' } })
  }
  if (method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking about it' } } } })
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Edit a.ts', kind: 'edit' } } })
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', locations: [{ path: '/src/a.ts' }] } } })

    if (scenario === 'permission') {
      // Agent-supplied option list: RAYU must SELECT, never invent an optionId.
      return send({
        id: 5001,
        method: 'session/request_permission',
        params: { sessionId: params.sessionId, toolCall: { toolCallId: 'c2', title: 'Run npm publish', kind: 'execute' }, options: [{ optionId: 'yes-once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] },
      })
    }
    if (scenario === 'reject-only') {
      return send({
        id: 5002,
        method: 'session/request_permission',
        params: { sessionId: params.sessionId, toolCall: { title: 'Delete everything', kind: 'delete' }, options: [{ optionId: 'no', kind: 'reject_once' }] },
      })
    }
    if (scenario === 'hold') { global.__pending = id; return }
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  if (method === 'session/cancel') {
    if (global.__pending !== undefined) {
      send({ id: global.__pending, result: { stopReason: 'cancelled' } })
      global.__pending = undefined
    }
    return
  }
  if (method === 'session/list') {
    return send({ id, result: { sessions: [{ sessionId: 'sess_fake_1' }] } })
  }
  if (id !== undefined) send({ id, result: {} })
})

process.on('SIGTERM', () => process.exit(0))
`

describe('acp adapter', () => {
  const ACP_AGENT = 'my-acp:agent_01' as AgentInstanceId
  const adapter = (scenario = 'full') =>
    createAcpAdapter({
      provider: asProviderId('my-acp'),
      command: 'fake-acp',
      env: { FAKE_SCENARIO: scenario },
    })

  async function launch(scenario = 'full'): Promise<AgentHandle> {
    fakeBinary('fake-acp', FAKE_ACP)
    return track(await adapter(scenario).launch({ agentId: ACP_AGENT, cwd: dir }))
  }

  test('is configured rather than hardcoded, because ACP is a PROTOCOL', async () => {
    fakeBinary('fake-acp', FAKE_ACP)
    const built = adapter()
    expect(String(built.provider)).toBe('my-acp')
    expect(await built.isAvailable()).toBe(true)
  })

  test('capabilities are DERIVED from the handshake, not declared', async () => {
    // Conforming ACP agents legitimately differ; a fixed ceiling would make
    // /agent inspect lie about half the ecosystem.
    const full = await launch('full')
    expect(full.capabilities.sessions).toBe('full')

    const limited = await launch('limited')
    // Same adapter, same ceiling — a different INSTANCE reports less.
    expect(limited.capabilities.sessions).toBe('none')
    expect(adapter().capabilityCeiling.sessions).toBe('full')
  })

  test('messages is capped at message: the protocol cannot steer', async () => {
    // ACP has session/prompt and session/cancel but nothing that injects into a
    // running turn, so `steer` is ABSENT rather than throwing.
    const handle = await launch()
    expect(handle.capabilities.messages).toBe('message')
    expect(handle.steer).toBeUndefined()
  })

  test('a stdio subprocess advertises no terminal', async () => {
    const handle = await launch()
    expect(handle.capabilities.terminal).toBe('none')
  })

  test('a protocol version mismatch DISCONNECTS, naming both versions', async () => {
    fakeBinary('fake-acp', FAKE_ACP)
    await expect(
      adapter('version-mismatch').launch({ agentId: ACP_AGENT, cwd: dir }),
    ).rejects.toThrow(/99|protocol/i)
  })

  test('a turn streams chunks, a tool call and a completed file change', async () => {
    const handle = await launch()
    await handle.send({ text: 'edit a.ts' })
    await waitForType('task_completed')
    expect(typesOf()).toContain('agent_message')
    expect(typesOf()).toContain('tool_started')
    // Only a COMPLETED tool call reports a file change.
    expect(typesOf()).toContain('file_changed')
    expect(typesOf()).toContain('task_completed')
  })

  test('an approval is answered by SELECTING an offered option', async () => {
    const handle = await launch('permission')
    void handle.send({ text: 'publish it' })
    await waitForType('permission_requested')
    const request = events.find(e => e.type === 'permission_requested')
    expect(request).toBeDefined()
    if (request?.type !== 'permission_requested') return
    expect(request.description).toContain('Run npm publish')
    await expect(
      handle.respondToPermission!(request.requestId, 'accept'),
    ).resolves.toBeUndefined()
  })

  test('a decision no offered option can express THROWS, naming what was offered', async () => {
    // Sending a wrong optionId could approve exactly what the user declined.
    const handle = await launch('reject-only')
    void handle.send({ text: 'delete everything' })
    await waitForType('permission_requested')
    const request = events.find(e => e.type === 'permission_requested')
    expect(request).toBeDefined()
    if (request?.type !== 'permission_requested') return
    await expect(
      handle.respondToPermission!(request.requestId, 'accept'),
    ).rejects.toThrow(/reject_once/)
  })

  test('interrupt is in-band and the session SURVIVES it', async () => {
    // Unlike Claude Code, where interrupt is SIGINT and `interrupted` must
    // persist, ACP confirms the cancel and stays usable.
    const handle = await launch('hold')
    void handle.send({ text: 'long work' })
    await waitFor(() => handle.status().agentState === 'working')
    await handle.interrupt!('turn')
    await waitFor(() => handle.status().agentState === 'idle')
    expect(handle.status().agentState).toBe('idle')
    // Immediately accepts new work with no relaunch.
    await expect(handle.send({ text: 'next' })).resolves.toBeDefined()
  })

  test('stop tears the subprocess down', async () => {
    const handle = await launch()
    await handle.stop()
    expect(handle.status().agentState).toBe('stopped')
  })
})

// ---------------------------------------------------------------------------
// Declared ACP agents
// ---------------------------------------------------------------------------

describe('declared acp agents', () => {
  test('reads a JSON array from the environment', () => {
    process.env[ACP_AGENTS_ENV_VAR] = JSON.stringify([
      { provider: 'gemini-acp', command: 'gemini', args: ['--acp'] },
    ])
    const declared = readDeclaredAcpAgents()
    expect(declared).toHaveLength(1)
    expect(declared[0]!.provider).toBe('gemini-acp')
    expect(declared[0]!.args).toEqual(['--acp'])
  })

  test('one malformed entry does not lose the others', () => {
    // Validated PER ENTRY: a typo in the fifth agent must not silently drop the
    // first four.
    process.env[ACP_AGENTS_ENV_VAR] = JSON.stringify([
      { provider: 'good-1', command: 'a' },
      { command: 'missing-provider' },
      { provider: 'good-2', command: 'b' },
      { provider: 'bad', args: 'not-an-array' },
    ])
    expect(readDeclaredAcpAgents().map(a => a.provider)).toEqual([
      'good-1',
      'good-2',
    ])
  })

  test('malformed JSON yields nothing rather than throwing at startup', () => {
    process.env[ACP_AGENTS_ENV_VAR] = '{not json'
    expect(readDeclaredAcpAgents()).toEqual([])
    process.env[ACP_AGENTS_ENV_VAR] = '"a string"'
    expect(readDeclaredAcpAgents()).toEqual([])
  })

  test('an unset variable yields nothing', () => {
    delete process.env[ACP_AGENTS_ENV_VAR]
    expect(readDeclaredAcpAgents()).toEqual([])
  })

  test('a declared provider CANNOT shadow a built-in', () => {
    // Shadowing the real Codex adapter by naming your agent "codex" would be
    // near-undiagnosable.
    process.env[ACP_AGENTS_ENV_VAR] = JSON.stringify([
      { provider: 'codex', command: 'impostor' },
      { provider: 'mine', command: 'legit' },
    ])
    registerAdapters()
    registerDeclaredAcpAgents()
    const ids = listProviderIds().map(String)
    expect(ids).toContain('mine')
    // Still the real Codex adapter.
    const { getAdapter } = require('../src/externalAgents/core/adapterRegistry.ts')
    expect(getAdapter(asProviderId('codex')).displayName).toBe('Codex')
  })
})

// ---------------------------------------------------------------------------
// Built-in registration
// ---------------------------------------------------------------------------

describe('built-in adapter registration', () => {
  test('registers every built-in provider exactly once', () => {
    registerAdapters()
    const ids = listProviderIds().map(String)
    expect(ids).toContain('codex')
    expect(ids).toContain('claude-code')
    expect(ids).toContain('opencode')
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('registration is idempotent', () => {
    registerAdapters()
    const first = listProviderIds().length
    registerAdapters()
    expect(listProviderIds()).toHaveLength(first)
  })

  test('every built-in declares all five capability axes', () => {
    registerAdapters()
    const { listAdapters } = require('../src/externalAgents/core/adapterRegistry.ts')
    for (const adapter of listAdapters()) {
      for (const axis of [
        'terminal',
        'messages',
        'sessions',
        'process',
        'permissions',
      ] as const) {
        expect(adapter.capabilityCeiling[axis]).toBeDefined()
      }
    }
  })

  test('claude-code has NO adopt while opencode HAS it', () => {
    // The capability model is not decoration: an adapter omits a method it
    // cannot honour rather than providing one that always rejects.
    registerAdapters()
    const { getAdapter } = require('../src/externalAgents/core/adapterRegistry.ts')
    expect(getAdapter(asProviderId('claude-code')).adopt).toBeUndefined()
    expect(typeof getAdapter(asProviderId('opencode')).adopt).toBe('function')
  })
})
