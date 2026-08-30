/**
 * Executes an orchestration plan.
 *
 * Dependencies are INJECTED rather than imported. The runner needs to create
 * tasks (which needs `setAppState`), talk to `AgentManager`, and read the
 * workspace map — importing all three would tie this module to the UI and close
 * an import cycle through `core/`. Injection also means the policy logic is
 * exercisable against fakes, which is the only way to test a race or a
 * disconnect deterministically.
 *
 * What each mode actually promises
 * --------------------------------
 * `parallel`   — everything starts at once and a failure does NOT stop the
 *                others. They are already running; abandoning them would throw
 *                away work that may well succeed.
 * `sequential` — one at a time, stopping on the first failure by default,
 *                because a later step usually depends on an earlier one.
 *                Remaining steps are reported as `skipped` with the reason, not
 *                silently dropped.
 * `race`       — the same work to several targets; first success wins and the
 *                losers are cancelled. Cancelling stops FUTURE work only: edits
 *                already written stay written, which is why `validatePlan`
 *                refuses a race in a shared working tree unless the caller
 *                explicitly accepts that.
 */

import { errorMessage } from '../../utils/errors.js'
import type { AgentInstanceId, TaskRef } from '../core/types.js'
import {
  attemptsFor,
  describeTarget,
  type OrchestrationMode,
  type Plan,
  type ReviewPlan,
  type StepPlan,
  type StepTarget,
  targetsFor,
  validatePlan,
} from './plan.js'
import {
  type AwaitTaskOptions,
  isSuccessfulOutcome,
  looksRetryable,
  type TaskOutcome,
} from './taskOutcome.js'

/** What `prepare` hands back: the task exists, but no work has been sent yet. */
export type PreparedStep = {
  readonly agentId: AgentInstanceId
  readonly taskRef: TaskRef
  /**
   * Actually hand the work to the agent.
   *
   * Split from `prepare` so the runner can subscribe to the outcome BEFORE the
   * agent can possibly report one. Without the split there is a window between
   * sending and listening, and an agent that answers inside that window leaves
   * the step waiting forever — which is exactly what a fast adapter does.
   */
  start(): Promise<{ readonly action?: string }>
}

export type OrchestrationDeps = {
  /** Create the task and resolve the target, without dispatching yet. */
  prepare(
    target: StepTarget,
    prompt: string,
    label: string,
  ): Promise<PreparedStep>
  awaitOutcome(
    taskRef: TaskRef,
    agentId: AgentInstanceId,
    options?: AwaitTaskOptions,
  ): Promise<TaskOutcome>
  /** Stop a step's work. Must not throw for an agent that is already gone. */
  cancel(taskRef: TaskRef, agentId: AgentInstanceId): Promise<void>
  /** Current working root of a connected agent, for race validation. */
  workspaceRootOf?(agentId: AgentInstanceId): string | undefined
  /** Injected so retry backoff is instant in tests. */
  sleep?(ms: number): Promise<void>
}

export type AttemptResult = {
  readonly target: string
  readonly attempt: number
  readonly agentId?: AgentInstanceId
  readonly taskRef?: TaskRef
  readonly outcome?: TaskOutcome
  /** Set when dispatch itself failed, so no task ever existed. */
  readonly dispatchError?: string
}

export type StepStatus =
  | 'completed'
  | 'failed'
  /** Never started, because an earlier step failed. */
  | 'skipped'
  /** Lost a race, or the plan was aborted while it ran. */
  | 'cancelled'

export type StepResult = {
  readonly id: string
  readonly status: StepStatus
  readonly attempts: readonly AttemptResult[]
  readonly detail?: string
  readonly agentId?: AgentInstanceId
  readonly taskRef?: TaskRef
}

export type PlanStatus =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'aborted'
  /** Refused by validation; nothing was launched. */
  | 'invalid'

