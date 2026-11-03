/**
 * The verification gate: the Orchestrator may not end a run's work as done while the
 * run says otherwise.
 *
 * Checked when the Orchestrator's turn is about to end (query.ts, after stop hooks),
 * only once some packet has started and nothing is still working: no packet running or
 * being merged, no verifier running, and no worker notice waiting to be read. (A turn
 * that ends while workers run is the Orchestrator waiting for their notices, not
 * reporting.) The gate is closed while:
 *   - a packet has not completed (pending, conflicted, failed or stopped);
 *   - a contract problem is open;
 *   - there is no accepted verification of the current contract and of the project
 *     exactly as it is now (the tree the verifier saw).
 *
 * With `orchestrator.verificationGate` "hard" (the default), a closed gate sends the
 * Orchestrator back to work with the reasons, at most ORCHESTRATOR_GATE_NUDGES times
 * for the same reasons, then once tells it not to claim success and to report what is
 * unfinished. After `orchestrator.maxRepairRounds` failed verifications it stops
 * pushing for repairs and asks for that report at once. "soft" only reports. Either
 * way the user sees the gate's status, and the audit history records it.
 */
import { ORCHESTRATOR_GATE_NUDGES } from '../constants/orchestrator.js'
import type { ToolUseContext } from '../Tool.js'
import { logError } from '../utils/log.js'
import { getCommandQueueSnapshot } from '../utils/messageQueueManager.js'
import { appendAuditEvent } from './audit.js'
import { describeProblem } from './packetProgress.js'
import { type GateState, getActiveRun, type OrchestrationRun, openProblems, updateActiveRun } from './runState.js'
import { captureTree } from './treeTracker.js'
import { getOrchestratorSettings, type OrchestratorSettings } from './settings.js'
import { hasOpenVerifierSessions, latestVerification } from './verification.js'

export type { GateState }

export type GateDecision =
  | { readonly action: 'open' }
  | { readonly action: 'nudge'; readonly reasons: readonly string[]; readonly gate: GateState }
  | { readonly action: 'final'; readonly reasons: readonly string[]; readonly gate: GateState; readonly exhausted: boolean }
  /** Tell the user and let the turn end; `gate` is the state to keep, if any. */
  | { readonly action: 'report'; readonly reasons: readonly string[]; readonly gate?: GateState }

/** Whether the gate looks at this moment: work has started and nothing is still working. */
export function gateApplies(run: OrchestrationRun, verifierRunning: boolean): boolean {
  if (!run.packets.some(packet => packet.workerAgentIds.length > 0)) return false
  if (verifierRunning) return false
  return !run.packets.some(packet => packet.status === 'running' || packet.status === 'merging')
}

/** Pure: why the run is not done. `tree` is the project's current tree, when it was read. */
export function gateReasons(run: OrchestrationRun, tree: string | null): string[] {
  const unfinished = run.packets.filter(packet => packet.status !== 'completed')
  const problems = openProblems(run)
  const verification = latestVerification(run)
  const reasons = unfinished.map(packet => `Packet ${packet.name} is ${packet.status}${packet.status === 'pending' ? ' (not started)' : ''}.`)
  if (problems.length) {
    reasons.push(`${problems.length} contract problem${problems.length === 1 ? ' is' : 's are'} open: ${problems.map(problem => `${problem.id} ${describeProblem(problem)}`).join('; ')}.`)
  }
  if (!verification) reasons.push('No verifier has checked the run.')
  else if (!verification.accepted) reasons.push(`The latest verification (${verification.id}) was not accepted: ${verification.findings.slice(0, 3).join(' ') || `verdict ${verification.verdict ?? 'missing'}`}`)
  else if (verification.contractVersion !== run.current.version) reasons.push(`The accepted verification (${verification.id}) checked contract v${verification.contractVersion}; the contract is now v${run.current.version}.`)
  // A PASS on a project that cannot be tracked has no tree to compare; it stands on its evidence.
  else if (verification.tree !== null && verification.tree !== tree) {
    reasons.push(tree === null
      ? `The state of the project could not be read to confirm it is unchanged since the accepted verification (${verification.id}). Launch the verifier again.`
      : `The project changed after the accepted verification (${verification.id}).`)
  }
  return reasons
}

/**
 * Repair rounds used under the current contract: verifications that found the project
 * itself failing. One rejected for another reason (the verifier did not finish, a file
 * changed while it ran) is not a repair the Orchestrator can make, and must not run the
 * budget out. A new contract version starts the count again: its checks may be the
 * thing that was wrong, and fixing them is how the Orchestrator gets out of a failing
 * check. Records from before `failed` existed count when they were rejected at all.
 */
export function failedVerifications(run: OrchestrationRun): number {
  return (run.verifications ?? []).filter(
    record => record.contractVersion === run.current.version && (record.failed ?? !record.accepted) && !record.accepted,
  ).length
}

/** Pure: what the gate does about `reasons`. */
export function decideGate(input: {
  reasons: readonly string[]
  gate: GateState | undefined
  settings: Pick<OrchestratorSettings, 'verificationGate' | 'maxRepairRounds'>
  failedRounds: number
}): GateDecision {
  const { reasons, gate, settings } = input
  if (reasons.length === 0) return { action: 'open' }
  if (settings.verificationGate === 'soft') return { action: 'report', reasons }
  const key = reasons.join('\n')
  const exhausted = input.failedRounds >= settings.maxRepairRounds
  const same = gate?.key === key
  // The last word was already said for these reasons: keep that fact, so asking again
  // does not start the reminders over.
  if (same && gate.finalSent) return { action: 'report', reasons, gate }
  if (exhausted || (same && gate.nudges >= ORCHESTRATOR_GATE_NUDGES)) {
    return { action: 'final', reasons, exhausted, gate: { key, nudges: same ? gate.nudges : 0, finalSent: true } }
  }
  return { action: 'nudge', reasons, gate: { key, nudges: same ? gate.nudges + 1 : 1, finalSent: false } }
}

