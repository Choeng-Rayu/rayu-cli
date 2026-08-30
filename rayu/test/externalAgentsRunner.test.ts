/**
 * Orchestration policies: parallel, sequential, race, retry, fallback, review.
 *
 * The runner takes its dependencies as an object, so these tests drive it with a
 * scripted fake instead of real agents — which is the only way to make a race
 * deterministic.
 *
 * Two design points get direct coverage:
 *
 *   - **Two-phase `prepare()` / `start()`.** The runner subscribes to the outcome
 *     BEFORE handing work over. Without the split, an adapter that answers
 *     instantly reports into a void and the step waits forever. The
 *     `instant` script below is exactly that adapter.
 *   - **A race with a winner reports `completed`, not `partial`.** A race asked
 *     for one answer; the cancelled losers are the mechanism, not a shortfall.
 */
import { describe, expect, test } from 'bun:test'
import {
  formatPlanResult,
  renderStepsForReview,
  runPlan,
  type OrchestrationDeps,
  type PreparedStep,
  type StepResult,
} from '../src/externalAgents/orchestration/runner.ts'
import type { Plan, StepPlan, StepTarget } from '../src/externalAgents/orchestration/plan.ts'
import type { TaskOutcome } from '../src/externalAgents/orchestration/taskOutcome.ts'
import {
  asProviderId,
  asTaskRef,
  type AgentInstanceId,
  type TaskRef,
} from '../src/externalAgents/core/types.ts'

/** How one step should behave, keyed by step label. */
type Script = {
  /** Resolve the outcome only after this many ms. */
  readonly delayMs?: number
  readonly status?: TaskOutcome['status']
  readonly detail?: string
  readonly sawProviderFault?: boolean
  /** Throw from `prepare`, so no task ever exists. */
  readonly failPrepare?: string
  /** Throw from `start`, after the task exists. */
  readonly failStart?: string
  /**
   * Report the outcome DURING `start()`, before the runner could subscribe if it
   * were single-phase. This is the fast-adapter hang the two-phase split fixes.
   */
  readonly instant?: boolean
  /** Succeed only from this attempt onwards. */
  readonly succeedFromAttempt?: number
}

type Recorder = {
  readonly prepared: { label: string; target: string; prompt: string }[]
  readonly started: string[]
  readonly cancelled: { taskRef: TaskRef; agentId: AgentInstanceId }[]
  readonly slept: number[]
}

function describeTargetForTest(target: StepTarget): string {
  return target.kind === 'agent' ? target.agentId : target.provider
}

/**
 * Build fake orchestration deps from a per-step script.
 *
 * Scripts are keyed by `<label>` and optionally `<label>@<target>` so a fallback
 * target can behave differently from the primary.
 */
function scriptedDeps(scripts: Record<string, Script>): {
  deps: OrchestrationDeps
  rec: Recorder
} {
  const rec: Recorder = { prepared: [], started: [], cancelled: [], slept: [] }
  const attemptsByKey = new Map<string, number>()
  let taskCounter = 0

  const deps: OrchestrationDeps = {
    async prepare(target, prompt, label): Promise<PreparedStep> {
      const targetName = describeTargetForTest(target)
      const key = `${label}@${targetName}`
      const script = scripts[key] ?? scripts[label] ?? {}
      const attempt = (attemptsByKey.get(key) ?? 0) + 1
      attemptsByKey.set(key, attempt)

      rec.prepared.push({ label, target: targetName, prompt })
      if (script.failPrepare) throw new Error(script.failPrepare)

      const taskRef = asTaskRef(`task_${++taskCounter}`)
      const agentId = `${targetName.includes(':') ? targetName : `${targetName}:agent_01`}` as AgentInstanceId

      const scripted: TaskOutcome['status'] = script.status ?? 'completed'
      // `succeedFromAttempt` overrides the scripted status once reached, so a
      // step can fail twice and then succeed.
      const status: TaskOutcome['status'] =
        script.succeedFromAttempt === undefined
          ? scripted
          : attempt >= script.succeedFromAttempt
            ? 'completed'
            : scripted

      const outcome: TaskOutcome = {
        taskRef,
        agentId,
        status,
        detail: script.detail,
        sawProviderFault: script.sawProviderFault ?? false,
        durationMs: 1,
      }
      settlers.set(taskRef, { outcome, script })

      return {
        agentId,
        taskRef,
        async start() {
          rec.started.push(label)
          if (script.failStart) throw new Error(script.failStart)
          if (script.instant) {
            // Report before start() even returns.
            settlers.get(taskRef)!.resolve?.(outcome)
          }
          return {}
        },
      }
    },

    async awaitOutcome(taskRef, agentId, options) {
      const entry = settlers.get(taskRef)!
      if (options?.signal?.aborted) {
        return abortedOutcome(taskRef, agentId)
      }
      return new Promise<TaskOutcome>(resolve => {
        entry.resolve = resolve
        const finish = () => resolve(entry.outcome)
        if (entry.script.instant) {
          // Already started: resolve on the next tick if start() beat us here.
          return
        }
        const timer = setTimeout(finish, entry.script.delayMs ?? 0)
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve(abortedOutcome(taskRef, agentId))
          },
          { once: true },
        )
      })
    },

    async cancel(taskRef, agentId) {
      rec.cancelled.push({ taskRef, agentId })
    },

    async sleep(ms) {
      rec.slept.push(ms)
    },
  }

  const settlers = new Map<
    TaskRef,
    { outcome: TaskOutcome; script: Script; resolve?: (o: TaskOutcome) => void }
  >()

  return { deps, rec }
}

