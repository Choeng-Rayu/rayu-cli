/**
 * The model-facing `ExternalAgent` tool and the `external_agent` task type.
 *
 * The surface is deliberately narrow — delegate / send / list / orchestrate.
 * TaskOutput, TaskGet, TaskList and TaskStop already work on these tasks, so
 * duplicating them here would add a second way to do the same thing.
 *
 * Two behaviours are load-bearing:
 *
 *   - `delegate` does NOT wait. It returns what admission control decided, and a
 *     queued dispatch says "do not resend" — a model that resent would double the
 *     work.
 *   - `ExternalAgentTask.kill` interrupts the TURN, not the agent. The agent may
 *     be process-durable, serving other tasks, or hosting a TUI the user is
 *     looking at.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ExternalAgentTool } from '../src/tools/ExternalAgentTool/ExternalAgentTool.ts'
import type { Input, Output } from '../src/tools/ExternalAgentTool/ExternalAgentTool.ts'
import {
  ExternalAgentTask,
  isExternalAgentTask,
  isTerminalExternalState,
  noteExternalTaskFile,
  registerExternalAgentTask,
  setExternalTaskState,
} from '../src/tasks/ExternalAgentTask/ExternalAgentTask.ts'
import type { ExternalAgentTaskState } from '../src/tasks/ExternalAgentTask/guards.ts'
import {
  registerAdapter,
  resetAdapterRegistry,
} from '../src/externalAgents/core/adapterRegistry.ts'
import {
  createObserveOnlyStubAdapter,
  createStubAdapter,
  type StubHandle,
} from '../src/externalAgents/adapters/stub/StubAdapter.ts'
import {
  assign,
  listLiveAgents,
  resetAgentManager,
  startAgent,
} from '../src/externalAgents/core/AgentManager.ts'
import { resetEventBus } from '../src/externalAgents/core/eventBus.ts'
import { resetWorkspaceManager } from '../src/externalAgents/workspace/workspaceManager.ts'
import {
  asProviderId,
  type AgentInstanceId,
} from '../src/externalAgents/core/types.ts'
import type { AgentHandle } from '../src/externalAgents/core/adapter.ts'
import type { ToolUseContext } from '../src/Tool.ts'

const STUB = asProviderId('stub')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-tool-'))
  process.env.RAYU_CONFIG_DIR = dir
  resetAdapterRegistry()
  resetAgentManager()
  resetWorkspaceManager()
  resetEventBus()
})
afterEach(() => {
  resetAdapterRegistry()
  resetAgentManager()
  resetWorkspaceManager()
  resetEventBus()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

/** Minimal AppState harness — the tool only needs setAppState + tasks. */
function appState() {
  type State = {
    tasks: Record<string, unknown>
    speculation: { status: 'idle' }
  }
  let state: State = { tasks: {}, speculation: { status: 'idle' } }
  const setAppState = ((updater: unknown) => {
    state = typeof updater === 'function'
      ? (updater as (p: State) => State)(state)
      : (updater as State)
  }) as never
  return {
    setAppState,
    tasks: () => state.tasks,
    task: (id: string) => state.tasks[id] as ExternalAgentTaskState,
    context: {
      setAppState,
      toolUseId: 'tool_use_1',
      abortController: new AbortController(),
    } as unknown as ToolUseContext,
  }
}

async function launch(
  options: Parameters<typeof createStubAdapter>[0] = {},
): Promise<AgentHandle> {
  registerAdapter(createStubAdapter({ provider: STUB, ...options }))
  return startAgent({ provider: STUB, cwd: dir })
}

async function call(input: Input, context: ToolUseContext): Promise<Output> {
  const generator = ExternalAgentTool.call(input, context) as unknown
  const result = await (generator as Promise<{ data: Output }>)
  return result.data
}

