/**
 * Orchestration plan shapes and their validation.
 *
 * Pure: no I/O, no bus, no manager. Validation is separated from execution so
 * the dangerous combinations are caught BEFORE any agent is launched — a plan
 * that would have two agents fighting over one working tree should be refused
 * while refusing is still free.
 */

import type { AgentInstanceId, ProviderId } from '../core/types.js'

export type StepTarget =
  /** An agent already connected to this session. */
  | { readonly kind: 'agent'; readonly agentId: AgentInstanceId }
  /** Start a fresh instance of a provider for this step. */
  | {
      readonly kind: 'provider'
      readonly provider: ProviderId
      /** Give the new agent its own git worktree. */
      readonly isolate?: boolean
    }

export type RetryPolicy = {
  /** Total attempts against one target, including the first. */
  readonly attempts: number
  /** Delay before each retry. Applied as-is; no jitter, since steps are few. */
  readonly backoffMs?: number
  /**
   * Only retry when the failure looks transient (provider fault, disconnect,
   * timeout). Default TRUE: repeating an identical prompt that the agent already
   * refused or could not complete will usually fail identically and just burn
   * tokens. Set false to retry regardless.
   */
  readonly onlyRetryable?: boolean
}

export type StepPlan = {
  /** Caller's label, echoed in results. Must be unique within the plan. */
  readonly id: string
  readonly prompt: string
  readonly target: StepTarget
  readonly retry?: RetryPolicy
  /** Tried in order once the primary target is exhausted. */
  readonly fallback?: readonly StepTarget[]
  /** Opt-in per-step deadline. Omitted means wait as long as the agent takes. */
  readonly timeoutMs?: number
}

export type ReviewPlan = {
  readonly target: StepTarget
  /**
   * Instruction for the reviewer. A rendered summary of what the steps produced
   * is appended, because the reviewer is a separate process that cannot see this
   * session or the other agents' transcripts.
   */
  readonly prompt: string
  readonly timeoutMs?: number
}

export type OrchestrationMode =
  /** All steps at once; a failure does not stop the others. */
  | 'parallel'
  /** One after another; stops on failure by default. */
  | 'sequential'
  /** Same work to several targets; first success wins, the rest are cancelled. */
  | 'race'

export type Plan = {
  readonly mode: OrchestrationMode
  readonly steps: readonly StepPlan[]
  readonly reviewAfter?: ReviewPlan
  /** Sequential only. Default true. */
  readonly stopOnFailure?: boolean
  /**
   * Required to run a `race` whose participants may share a working tree.
   *
   * Losing a race stops FUTURE work; it does not revert edits already written.
   * Racing two agents in one directory therefore risks interleaved, half-applied
   * changes from the loser. Opting in has to be explicit.
   */
  readonly allowSharedWorkspaceRace?: boolean
}

export type PlanValidation = {
  /** Plan must not run. */
  readonly errors: readonly string[]
  /** Plan may run, but the user should know. */
  readonly warnings: readonly string[]
}

export function describeTarget(target: StepTarget): string {
  return target.kind === 'agent'
    ? target.agentId
    : `${target.provider}${target.isolate ? ' (isolated)' : ''}`
}

/** True when this target is guaranteed its own working tree. */
function isIsolated(target: StepTarget): boolean {
  return target.kind === 'provider' && target.isolate === true
}

/**
 * Check a plan before anything is launched.
 *
 * `workspaceRootOf` lets the caller supply the current root of an already-
 * connected agent. It is optional: when absent, a shared root cannot be ruled
 * out, and for a race that counts against the plan rather than for it.
 */
export function validatePlan(
  plan: Plan,
  workspaceRootOf?: (agentId: AgentInstanceId) => string | undefined,
): PlanValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (plan.steps.length === 0) {
    errors.push('The plan has no steps.')
  }

  const seen = new Set<string>()
  for (const step of plan.steps) {
    if (step.id.trim() === '') {
      errors.push('Every step needs a non-empty id.')
    } else if (seen.has(step.id)) {
      errors.push(`Duplicate step id "${step.id}"; ids identify results.`)
    }
    seen.add(step.id)

    if (step.prompt.trim() === '') {
      errors.push(`Step "${step.id}" has an empty prompt.`)
    }
    if (step.retry && step.retry.attempts < 1) {
      errors.push(
        `Step "${step.id}" has retry.attempts=${step.retry.attempts}; it must be at least 1.`,
      )
    }
    if (step.timeoutMs !== undefined && step.timeoutMs <= 0) {
      errors.push(`Step "${step.id}" has a non-positive timeoutMs.`)
    }
  }

  if (plan.mode === 'race') {
    validateRace(plan, workspaceRootOf, errors, warnings)
  }

  if (plan.mode !== 'sequential' && plan.stopOnFailure !== undefined) {
    warnings.push(
      `stopOnFailure only applies to sequential plans; it is ignored in ${plan.mode} mode.`,
    )
  }

  // Reusing ONE agent for several parallel steps is not parallel: admission
  // control will queue the extra work behind the first turn. Say so rather than
  // letting the caller believe the steps ran concurrently.
  if (plan.mode === 'parallel') {
    const perAgent = new Map<string, number>()
    for (const step of plan.steps) {
      if (step.target.kind !== 'agent') continue
      perAgent.set(
        step.target.agentId,
        (perAgent.get(step.target.agentId) ?? 0) + 1,
      )
    }
    for (const [agentId, count] of perAgent) {
      if (count > 1) {
        warnings.push(
          `${count} parallel steps target ${agentId}; one agent runs one turn at a time, so they will be queued and run in sequence.`,
        )
      }
    }
  }

  return { errors, warnings }
}

function validateRace(
  plan: Plan,
  workspaceRootOf: ((agentId: AgentInstanceId) => string | undefined) | undefined,
  errors: string[],
  warnings: string[],
): void {
  if (plan.steps.length < 2) {
    errors.push('A race needs at least two steps to race.')
  }

  const prompts = new Set(plan.steps.map(step => step.prompt))
  if (prompts.size > 1) {
    warnings.push(
      'The race steps have different prompts, so this is not the same work done twice — the first to finish wins regardless of what it did.',
    )
  }

  if (plan.allowSharedWorkspaceRace) return

  const unIsolated = plan.steps.filter(step => !isIsolated(step.target))
  if (unIsolated.length === 0) return

  // Two connected agents in DIFFERENT roots are fine; the hazard is a shared
  // root, or a root we cannot determine.
  const roots: string[] = []
  let undetermined = false
  for (const step of unIsolated) {
    if (step.target.kind === 'agent') {
      const root = workspaceRootOf?.(step.target.agentId)
      if (root === undefined) undetermined = true
      else roots.push(root)
    } else {
      // A non-isolated provider target lands in the session's working
      // directory, which every other non-isolated participant also uses.
      undetermined = true
    }
  }

  const shared = new Set(roots).size !== roots.length
  if (shared || undetermined) {
    errors.push(
      'This race would run more than one agent in the same working tree. ' +
        'Losing a race stops future work but does not revert edits already written, ' +
        'so the loser can leave half-applied changes behind. ' +
        'Give each step `isolate: true`, or set `allowSharedWorkspaceRace: true` to accept that risk.',
    )
  }
}

/** Attempts against one target, defaulting to a single try. */
export function attemptsFor(step: StepPlan): number {
  return Math.max(1, step.retry?.attempts ?? 1)
}

/** Primary target first, then each fallback in order. */
export function targetsFor(step: StepPlan): readonly StepTarget[] {
  return [step.target, ...(step.fallback ?? [])]
}