export type PlanResult = {
  readonly mode: OrchestrationMode
  readonly status: PlanStatus
  readonly steps: readonly StepResult[]
  readonly review?: StepResult
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
}

export type RunPlanOptions = {
  readonly signal?: AbortSignal
}

export async function runPlan(
  plan: Plan,
  deps: OrchestrationDeps,
  options: RunPlanOptions = {},
): Promise<PlanResult> {
  const validation = validatePlan(plan, deps.workspaceRootOf)
  if (validation.errors.length > 0) {
    // Nothing is launched. Refusing while it is still free is the whole point of
    // validating separately from running.
    return {
      mode: plan.mode,
      status: 'invalid',
      steps: [],
      warnings: validation.warnings,
      errors: validation.errors,
    }
  }

  const steps =
    plan.mode === 'race'
      ? await runRace(plan, deps, options)
      : plan.mode === 'parallel'
        ? await runParallel(plan, deps, options)
        : await runSequential(plan, deps, options)

  const review = await runReview(plan.reviewAfter, steps, deps, options)

  return {
    mode: plan.mode,
    status: overallStatus(plan.mode, steps, review, options.signal?.aborted === true),
    steps,
    review,
    warnings: validation.warnings,
    errors: [],
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runParallel(
  plan: Plan,
  deps: OrchestrationDeps,
  options: RunPlanOptions,
): Promise<StepResult[]> {
  return Promise.all(plan.steps.map(step => runStep(step, deps, options)))
}

async function runSequential(
  plan: Plan,
  deps: OrchestrationDeps,
  options: RunPlanOptions,
): Promise<StepResult[]> {
  const stopOnFailure = plan.stopOnFailure ?? true
  const results: StepResult[] = []
  let stoppedBy: string | undefined

  for (const step of plan.steps) {
    if (stoppedBy !== undefined) {
      results.push({
        id: step.id,
        status: 'skipped',
        attempts: [],
        detail: `skipped because step "${stoppedBy}" failed`,
      })
      continue
    }
    if (options.signal?.aborted) {
      results.push({
        id: step.id,
        status: 'cancelled',
        attempts: [],
        detail: 'the plan was cancelled',
      })
      continue
    }
    const result = await runStep(step, deps, options)
    results.push(result)
    if (result.status !== 'completed' && stopOnFailure) {
      stoppedBy = step.id
    }
  }
  return results
}

/**
 * First success wins; the rest are cancelled.
 *
 * All participants are started together and settled individually, so a loser's
 * cancellation can be issued the moment a winner appears rather than after the
 * whole set has finished.
 */
async function runRace(
  plan: Plan,
  deps: OrchestrationDeps,
  options: RunPlanOptions,
): Promise<StepResult[]> {
  const raceController = new AbortController()
  const onOuterAbort = () => raceController.abort()
  if (options.signal?.aborted) raceController.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })

  const results = new Map<string, StepResult>()
  const live = new Map<string, { agentId: AgentInstanceId; taskRef: TaskRef }>()
  let winner: string | undefined

  try {
    await Promise.all(
      plan.steps.map(async step => {
        const result = await runStep(
          step,
          deps,
          { signal: raceController.signal },
          handle => {
            live.set(step.id, handle)
          },
        )
        results.set(step.id, result)
        live.delete(step.id)

        if (result.status === 'completed' && winner === undefined) {
          winner = step.id
          // Abort the shared signal so the other waiters settle immediately,
          // then tell their agents to stop working.
          raceController.abort()
          await cancelOthers(live, deps)
        }
      }),
    )
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort)
  }

  // Re-label the non-winners: they were aborted by the race itself, which is a
  // cancellation, not a failure of the agent.
  return plan.steps.map(step => {
    const result = results.get(step.id)
    if (!result) {
      return {
        id: step.id,
        status: 'cancelled' as StepStatus,
        attempts: [],
        detail: 'never settled',
      }
    }
    if (winner !== undefined && step.id !== winner && result.status !== 'completed') {
      return {
        ...result,
        status: 'cancelled',
        detail: `step "${winner}" finished first`,
      }
    }
    return result
  })
}