const validate = (input: Partial<Input>) =>
  ExternalAgentTool.validateInput!(input as Input)

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe('tool metadata', () => {
  test('only list is read-only and concurrency-safe', () => {
    // delegate and send hand work to a process that will edit files, so they
    // must never be treated as safe to run concurrently.
    expect(ExternalAgentTool.isReadOnly({ action: 'list' } as Input)).toBe(true)
    expect(ExternalAgentTool.isConcurrencySafe({ action: 'list' } as Input)).toBe(
      true,
    )
    for (const action of ['delegate', 'send', 'orchestrate'] as const) {
      expect(ExternalAgentTool.isReadOnly({ action } as Input)).toBe(false)
      expect(ExternalAgentTool.isConcurrencySafe({ action } as Input)).toBe(false)
    }
  })

  test('the activity description names the action and its target', () => {
    expect(
      ExternalAgentTool.getActivityDescription!({
        action: 'send',
        agent_id: 'codex:agent_01',
      } as Input),
    ).toContain('codex:agent_01')
    expect(
      ExternalAgentTool.getActivityDescription!({
        action: 'orchestrate',
        mode: 'race',
        steps: [{ id: 'a', prompt: 'x' }],
      } as Input),
    ).toContain('race')
    expect(ExternalAgentTool.getActivityDescription!(undefined as never)).toContain(
      'external agent',
    )
  })

  test('the tool-use message distinguishes delegate from send', () => {
    expect(
      ExternalAgentTool.renderToolUseMessage!({
        action: 'delegate',
        provider: 'codex',
        isolate: true,
      } as Input),
    ).toContain('(isolated)')
    expect(
      ExternalAgentTool.renderToolUseMessage!({
        action: 'send',
        agent_id: 'codex:agent_01',
      } as Input),
    ).toContain('codex:agent_01')
  })

  test('the schema rejects unknown keys', () => {
    // strictObject: a hallucinated field is a schema error rather than a silently
    // ignored instruction.
    const parsed = ExternalAgentTool.inputSchema.safeParse({
      action: 'list',
      unexpected: true,
    })
    expect(parsed.success).toBe(false)
  })

  test('the result block renders the summary as text', () => {
    const block = ExternalAgentTool.mapToolResultToToolResultBlockParam!(
      { action: 'list', summary: 'Installed: codex.' } as Output,
      'tu_1',
    )
    expect(JSON.stringify(block)).toContain('Installed: codex.')
  })
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('input validation', () => {
  test('list needs nothing', async () => {
    expect(await validate({ action: 'list' })).toEqual({ result: true })
  })

  test('delegate and send need a prompt', async () => {
    for (const action of ['delegate', 'send'] as const) {
      const result = await validate({ action, agent_id: 'codex:agent_01' })
      expect(result.result).toBe(false)
      expect((result as { message: string }).message).toContain('prompt is required')
    }
    // Whitespace is not a prompt.
    const blank = await validate({
      action: 'send',
      agent_id: 'x',
      prompt: '   ',
    })
    expect(blank.result).toBe(false)
  })

  test('send needs an agent_id, and the message says how to find one', async () => {
    const result = await validate({ action: 'send', prompt: 'do it' })
    expect(result.result).toBe(false)
    expect((result as { message: string }).message).toContain('action="list"')
  })

  test('delegate needs either a provider or an agent_id', async () => {
    const result = await validate({ action: 'delegate', prompt: 'do it' })
    expect(result.result).toBe(false)
    expect((result as { message: string }).message).toContain(
      'either provider',
    )
  })

  test('delegate accepts a provider alone or an agent_id alone', async () => {
    expect(
      await validate({ action: 'delegate', prompt: 'x', provider: 'codex' }),
    ).toEqual({ result: true })
    expect(
      await validate({ action: 'delegate', prompt: 'x', agent_id: 'codex:agent_01' }),
    ).toEqual({ result: true })
  })

  test('orchestrate needs a non-empty steps array', async () => {
    for (const steps of [undefined, []]) {
      const result = await validate({ action: 'orchestrate', steps })
      expect(result.result).toBe(false)
      expect((result as { message: string }).message).toContain('non-empty steps')
    }
  })

  test('every orchestrate step needs a target, and the message NAMES the step', async () => {
    const result = await validate({
      action: 'orchestrate',
      steps: [
        { id: 'good', prompt: 'x', provider: 'codex' },
        { id: 'bad', prompt: 'y' },
      ],
    })
    expect(result.result).toBe(false)
    expect((result as { message: string }).message).toContain('Step "bad"')
  })

  test('a review provider without a review prompt is refused', async () => {
    const result = await validate({
      action: 'orchestrate',
      steps: [{ id: 'a', prompt: 'x', provider: 'codex' }],
      review_provider: 'claude-code',
    })
    expect(result.result).toBe(false)
    expect((result as { message: string }).message).toContain('review_prompt')
  })

  test('a valid orchestrate plan passes', async () => {
    expect(
      await validate({
        action: 'orchestrate',
        mode: 'race',
        steps: [
          { id: 'a', prompt: 'x', provider: 'codex', isolate: true },
          { id: 'b', prompt: 'x', provider: 'claude-code', isolate: true },
        ],
        review_provider: 'opencode',
        review_prompt: 'check it',
      }),
    ).toEqual({ result: true })
  })

  test('every validation failure carries a distinct error code', async () => {
    const codes = new Set<number>()
    for (const input of [
      { action: 'send', prompt: 'x' },
      { action: 'delegate', prompt: 'x' },
      { action: 'send', agent_id: 'x' },
      { action: 'orchestrate' },
      { action: 'orchestrate', steps: [{ id: 'a', prompt: 'x' }] },
      {
        action: 'orchestrate',
        steps: [{ id: 'a', prompt: 'x', provider: 'c' }],
        review_provider: 'r',
      },
    ] as Partial<Input>[]) {
      const result = await validate(input)
      expect(result.result).toBe(false)
      codes.add((result as { errorCode: number }).errorCode)
    }
    expect(codes.size).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list action', () => {
  test('reports what is actually installed, and none connected', async () => {
    // `call` registers the real built-in adapters, so `providers` reflects this
    // machine. What is deterministic is that nothing is CONNECTED yet.
    const app = appState()
    const output = await call({ action: 'list' } as Input, app.context)
    expect(output.agents).toEqual([])
    expect(output.summary).toContain('Connected: none.')
    for (const provider of output.providers ?? []) {
      expect(typeof provider).toBe('string')
    }
  })

  test('reports installed providers and connected agents', async () => {
    const app = appState()
    const handle = await launch()
    const output = await call({ action: 'list' } as Input, app.context)
    expect(output.providers).toContain('stub')
    expect(output.agents).toHaveLength(1)
    expect(output.agents![0]).toMatchObject({
      agent_id: handle.agentId,
      provider: 'stub',
      agent_state: 'idle',
      can_send: true,
    })
    expect(output.summary).toContain(handle.agentId)
  })

  test('can_send is PER INSTANCE, not per provider', async () => {
    // An adopted or observe-class instance can be connected yet unable to accept
    // input.
    const app = appState()
    registerAdapter(createObserveOnlyStubAdapter(asProviderId('watch')))
    await startAgent({ provider: asProviderId('watch'), cwd: dir })
    const output = await call({ action: 'list' } as Input, app.context)
    expect(output.agents![0]!.can_send).toBe(false)
  })

  test('the rendered text flags an agent that cannot accept input', async () => {
    registerAdapter(createObserveOnlyStubAdapter(asProviderId('watch')))
    await startAgent({ provider: asProviderId('watch'), cwd: dir })
    const app = appState()
    const output = await call({ action: 'list' } as Input, app.context)
    const block = ExternalAgentTool.mapToolResultToToolResultBlockParam!(
      output,
      'tu_1',
    )
    expect(JSON.stringify(block)).toContain('cannot accept input')
  })
})

// ---------------------------------------------------------------------------
// delegate and send
// ---------------------------------------------------------------------------

describe('delegate and send', () => {
  test('delegate launches, registers a task and dispatches', async () => {
    registerAdapter(createStubAdapter({ provider: STUB }))
    const app = appState()
    const output = await call(
      { action: 'delegate', provider: 'stub', prompt: 'fix the tests', cwd: dir } as Input,
      app.context,
    )
    expect(output.agent_id).toBe('stub:agent_01')
    expect(output.outcome).toBe('dispatch')
    expect(output.task_id).toBeDefined()

    const task = app.task(output.task_id!)
    expect(isExternalAgentTask(task)).toBe(true)
    expect(task.prompt).toBe('fix the tests')
    expect(String(task.agentInstanceId)).toBe('stub:agent_01')
    expect(task.toolUseId).toBe('tool_use_1')
    // The summary points the model at the existing TaskOutput surface rather
    // than inventing a new one.
    expect(output.summary).toContain('TaskOutput')
  })

  test('delegate reuses a connected agent when given an agent_id', async () => {
    const handle = await launch()
    const app = appState()
    const output = await call(
      { action: 'delegate', agent_id: handle.agentId, prompt: 'more work' } as Input,
      app.context,
    )
    expect(output.agent_id).toBe(handle.agentId)
    expect(listLiveAgents()).toHaveLength(1)
  })

  test('send targets an already-connected agent', async () => {
    const handle = await launch()
    const app = appState()
    await call(
      { action: 'send', agent_id: handle.agentId, prompt: 'continue' } as Input,
      app.context,
    )
    expect((handle as unknown as StubHandle).sent.map(s => s.input.text)).toEqual([
      'continue',
    ])
  })

  test('the task ref is the task id, so the event sinks route output to it', async () => {
    const handle = await launch()
    const app = appState()
    const output = await call(
      { action: 'send', agent_id: handle.agentId, prompt: 'work' } as Input,
      app.context,
    )
    expect(output.task_id).toBeDefined()
    expect(String((handle as unknown as StubHandle).sent[0]!.taskRef)).toBe(
      output.task_id!,
    )
  })

  test('send to an unknown agent reports what IS connected', async () => {
    const handle = await launch()
    const app = appState()
    const output = await call(
      { action: 'send', agent_id: 'codex:ghost', prompt: 'x' } as Input,
      app.context,
    )
    expect(output.summary).toContain(handle.agentId)
    expect(output.task_id).toBeUndefined()
  })

  test('send with nothing connected suggests delegate instead', async () => {
    const app = appState()
    const output = await call(
      { action: 'send', agent_id: 'codex:agent_01', prompt: 'x' } as Input,
      app.context,
    )
    expect(output.summary).toContain('action="delegate"')
  })

  test('a queued dispatch tells the model NOT to resend', async () => {
    // A model that resent would double the work.
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    const app = appState()
    const output = await call(
      { action: 'send', agent_id: handle.agentId, prompt: 'second' } as Input,
      app.context,
    )
    expect(output.outcome).toBe('queue')
    expect(output.summary).toContain('do not resend')
    expect(output.summary).toContain('position 1')
  })

  test('a task starts as queued, never claiming to run before it does', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    const app = appState()
    const output = await call(
      { action: 'send', agent_id: handle.agentId, prompt: 'second' } as Input,
      app.context,
    )
    expect(app.task(output.task_id!).externalState).toBe('queued')
    expect(app.task(output.task_id!).status).toBe('pending')
  })

  test('a failed launch reports the reason and reserves nothing', async () => {
    registerAdapter(createStubAdapter({ provider: STUB, failLaunch: true }))
    const app = appState()
    const output = await call(
      { action: 'delegate', provider: 'stub', prompt: 'x', cwd: dir } as Input,
      app.context,
    )
    expect(output.summary).toContain('Could not start stub')
    expect(app.tasks()).toEqual({})
    const { listWriteLeases } = await import(
      '../src/externalAgents/persistence/workspaceLease.ts'
    )
    expect(await listWriteLeases()).toEqual([])
  })

  test('a missing cwd is reported rather than surfacing as a spawn failure', async () => {
    registerAdapter(createStubAdapter({ provider: STUB }))
    const app = appState()
    const output = await call(
      {
        action: 'delegate',
        provider: 'stub',
        prompt: 'x',
        cwd: join(dir, 'nope'),
      } as Input,
      app.context,
    )
    expect(output.summary).toContain('does not exist')
  })
})

// ---------------------------------------------------------------------------
// orchestrate
// ---------------------------------------------------------------------------

describe('orchestrate action', () => {
  test('a refused plan launches nothing and says so', async () => {
    // The escape hatch is not set, so a shared-tree race is refused.
    const handleA = await launch()
    const app = appState()
    const output = await call(
      {
        action: 'orchestrate',
        mode: 'race',
        steps: [
          { id: 'a', prompt: 'same', agent_id: handleA.agentId },
          { id: 'b', prompt: 'same', agent_id: handleA.agentId },
        ],
      } as Input,
      app.context,
    )
    expect(output.plan_status).toBe('invalid')
    expect(output.summary).toContain('nothing was launched')
  })

  test('a sequential plan runs its steps and reports the tally', async () => {
    const handle = await launch()
    const app = appState()
    const output = await call(
      {
        action: 'orchestrate',
        mode: 'sequential',
        steps: [
          { id: 'first', prompt: 'step one', agent_id: handle.agentId },
          { id: 'second', prompt: 'step two', agent_id: handle.agentId },
        ],
      } as Input,
      app.context,
    )
    expect(output.plan_status).toBe('completed')
    expect(output.summary).toContain('2/2 steps completed')
    expect(output.plan_report).toContain('[completed] first')
    // Every step is a real task, so its output stays readable while the plan runs.
    expect(Object.keys(app.tasks())).toHaveLength(2)
  })

  test('orchestrate WAITS for the outcome, unlike delegate', async () => {
    // sequential, race, retry and fallback are all meaningless if the tool
    // returns before the steps resolve. `delegate` on the same agent returns
    // while the turn is still in flight; `orchestrate` does not come back until
    // the step has settled.
    const handle = await launch()
    const app = appState()

    const delegated = await call(
      { action: 'send', agent_id: handle.agentId, prompt: 'x' } as Input,
      app.context,
    )
    expect(delegated.outcome).toBe('dispatch')
    expect(delegated.plan_status).toBeUndefined()

    const orchestrated = await call(
      {
        action: 'orchestrate',
        steps: [{ id: 'a', prompt: 'x', agent_id: handle.agentId }],
      } as Input,
      app.context,
    )
    expect(orchestrated.plan_status).toBe('completed')
    // The report records a settled step, which can only exist after the wait.
    expect(orchestrated.plan_report).toContain('[completed] a')
  })
})

// ---------------------------------------------------------------------------
// The external_agent task type
// ---------------------------------------------------------------------------

describe('external agent task', () => {
  function register(app: ReturnType<typeof appState>, overrides = {}) {
    return registerExternalAgentTask(app.setAppState, {
      agentInstanceId: 'codex:agent_01' as AgentInstanceId,
      provider: asProviderId('codex'),
      prompt: 'refactor auth\nand tidy up',
      externalState: 'queued',
      ...overrides,
    })
  }

  test('the description names the AGENT, not just the provider', () => {
    // With two codex instances running, "codex" alone would be ambiguous in the
    // footer.
    const app = appState()
    const id = register(app)
    expect(app.task(id).description).toContain('codex:agent_01')
    // Only the first line of the prompt.
    expect(app.task(id).description).toContain('refactor auth')
    expect(app.task(id).description).not.toContain('tidy up')
  })

  test('a long first line is truncated', () => {
    const app = appState()
    const id = register(app, { prompt: 'x'.repeat(200) })
    expect(app.task(id).description.length).toBeLessThan(120)
    expect(app.task(id).description).toContain('...')
  })

  test('an orchestration label is prefixed so concurrent steps are distinguishable', () => {
    const app = appState()
    const id = register(app, { label: 'step-two' })
    expect(app.task(id).description).toStartWith('[step-two] ')
  })

  test('the external state is projected onto the generic TaskStatus', () => {
    const app = appState()
    const id = register(app, { externalState: 'running' })
    expect(app.task(id).status).toBe('running')
    expect(app.task(id).externalState).toBe('running')
  })

  test('state transitions carry the summary and clear the turn', () => {
    const app = appState()
    const id = register(app, { externalState: 'running', activeTurnId: 'turn_1' })
    setExternalTaskState(id, app.setAppState, 'completed', {
      resultSummary: 'done',
    })
    const task = app.task(id)
    expect(task.externalState).toBe('completed')
    expect(task.status).toBe('completed')
    expect(task.resultSummary).toBe('done')
    expect(task.activeTurnId).toBeUndefined()
    expect(task.endTime).toBeGreaterThan(0)
  })

  test('a terminal task does NOT reopen on a late event', () => {
    // The model has already been told it finished, and the task may already have
    // been evicted.
    const app = appState()
    const id = register(app, { externalState: 'completed' })
    setExternalTaskState(id, app.setAppState, 'running')
    expect(app.task(id).externalState).toBe('completed')
  })

  test.each(['completed', 'failed', 'cancelled'] as const)(
    '%s is terminal',
    state => {
      expect(isTerminalExternalState(state)).toBe(true)
    },
  )

  test.each(['queued', 'dispatched', 'running', 'waiting-provider'] as const)(
    '%s is not terminal',
    state => {
      expect(isTerminalExternalState(state)).toBe(false)
    },
  )

  test('changed files are deduplicated', () => {
    const app = appState()
    const id = register(app)
    noteExternalTaskFile(id, app.setAppState, '/a.ts')
    noteExternalTaskFile(id, app.setAppState, '/b.ts')
    noteExternalTaskFile(id, app.setAppState, '/a.ts')
    expect(app.task(id).changedFiles).toEqual(['/a.ts', '/b.ts'])
  })

  test('the guard distinguishes an external agent task from other types', () => {
    expect(isExternalAgentTask({ type: 'external_agent' })).toBe(true)
    expect(isExternalAgentTask({ type: 'local_shell' })).toBe(false)
    expect(isExternalAgentTask(null)).toBe(false)
    expect(isExternalAgentTask('external_agent')).toBe(false)
  })

  test('kill interrupts the TURN and leaves the agent running', async () => {
    // The agent may be process-durable, serving other tasks, or hosting a TUI
    // the user is looking at.
    const handle = await launch({ holdTurns: true })
    const app = appState()
    const output = await call(
      { action: 'send', agent_id: handle.agentId, prompt: 'long work' } as Input,
      app.context,
    )
    const taskId = output.task_id!
    // The dispatch left a turn in flight, which the sinks record on the task.
    setExternalTaskState(taskId, app.setAppState, 'running', {
      activeTurnId: 'turn_1',
    })

    await ExternalAgentTask.kill!(taskId, app.setAppState)

    expect(app.task(taskId).externalState).toBe('cancelled')
    expect(app.task(taskId).status).toBe('killed')
    expect((handle as unknown as StubHandle).interrupted).toEqual(['turn_1'])
    // Still connected.
    expect(listLiveAgents()).toHaveLength(1)
    expect((handle as unknown as StubHandle).stopped).toBe(false)
  })

  test('kill with no active turn does not try to interrupt', async () => {
    const handle = await launch()
    const app = appState()
    const id = register(app, {
      agentInstanceId: handle.agentId,
      externalState: 'running',
    })
    await ExternalAgentTask.kill!(id, app.setAppState)
    expect(app.task(id).externalState).toBe('cancelled')
    expect((handle as unknown as StubHandle).interrupted).toEqual([])
  })

  test('killing an already-terminal task is a no-op', async () => {
    const app = appState()
    const id = register(app, { externalState: 'completed' })
    await ExternalAgentTask.kill!(id, app.setAppState)
    expect(app.task(id).externalState).toBe('completed')
  })

  test('kill survives the agent already being gone', async () => {
    // A failed interrupt is not worth failing the kill over: the task is already
    // marked cancelled, which is what the user asked for.
    const app = appState()
    const id = register(app, {
      agentInstanceId: 'codex:vanished' as AgentInstanceId,
      externalState: 'running',
      activeTurnId: 'turn_1',
    })
    await expect(
      ExternalAgentTask.kill!(id, app.setAppState),
    ).resolves.toBeUndefined()
    expect(app.task(id).externalState).toBe('cancelled')
  })

  test('the task type matches what the registry dispatches on', () => {
    expect(ExternalAgentTask.type).toBe('external_agent')
    expect(ExternalAgentTask.name).toBe('ExternalAgentTask')
  })
})