function abortedOutcome(taskRef: TaskRef, agentId: AgentInstanceId): TaskOutcome {
  return {
    taskRef,
    agentId,
    status: 'aborted',
    detail: 'the plan was cancelled',
    sawProviderFault: false,
    durationMs: 1,
  }
}

function step(id: string, overrides: Partial<StepPlan> = {}): StepPlan {
  return {
    id,
    prompt: `do ${id}`,
    target: { kind: 'provider', provider: asProviderId('codex'), isolate: true },
    ...overrides,
  }
}

const byId = (steps: readonly StepResult[]) =>
  Object.fromEntries(steps.map(s => [s.id, s.status]))

// ---------------------------------------------------------------------------
// Validation gate
// ---------------------------------------------------------------------------

describe('validation gate', () => {
  test('an invalid plan launches NOTHING', async () => {
    // Refusing while it is still free is the whole point of validating separately
    // from running.
    const { deps, rec } = scriptedDeps({})
    const result = await runPlan({ mode: 'parallel', steps: [] }, deps)
    expect(result.status).toBe('invalid')
    expect(result.errors).toContain('The plan has no steps.')
    expect(rec.prepared).toEqual([])
  })

  test('a shared-tree race is refused before any agent starts', async () => {
    const { deps, rec } = scriptedDeps({})
    const result = await runPlan(
      {
        mode: 'race',
        steps: [
          step('a', { target: { kind: 'agent', agentId: 'codex:agent_01' as AgentInstanceId } }),
          step('b', { target: { kind: 'agent', agentId: 'claude-code:agent_01' as AgentInstanceId } }),
        ],
      },
      { ...deps, workspaceRootOf: () => '/repo' },
    )
    expect(result.status).toBe('invalid')
    expect(rec.prepared).toEqual([])
  })

  test('warnings are carried through a successful run', async () => {
    const { deps } = scriptedDeps({})
    const result = await runPlan(
      {
        mode: 'parallel',
        steps: [
          step('a', { target: { kind: 'agent', agentId: 'codex:agent_01' as AgentInstanceId } }),
          step('b', { target: { kind: 'agent', agentId: 'codex:agent_01' as AgentInstanceId } }),
        ],
      },
      deps,
    )
    expect(result.status).toBe('completed')
    expect(result.warnings.join(' ')).toContain('run in sequence')
  })
})

// ---------------------------------------------------------------------------
// Two-phase dispatch
// ---------------------------------------------------------------------------

