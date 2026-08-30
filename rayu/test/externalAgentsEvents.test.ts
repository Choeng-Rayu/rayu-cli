/**
 * Event bus, envelope factory, disk log, and the five sinks.
 *
 * The sink tests are the interesting half: each sink is registered as its own
 * independent bus subscriber, and that separation is load-bearing rather than
 * stylistic — a throwing sink must not silently swallow the ones registered
 * after it. That is exercised directly below.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  currentSeq,
  forgetSeq,
  nextSeq,
  publishEvent,
  resetEventBus,
  seedSeq,
  subscribeToAgent,
  subscribeToEvents,
  waitForAgentEvent,
} from '../src/externalAgents/core/eventBus.ts'
import {
  buildEvent,
  emitEvent,
  emitEvents,
  type EventContext,
  type EventPayload,
} from '../src/externalAgents/core/normalizer.ts'
import {
  appendEvent,
  clearEventLog,
  flushEventLog,
  readEvents,
  readLastEvent,
} from '../src/externalAgents/core/eventLog.ts'
import {
  EXTERNAL_AGENT_SUMMARY_PREFIX,
  installEventSinks,
  renderEventForOutput,
  shouldNotifyModel,
} from '../src/externalAgents/core/eventSinks.ts'
import {
  asAgentSessionId,
  asProviderId,
  asTaskRef,
  noCapabilities,
  type AgentInstanceId,
  type ExternalAgentEvent,
} from '../src/externalAgents/core/types.ts'
import { getAgentEventsDir } from '../src/externalAgents/persistence/paths.ts'
import {
  clearCommandQueue,
  getPendingNotificationsSnapshot,
} from '../src/utils/messageQueueManager.ts'
import { drainSdkEvents } from '../src/utils/sdkEventQueue.ts'
import {
  _resetTaskOutputDirForTest,
  flushTaskOutput,
  getTaskOutputPath,
} from '../src/utils/task/diskOutput.ts'
import type { ExternalAgentTaskState } from '../src/tasks/ExternalAgentTask/guards.ts'

const AGENT = 'codex:agent_01' as AgentInstanceId
const OTHER = 'claude-code:agent_01' as AgentInstanceId
const TASK = asTaskRef('task_ext_1')

const CTX: EventContext = { agentId: AGENT }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-events-'))
  process.env.RAYU_CONFIG_DIR = dir
  resetEventBus()
  clearCommandQueue()
  drainSdkEvents()
  _resetTaskOutputDirForTest()
})
afterEach(async () => {
  resetEventBus()
  // The per-agent write chain is module-level and resolves its path lazily, so
  // an append still in flight would land in the NEXT test's config dir. Draining
  // both agents also drops their chain entries.
  await clearEventLog(AGENT)
  await clearEventLog(OTHER)
  clearCommandQueue()
  drainSdkEvents()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

function message(text: string, delta = false): EventPayload {
  return { type: 'agent_message', text, delta }
}

// ---------------------------------------------------------------------------
// Sequence numbers
// ---------------------------------------------------------------------------

describe('sequence allocation', () => {
  test('is monotonic per agent and independent across agents', () => {
    expect(nextSeq(AGENT)).toBe(1)
    expect(nextSeq(AGENT)).toBe(2)
    expect(nextSeq(OTHER)).toBe(1)
    expect(nextSeq(AGENT)).toBe(3)
    expect(currentSeq(AGENT)).toBe(3)
    expect(currentSeq(OTHER)).toBe(1)
  })

  test('an unseen agent reports 0', () => {
    expect(currentSeq('never:seen' as AgentInstanceId)).toBe(0)
  })

  test('seeding continues from a persisted high-water mark', () => {
    // A recovered agent must not restart at 1, which would make old and new
    // events indistinguishable in the log.
    seedSeq(AGENT, 42)
    expect(nextSeq(AGENT)).toBe(43)
  })

  test('seeding refuses to lower a sequence', () => {
    // Replaying numbers already written would make gap detection report phantom
    // gaps and dedupe drop live events.
    nextSeq(AGENT)
    nextSeq(AGENT)
    seedSeq(AGENT, 1)
    expect(nextSeq(AGENT)).toBe(3)
  })

  test('forget restarts numbering', () => {
    nextSeq(AGENT)
    forgetSeq(AGENT)
    expect(currentSeq(AGENT)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Envelope factory
// ---------------------------------------------------------------------------

describe('event envelope', () => {
  test('stamps agent, timestamp and sequence', () => {
    const before = Date.now()
    const event = buildEvent(CTX, message('hi'))
    expect(event.agentId).toBe(AGENT)
    expect(event.seq).toBe(1)
    expect(event.at).toBeGreaterThanOrEqual(before)
    expect(event.type).toBe('agent_message')
  })

  test('carries session, task and turn context', () => {
    const event = buildEvent(
      {
        agentId: AGENT,
        sessionId: asAgentSessionId('thread_1'),
        taskRef: TASK,
        turnId: 'turn_1',
      },
      message('hi'),
    )
    expect(String(event.sessionId)).toBe('thread_1')
    expect(event.taskRef).toBe(TASK)
    expect(event.turnId).toBe('turn_1')
  })

  test('buildEvent does not publish', () => {
    const seen: ExternalAgentEvent[] = []
    subscribeToEvents(e => seen.push(e))
    buildEvent(CTX, message('quiet'))
    expect(seen).toEqual([])
  })

  test('emitEvent publishes exactly once', () => {
    const seen: ExternalAgentEvent[] = []
    subscribeToEvents(e => seen.push(e))
    emitEvent(CTX, message('loud'))
    expect(seen).toHaveLength(1)
  })

  test('a batch keeps allocation order contiguous', () => {
    // Sequence is allocated at build time, so an adapter batching several events
    // from one wire message keeps them strictly ordered.
    const events = emitEvents(CTX, [
      message('a'),
      { type: 'file_changed', path: '/x.ts', change: 'modified' },
      { type: 'task_completed', summary: 'done' },
    ])
    expect(events.map(e => e.seq)).toEqual([1, 2, 3])
  })

  test('an empty batch is a no-op', () => {
    expect(emitEvents(CTX, [])).toEqual([])
    expect(currentSeq(AGENT)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

describe('event bus', () => {
  test('fans out to every subscriber', () => {
    const a: string[] = []
    const b: string[] = []
    subscribeToEvents(e => a.push(e.type))
    subscribeToEvents(e => b.push(e.type))
    emitEvent(CTX, message('x'))
    expect(a).toEqual(['agent_message'])
    expect(b).toEqual(['agent_message'])
  })

  test('unsubscribe stops delivery', () => {
    const seen: string[] = []
    const off = subscribeToEvents(e => seen.push(e.type))
    emitEvent(CTX, message('one'))
    off()
    emitEvent(CTX, message('two'))
    expect(seen).toHaveLength(1)
  })

  test('a throwing subscriber does not stop later ones', () => {
    // The disk log must still record an event even when a UI sink blows up,
    // because that log is what the recovery path reads after a crash.
    const reached: string[] = []
    subscribeToEvents(() => {
      throw new Error('sink exploded')
    })
    subscribeToEvents(e => reached.push(e.type))
    emitEvent(CTX, message('x'))
    expect(reached).toEqual(['agent_message'])
  })

  test('subscribeToAgent filters by agent', () => {
    const seen: string[] = []
    subscribeToAgent(AGENT, e => seen.push(e.agentId))
    emitEvent({ agentId: AGENT }, message('mine'))
    emitEvent({ agentId: OTHER }, message('theirs'))
    expect(seen).toEqual([AGENT])
  })

  test('waitForAgentEvent resolves on a match', async () => {
    const promise = waitForAgentEvent(
      AGENT,
      e => e.type === 'task_completed',
      1000,
    )
    emitEvent(CTX, message('noise'))
    emitEvent(CTX, { type: 'task_completed', summary: 'ok' })
    const event = await promise
    expect(event?.type).toBe('task_completed')
  })

  test('waitForAgentEvent resolves null on timeout rather than rejecting', async () => {
    // The caller decides whether a timeout is an error; a rejection here would
    // force every adapter to wrap it.
    expect(await waitForAgentEvent(AGENT, () => false, 20)).toBeNull()
  })

  test('waitForAgentEvent ignores other agents', async () => {
    const promise = waitForAgentEvent(AGENT, () => true, 60)
    emitEvent({ agentId: OTHER }, message('not mine'))
    expect(await promise).toBeNull()
  })

  test('waitForAgentEvent unsubscribes after settling', async () => {
    const promise = waitForAgentEvent(AGENT, () => true, 500)
    emitEvent(CTX, message('first'))
    await promise
    // A second event must not leak a listener or double-resolve.
    emitEvent(CTX, message('second'))
    expect(currentSeq(AGENT)).toBe(2)
  })

  test('reset clears subscribers and sequences', () => {
    const seen: string[] = []
    subscribeToEvents(e => seen.push(e.type))
    nextSeq(AGENT)
    resetEventBus()
    emitEvent(CTX, message('after reset'))
    expect(seen).toEqual([])
    expect(currentSeq(AGENT)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Disk log
// ---------------------------------------------------------------------------

describe('event log', () => {
  test('appends JSONL under the agent event dir', async () => {
    await appendEvent(buildEvent(CTX, message('logged')))
    const file = join(getAgentEventsDir(AGENT), 'events.jsonl')
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).text).toBe('logged')
  })

  test('reads back in order across many events', async () => {
    for (let i = 1; i <= 5; i++) {
      void appendEvent(buildEvent(CTX, message(`m${i}`)))
    }
    const events = await readEvents(AGENT)
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  test('concurrent appends are serialized, not interleaved', async () => {
    // Interleaved partial writes would corrupt a JSONL line and poison the
    // reader for every earlier event too.
    const events = Array.from({ length: 60 }, (_, i) =>
      buildEvent(CTX, message(`chunk-${i}-${'x'.repeat(500)}`)),
    )
    await Promise.all(events.map(appendEvent))
    const read = await readEvents(AGENT)
    expect(read).toHaveLength(60)
    expect(read.map(e => e.seq)).toEqual(events.map(e => e.seq))
  })

  test('sinceSeq replays only the tail', async () => {
    for (let i = 1; i <= 4; i++) void appendEvent(buildEvent(CTX, message(`m${i}`)))
    const tail = await readEvents(AGENT, { sinceSeq: 2 })
    expect(tail.map(e => e.seq)).toEqual([3, 4])
  })

  test('limit returns the most recent events', async () => {
    for (let i = 1; i <= 4; i++) void appendEvent(buildEvent(CTX, message(`m${i}`)))
    expect((await readEvents(AGENT, { limit: 2 })).map(e => e.seq)).toEqual([3, 4])
  })

  test('readLastEvent reports what the agent was doing when it stopped', async () => {
    // agent.json records the final state; only the log can say how it got there.
    void appendEvent(buildEvent(CTX, message('working on it')))
    void appendEvent(
      buildEvent(CTX, { type: 'task_failed', message: 'ran out of context' }),
    )
    const last = await readLastEvent(AGENT)
    expect(last?.type).toBe('task_failed')
    if (last?.type === 'task_failed') {
      expect(last.message).toBe('ran out of context')
    }
  })

  test('readLastEvent returns null for an agent with no log', async () => {
    expect(await readLastEvent(AGENT)).toBeNull()
  })

  test('reading a nonexistent log returns empty, not an error', async () => {
    expect(await readEvents(AGENT)).toEqual([])
  })

  test('a corrupt line does not lose the readable ones', async () => {
    void appendEvent(buildEvent(CTX, message('good')))
    await flushEventLog(AGENT)
    const { appendFileSync } = await import('fs')
    appendFileSync(join(getAgentEventsDir(AGENT), 'events.jsonl'), 'not json\n')
    void appendEvent(buildEvent(CTX, message('also good')))
    const events = await readEvents(AGENT)
    expect(events.map(e => (e as { text?: string }).text)).toEqual([
      'good',
      'also good',
    ])
  })

  test('logs for different agents are separate', async () => {
    void appendEvent(buildEvent({ agentId: AGENT }, message('mine')))
    void appendEvent(buildEvent({ agentId: OTHER }, message('theirs')))
    expect(await readEvents(AGENT)).toHaveLength(1)
    expect(await readEvents(OTHER)).toHaveLength(1)
  })

  test('clearEventLog removes the directory', async () => {
    void appendEvent(buildEvent(CTX, message('temp')))
    await clearEventLog(AGENT)
    expect(existsSync(getAgentEventsDir(AGENT))).toBe(false)
    expect(await readEvents(AGENT)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('event rendering', () => {
  function render(payload: EventPayload): string | null {
    return renderEventForOutput(buildEvent(CTX, payload))
  }

  test('agent prose is passed through verbatim', () => {
    expect(render(message('Here is the plan.'))).toBe('Here is the plan.')
  })

  test('tool output is passed through verbatim', () => {
    // A reader must be able to tell tool stdout from RAYU's own labelling.
    expect(
      render({
        type: 'tool_output',
        callId: 'c1',
        chunk: 'raw stdout\n',
        stream: 'stdout',
      }),
    ).toBe('raw stdout\n')
  })

  test('thinking deltas are dropped, complete thoughts are labelled', () => {
    expect(render({ type: 'agent_thinking', text: 'part', delta: true })).toBeNull()
    expect(render({ type: 'agent_thinking', text: 'whole', delta: false })).toBe(
      '[thinking] whole\n',
    )
  })

  test('labels tool, file, permission, failure and error lines', () => {
    expect(
      render({ type: 'tool_started', callId: 'c', toolName: 'Bash', summary: 'ls' }),
    ).toContain('[tool] Bash: ls')
    expect(
      render({ type: 'file_changed', path: '/a.ts', change: 'created' }),
    ).toBe('[file created] /a.ts\n')
    expect(
      render({
        type: 'permission_requested',
        requestId: 'r1',
        kind: 'command',
        description: 'run rm -rf build',
      }),
    ).toContain('[permission] run rm -rf build')
    expect(render({ type: 'task_failed', message: 'boom' })).toContain(
      '[failed] boom',
    )
    expect(render({ type: 'agent_error', message: 'overloaded' })).toContain(
      '[error] overloaded',
    )
    expect(
      render({ type: 'agent_disconnected', reason: 'shutdown' }),
    ).toContain('[disconnected] shutdown')
  })

  test('pure state transitions render nothing', () => {
    expect(
      render({
        type: 'agent_started',
        provider: asProviderId('codex'),
        adoption: 'managed',
        capabilities: noCapabilities(),
      }),
    ).toBeNull()
    expect(render({ type: 'agent_idle' })).toBeNull()
  })

  test('completion renders with or without a summary', () => {
    expect(render({ type: 'task_completed', summary: 'shipped' })).toContain(
      '[completed] shipped',
    )
    expect(render({ type: 'task_completed' })).toBe('\n[completed]\n')
  })
})

// ---------------------------------------------------------------------------
// Model-notification selectivity
// ---------------------------------------------------------------------------

describe('model notification selectivity', () => {
  function should(payload: EventPayload): boolean {
    return shouldNotifyModel(buildEvent(CTX, payload))
  }

  test('notifies on events the model must act on', () => {
    expect(should({ type: 'task_completed' })).toBe(true)
    expect(should({ type: 'task_failed', message: 'x' })).toBe(true)
    expect(should({ type: 'agent_error', message: 'x' })).toBe(true)
    expect(
      should({
        type: 'permission_requested',
        requestId: 'r',
        kind: 'tool',
        description: 'd',
      }),
    ).toBe(true)
  })

  test('does NOT notify on streaming text or tool chatter', () => {
    // A streaming agent emits deltas continuously; enqueuing each one would
    // burn the model's context on text it can read from the output file.
    expect(should(message('token', true))).toBe(false)
    expect(should({ type: 'agent_thinking', text: 't', delta: true })).toBe(false)
    expect(should({ type: 'tool_started', callId: 'c', toolName: 'Bash' })).toBe(
      false,
    )
    expect(
      should({ type: 'tool_output', callId: 'c', chunk: 'x', stream: 'stdout' }),
    ).toBe(false)
    expect(should({ type: 'file_changed', path: '/a', change: 'modified' })).toBe(
      false,
    )
    expect(should({ type: 'agent_idle' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Installed sinks
// ---------------------------------------------------------------------------

describe('installed event sinks', () => {
  type Stub = {
    tasks: Record<string, unknown>
    speculation: { status: 'idle' }
  }

  function harness() {
    let state: Stub = {
      tasks: {
        [TASK]: {
          type: 'external_agent',
          agentInstanceId: AGENT,
          provider: asProviderId('codex'),
          prompt: 'do it',
          externalState: 'dispatched',
          changedFiles: [],
          status: 'running',
          isBackgrounded: true,
          lastReportedTotalLines: 0,
        } satisfies Partial<ExternalAgentTaskState> as unknown,
      },
      // abortSpeculation reads prev.speculation.status unconditionally; without
      // it every terminal event throws inside the AppState sink.
      speculation: { status: 'idle' },
    }
    const setAppState = (updater: unknown) => {
      state = typeof updater === 'function'
        ? (updater as (p: Stub) => Stub)(state)
        : (updater as Stub)
    }
    const uninstall = installEventSinks(setAppState as never)
    return {
      uninstall,
      task: () => state.tasks[TASK] as ExternalAgentTaskState,
    }
  }

  test('an event reaches disk, task output, AppState, the model and the SDK', async () => {
    const h = harness()
    try {
      emitEvent({ agentId: AGENT, taskRef: TASK }, message('working'))
      emitEvent(
        { agentId: AGENT, taskRef: TASK },
        { type: 'task_completed', summary: 'all done' },
      )

      // 1. disk log
      const logged = await readEvents(AGENT)
      expect(logged.map(e => e.type)).toEqual(['agent_message', 'task_completed'])

      // 2. task output file
      await flushTaskOutput(TASK)
      const output = readFileSync(getTaskOutputPath(TASK), 'utf-8')
      expect(output).toContain('working')
      expect(output).toContain('[completed] all done')

      // 3. AppState
      expect(h.task().externalState).toBe('completed')
      expect(h.task().resultSummary).toBe('all done')
      expect(h.task().endTime).toBeGreaterThan(0)

      // 4. model queue
      const queued = getPendingNotificationsSnapshot()
      expect(queued).toHaveLength(1)
      expect(String(queued[0]!.value)).toContain(EXTERNAL_AGENT_SUMMARY_PREFIX)
      expect(String(queued[0]!.value)).toContain('<status>completed</status>')

      // 5. SDK queue
      const sdk = drainSdkEvents()
      expect(sdk.some(e => JSON.stringify(e).includes('task_notification'))).toBe(
        true,
      )
    } finally {
      h.uninstall()
    }
  })

  test('progress notifications carry NO status tag', async () => {
    // print.ts treats ANY <status> as terminal, so a progress event carrying one
    // would falsely close the task for SDK consumers.
    const h = harness()
    try {
      emitEvent(
        { agentId: AGENT, taskRef: TASK },
        {
          type: 'permission_requested',
          requestId: 'r1',
          kind: 'command',
          description: 'run tests',
        },
      )
      const queued = getPendingNotificationsSnapshot()
      expect(queued).toHaveLength(1)
      expect(String(queued[0]!.value)).not.toContain('<status>')
      // Blocking events jump the queue.
      expect(queued[0]!.priority).toBe('next')
    } finally {
      h.uninstall()
    }
  })

  test('a completion is queued as later so it cannot preempt the user', async () => {
    const h = harness()
    try {
      emitEvent({ agentId: AGENT, taskRef: TASK }, { type: 'task_completed' })
      expect(getPendingNotificationsSnapshot()[0]!.priority).toBe('later')
    } finally {
      h.uninstall()
    }
  })

  test('events with no taskRef reach the log but not the task sinks', async () => {
    const h = harness()
    try {
      emitEvent({ agentId: AGENT }, { type: 'task_completed', summary: 'orphan' })
      expect(await readEvents(AGENT)).toHaveLength(1)
      expect(getPendingNotificationsSnapshot()).toHaveLength(0)
      expect(h.task().externalState).toBe('dispatched')
    } finally {
      h.uninstall()
    }
  })

  test('file_changed accumulates deduplicated paths on the task', () => {
    const h = harness()
    try {
      for (const path of ['/a.ts', '/b.ts', '/a.ts']) {
        emitEvent(
          { agentId: AGENT, taskRef: TASK },
          { type: 'file_changed', path, change: 'modified' },
        )
      }
      expect(h.task().changedFiles).toEqual(['/a.ts', '/b.ts'])
    } finally {
      h.uninstall()
    }
  })

  test('a provider fault moves the task to waiting-provider, not failed', () => {
    // The task is not finished and must not be evicted; the user can act on it
    // by waiting or switching provider.
    const h = harness()
    try {
      emitEvent(
        { agentId: AGENT, taskRef: TASK },
        { type: 'agent_error', message: 'upstream 529', providerFault: true },
      )
      expect(h.task().externalState).toBe('waiting-provider')
    } finally {
      h.uninstall()
    }
  })

  test('a non-provider error leaves the task state alone', () => {
    const h = harness()
    try {
      emitEvent(
        { agentId: AGENT, taskRef: TASK },
        { type: 'agent_error', message: 'bad tool input' },
      )
      expect(h.task().externalState).toBe('dispatched')
    } finally {
      h.uninstall()
    }
  })

  test('a terminal event clears the active turn', () => {
    const h = harness()
    try {
      emitEvent(
        { agentId: AGENT, taskRef: TASK, turnId: 'turn_1' },
        message('mid-turn'),
      )
      expect(h.task().activeTurnId).toBe('turn_1')
      emitEvent(
        { agentId: AGENT, taskRef: TASK, turnId: 'turn_1' },
        { type: 'task_completed' },
      )
      expect(h.task().activeTurnId).toBeUndefined()
    } finally {
      h.uninstall()
    }
  })

  test('disconnect by shutdown reports killed, other reasons report failed', () => {
    const h = harness()
    try {
      emitEvent(
        { agentId: AGENT, taskRef: TASK },
        { type: 'agent_disconnected', reason: 'shutdown' },
      )
      expect(String(getPendingNotificationsSnapshot()[0]!.value)).toContain(
        '<status>killed</status>',
      )
      clearCommandQueue()
      emitEvent(
        { agentId: AGENT, taskRef: TASK },
        { type: 'agent_disconnected', reason: 'process_exit' },
      )
      expect(String(getPendingNotificationsSnapshot()[0]!.value)).toContain(
        '<status>failed</status>',
      )
    } finally {
      h.uninstall()
    }
  })

  test('summaries are XML-escaped', () => {
    const h = harness()
    try {
      emitEvent(
        { agentId: AGENT, taskRef: TASK },
        { type: 'task_failed', message: 'compare <a> & <b>' },
      )
      const value = String(getPendingNotificationsSnapshot()[0]!.value)
      expect(value).toContain('&lt;a&gt;')
      expect(value).toContain('&amp;')
    } finally {
      h.uninstall()
    }
  })

  test('a task that is not an external agent task is left untouched', () => {
    // updateTaskState is shared with shell tasks; the guard prevents this sink
    // from stomping on a different task type that happens to share a ref.
    let state = {
      tasks: { [TASK]: { type: 'local_shell', status: 'running' } },
      speculation: { status: 'idle' as const },
    }
    const uninstall = installEventSinks(((updater: unknown) => {
      state = typeof updater === 'function'
        ? (updater as (p: typeof state) => typeof state)(state)
        : (updater as typeof state)
    }) as never)
    try {
      emitEvent({ agentId: AGENT, taskRef: TASK }, { type: 'task_completed' })
      expect(state.tasks[TASK]).toEqual({ type: 'local_shell', status: 'running' })
    } finally {
      uninstall()
    }
  })

  test('uninstall detaches every sink', async () => {
    const h = harness()
    h.uninstall()
    emitEvent({ agentId: AGENT, taskRef: TASK }, { type: 'task_completed' })
    expect(await readEvents(AGENT)).toEqual([])
    expect(getPendingNotificationsSnapshot()).toHaveLength(0)
    expect(h.task().externalState).toBe('dispatched')
  })

  test('a broken AppState setter does not stop the disk log or the model queue', async () => {
    // The exact failure this five-subscriber design exists to prevent: during
    // development, abortSpeculation throwing on an unexpected AppState shape
    // swallowed the completion notification to the model AND the SDK, so tasks
    // appeared to hang with no error anywhere.
    const uninstall = installEventSinks((() => {
      throw new Error('AppState shape unexpected')
    }) as never)
    try {
      emitEvent({ agentId: AGENT, taskRef: TASK }, { type: 'task_completed' })
      expect(await readEvents(AGENT)).toHaveLength(1)
      expect(getPendingNotificationsSnapshot()).toHaveLength(1)
      expect(drainSdkEvents().length).toBeGreaterThan(0)
    } finally {
      uninstall()
    }
  })
})
