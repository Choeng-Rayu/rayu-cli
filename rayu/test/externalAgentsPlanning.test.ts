/**
 * Plan validation, task-outcome waiting, and the file-change tracker.
 *
 * Plan validation is where the dangerous combinations get caught while refusing
 * is still free — before any third-party process is launched. The most important
 * rule enforced here is that a race in a shared working tree is REFUSED, because
 * losing a race stops future work but does not revert edits already written.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  attemptsFor,
  describeTarget,
  targetsFor,
  validatePlan,
  type Plan,
  type StepPlan,
  type StepTarget,
} from '../src/externalAgents/orchestration/plan.ts'
import {
  awaitTaskOutcome,
  isSuccessfulOutcome,
  looksRetryable,
  type TaskOutcome,
} from '../src/externalAgents/orchestration/taskOutcome.ts'
import {
  clearAgentChanges,
  findConflicts,
  findConflictsForAgent,
  formatConflictReport,
  getChangeSummary,
  hasPartialCoverage,
  listChangedFiles,
  listChangeSummaries,
  MAX_TRACKED_PATHS_PER_AGENT,
  recordFileChange,
  resetChangeTracker,
  resolveChangePath,
} from '../src/externalAgents/workspace/changeTracker.ts'
import { emitEvent } from '../src/externalAgents/core/normalizer.ts'
import { resetEventBus } from '../src/externalAgents/core/eventBus.ts'
import {
  asProviderId,
  asTaskRef,
  type AgentInstanceId,
  type FileChangedEvent,
} from '../src/externalAgents/core/types.ts'

const CODEX = 'codex:agent_01' as AgentInstanceId
const CLAUDE = 'claude-code:agent_01' as AgentInstanceId
const TASK = asTaskRef('task_1')
const ROOT = '/home/u/project'

function step(overrides: Partial<StepPlan> = {}): StepPlan {
  return {
    id: 's1',
    prompt: 'do the work',
    target: { kind: 'agent', agentId: CODEX },
    ...overrides,
  }
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return { mode: 'parallel', steps: [step()], ...overrides }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

describe('step targets', () => {
  test('an agent target is described by its id', () => {
    expect(describeTarget({ kind: 'agent', agentId: CODEX })).toBe(CODEX)
  })

  test('a provider target names isolation explicitly', () => {
    expect(
      describeTarget({ kind: 'provider', provider: asProviderId('codex') }),
    ).toBe('codex')
    expect(
      describeTarget({
        kind: 'provider',
        provider: asProviderId('codex'),
        isolate: true,
      }),
    ).toBe('codex (isolated)')
  })

  test('attempts default to a single try and never go below one', () => {
    expect(attemptsFor(step())).toBe(1)
    expect(attemptsFor(step({ retry: { attempts: 3 } }))).toBe(3)
    expect(attemptsFor(step({ retry: { attempts: 0 } }))).toBe(1)
    expect(attemptsFor(step({ retry: { attempts: -5 } }))).toBe(1)
  })

  test('targets are ordered primary first, then each fallback', () => {
    const fallback: StepTarget[] = [
      { kind: 'provider', provider: asProviderId('claude-code') },
      { kind: 'provider', provider: asProviderId('opencode') },
    ]
    const targets = targetsFor(step({ fallback }))
    expect(targets).toHaveLength(3)
    expect(describeTarget(targets[0]!)).toBe(CODEX)
    expect(describeTarget(targets[2]!)).toBe('opencode')
  })
})

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

describe('plan validation', () => {
  test('a minimal plan is valid', () => {
    expect(validatePlan(plan())).toEqual({ errors: [], warnings: [] })
  })

  test('an empty plan is refused', () => {
    expect(validatePlan(plan({ steps: [] })).errors).toContain(
      'The plan has no steps.',
    )
  })

  test('duplicate step ids are refused because ids identify results', () => {
    const errors = validatePlan(
      plan({ steps: [step({ id: 'a' }), step({ id: 'a' })] }),
    ).errors
    expect(errors.some(e => e.includes('Duplicate step id "a"'))).toBe(true)
  })

  test('an empty step id is refused', () => {
    expect(
      validatePlan(plan({ steps: [step({ id: '  ' })] })).errors.some(e =>
        e.includes('non-empty id'),
      ),
    ).toBe(true)
  })

  test('an empty prompt is refused', () => {
    expect(
      validatePlan(plan({ steps: [step({ prompt: '   ' })] })).errors.some(e =>
        e.includes('empty prompt'),
      ),
    ).toBe(true)
  })

  test('retry attempts below one is refused', () => {
    expect(
      validatePlan(
        plan({ steps: [step({ retry: { attempts: 0 } })] }),
      ).errors.some(e => e.includes('at least 1')),
    ).toBe(true)
  })

  test('a non-positive timeout is refused', () => {
    for (const timeoutMs of [0, -1]) {
      expect(
        validatePlan(plan({ steps: [step({ timeoutMs })] })).errors.some(e =>
          e.includes('non-positive timeoutMs'),
        ),
      ).toBe(true)
    }
  })

  test('stopOnFailure outside sequential mode is a warning, not an error', () => {
    for (const mode of ['parallel', 'race'] as const) {
      const result = validatePlan(
        plan({
          mode,
          stopOnFailure: true,
          steps: [step({ id: 'a' }), step({ id: 'b' })],
          allowSharedWorkspaceRace: true,
        }),
      )
      expect(result.warnings.some(w => w.includes('only applies to sequential'))).toBe(
        true,
      )
    }
  })

  test('sequential mode accepts stopOnFailure silently', () => {
    expect(
      validatePlan(plan({ mode: 'sequential', stopOnFailure: false })).warnings,
    ).toEqual([])
  })

  test('several parallel steps on one agent warns that they will be serialized', () => {
    // One agent runs one turn at a time; admission control queues the rest. Say
    // so rather than letting the caller believe the steps ran concurrently.
    const result = validatePlan(
      plan({
        mode: 'parallel',
        steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })],
      }),
    )
    expect(result.errors).toEqual([])
    expect(
      result.warnings.some(
        w => w.includes('3 parallel steps') && w.includes('run in sequence'),
      ),
    ).toBe(true)
  })

  test('parallel steps on DIFFERENT agents warn about nothing', () => {
    expect(
      validatePlan(
        plan({
          steps: [
            step({ id: 'a', target: { kind: 'agent', agentId: CODEX } }),
            step({ id: 'b', target: { kind: 'agent', agentId: CLAUDE } }),
          ],
        }),
      ).warnings,
    ).toEqual([])
  })
})

describe('race validation', () => {
  const isolated = (id: string): StepPlan =>
    step({
      id,
      target: { kind: 'provider', provider: asProviderId('codex'), isolate: true },
    })

  test('a race needs at least two participants', () => {
    expect(
      validatePlan(plan({ mode: 'race', steps: [isolated('a')] })).errors,
    ).toContain('A race needs at least two steps to race.')
  })

  test('fully isolated participants are allowed', () => {
    expect(
      validatePlan(
        plan({ mode: 'race', steps: [isolated('a'), isolated('b')] }),
      ).errors,
    ).toEqual([])
  })

  test('a shared working tree is REFUSED with an actionable message', () => {
    // Losing a race stops FUTURE work; it does not revert edits already written,
    // so the loser can leave half-applied changes behind.
    const result = validatePlan(
      plan({
        mode: 'race',
        steps: [
          step({ id: 'a', target: { kind: 'agent', agentId: CODEX } }),
          step({ id: 'b', target: { kind: 'agent', agentId: CLAUDE } }),
        ],
      }),
      () => ROOT,
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('same working tree')
    expect(result.errors[0]).toContain('does not revert edits already written')
    // Both escape hatches are named.
    expect(result.errors[0]).toContain('isolate: true')
    expect(result.errors[0]).toContain('allowSharedWorkspaceRace: true')
  })

  test('two connected agents in DIFFERENT roots may race', () => {
    const roots: Record<string, string> = {
      [CODEX]: '/wt/a',
      [CLAUDE]: '/wt/b',
    }
    expect(
      validatePlan(
        plan({
          mode: 'race',
          steps: [
            step({ id: 'a', target: { kind: 'agent', agentId: CODEX } }),
            step({ id: 'b', target: { kind: 'agent', agentId: CLAUDE } }),
          ],
        }),
        id => roots[id],
      ).errors,
    ).toEqual([])
  })

  test('an UNDETERMINABLE root counts against the plan', () => {
    // When a shared root cannot be ruled out, for a race that counts against the
    // plan rather than for it.
    const result = validatePlan(
      plan({
        mode: 'race',
        steps: [
          step({ id: 'a', target: { kind: 'agent', agentId: CODEX } }),
          isolated('b'),
        ],
      }),
      // No resolver supplied → root unknown.
    )
    expect(result.errors.some(e => e.includes('same working tree'))).toBe(true)
  })

  test('a non-isolated provider target is treated as sharing the session cwd', () => {
    const result = validatePlan(
      plan({
        mode: 'race',
        steps: [
          step({
            id: 'a',
            target: { kind: 'provider', provider: asProviderId('codex') },
          }),
          isolated('b'),
        ],
      }),
      () => ROOT,
    )
    expect(result.errors.some(e => e.includes('same working tree'))).toBe(true)
  })

  test('the explicit escape hatch permits a shared-tree race', () => {
    expect(
      validatePlan(
        plan({
          mode: 'race',
          allowSharedWorkspaceRace: true,
          steps: [
            step({ id: 'a', target: { kind: 'agent', agentId: CODEX } }),
            step({ id: 'b', target: { kind: 'agent', agentId: CLAUDE } }),
          ],
        }),
        () => ROOT,
      ).errors,
    ).toEqual([])
  })

  test('differing race prompts warn that it is not the same work twice', () => {
    const result = validatePlan(
      plan({
        mode: 'race',
        steps: [
          isolated('a'),
          { ...isolated('b'), prompt: 'do something else entirely' },
        ],
      }),
    )
    expect(result.errors).toEqual([])
    expect(
      result.warnings.some(w => w.includes('not the same work done twice')),
    ).toBe(true)
  })

  test('identical race prompts warn about nothing', () => {
    expect(
      validatePlan(
        plan({ mode: 'race', steps: [isolated('a'), isolated('b')] }),
      ).warnings,
    ).toEqual([])
  })

  test('errors accumulate rather than short-circuiting on the first', () => {
    // A caller should be able to fix every problem in one pass.
    const result = validatePlan(
      plan({
        mode: 'race',
        steps: [step({ id: '', prompt: '', timeoutMs: -1 })],
      }),
    )
    expect(result.errors.length).toBeGreaterThan(2)
  })
})

// ---------------------------------------------------------------------------
// Task outcome
// ---------------------------------------------------------------------------

describe('awaiting a task outcome', () => {
  beforeEach(() => {
    resetEventBus()
  })
  afterEach(() => {
    resetEventBus()
  })

  test('resolves on task_completed with its summary', async () => {
    const promise = awaitTaskOutcome(TASK, CODEX)
    emitEvent(
      { agentId: CODEX, taskRef: TASK },
      { type: 'task_completed', summary: 'shipped it' },
    )
    const outcome = await promise
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toBe('shipped it')
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
    expect(isSuccessfulOutcome(outcome)).toBe(true)
  })

  test('resolves on task_failed with the message and code', async () => {
    const promise = awaitTaskOutcome(TASK, CODEX)
    emitEvent(
      { agentId: CODEX, taskRef: TASK },
      { type: 'task_failed', message: 'patch conflict', code: 'InvalidRequest' },
    )
    const outcome = await promise
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toBe('patch conflict')
    expect(outcome.code).toBe('InvalidRequest')
  })

  test('ignores results belonging to another task', async () => {
    const promise = awaitTaskOutcome(TASK, CODEX, { timeoutMs: 60 })
    emitEvent(
      { agentId: CODEX, taskRef: asTaskRef('other_task') },
      { type: 'task_completed' },
    )
    expect((await promise).status).toBe('timeout')
  })

  test('a disconnect of the OWNING agent settles the wait', async () => {
    // Disconnect events are agent-level and carry no taskRef, so without this a
    // crashed agent would leave the step waiting forever.
    const promise = awaitTaskOutcome(TASK, CODEX)
    emitEvent({ agentId: CODEX }, { type: 'agent_disconnected', reason: 'process_exit' })
    const outcome = await promise
    expect(outcome.status).toBe('disconnected')
    expect(outcome.detail).toContain('process_exit')
  })

  test('a disconnect of a DIFFERENT agent does not settle the wait', async () => {
    const promise = awaitTaskOutcome(TASK, CODEX, { timeoutMs: 60 })
    emitEvent({ agentId: CLAUDE }, { type: 'agent_disconnected', reason: 'shutdown' })
    expect((await promise).status).toBe('timeout')
  })

  test('agent_error does NOT settle but is remembered for the retry decision', async () => {
    // Documented as non-fatal: the agent may still finish the turn.
    const promise = awaitTaskOutcome(TASK, CODEX)
    emitEvent(
      { agentId: CODEX, taskRef: TASK },
      { type: 'agent_error', message: 'rate limited', providerFault: true },
    )
    emitEvent(
      { agentId: CODEX, taskRef: TASK },
      { type: 'task_failed', message: 'gave up' },
    )
    const outcome = await promise
    expect(outcome.status).toBe('failed')
    expect(outcome.sawProviderFault).toBe(true)
    expect(looksRetryable(outcome)).toBe(true)
  })

  test('a non-provider error does not set the provider-fault flag', async () => {
    const promise = awaitTaskOutcome(TASK, CODEX)
    emitEvent(
      { agentId: CODEX, taskRef: TASK },
      { type: 'agent_error', message: 'bad tool input', providerFault: false },
    )
    emitEvent({ agentId: CODEX, taskRef: TASK }, { type: 'task_failed', message: 'x' })
    expect((await promise).sawProviderFault).toBe(false)
  })

  test("another task's provider fault is not attributed to this one", async () => {
    const promise = awaitTaskOutcome(TASK, CODEX)
    emitEvent(
      { agentId: CODEX, taskRef: asTaskRef('other') },
      { type: 'agent_error', message: 'rate limited', providerFault: true },
    )
    emitEvent({ agentId: CODEX, taskRef: TASK }, { type: 'task_failed', message: 'x' })
    expect((await promise).sawProviderFault).toBe(false)
  })

  test('times out when asked to, and says the agent may still be working', async () => {
    const outcome = await awaitTaskOutcome(TASK, CODEX, { timeoutMs: 25 })
    expect(outcome.status).toBe('timeout')
    expect(outcome.detail).toContain('may still be working')
  })

  test('with no timeout it simply waits', async () => {
    let settled = false
    void awaitTaskOutcome(TASK, CODEX).then(() => {
      settled = true
    })
    await new Promise(r => setTimeout(r, 40))
    // A legitimate foreign turn can run for many minutes; a default deadline
    // would abandon real work.
    expect(settled).toBe(false)
    emitEvent({ agentId: CODEX, taskRef: TASK }, { type: 'task_completed' })
    await new Promise(r => setTimeout(r, 10))
    expect(settled).toBe(true)
  })

  test('an abort signal settles the wait', async () => {
    const controller = new AbortController()
    const promise = awaitTaskOutcome(TASK, CODEX, { signal: controller.signal })
    controller.abort()
    const outcome = await promise
    expect(outcome.status).toBe('aborted')
    expect(outcome.detail).toContain('cancelled')
  })

  test('an ALREADY-aborted signal settles without leaving a subscription', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await awaitTaskOutcome(TASK, CODEX, {
      signal: controller.signal,
    })
    expect(outcome.status).toBe('aborted')
    // Nothing is listening, so a later event changes nothing and does not throw.
    emitEvent({ agentId: CODEX, taskRef: TASK }, { type: 'task_completed' })
  })

  test('only the first ending wins', async () => {
    const promise = awaitTaskOutcome(TASK, CODEX)
    emitEvent({ agentId: CODEX, taskRef: TASK }, { type: 'task_completed' })
    emitEvent({ agentId: CODEX, taskRef: TASK }, { type: 'task_failed', message: 'late' })
    expect((await promise).status).toBe('completed')
  })

  test('the watcher unsubscribes once settled', async () => {
    const promise = awaitTaskOutcome(TASK, CODEX)
    emitEvent({ agentId: CODEX, taskRef: TASK }, { type: 'task_completed' })
    await promise
    // A second wait on the same ref must be able to settle independently.
    const second = awaitTaskOutcome(TASK, CODEX, { timeoutMs: 25 })
    expect((await second).status).toBe('timeout')
  })
})

describe('retry classification', () => {
  function outcome(overrides: Partial<TaskOutcome>): TaskOutcome {
    return {
      taskRef: TASK,
      agentId: CODEX,
      status: 'failed',
      sawProviderFault: false,
      durationMs: 1,
      ...overrides,
    }
  }

  test('a plain failure is NOT retried by default', () => {
    // The agent tried and could not do the work; repeating the identical prompt
    // would most likely fail identically. Fallback to a different agent is the
    // better answer.
    expect(looksRetryable(outcome({ status: 'failed' }))).toBe(false)
  })

  test('a provider fault is retryable', () => {
    expect(
      looksRetryable(outcome({ status: 'failed', sawProviderFault: true })),
    ).toBe(true)
  })

  test('a disconnect is retryable because a relaunch may fix it', () => {
    expect(looksRetryable(outcome({ status: 'disconnected' }))).toBe(true)
  })

  test('a timeout is retryable', () => {
    expect(looksRetryable(outcome({ status: 'timeout' }))).toBe(true)
  })

  test('completed and aborted are never retryable', () => {
    expect(looksRetryable(outcome({ status: 'completed' }))).toBe(false)
    // An aborted plan was cancelled on purpose.
    expect(
      looksRetryable(outcome({ status: 'aborted', sawProviderFault: true })),
    ).toBe(false)
  })

  test('only completed counts as success', () => {
    for (const status of ['failed', 'disconnected', 'timeout', 'aborted'] as const) {
      expect(isSuccessfulOutcome(outcome({ status }))).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Change tracker
// ---------------------------------------------------------------------------

describe('file change tracker', () => {
  beforeEach(resetChangeTracker)
  afterEach(resetChangeTracker)

  let seq = 0
  function change(
    agentId: AgentInstanceId,
    path: string,
    overrides: Partial<FileChangedEvent> = {},
  ): FileChangedEvent {
    seq++
    return {
      type: 'file_changed',
      agentId,
      path,
      change: 'modified',
      at: 1_000 + seq,
      seq,
      ...overrides,
    }
  }

  test('resolves a relative path against the workspace root', () => {
    // Providers are inconsistent: Codex reports absolute paths, OpenCode's
    // file.edited may report repo-relative ones.
    expect(resolveChangePath('src/a.ts', ROOT)).toBe(`${ROOT}/src/a.ts`)
    expect(resolveChangePath('/abs/b.ts', ROOT)).toBe('/abs/b.ts')
    expect(resolveChangePath('./src/../src/c.ts', ROOT)).toBe(`${ROOT}/src/c.ts`)
  })

  test('records a change with a display path relative to the root', () => {
    recordFileChange(change(CODEX, `${ROOT}/src/auth.ts`), ROOT)
    const files = listChangedFiles(CODEX)
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe(`${ROOT}/src/auth.ts`)
    expect(files[0]!.displayPath).toBe('src/auth.ts')
    expect(files[0]!.count).toBe(1)
  })

  test('a path outside the workspace keeps its absolute form', () => {
    // Better than a confusing pile of `../` segments.
    recordFileChange(change(CODEX, '/etc/hosts'), ROOT)
    expect(listChangedFiles(CODEX)[0]!.displayPath).toBe('/etc/hosts')
  })

  test('repeated writes collapse to a count, keeping first and last kind', () => {
    // A long-running agent may rewrite one file hundreds of times.
    recordFileChange(change(CODEX, 'a.ts', { change: 'created' }), ROOT)
    recordFileChange(change(CODEX, 'a.ts', { change: 'modified' }), ROOT)
    recordFileChange(change(CODEX, 'a.ts', { change: 'modified' }), ROOT)
    const file = listChangedFiles(CODEX)[0]!
    expect(file.count).toBe(3)
    // create-then-modify stays legible.
    expect(file.firstChange).toBe('created')
    expect(file.change).toBe('modified')
    expect(file.lastSeenMs).toBeGreaterThan(file.firstSeenMs)
  })

  test('a diff on any event marks the file as having one', () => {
    recordFileChange(change(CODEX, 'a.ts'), ROOT)
    expect(listChangedFiles(CODEX)[0]!.hasDiff).toBe(false)
    recordFileChange(change(CODEX, 'a.ts', { diff: '@@ -1 +1 @@' }), ROOT)
    expect(listChangedFiles(CODEX)[0]!.hasDiff).toBe(true)
  })

  test('files are listed most recently changed first', () => {
    recordFileChange(change(CODEX, 'old.ts'), ROOT)
    recordFileChange(change(CODEX, 'new.ts'), ROOT)
    expect(listChangedFiles(CODEX).map(f => f.displayPath)).toEqual([
      'new.ts',
      'old.ts',
    ])
  })

  test('an unknown agent has no changes', () => {
    expect(listChangedFiles(CODEX)).toEqual([])
    expect(getChangeSummary(CODEX)).toBeUndefined()
    expect(listChangeSummaries()).toEqual([])
  })

  test('a relaunch into a new worktree adopts the newest root', () => {
    recordFileChange(change(CODEX, 'a.ts'), ROOT)
    recordFileChange(change(CODEX, 'b.ts'), '/wt/new')
    expect(getChangeSummary(CODEX)!.workspaceRoot).toBe('/wt/new')
  })

  test('two agents on one file is a conflict, newest writer first', () => {
    recordFileChange(change(CODEX, 'shared.ts'), ROOT)
    recordFileChange(change(CLAUDE, 'shared.ts', { change: 'deleted' }), ROOT)
    const conflicts = findConflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.path).toBe(`${ROOT}/shared.ts`)
    // The likely clobberer is listed first.
    expect(conflicts[0]!.agents[0]!.agentId).toBe(CLAUDE)
    expect(conflicts[0]!.agents[0]!.change).toBe('deleted')
  })

  test('one agent writing one file many times is not a conflict', () => {
    recordFileChange(change(CODEX, 'a.ts'), ROOT)
    recordFileChange(change(CODEX, 'a.ts'), ROOT)
    expect(findConflicts()).toEqual([])
  })

  test('agents in SEPARATE worktrees never conflict', () => {
    // Normalizing to absolute is what makes this true: their roots differ, so
    // the same relative path resolves to two different files.
    recordFileChange(change(CODEX, 'src/a.ts'), '/wt/a')
    recordFileChange(change(CLAUDE, 'src/a.ts'), '/wt/b')
    expect(findConflicts()).toEqual([])
  })

  test('a mix of absolute and relative reports still detects the overlap', () => {
    recordFileChange(change(CODEX, 'src/a.ts'), ROOT)
    recordFileChange(change(CLAUDE, `${ROOT}/src/a.ts`), ROOT)
    expect(findConflicts()).toHaveLength(1)
  })

  test('conflicts are ordered by most recent activity', () => {
    recordFileChange(change(CODEX, 'first.ts'), ROOT)
    recordFileChange(change(CLAUDE, 'first.ts'), ROOT)
    recordFileChange(change(CODEX, 'second.ts'), ROOT)
    recordFileChange(change(CLAUDE, 'second.ts'), ROOT)
    expect(findConflicts().map(c => c.path)).toEqual([
      `${ROOT}/second.ts`,
      `${ROOT}/first.ts`,
    ])
  })

  test('findConflictsForAgent filters to one agent', () => {
    recordFileChange(change(CODEX, 'shared.ts'), ROOT)
    recordFileChange(change(CLAUDE, 'shared.ts'), ROOT)
    recordFileChange(change(CODEX, 'solo.ts'), ROOT)
    expect(findConflictsForAgent(CODEX)).toHaveLength(1)
    expect(
      findConflictsForAgent('opencode:agent_01' as AgentInstanceId),
    ).toHaveLength(0)
  })

  test('overflow is counted rather than silently dropped', () => {
    // An agent that blew the cap is exactly the one you want to know about.
    for (let i = 0; i < MAX_TRACKED_PATHS_PER_AGENT + 25; i++) {
      recordFileChange(change(CODEX, `f${i}.ts`), ROOT)
    }
    const summary = getChangeSummary(CODEX)!
    expect(summary.files).toHaveLength(MAX_TRACKED_PATHS_PER_AGENT)
    expect(summary.overflowCount).toBe(25)
    expect(hasPartialCoverage()).toBe(true)
  })

  test('a path already tracked still updates after the cap is hit', () => {
    for (let i = 0; i < MAX_TRACKED_PATHS_PER_AGENT; i++) {
      recordFileChange(change(CODEX, `f${i}.ts`), ROOT)
    }
    recordFileChange(change(CODEX, 'f0.ts'), ROOT)
    const file = listChangedFiles(CODEX).find(f => f.displayPath === 'f0.ts')!
    expect(file.count).toBe(2)
  })

  test('coverage is complete until the cap is reached', () => {
    recordFileChange(change(CODEX, 'a.ts'), ROOT)
    expect(hasPartialCoverage()).toBe(false)
  })

  test('clearing one agent leaves the others', () => {
    recordFileChange(change(CODEX, 'a.ts'), ROOT)
    recordFileChange(change(CLAUDE, 'b.ts'), ROOT)
    clearAgentChanges(CODEX)
    expect(listChangedFiles(CODEX)).toEqual([])
    expect(listChangedFiles(CLAUDE)).toHaveLength(1)
  })

  test('summaries cover every tracked agent', () => {
    recordFileChange(change(CODEX, 'a.ts'), ROOT)
    recordFileChange(change(CLAUDE, 'b.ts'), ROOT)
    expect(listChangeSummaries().map(s => s.agentId).sort()).toEqual(
      [CLAUDE, CODEX].sort(),
    )
  })

  test('the conflict report names both writers and the real remedy', () => {
    recordFileChange(change(CODEX, 'shared.ts'), ROOT)
    recordFileChange(change(CLAUDE, 'shared.ts'), ROOT)
    const report = formatConflictReport(findConflicts())
    expect(report).toContain('1 file changed by more than one agent')
    expect(report).toContain(CODEX)
    expect(report).toContain(CLAUDE)
    // Worktree isolation is the remedy; leases are only the detector.
    expect(report).toContain('own worktree')
    expect(report).toContain('cannot serialise')
  })

  test('the report pluralizes and handles the empty case', () => {
    expect(formatConflictReport([])).toBe('No overlapping file changes detected.')
    recordFileChange(change(CODEX, 'a.ts'), ROOT)
    recordFileChange(change(CLAUDE, 'a.ts'), ROOT)
    recordFileChange(change(CODEX, 'b.ts'), ROOT)
    recordFileChange(change(CLAUDE, 'b.ts'), ROOT)
    expect(formatConflictReport(findConflicts())).toContain('2 files changed')
  })
})