describe('two-phase prepare/start', () => {
  test('subscribes BEFORE starting, so an instant answer is not lost', async () => {
    // Without the split there is a window between sending and listening, and an
    // agent that answers inside it leaves the step waiting forever.
    const { deps } = scriptedDeps({ a: { instant: true } })
    const result = await runPlan({ mode: 'parallel', steps: [step('a')] }, deps)
    expect(result.status).toBe('completed')
  })

  test('prepare is called before start for every attempt', async () => {
    const { deps, rec } = scriptedDeps({})
    await runPlan({ mode: 'parallel', steps: [step('a')] }, deps)
    expect(rec.prepared.map(p => p.label)).toEqual(['a'])
    expect(rec.started).toEqual(['a'])
  })

  test('a failed prepare records the reason and never starts', async () => {
    const { deps, rec } = scriptedDeps({ a: { failPrepare: 'no codex binary' } })
    const result = await runPlan({ mode: 'parallel', steps: [step('a')] }, deps)
    expect(result.steps[0]!.status).toBe('failed')
    expect(result.steps[0]!.detail).toContain('no codex binary')
    expect(rec.started).toEqual([])
  })

  test('a failed start settles the waiter instead of leaking it', async () => {
    const { deps } = scriptedDeps({
      a: { failStart: 'stdin already closed', delayMs: 5_000 },
    })
    const result = await runPlan({ mode: 'parallel', steps: [step('a')] }, deps)
    // It resolves promptly rather than waiting out the 5s delay.
    expect(result.steps[0]!.status).toBe('failed')
    expect(result.steps[0]!.detail).toContain('stdin already closed')
  })
})

// ---------------------------------------------------------------------------
// Parallel
// ---------------------------------------------------------------------------

describe('parallel mode', () => {
  test('a failure does not stop the others', async () => {
    const { deps } = scriptedDeps({ b: { status: 'failed', detail: 'nope' } })
    const result = await runPlan(
      { mode: 'parallel', steps: [step('a'), step('b'), step('c')] },
      deps,
    )
    expect(byId(result.steps)).toEqual({
      a: 'completed',
      b: 'failed',
      c: 'completed',
    })
    expect(result.status).toBe('partial')
  })

  test('all completing reports completed', async () => {
    const { deps } = scriptedDeps({})
    const result = await runPlan(
      { mode: 'parallel', steps: [step('a'), step('b')] },
      deps,
    )
    expect(result.status).toBe('completed')
  })

  test('none completing reports failed', async () => {
    const { deps } = scriptedDeps({
      a: { status: 'failed' },
      b: { status: 'failed' },
    })
    const result = await runPlan(
      { mode: 'parallel', steps: [step('a'), step('b')] },
      deps,
    )
    expect(result.status).toBe('failed')
  })

  test('every step really is started', async () => {
    const { deps, rec } = scriptedDeps({})
    await runPlan(
      { mode: 'parallel', steps: [step('a'), step('b'), step('c')] },
      deps,
    )
    expect(rec.started.sort()).toEqual(['a', 'b', 'c'])
  })
})

// ---------------------------------------------------------------------------
// Sequential
// ---------------------------------------------------------------------------

describe('sequential mode', () => {
  test('runs in order', async () => {
    const { deps, rec } = scriptedDeps({})
    await runPlan(
      { mode: 'sequential', steps: [step('a'), step('b'), step('c')] },
      deps,
    )
    expect(rec.started).toEqual(['a', 'b', 'c'])
  })

  test('stops on failure by default and SKIPS the rest', async () => {
    const { deps, rec } = scriptedDeps({ a: { status: 'failed' } })
    const result = await runPlan(
      { mode: 'sequential', steps: [step('a'), step('b'), step('c')] },
      deps,
    )
    expect(byId(result.steps)).toEqual({
      a: 'failed',
      b: 'skipped',
      c: 'skipped',
    })
    // Skipped means never started, not failed.
    expect(rec.started).toEqual(['a'])
    expect(result.steps[1]!.detail).toContain('step "a" failed')
  })

  test('stopOnFailure false continues past a failure', async () => {
    const { deps, rec } = scriptedDeps({ a: { status: 'failed' } })
    const result = await runPlan(
      {
        mode: 'sequential',
        stopOnFailure: false,
        steps: [step('a'), step('b')],
      },
      deps,
    )
    expect(byId(result.steps)).toEqual({ a: 'failed', b: 'completed' })
    expect(rec.started).toEqual(['a', 'b'])
    expect(result.status).toBe('partial')
  })
})

// ---------------------------------------------------------------------------
// Race
// ---------------------------------------------------------------------------