async function cancelOthers(
  live: Map<string, { agentId: AgentInstanceId; taskRef: TaskRef }>,
  deps: OrchestrationDeps,
): Promise<void> {
  const pending = [...live.values()]
  live.clear()
  await Promise.all(
    pending.map(entry =>
      // A cancel failure must not fail the race — the winner already won, and
      // the loser may simply have finished on its own a moment earlier.
      deps.cancel(entry.taskRef, entry.agentId).catch(() => undefined),
    ),
  )
}

// ---------------------------------------------------------------------------
// One step: targets x attempts
// ---------------------------------------------------------------------------

async function runStep(
  step: StepPlan,
  deps: OrchestrationDeps,
  options: RunPlanOptions,
  onDispatched?: (handle: {
    agentId: AgentInstanceId
    taskRef: TaskRef
  }) => void,
): Promise<StepResult> {
  const attempts: AttemptResult[] = []
  const targets = targetsFor(step)
  const maxAttempts = attemptsFor(step)
  const onlyRetryable = step.retry?.onlyRetryable ?? true

  for (const target of targets) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (options.signal?.aborted) {
        return {
          id: step.id,
          status: 'cancelled',
          attempts,
          detail: 'the plan was cancelled',
        }
      }

      if (attempt > 1 && step.retry?.backoffMs) {
        await (deps.sleep ?? defaultSleep)(step.retry.backoffMs)
      }

      let prepared
      try {
        prepared = await deps.prepare(target, step.prompt, step.id)
      } catch (error) {
        // Could not even set up: a missing binary, a held workspace lease, an
        // unconnected agent. Recorded as an attempt so the reason survives.
        attempts.push({
          target: describeTarget(target),
          attempt,
          dispatchError: errorMessage(error),
        })
        continue
      }

      onDispatched?.({ agentId: prepared.agentId, taskRef: prepared.taskRef })

      // Subscribe BEFORE starting, so an agent that finishes immediately cannot
      // report into a void. `attemptSignal` lets a failed start settle the
      // waiter instead of leaking the subscription.
      const attemptAbort = new AbortController()
      const forwardAbort = () => attemptAbort.abort()
      options.signal?.addEventListener('abort', forwardAbort, { once: true })
      if (options.signal?.aborted) attemptAbort.abort()

      const waiting = deps.awaitOutcome(prepared.taskRef, prepared.agentId, {
        signal: attemptAbort.signal,
        timeoutMs: step.timeoutMs,
      })

      let startError: string | undefined
      try {
        await prepared.start()
      } catch (error) {
        startError = errorMessage(error)
        attemptAbort.abort()
      }

      const outcome = await waiting
      options.signal?.removeEventListener('abort', forwardAbort)

      if (startError !== undefined) {
        attempts.push({
          target: describeTarget(target),
          attempt,
          agentId: prepared.agentId,
          taskRef: prepared.taskRef,
          dispatchError: startError,
        })
        continue
      }

      attempts.push({
        target: describeTarget(target),
        attempt,
        agentId: prepared.agentId,
        taskRef: prepared.taskRef,
        outcome,
      })

      if (isSuccessfulOutcome(outcome)) {
        return {
          id: step.id,
          status: 'completed',
          attempts,
          detail: outcome.detail,
          agentId: prepared.agentId,
          taskRef: prepared.taskRef,
        }
      }

      if (outcome.status === 'aborted') {
        return {
          id: step.id,
          status: 'cancelled',
          attempts,
          detail: outcome.detail,
          agentId: prepared.agentId,
          taskRef: prepared.taskRef,
        }
      }

      // Stop hammering a target that failed for a reason another identical
      // attempt cannot change.
      if (onlyRetryable && !looksRetryable(outcome)) break
    }
  }

  return {
    id: step.id,
    status: 'failed',
    attempts,
    detail: describeFailure(attempts),
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function describeFailure(attempts: readonly AttemptResult[]): string {
  const last = attempts[attempts.length - 1]
  if (!last) return 'no attempt was made'
  if (last.dispatchError) return `could not start: ${last.dispatchError}`
  const outcome = last.outcome
  if (!outcome) return 'no outcome recorded'
  const tried =
    attempts.length > 1 ? ` after ${attempts.length} attempts` : ''
  return `${outcome.status}${tried}${outcome.detail ? `: ${outcome.detail}` : ''}`
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * Run the reviewer, if one was asked for and there is anything to review.
 *
 * The reviewer is a separate process with its own conversation: it cannot see
 * this session, the other agents' transcripts, or their tool output. So the
 * prompt carries an explicit rendered summary of what happened rather than
 * assuming shared context.
 */
async function runReview(
  review: ReviewPlan | undefined,
  steps: readonly StepResult[],
  deps: OrchestrationDeps,
  options: RunPlanOptions,
): Promise<StepResult | undefined> {
  if (!review) return undefined

  const completed = steps.filter(step => step.status === 'completed')
  if (completed.length === 0) {
    return {
      id: 'review',
      status: 'skipped',
      attempts: [],
      detail: 'no step completed, so there is nothing to review',
    }
  }
  if (options.signal?.aborted) {
    return {
      id: 'review',
      status: 'cancelled',
      attempts: [],
      detail: 'the plan was cancelled before the review',
    }
  }

  return runStep(
    {
      id: 'review',
      prompt: `${review.prompt}\n\n${renderStepsForReview(steps)}`,
      target: review.target,
      timeoutMs: review.timeoutMs,
    },
    deps,
    options,
  )
}

export function renderStepsForReview(steps: readonly StepResult[]): string {
  const lines = ['Work completed by other agents:']
  for (const step of steps) {
    lines.push(`- [${step.status}] ${step.id}${step.agentId ? ` (${step.agentId})` : ''}`)
    if (step.detail) lines.push(`    ${step.detail}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------

function overallStatus(
  mode: OrchestrationMode,
  steps: readonly StepResult[],
  review: StepResult | undefined,
  aborted: boolean,
): PlanStatus {
  if (aborted) return 'aborted'
  const completed = steps.filter(step => step.status === 'completed').length
  const reviewFailed = review?.status === 'failed'

  if (completed === 0) return 'failed'
  if (reviewFailed) return 'partial'

  // A race asked for ONE answer, so a single winner is total success — the
  // cancelled losers are the mechanism, not a shortfall. Reporting 'partial'
  // here would tell the caller something went wrong when nothing did.
  if (mode === 'race') return 'completed'

  return completed === steps.length ? 'completed' : 'partial'
}

/** Human-readable plan report, shared by commands and non-interactive output. */
export function formatPlanResult(result: PlanResult): string {
  const lines: string[] = [`Plan (${result.mode}): ${result.status}`]

  for (const error of result.errors) lines.push(`  error: ${error}`)
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`)

  for (const step of result.steps) {
    lines.push(`  [${step.status}] ${step.id}${step.agentId ? ` \u2014 ${step.agentId}` : ''}`)
    if (step.detail) lines.push(`      ${step.detail}`)
    // Only worth listing when something was retried or fell back.
    if (step.attempts.length > 1) {
      for (const attempt of step.attempts) {
        const what =
          attempt.dispatchError ?? attempt.outcome?.status ?? 'no outcome'
        lines.push(`      attempt ${attempt.attempt} on ${attempt.target}: ${what}`)
      }
    }
  }

  if (result.review) {
    lines.push(`  [${result.review.status}] review`)
    if (result.review.detail) lines.push(`      ${result.review.detail}`)
  }
  return lines.join('\n')
}
