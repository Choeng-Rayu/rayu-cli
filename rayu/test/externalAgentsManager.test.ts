/**
 * AgentManager, the adapter registry, and the errors they raise — driven through
 * the stub adapter.
 *
 * The stub exists so the manager's provider-independent behaviour (capability
 * gating, admission, queue draining, persistence sync, the inspection matrix) can
 * be validated deterministically instead of against a live Codex process.
 *
 * The invariant most worth protecting here: a declared capability can be TRUSTED.
 * An adapter that declares a level but omits the method raises
 * `AdapterInvariantError` rather than silently degrading, because silent
 * degradation would make the whole capability model a lie.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertCapability,
  adoptAgent,
  allocateAgentId,
  assign,
  canPerform,
  detachAllAgents,
  findLiveAgent,
  getLiveAgent,
  inspectAgent,
  interruptAgent,
  listLiveAgents,
  listRecordedSessions,
  pendingCount,
  reconnectAgent,
  recordSession,
  resetAgentManager,
  respondToPermission,
  startAgent,
  stopAgent,
} from '../src/externalAgents/core/AgentManager.ts'
import {
  findAdapter,
  getAdapter,
  listAdapters,
  listAvailableAdapters,
  listProviderIds,
  registerAdapter,
  resetAdapterRegistry,
  unregisterAdapter,
} from '../src/externalAgents/core/adapterRegistry.ts'
import {
  createObserveOnlyStubAdapter,
  createStubAdapter,
  type StubHandle,
} from '../src/externalAgents/adapters/stub/StubAdapter.ts'
import {
  AdapterInvariantError,
  AdmissionError,
  CapabilityError,
  UnknownAgentError,
  UnknownProviderError,
} from '../src/externalAgents/core/errors.ts'
import { resetEventBus } from '../src/externalAgents/core/eventBus.ts'
import { readAgentRecord } from '../src/externalAgents/persistence/agentStore.ts'
import {
  asAgentSessionId,
  asProviderId,
  asTaskRef,
  noCapabilities,
  type AgentInstanceId,
} from '../src/externalAgents/core/types.ts'
import type { AgentAdapter, AgentHandle } from '../src/externalAgents/core/adapter.ts'

const STUB = asProviderId('stub')
const TASK = asTaskRef('task_1')
const CWD = '/tmp/project'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-manager-'))
  process.env.RAYU_CONFIG_DIR = dir
  resetAgentManager()
  resetAdapterRegistry()
  resetEventBus()
})
afterEach(() => {
  resetAgentManager()
  resetAdapterRegistry()
  resetEventBus()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

/** An AdoptTarget for the stub: adoption needs a cwd and a transport, not just an id. */
function adoptTarget(agentId: string) {
  return {
    agentId: agentId as AgentInstanceId,
    cwd: CWD,
    transport: { kind: 'stdio' as const },
  }
}

const stub = (handle: AgentHandle) => handle as unknown as StubHandle
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

/**
 * Wrap a handle, overriding some members.
 *
 * Neither `{ ...handle }` nor `Object.create(handle)` works: the first drops
 * every prototype method, and the second breaks `StubHandle`'s `#private` fields
 * because `this` becomes the wrapper. A proxy that binds methods back to the real
 * instance is the only faithful wrapper.
 */