describe('race mode', () => {
  test('the first success wins and the losers are CANCELLED, not failed', async () => {
    const { deps, rec } = scriptedDeps({
      fast: { delayMs: 5 },
      slow: { delayMs: 500 },
    })
    const result = await runPlan(
      { mode: 'race', steps: [step('fast'), step('slow')] },
      deps,
    )
    expect(byId(result.steps)).toEqual({ fast: 'completed', slow: 'cancelled' })
    expect(result.steps.find(s => s.id === 'slow')!.detail).toContain(
      'step "fast" finished first',
    )
    expect(rec.cancelled).toHaveLength(1)
  })

  test('a race WITH a winner reports completed, not partial', async () => {
    // A race asked for ONE answer; the cancelled losers are the mechanism, not a
    // shortfall. Reporting partial would say something went wrong when nothing
    // did.
    const { deps } = scriptedDeps({ fast: { delayMs: 5 }, slow: { delayMs: 500 } })
    const result = await runPlan(
      { mode: 'race', steps: [step('fast'), step('slow')] },
      deps,
    )
    expect(result.status).toBe('completed')
  })

  test('a race where everyone fails reports failed', async () => {
    const { deps } = scriptedDeps({
      a: { status: 'failed' },
      b: { status: 'failed' },
    })
    const result = await runPlan(
      { mode: 'race', steps: [step('a'), step('b')] },
      deps,
    )
    expect(result.status).toBe('failed')
    expect(byId(result.steps)).toEqual({ a: 'failed', b: 'failed' })
  })

  test('a cancel failure does not fail the race', async () => {
    // The winner already won, and the loser may simply have finished a moment
    // earlier.
    const { deps } = scriptedDeps({ fast: { delayMs: 5 }, slow: { delayMs: 500 } })
    const result = await runPlan(
      { mode: 'race', steps: [step('fast'), step('slow')] },
      {
        ...deps,
        cancel: async () => {
          throw new Error('agent already gone')
        },
      },
    )
    expect(result.status).toBe('completed')
  })

  test('an explicitly allowed shared-tree race still runs', async () => {
    const { deps, rec } = scriptedDeps({ a: { delayMs: 5 }, b: { delayMs: 200 } })
    const result = await runPlan(
      {
        mode: 'race',
        allowSharedWorkspaceRace: true,
        steps: [
          {
            ...step('a'),
            target: { kind: 'agent', agentId: 'codex:agent_01' as AgentInstanceId },
          },
          {
            ...step('b'),
            target: { kind: 'agent', agentId: 'claude-code:agent_01' as AgentInstanceId },
          },
        ],
      },
      { ...deps, workspaceRootOf: () => '/repo' },
    )
    expect(result.status).toBe('completed')
    expect(rec.prepared).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Retry and fallback
// ---------------------------------------------------------------------------

describe('retry policy', () => {
  test('a plain failure is NOT retried by default', async () => {
    // Repeating an identical prompt the agent already could not complete would
    // just burn tokens.
    const { deps, rec } = scriptedDeps({ a: { status: 'failed' } })
    await runPlan(
      { mode: 'parallel', steps: [step('a', { retry: { attempts: 3 } })] },
      deps,
    )
    expect(rec.started).toEqual(['a'])
  })

  test('a provider fault IS retried', async () => {
    const { deps, rec } = scriptedDeps({
      a: { status: 'failed', sawProviderFault: true, succeedFromAttempt: 3 },
    })
    const result = await runPlan(
      { mode: 'parallel', steps: [step('a', { retry: { attempts: 3 } })] },
      deps,
    )
    expect(rec.started).toHaveLength(3)
    expect(result.steps[0]!.status).toBe('completed')
    expect(result.steps[0]!.attempts).toHaveLength(3)
  })

  test('onlyRetryable false retries a plain failure too', async () => {
    const { deps, rec } = scriptedDeps({
      a: { status: 'failed', succeedFromAttempt: 2 },
    })
    const result = await runPlan(
      {
        mode: 'parallel',
        steps: [step('a', { retry: { attempts: 3, onlyRetryable: false } })],
      },
      deps,
    )
    expect(rec.started).toHaveLength(2)
    expect(result.steps[0]!.status).toBe('completed')
  })

  test('a timeout is retryable', async () => {
    const { deps, rec } = scriptedDeps({
      a: { status: 'timeout', succeedFromAttempt: 2 },
    })
    await runPlan(
      { mode: 'parallel', steps: [step('a', { retry: { attempts: 2 } })] },
      deps,
    )
    expect(rec.started).toHaveLength(2)
  })

  test('backoff is applied between attempts, not before the first', async () => {
    const { deps, rec } = scriptedDeps({
      a: { status: 'timeout', succeedFromAttempt: 3 },
    })
    await runPlan(
      {
        mode: 'parallel',
        steps: [step('a', { retry: { attempts: 3, backoffMs: 250 } })],
      },
      deps,
    )
    expect(rec.slept).toEqual([250, 250])
  })

  test('a dispatch failure still consumes attempts', async () => {
    const { deps, rec } = scriptedDeps({ a: { failPrepare: 'no binary' } })
    const result = await runPlan(
      { mode: 'parallel', steps: [step('a', { retry: { attempts: 2 } })] },
      deps,
    )
    expect(rec.prepared).toHaveLength(2)
    expect(result.steps[0]!.attempts).toHaveLength(2)
  })
})

describe('fallback targets', () => {
  const fallbackStep = step('a', {
    target: { kind: 'provider', provider: asProviderId('codex'), isolate: true },
    fallback: [
      { kind: 'provider', provider: asProviderId('claude-code'), isolate: true },
    ],
  })

  test('a fallback is tried after the primary is exhausted', async () => {
    // The better answer for a plain failure than retrying the same agent.
    const { deps, rec } = scriptedDeps({
      'a@codex': { status: 'failed' },
      'a@claude-code': { status: 'completed' },
    })
    const result = await runPlan({ mode: 'parallel', steps: [fallbackStep] }, deps)
    expect(result.steps[0]!.status).toBe('completed')
    expect(rec.prepared.map(p => p.target)).toEqual(['codex', 'claude-code'])
    expect(result.steps[0]!.attempts.map(a => a.target)).toEqual([
      'codex (isolated)',
      'claude-code (isolated)',
    ])
  })

  test('a succeeding primary never touches the fallback', async () => {
    const { deps, rec } = scriptedDeps({})
    await runPlan({ mode: 'parallel', steps: [fallbackStep] }, deps)
    expect(rec.prepared.map(p => p.target)).toEqual(['codex'])
  })

  test('exhausting every target reports the LAST failure', async () => {
    const { deps } = scriptedDeps({
      'a@codex': { status: 'failed', detail: 'codex gave up' },
      'a@claude-code': { status: 'failed', detail: 'claude gave up' },
    })
    const result = await runPlan({ mode: 'parallel', steps: [fallbackStep] }, deps)
    expect(result.steps[0]!.status).toBe('failed')
    expect(result.steps[0]!.detail).toContain('claude gave up')
  })
})

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('abort', () => {
  test('an already-aborted signal cancels every step', async () => {
    const controller = new AbortController()
    controller.abort()
    const { deps } = scriptedDeps({})
    const result = await runPlan(
      { mode: 'sequential', steps: [step('a'), step('b')] },
      deps,
      { signal: controller.signal },
    )
    expect(result.status).toBe('aborted')
    expect(byId(result.steps)).toEqual({ a: 'cancelled', b: 'cancelled' })
  })

  test('aborting mid-flight settles the running step as cancelled', async () => {
    const controller = new AbortController()
    const { deps } = scriptedDeps({ a: { delayMs: 5_000 } })
    const promise = runPlan({ mode: 'parallel', steps: [step('a')] }, deps, {
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)
    const result = await promise
    expect(result.status).toBe('aborted')
    expect(result.steps[0]!.status).toBe('cancelled')
  })

  test('an aborted plan reports aborted even when a step completed', async () => {
    const controller = new AbortController()
    const { deps } = scriptedDeps({ a: {}, b: { delayMs: 5_000 } })
    const promise = runPlan(
      { mode: 'parallel', steps: [step('a'), step('b')] },
      deps,
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 15)
    expect((await promise).status).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

describe('review pass', () => {
  const reviewer: StepTarget = {
    kind: 'provider',
    provider: asProviderId('claude-code'),
    isolate: true,
  }

  test('the reviewer receives a RENDERED summary, not assumed context', async () => {
    // It is a separate process with its own conversation: it cannot see this
    // session or the other agents' transcripts.
    const { deps, rec } = scriptedDeps({})
    await runPlan(
      {
        mode: 'parallel',
        steps: [step('a')],
        reviewAfter: { target: reviewer, prompt: 'check the work' },
      },
      deps,
    )
    const reviewPrompt = rec.prepared.find(p => p.label === 'review')!.prompt
    expect(reviewPrompt).toContain('check the work')
    expect(reviewPrompt).toContain('Work completed by other agents:')
    expect(reviewPrompt).toContain('[completed] a')
  })

  test('review is SKIPPED when nothing completed', async () => {
    const { deps, rec } = scriptedDeps({ a: { status: 'failed' } })
    const result = await runPlan(
      {
        mode: 'parallel',
        steps: [step('a')],
        reviewAfter: { target: reviewer, prompt: 'check' },
      },
      deps,
    )
    expect(result.review?.status).toBe('skipped')
    expect(result.review?.detail).toContain('nothing to review')
    expect(rec.prepared.map(p => p.label)).toEqual(['a'])
  })

  test('a failed review downgrades a completed plan to partial', async () => {
    const { deps } = scriptedDeps({ review: { status: 'failed' } })
    const result = await runPlan(
      {
        mode: 'parallel',
        steps: [step('a')],
        reviewAfter: { target: reviewer, prompt: 'check' },
      },
      deps,
    )
    expect(result.steps[0]!.status).toBe('completed')
    expect(result.review?.status).toBe('failed')
    expect(result.status).toBe('partial')
  })

  test('review is cancelled when the plan was aborted', async () => {
    const controller = new AbortController()
    const { deps } = scriptedDeps({ a: {} })
    // Abort the moment the first step settles, so the step itself completes and
    // the review is what gets cancelled.
    const result = await runPlan(
      {
        mode: 'parallel',
        steps: [step('a')],
        reviewAfter: { target: reviewer, prompt: 'check' },
      },
      {
        ...deps,
        async awaitOutcome(taskRef, agentId, opts) {
          const outcome = await deps.awaitOutcome(taskRef, agentId, opts)
          controller.abort()
          return outcome
        },
      },
      { signal: controller.signal },
    )
    expect(result.steps[0]!.status).toBe('completed')
    expect(result.review!.status).toBe('cancelled')
    expect(result.review!.detail).toContain('cancelled before the review')
  })

  test('no reviewAfter means no review entry', async () => {
    const { deps } = scriptedDeps({})
    const result = await runPlan({ mode: 'parallel', steps: [step('a')] }, deps)
    expect(result.review).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('plan result rendering', () => {
  test('leads with mode and status', async () => {
    const { deps } = scriptedDeps({})
    const text = formatPlanResult(
      await runPlan({ mode: 'parallel', steps: [step('a')] }, deps),
    )
    expect(text).toStartWith('Plan (parallel): completed')
  })

  test('lists errors for an invalid plan', async () => {
    const { deps } = scriptedDeps({})
    const text = formatPlanResult(await runPlan({ mode: 'parallel', steps: [] }, deps))
    expect(text).toContain('error: The plan has no steps.')
  })

  test('itemizes attempts only when something was retried', async () => {
    const { deps } = scriptedDeps({
      a: { status: 'timeout', sawProviderFault: true, succeedFromAttempt: 2 },
    })
    const retried = formatPlanResult(
      await runPlan(
        { mode: 'parallel', steps: [step('a', { retry: { attempts: 2 } })] },
        deps,
      ),
    )
    expect(retried).toContain('attempt 1 on codex (isolated): timeout')

    const { deps: cleanDeps } = scriptedDeps({})
    const clean = formatPlanResult(
      await runPlan({ mode: 'parallel', steps: [step('a')] }, cleanDeps),
    )
    expect(clean).not.toContain('attempt 1')
  })

  test('names the agent that served each step', async () => {
    const { deps } = scriptedDeps({})
    const text = formatPlanResult(
      await runPlan({ mode: 'parallel', steps: [step('a')] }, deps),
    )
    expect(text).toContain('codex:agent_01')
  })

  test('the review summary lists every step with its status', () => {
    const text = renderStepsForReview([
      { id: 'a', status: 'completed', attempts: [], detail: 'built it' },
      { id: 'b', status: 'failed', attempts: [], detail: 'broke' },
    ])
    expect(text).toContain('[completed] a')
    expect(text).toContain('built it')
    expect(text).toContain('[failed] b')
  })
})