const bullet = (reasons: readonly string[]) => reasons.map(reason => `- ${reason}`).join('\n')

/** What the Orchestrator is told when the gate sends it back to work. */
export function renderNudge(reasons: readonly string[]): string {
  return `<orchestrator-gate>
The run is not finished, so do not report it as done yet:
${bullet(reasons)}

Settle each one: send the issue to the worker that owns the files (SendMessage), launch the packets that have not started, have problems fixed, undone or accepted by the user, and launch the verifier once every worker has finished. If something cannot be fixed, tell the user that plainly instead of claiming success.
</orchestrator-gate>`
}

/** The last word when the gate stays closed. */
export function renderFinal(reasons: readonly string[], exhausted: boolean, maxRepairRounds: number): string {
  const why = exhausted
    ? `Verification has failed ${maxRepairRounds} times (setting orchestrator.maxRepairRounds), so stop repairing.`
    : 'The gate is still closed after repeated reminders.'
  return `<orchestrator-gate>
${why} Still open:
${bullet(reasons)}

Do not claim the work is done or verified. Tell the user exactly what is unfinished or failing, what was verified, and that /orchestrator-status shows the run.
</orchestrator-gate>`
}

/** The status line the user sees. */
export function renderGateStatus(run: OrchestrationRun, reasons: readonly string[]): string {
  if (reasons.length === 0) return `Orchestrator gate for ${run.runId} is open: ${latestVerification(run)?.id ?? 'the verification'} accepted the project as it is.`
  return `Orchestrator gate for ${run.runId} is closed: ${reasons.join(' ')} See /orchestrator-status.`
}

export type GateOutcome = {
  /** A message that sends the Orchestrator back to work, or null to let the turn end. */
  readonly continuation: string | null
  /** The status for the user, or null when there is nothing new to show. */
  readonly status: string | null
  /** Whether the gate is closed. */
  readonly closed: boolean
}

/**
 * Worker completion notices still waiting for the Orchestrator: it gets another turn
 * for them, and has not seen those results yet.
 */
function hasPendingWorkerNotices(): boolean {
  return getCommandQueueSnapshot().some(command => command.mode === 'task-notification' && command.agentId === undefined)
}

/** The project's state now, read only when an accepted verification has one to compare with. */
async function currentTree(run: OrchestrationRun): Promise<string | null> {
  const verification = latestVerification(run)
  if (!verification?.accepted || verification.tree === null) return null
  return captureTree(run.workspace)
}

/**
 * Check the gate as the Orchestrator's turn ends. Null outside an Orchestrator run's
 * main thread, or when the gate does not apply now. Never throws.
 */
export async function checkOrchestratorGate(
  context: Pick<ToolUseContext, 'agentId' | 'getAppState' | 'setAppState'>,
): Promise<GateOutcome | null> {
  if (context.agentId) return null
  const state = context.getAppState()
  if (state.toolPermissionContext.mode !== 'orchestrator') return null
  const run = getActiveRun(state)
  if (!run || !gateApplies(run, hasOpenVerifierSessions(run.runId)) || hasPendingWorkerNotices()) return null
  try {
    const settings = getOrchestratorSettings()
    const reasons = gateReasons(run, await currentTree(run))
    const decision = decideGate({ reasons, gate: run.gate, settings, failedRounds: failedVerifications(run) })
    updateActiveRun(context.setAppState, run.runId, current => ({ ...current, gate: nextGateState(decision, current.gate) }))
    void recordGate(run, decision)
    return outcomeOf(run, decision, settings)
  } catch (error) {
    logError(error)
    return null
  }
}

/** The gate state to store after a decision: open clears it, a report keeps what was there. */
function nextGateState(decision: GateDecision, previous: GateState | undefined): GateState | undefined {
  if (decision.action === 'open') return undefined
  if ('gate' in decision && decision.gate) return decision.gate
  return previous
}

function outcomeOf(run: OrchestrationRun, decision: GateDecision, settings: OrchestratorSettings): GateOutcome {
  switch (decision.action) {
    case 'open':
      return { continuation: null, status: run.gate ? renderGateStatus(run, []) : null, closed: false }
    case 'nudge':
      return { continuation: renderNudge(decision.reasons), status: renderGateStatus(run, decision.reasons), closed: true }
    case 'final':
      return {
        continuation: renderFinal(decision.reasons, decision.exhausted, settings.maxRepairRounds),
        status: renderGateStatus(run, decision.reasons),
        closed: true,
      }
    case 'report':
      // Said once already for these reasons (final) or reported every turn (soft): show it
      // in the status, but not as a second identical notice after the final word.
      return { continuation: null, status: run.gate?.finalSent ? null : renderGateStatus(run, decision.reasons), closed: true }
  }
}

async function recordGate(run: OrchestrationRun, decision: GateDecision): Promise<void> {
  if (!run.auditDir) return
  await appendAuditEvent(run.auditDir, {
    type: 'gate',
    action: decision.action,
    reasons: decision.action === 'open' ? [] : decision.reasons,
  }).catch(logError)
}