function withOverrides(
  handle: AgentHandle,
  overrides: Partial<Record<keyof AgentHandle, unknown>>,
): AgentHandle {
  return new Proxy(handle as unknown as Record<string, unknown>, {
    get(target, property, receiver) {
      if (property in overrides) {
        return overrides[property as keyof AgentHandle]
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    has(target, property) {
      return property in overrides || Reflect.has(target, property)
    },
  }) as unknown as AgentHandle
}

async function launch(
  options: Parameters<typeof createStubAdapter>[0] = {},
): Promise<AgentHandle> {
  registerAdapter(createStubAdapter(options))
  return startAgent({
    provider: options.provider ?? STUB,
    cwd: CWD,
  })
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

describe('adapter registry', () => {
  test('registers and looks up by provider id', () => {
    const adapter = createStubAdapter()
    registerAdapter(adapter)
    expect(getAdapter(STUB)).toBe(adapter)
    expect(findAdapter(STUB)).toBe(adapter)
    expect(listProviderIds()).toEqual([STUB])
    expect(listAdapters()).toEqual([adapter])
  })

  test('an unknown provider throws naming every registered one', () => {
    registerAdapter(createStubAdapter())
    const error = (() => {
      try {
        getAdapter(asProviderId('nope'))
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(UnknownProviderError)
    expect((error as Error).message).toContain("'nope'")
    expect((error as Error).message).toContain('stub')
  })

  test('an empty registry says so rather than listing nothing', () => {
    expect(() => getAdapter(STUB)).toThrow(/\(none\)/)
  })

  test('findAdapter does not throw', () => {
    expect(findAdapter(asProviderId('missing'))).toBeUndefined()
  })

  test('re-registering replaces so a config edit takes effect without a restart', () => {
    registerAdapter(createStubAdapter())
    const replacement = createStubAdapter({ capabilities: { messages: 'none' } })
    registerAdapter(replacement)
    expect(getAdapter(STUB)).toBe(replacement)
    expect(listAdapters()).toHaveLength(1)
  })

  test('unregister reports whether anything was removed', () => {
    registerAdapter(createStubAdapter())
    expect(unregisterAdapter(STUB)).toBe(true)
    expect(unregisterAdapter(STUB)).toBe(false)
  })

  test('availability probes run concurrently and a thrower counts as unavailable', async () => {
    // A probe that throws must not fail the whole list.
    const ok = createStubAdapter({ provider: asProviderId('ok') })
    const thrower: AgentAdapter = {
      ...createStubAdapter({ provider: asProviderId('boom') }),
      async isAvailable() {
        throw new Error('which() blew up')
      },
    }
    const absent: AgentAdapter = {
      ...createStubAdapter({ provider: asProviderId('absent') }),
      async isAvailable() {
        return false
      },
    }
    registerAdapter(ok)
    registerAdapter(thrower)
    registerAdapter(absent)
    const available = await listAvailableAdapters()
    expect(available.map(a => String(a.provider))).toEqual(['ok'])
  })
})

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

describe('capability gating', () => {
  test('an operation within the declared level is allowed', async () => {
    const handle = await launch()
    expect(() => assertCapability(handle, 'sendMessage')).not.toThrow()
    expect(canPerform(handle, 'steer')).toBe(true)
  })

  test('a shortfall throws a CapabilityError naming the axis and both levels', async () => {
    // Actionable before any protocol call, rather than an obscure failure 30
    // seconds in.
    const handle = await launch({ capabilities: { messages: 'message' } })
    const error = (() => {
      try {
        assertCapability(handle, 'steer')
      } catch (e) {
        return e as CapabilityError
      }
    })()!
    expect(error).toBeInstanceOf(CapabilityError)
    expect(error.axis).toBe('messages')
    expect(error.required).toBe('full')
    expect(error.actual).toBe('message')
    expect(error.message).toContain('cannot steer')
  })

  test('a declared level with NO implementing method is a RAYU bug, not a degrade', async () => {
    // The whole value of the capability model is that a declared level can be
    // trusted, so this is surfaced loudly.
    const adapter = createStubAdapter()
    const original = adapter.launch
    adapter.launch = async spec => {
      // Declare full messages but remove the method.
      return withOverrides(await original(spec), { steer: undefined })
    }
    registerAdapter(adapter)
    const handle = await startAgent({ provider: STUB, cwd: CWD })
    expect(() => assertCapability(handle, 'steer')).toThrow(AdapterInvariantError)
    expect(() => assertCapability(handle, 'steer')).toThrow(/RAYU bug/)
    expect(canPerform(handle, 'steer')).toBe(false)
  })

  test('operations with no handle method are gated on capability alone', async () => {
    // Terminal observe/attach are the Terminal Manager's job, so there is no
    // method to check.
    const handle = await launch({ capabilities: { terminal: 'observe' } })
    expect(canPerform(handle, 'observeTerminal')).toBe(true)
    expect(canPerform(handle, 'attachTerminal')).toBe(true)
    expect(canPerform(handle, 'driveTerminal')).toBe(false)
  })

  test('an observe-only agent can perform nothing but terminal observation', async () => {
    registerAdapter(createObserveOnlyStubAdapter(asProviderId('watch')))
    const handle = await startAgent({ provider: asProviderId('watch'), cwd: CWD })
    expect(canPerform(handle, 'sendMessage')).toBe(false)
    expect(canPerform(handle, 'interrupt')).toBe(false)
    expect(canPerform(handle, 'kill')).toBe(false)
    expect(canPerform(handle, 'observeTerminal')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('agent lifecycle', () => {
  test('launching registers the handle and persists a record', async () => {
    const handle = await launch()
    expect(listLiveAgents()).toEqual([handle])
    expect(findLiveAgent(handle.agentId)).toBe(handle)

    const record = await readAgentRecord(handle.agentId)
    expect(record.status).toBe('ok')
    if (record.status === 'ok') {
      expect(record.record.provider).toBe(STUB)
      expect(record.record.agentState).toBe('idle')
      expect(record.record.capabilities.messages).toBe('full')
    }
  })

  test('launching records the agent’s own session id', async () => {
    const handle = await launch()
    const sessions = await listRecordedSessions(handle.agentId)
    // Resuming with the real session id is what separates continuing a
    // conversation from silently starting a fresh one.
    expect(sessions.map(s => String(s.agentSessionId))).toEqual([
      `stub-session-${handle.agentId}`,
    ])
  })

  test('slots are allocated lowest-free-first', async () => {
    registerAdapter(createStubAdapter())
    const first = await startAgent({ provider: STUB, cwd: CWD })
    const second = await startAgent({ provider: STUB, cwd: CWD })
    expect(String(first.agentId)).toBe('stub:agent_01')
    expect(String(second.agentId)).toBe('stub:agent_02')
  })

  test('a PERSISTED slot is not reused even after the agent is gone', async () => {
    // Reusing it would silently inherit another agent's session history and
    // crash forensics.
    registerAdapter(createStubAdapter())
    const first = await startAgent({ provider: STUB, cwd: CWD })
    await stopAgent(first.agentId)
    expect(listLiveAgents()).toEqual([])
    expect(String(await allocateAgentId(STUB))).toBe('stub:agent_02')
  })

  test('slots are namespaced per provider', async () => {
    registerAdapter(createStubAdapter({ provider: asProviderId('a') }))
    registerAdapter(createStubAdapter({ provider: asProviderId('b') }))
    const first = await startAgent({ provider: asProviderId('a'), cwd: CWD })
    const second = await startAgent({ provider: asProviderId('b'), cwd: CWD })
    expect(String(first.agentId)).toBe('a:agent_01')
    expect(String(second.agentId)).toBe('b:agent_01')
  })

  test('an explicit agentId is honoured, so a relaunch keeps its identity', async () => {
    registerAdapter(createStubAdapter())
    const handle = await startAgent({
      provider: STUB,
      cwd: CWD,
      agentId: 'stub:agent_07' as AgentInstanceId,
    })
    expect(String(handle.agentId)).toBe('stub:agent_07')
  })

  test('a resume session id is passed to the adapter', async () => {
    registerAdapter(createStubAdapter())
    const handle = await startAgent({
      provider: STUB,
      cwd: CWD,
      resumeSessionId: asAgentSessionId('previous-thread'),
    })
    expect(String(handle.activeSessionId())).toBe('previous-thread')
  })

  test('a launch failure does not leave a half-registered agent', async () => {
    registerAdapter(createStubAdapter({ failLaunch: true }))
    await expect(startAgent({ provider: STUB, cwd: CWD })).rejects.toThrow(
      /stub launch failure/,
    )
    expect(listLiveAgents()).toEqual([])
  })

  test('an unknown live agent throws listing what IS running', async () => {
    const handle = await launch()
    const error = (() => {
      try {
        getLiveAgent('stub:agent_99' as AgentInstanceId)
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(UnknownAgentError)
    expect((error as Error).message).toContain(handle.agentId)
    expect((error as Error).message).toContain('/agent list')
  })

  test('stopping removes the handle and marks the record stopped', async () => {
    const handle = await launch()
    await stopAgent(handle.agentId)
    expect(stub(handle).stopped).toBe(true)
    expect(listLiveAgents()).toEqual([])
    const record = await readAgentRecord(handle.agentId)
    if (record.status === 'ok') {
      expect(record.record.agentState).toBe('stopped')
      expect(record.record.connectionState).toBe('disconnected')
    }
  })

  test('an agent that cannot be killed is refused before the wire', async () => {
    const handle = await launch({ capabilities: { process: 'message' } })
    await expect(stopAgent(handle.agentId)).rejects.toThrow(CapabilityError)
    expect(stub(handle).stopped).toBe(false)
  })

  test('adopt is only offered when the adapter implements it', async () => {
    registerAdapter(createStubAdapter({ adoption: 'managed' }))
    await expect(
      adoptAgent(adoptTarget('stub:agent_01')),
    ).rejects.toThrow(CapabilityError)
  })

  test('adopting registers a handle like a launch does', async () => {
    registerAdapter(createStubAdapter({ adoption: 'adoptable' }))
    const handle = await adoptAgent(adoptTarget('stub:agent_01'))
    expect(handle.adoption).toBe('adoptable')
    expect(listLiveAgents()).toHaveLength(1)
    expect((await readAgentRecord(handle.agentId)).status).toBe('ok')
  })

  test('reconnect returns the live handle when one already exists', async () => {
    const handle = await launch({ durability: 'process-durable' })
    expect(await reconnectAgent(handle.agentId)).toBe(handle)
  })

  test('reconnect rebuilds a handle from the persisted record', async () => {
    const handle = await launch({ durability: 'process-durable' })
    resetAgentManager()
    expect(listLiveAgents()).toEqual([])
    const reconnected = await reconnectAgent(handle.agentId)
    expect(reconnected.agentId).toBe(handle.agentId)
    expect(listLiveAgents()).toHaveLength(1)
  })

  test('reconnect with no record throws UnknownAgentError', async () => {
    registerAdapter(createStubAdapter({ durability: 'process-durable' }))
    await expect(
      reconnectAgent('stub:agent_44' as AgentInstanceId),
    ).rejects.toThrow(UnknownAgentError)
  })

  test('a session-bound adapter has no reconnect, and that is reported as a bug', async () => {
    const handle = await launch({ durability: 'session-bound' })
    resetAgentManager()
    registerAdapter(createStubAdapter({ durability: 'session-bound' }))
    await expect(reconnectAgent(handle.agentId)).rejects.toThrow(
      AdapterInvariantError,
    )
  })

  test('detachAll stops session-bound agents but only detaches durable ones', async () => {
    // The whole point of the durability distinction: a durable agent keeps
    // running and stays reconnectable.
    registerAdapter(createStubAdapter({ provider: asProviderId('bound') }))
    registerAdapter(
      createStubAdapter({
        provider: asProviderId('durable'),
        durability: 'process-durable',
      }),
    )
    const bound = await startAgent({ provider: asProviderId('bound'), cwd: CWD })
    const durable = await startAgent({
      provider: asProviderId('durable'),
      cwd: CWD,
    })

    await detachAllAgents()

    expect(stub(bound).stopped).toBe(true)
    expect(stub(durable).stopped).toBe(false)
    expect(stub(durable).detached).toBe(true)
    expect(listLiveAgents()).toEqual([])

    const record = await readAgentRecord(durable.agentId)
    if (record.status === 'ok') {
      // Left reconnectable rather than marked dead.
      expect(record.record.agentState).not.toBe('stopped')
      expect(record.record.connectionState).toBe('disconnected')
    }
  })

  test('detachAll does not stop an agent it cannot kill', async () => {
    const handle = await launch({ capabilities: { process: 'message' } })
    await detachAllAgents()
    expect(stub(handle).stopped).toBe(false)
    expect(listLiveAgents()).toEqual([])
  })

  test('one failing detach does not abandon the others', async () => {
    registerAdapter(createStubAdapter({ provider: asProviderId('good') }))
    const bad = createStubAdapter({ provider: asProviderId('bad') })
    const originalLaunch = bad.launch
    bad.launch = async spec =>
      withOverrides(await originalLaunch(spec), {
        stop: async () => {
          throw new Error('stop exploded')
        },
      })
    registerAdapter(bad)
    const good = await startAgent({ provider: asProviderId('good'), cwd: CWD })
    await startAgent({ provider: asProviderId('bad'), cwd: CWD })

    await detachAllAgents()
    expect(stub(good).stopped).toBe(true)
    expect(listLiveAgents()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('assign', () => {
  test('an idle agent dispatches immediately', async () => {
    const handle = await launch()
    const outcome = await assign(handle.agentId, { text: 'do it' }, { taskRef: TASK })
    expect(outcome.action).toBe('dispatch')
    expect(outcome.turnId).toBe('turn_1')
    expect(outcome.sessionId).toBeDefined()
    expect(stub(handle).sent).toEqual([{ input: { text: 'do it' }, taskRef: TASK }])
  })

  test('an agent that cannot receive messages is refused up front', async () => {
    registerAdapter(createObserveOnlyStubAdapter(asProviderId('watch')))
    const handle = await startAgent({ provider: asProviderId('watch'), cwd: CWD })
    await expect(assign(handle.agentId, { text: 'hi' })).rejects.toThrow(
      CapabilityError,
    )
  })

  test('a busy agent queues rather than clobbering its turn', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    const outcome = await assign(handle.agentId, { text: 'second' })
    expect(outcome.action).toBe('queue')
    expect(outcome.queuePosition).toBe(1)
    expect(pendingCount(handle.agentId)).toBe(1)
    // The second input was NOT sent.
    expect(stub(handle).sent).toHaveLength(1)
  })

  test('queue positions increment', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    expect((await assign(handle.agentId, { text: 'a' })).queuePosition).toBe(1)
    expect((await assign(handle.agentId, { text: 'b' })).queuePosition).toBe(2)
  })

  test('queued work drains when the agent reports idle', async () => {
    // Without the drain, queued work would sit forever — a silent drop that looks
    // identical to a hung agent.
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    await assign(handle.agentId, { text: 'queued' })
    expect(pendingCount(handle.agentId)).toBe(1)

    stub(handle).completeHeldTurn()
    await tick(20)

    expect(pendingCount(handle.agentId)).toBe(0)
    expect(stub(handle).sent.map(s => s.input.text)).toEqual(['first', 'queued'])
  })

  test('draining preserves FIFO order', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    await assign(handle.agentId, { text: 'a' })
    await assign(handle.agentId, { text: 'b' })
    stub(handle).completeHeldTurn()
    await tick(20)
    stub(handle).setState({ agentState: 'idle', activeTurn: undefined })
    stub(handle).completeHeldTurn()
    await tick(20)
    expect(stub(handle).sent.map(s => s.input.text)).toEqual(['first', 'a', 'b'])
  })

  test('preferSteer steers a regular turn', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    const outcome = await assign(
      handle.agentId,
      { text: 'also do this' },
      { preferSteer: true },
    )
    expect(outcome.action).toBe('steer')
    expect(stub(handle).steered).toEqual([
      { turnId: 'turn_1', input: { text: 'also do this' } },
    ])
  })

  test('preferSteer on an agent that cannot steer queues instead', async () => {
    const handle = await launch({
      holdTurns: true,
      capabilities: { messages: 'message' },
    })
    await assign(handle.agentId, { text: 'first' })
    const outcome = await assign(handle.agentId, { text: 'x' }, { preferSteer: true })
    expect(outcome.action).toBe('queue')
    expect(stub(handle).steered).toEqual([])
  })

  test('a turn ending between admission and steer queues rather than guessing', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    // Admission will say steer, but the turn id is gone by the time we look.
    const realSteer = stub(handle).steer.bind(handle)
    stub(handle).setState({ agentState: 'working', activeTurn: undefined })
    const outcome = await assign(handle.agentId, { text: 'x' }, { preferSteer: true })
    expect(outcome.action).toBe('queue')
    expect(realSteer).toBeDefined()
  })

  test('a dead agent holds the input and reports relaunch', async () => {
    // The request is not lost, and the outcome tells the caller what has to
    // happen first.
    const handle = await launch()
    stub(handle).setState({ processState: 'exited', agentState: 'dead' })
    const outcome = await assign(handle.agentId, { text: 'later' })
    expect(outcome.action).toBe('relaunch')
    expect(pendingCount(handle.agentId)).toBe(1)
    expect(stub(handle).sent).toHaveLength(0)
  })

  test('a disconnected-but-live agent reports resume', async () => {
    const handle = await launch()
    stub(handle).setState({ connectionState: 'lost' })
    const outcome = await assign(handle.agentId, { text: 'later' })
    expect(outcome.action).toBe('resume')
    expect(pendingCount(handle.agentId)).toBe(1)
  })

  test('dispatch updates the persisted record', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'work' })
    const record = await readAgentRecord(handle.agentId)
    if (record.status === 'ok') {
      expect(record.record.agentState).toBe('working')
      expect(record.record.activeTurn?.id).toBe('turn_1')
      expect(record.record.lastEventSeq).toBeGreaterThan(0)
    }
  })
})

describe('interrupt', () => {
  test('interrupts the active turn', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'work' })
    const outcome = await interruptAgent(handle.agentId)
    expect(outcome.action).toBe('dispatch')
    expect(outcome.turnId).toBe('turn_1')
    expect(stub(handle).interrupted).toEqual(['turn_1'])
  })

  test('is refused when nothing is running', async () => {
    const handle = await launch()
    const error = await interruptAgent(handle.agentId).catch(e => e)
    expect(error).toBeInstanceOf(AdmissionError)
    expect((error as AdmissionError).decision.action).toBe('reject')
  })

  test('is refused when the agent cannot be interrupted', async () => {
    const handle = await launch({
      holdTurns: true,
      capabilities: { process: 'none' },
    })
    await expect(interruptAgent(handle.agentId)).rejects.toThrow(CapabilityError)
  })

  test('refuses rather than guessing a turn id', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'work' })
    stub(handle).setState({ activeTurn: undefined })
    const error = await interruptAgent(handle.agentId).catch(e => e)
    expect(error).toBeInstanceOf(AdmissionError)
    expect((error as Error).message).toContain('nothing to interrupt')
  })
})

// ---------------------------------------------------------------------------
// Sessions and permissions
// ---------------------------------------------------------------------------

describe('session bookkeeping', () => {
  test('records a session and keeps it active', async () => {
    const handle = await launch()
    await recordSession(handle.agentId, asAgentSessionId('thread_2'), 'second')
    const sessions = await listRecordedSessions(handle.agentId)
    // The launch already recorded the stub's own session, so assert by lookup:
    // two sessions recorded in the same millisecond have no defined order.
    const recorded = sessions.find(s => s.agentSessionId === 'thread_2')
    expect(recorded).toBeDefined()
    expect(recorded!.title).toBe('second')
  })

  test('re-recording the same session updates rather than duplicating', async () => {
    const handle = await launch()
    await recordSession(handle.agentId, asAgentSessionId('thread_1'), 'first')
    await recordSession(handle.agentId, asAgentSessionId('thread_1'))
    const sessions = await listRecordedSessions(handle.agentId)
    expect(sessions.filter(s => s.agentSessionId === 'thread_1')).toHaveLength(1)
    // An omitted title does not erase the recorded one.
    expect(sessions.find(s => s.agentSessionId === 'thread_1')!.title).toBe('first')
  })

  test('sessions are listed newest-used first', async () => {
    const handle = await launch()
    await recordSession(handle.agentId, asAgentSessionId('old'))
    await new Promise(r => setTimeout(r, 5))
    await recordSession(handle.agentId, asAgentSessionId('new'))
    expect(
      (await listRecordedSessions(handle.agentId)).map(s =>
        String(s.agentSessionId),
      )[0],
    ).toBe('new')
  })

  test('an agent with no session record lists nothing', async () => {
    expect(
      await listRecordedSessions('stub:agent_99' as AgentInstanceId),
    ).toEqual([])
  })
})

describe('permission replies', () => {
  test('forwards the decision verbatim to the adapter', async () => {
    const handle = await launch()
    await respondToPermission(handle.agentId, 'req_1', 'accept-for-session')
    expect(stub(handle).permissionReplies).toEqual([
      { requestId: 'req_1', decision: 'accept-for-session' },
    ])
  })

  test('is refused when the agent has no reply channel', async () => {
    const handle = await launch({ capabilities: { permissions: 'observe' } })
    await expect(
      respondToPermission(handle.agentId, 'req_1', 'accept'),
    ).rejects.toThrow(CapabilityError)
  })
})

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

describe('inspection', () => {
  test('reports the full four-axis state plus the operation matrix', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'work' }, { taskRef: TASK })
    await assign(handle.agentId, { text: 'queued' })

    const inspection = await inspectAgent(handle.agentId)
    expect(inspection.provider).toBe(STUB)
    expect(inspection.adoption).toBe('managed')
    expect(inspection.durability).toBe('session-bound')
    expect(inspection.status.agentState).toBe('working')
    expect(inspection.status.activeTurn?.id).toBe('turn_1')
    expect(inspection.pendingInputs).toBe(1)
    expect(inspection.pid).toBe(process.pid)
    expect(inspection.activeSessionId).toBeDefined()
    expect(inspection.record?.provider).toBe(STUB)
  })

  test('the operation matrix matches what the manager would actually allow', async () => {
    // Computed from capabilities AND method presence, so the UI and the manager
    // cannot drift.
    const handle = await launch({ capabilities: { messages: 'message', sessions: 'observe' } })
    const inspection = await inspectAgent(handle.agentId)
    expect(inspection.operations.sendMessage).toBe(true)
    expect(inspection.operations.steer).toBe(false)
    expect(inspection.operations.listSessions).toBe(true)
    expect(inspection.operations.resumeSession).toBe(false)
    expect(inspection.operations.forkSession).toBe(false)

    for (const [operation, allowed] of Object.entries(inspection.operations)) {
      expect(canPerform(handle, operation as never)).toBe(allowed)
    }
  })

  test('an adopted agent with no pid reports absent, not zero', async () => {
    registerAdapter(
      createStubAdapter({ withoutPid: true, adoption: 'adoptable' }),
    )
    const handle = await adoptAgent(adoptTarget('stub:agent_01'))
    const inspection = await inspectAgent(handle.agentId)
    expect(inspection.pid).toBeUndefined()
    expect(inspection.status.processState).toBe('absent')
  })

  test('inspecting an unknown agent throws', async () => {
    await expect(
      inspectAgent('stub:agent_99' as AgentInstanceId),
    ).rejects.toThrow(UnknownAgentError)
  })

  test('every declared operation appears in the matrix', async () => {
    const handle = await launch({ capabilities: noCapabilities() })
    const inspection = await inspectAgent(handle.agentId)
    expect(Object.keys(inspection.operations)).toHaveLength(11)
    expect(Object.values(inspection.operations).every(v => v === false)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe('reset', () => {
  test('clears the registry and the pending queues', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    await assign(handle.agentId, { text: 'queued' })
    resetAgentManager()
    expect(listLiveAgents()).toEqual([])
    expect(pendingCount(handle.agentId)).toBe(0)
  })

  test('a reset agent no longer drains on idle', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    await assign(handle.agentId, { text: 'queued' })
    resetAgentManager()
    stub(handle).completeHeldTurn()
    await tick(20)
    expect(stub(handle).sent).toHaveLength(1)
  })
})
