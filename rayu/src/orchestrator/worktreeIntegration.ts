/**
 * Bring a worktree packet's work into the main tree when its worker finishes.
 *
 * A worktree packet's worker edits its own git worktree, which starts from the run's
 * baseline snapshot. When the worker completes, its packet is `merging` (see
 * packetProgress.ts) and this module merges the worktree's changes 3-way into the main
 * tree (worktreeMerge.ts):
 *   - clean: every file is written at once, recorded for /undo and the review card and
 *     in the run's ledger as the packet's work, and the worktree is removed. The packet
 *     is `completed`, so its dependents can start.
 *   - conflicts: nothing is written to the main tree. The worktree is synced with the
 *     main tree (conflict markers where both changed the same lines), the packet is
 *     `conflicted`, and the completion notice tells the Orchestrator to continue the
 *     worker with SendMessage to resolve them; the merge runs again when it finishes.
 *     After ORCHESTRATOR_MAX_MERGE_ATTEMPTS failed attempts each conflict is also raised
 *     as a `merge-conflict` problem, which keeps the run from being reported as done
 *     until it is merged or the user accepts it.
 * Merges into one repository run one at a time. Every attempt is in the audit history.
 */
import {
  ORCHESTRATOR_MAX_MERGE_ATTEMPTS,
  ORCHESTRATOR_MERGE_STALE_RETRIES,
} from '../constants/orchestrator.js'
import type { AppState } from '../state/AppStateStore.js'
import { getPatchFromContents } from '../utils/diff.js'
import { detectLineEndingsForString } from '../utils/fileRead.js'
import { logError } from '../utils/log.js'
import { type PendingFileSnapshot, recordPendingFileChange } from '../utils/pendingFileChanges.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { removeAgentWorktree } from '../utils/worktree.js'
import { auditClosedProblems, raiseRunProblem, recordMergedFiles } from './attribution.js'
import { appendAuditEvent } from './audit.js'
import { ownersOf } from './contract.js'
import { refComponent } from './gitSnapshot.js'
import { CONFLICT_REASON_TEXT, isBinaryContent } from './merge3.js'
import { defaultCaseInsensitivePaths } from './ownership.js'
import { packetOfWorker } from './packetProgress.js'
import {
  type OrchestrationProblem,
  type OrchestrationRun,
  type PacketWorktree,
  type PacketWorktreeConflict,
  updateActiveRun,
} from './runState.js'
import { insidePlansExclusion } from './runWorkspace.js'
import {
  type AppliedWrite,
  applyMerge,
  type MergePlan,
  type MergeTarget,
  planMerge,
  StaleMainTreeError,
  syncWorktree,
} from './worktreeMerge.js'

/** How merged files are labelled in /undo and the review card. */
export const WORKTREE_MERGE_TOOL_NAME = 'OrchestratorMerge'

type SetAppState = (update: (prev: AppState) => AppState) => void

export type PacketWorktreeHost = {
  readonly getAppState: () => AppState
  /** The root store: a merge outlives the turn that launched the worker. */
  readonly setAppState: SetAppState
  /** Called once the merged worktree is removed, to forget its path in the worker's metadata. */
  readonly onWorktreeRemoved?: () => void
  /** Removes a merged worktree; removeAgentWorktree unless replaced. Returns whether it was removed. */
  readonly removeWorktree?: (worktree: PacketWorktree) => Promise<boolean>
}

export type WorktreeResult = { worktreePath?: string; worktreeBranch?: string }

export type MergeSummary =
  | { readonly kind: 'merged'; readonly files: number }
  | { readonly kind: 'conflict'; readonly conflicts: readonly PacketWorktreeConflict[]; readonly syncedBase: string }
  | { readonly kind: 'error'; readonly message: string }

type MergeOutcome =
  | { kind: 'merged'; plan: MergePlan; applied: AppliedWrite[] }
  | { kind: 'conflict'; plan: MergePlan; syncedBase: string }
  | { kind: 'error'; message: string }

const queues = new Map<string, Promise<unknown>>()

/** Run `task` after every earlier task with the same key has settled. */
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(task)
  const settled = next.catch(() => undefined)
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return next
}

function kept(worktree: PacketWorktree): WorktreeResult {
  return { worktreePath: worktree.path, ...(worktree.branch ? { worktreeBranch: worktree.branch } : {}) }
}

/**
 * Called when a worker's run ends (AgentTool, resumeAgent), in place of the plain
 * worktree cleanup. Returns null for workers that are not a worktree packet's; else the
 * worktree to report in the completion notice, or nothing once it was merged and removed.
 */
export async function finishPacketWorktree(agentId: string, host: PacketWorktreeHost): Promise<WorktreeResult | null> {
  const found = packetOfWorker(host.getAppState(), agentId)
  const worktree = found?.packet.worktree
  if (!found || !worktree) return null
  if (worktree.state === 'merged') return {}
  // A worker that failed or was stopped keeps its worktree; nothing is merged.
  if (found.packet.status !== 'merging') return kept(worktree)
  return serialized(worktree.gitRoot, () => integrate(found.run.runId, agentId, host))
}

async function integrate(runId: string, agentId: string, host: PacketWorktreeHost): Promise<WorktreeResult> {
  // Read again: a merge that ran before this one in the queue may have changed the run.
  const found = packetOfWorker(host.getAppState(), agentId)
  const worktree = found?.packet.worktree
  if (!found || !worktree || found.run.runId !== runId) return worktree ? kept(worktree) : {}
  if (found.packet.status !== 'merging' || worktree.state !== 'open') return worktree.state === 'merged' ? {} : kept(worktree)
  const { run, packet } = found
  const target = mergeTargetFor(run, packet.name, worktree)
  const attempt = worktree.failedAttempts + 1
  const outcome = await attemptMerge(target, run, attempt, host)
  settleOutcome(host, run, packet.name, summaryOf(outcome))
  await auditMerge(run, { packet: packet.name, agentId, attempt, base: worktree.base }, outcome)
  if (outcome.kind !== 'merged') return kept(worktree)
  await removeMergedWorktree(worktree, host)
  return {}
}

export function mergeTargetFor(run: OrchestrationRun, packet: string, worktree: PacketWorktree): MergeTarget {
  const repoRoot = run.workspace.repoRoot ?? worktree.gitRoot
  return {
    repoRoot,
    worktreePath: worktree.path,
    base: worktree.base,
    packet,
    mainExcludes: insidePlansExclusion(repoRoot),
    // Directories symlinked into a new worktree (settings.worktree.symlinkDirectories) are setup, not work.
    worktreeExcludes: getInitialSettings().worktree?.symlinkDirectories ?? [],
  }
}

async function attemptMerge(target: MergeTarget, run: OrchestrationRun, attempt: number, host: PacketWorktreeHost): Promise<MergeOutcome> {
  for (let tries = 1; ; tries++) {
    try {
      const plan = await planMerge(target)
      if (plan.conflicts.length > 0) {
        const ref = `${run.workspace.snapshotRefPrefix ?? 'refs/rayu/orchestration'}/sync-${refComponent(target.packet)}-${attempt}`
        return { kind: 'conflict', plan, syncedBase: await syncWorktree(target, plan, ref) }
      }
      const applied = applyMerge(target, plan)
      // Recorded right after the synchronous write, before anything else can run.
      recordAppliedWrites(host, run.runId, target, applied)
      return { kind: 'merged', plan, applied }
    } catch (error) {
      if (error instanceof StaleMainTreeError && tries < ORCHESTRATOR_MERGE_STALE_RETRIES) continue
      logError(error)
      const message = error instanceof StaleMainTreeError
        ? `the main tree kept changing while the merge was planned (last: ${error.path})`
        : error instanceof Error ? error.message : String(error)
      return { kind: 'error', message }
    }
  }
}

function summaryOf(outcome: MergeOutcome): MergeSummary {
  switch (outcome.kind) {
    case 'merged':
      return { kind: 'merged', files: outcome.applied.length }
    case 'conflict':
      return {
        kind: 'conflict',
        syncedBase: outcome.syncedBase,
        conflicts: outcome.plan.conflicts.map(conflict => ({ path: conflict.path, reason: CONFLICT_REASON_TEXT[conflict.reason] })),
      }
    case 'error':
      return outcome
  }
}

function recordAppliedWrites(host: PacketWorktreeHost, runId: string, target: MergeTarget, applied: readonly AppliedWrite[]): void {
  recordMergedFiles(runId, target.packet, applied.map(write => write.absolutePath), target.repoRoot)
  for (const write of applied) {
    try {
      recordPendingMerge(host, write)
    } catch (error) {
      logError(error)
    }
  }
}

/** Record a merged text file for /undo and the review card. Deletions and binary files cannot be shown there. */
function recordPendingMerge(host: PacketWorktreeHost, write: AppliedWrite): void {
  if (write.after === null || isBinaryContent(write.after) || (write.before && isBinaryContent(write.before))) return
  const beforeText = write.before?.toString('utf8') ?? null
  const afterText = write.after.toString('utf8')
  const before: PendingFileSnapshot =
    beforeText === null
      ? { exists: false }
      : { exists: true, content: beforeText, encoding: 'utf8', lineEndings: detectLineEndingsForString(beforeText) }
  recordPendingFileChange(host, {
    filePath: write.absolutePath,
    toolName: WORKTREE_MERGE_TOOL_NAME,
    before,
    afterContent: afterText,
    structuredPatch: getPatchFromContents({ filePath: write.absolutePath, oldContent: beforeText ?? '', newContent: afterText }),
  })
}

/** Pure: the run after a merge attempt of `packetName`. */
export function withMergeOutcome(run: OrchestrationRun, packetName: string, summary: MergeSummary): OrchestrationRun {
  const packets = run.packets.map(packet => {
    if (packet.name !== packetName || !packet.worktree) return packet
    const worktree = packet.worktree
    if (summary.kind === 'merged') {
      return { ...packet, status: 'completed' as const, worktree: { ...worktree, state: 'merged' as const, conflicts: [], mergedFiles: summary.files } }
    }
    const conflicts = summary.kind === 'conflict' ? summary.conflicts : [{ path: worktree.path, reason: `the merge failed: ${summary.message}` }]
    const base = summary.kind === 'conflict' ? summary.syncedBase : worktree.base
    return {
      ...packet,
      status: 'conflicted' as const,
      worktree: { ...worktree, base, conflicts, failedAttempts: worktree.failedAttempts + 1 },
    }
  })
  return { ...run, packets }
}

/** Pure: close a packet's open merge-conflict problems after its merge succeeded. */
export function closeMergeProblems(run: OrchestrationRun, packet: string): { run: OrchestrationRun; closed: OrchestrationProblem[] } {
  const closed: OrchestrationProblem[] = []
  const problems = run.problems.map(problem => {
    if (problem.status !== 'open' || problem.kind !== 'merge-conflict' || problem.packet !== packet) return problem
    const done: OrchestrationProblem = { ...problem, status: 'resolved', resolution: 'A later merge of the packet\'s worktree succeeded.' }
    closed.push(done)
    return done
  })
  return closed.length ? { run: { ...run, problems }, closed } : { run, closed }
}

function settleOutcome(host: PacketWorktreeHost, run: OrchestrationRun, packetName: string, summary: MergeSummary): void {
  const closedHolder: { closed: OrchestrationProblem[] } = { closed: [] }
  updateActiveRun(host.setAppState, run.runId, current => {
    const next = withMergeOutcome(current, packetName, summary)
    if (summary.kind !== 'merged') return next
    const settled = closeMergeProblems(next, packetName)
    closedHolder.closed = settled.closed
    return settled.run
  })
  if (closedHolder.closed.length) void auditClosedProblems(run, closedHolder.closed).catch(logError)
  if (summary.kind !== 'merged') raiseIfExhausted(host, run.runId, packetName)
}

/** After the last allowed attempt, each conflict becomes a problem for the user. */
function raiseIfExhausted(host: PacketWorktreeHost, runId: string, packetName: string): void {
  const found = host.getAppState().orchestration.run
  const packet = found?.runId === runId ? found.packets.find(item => item.name === packetName) : undefined
  if (!found || !packet?.worktree || packet.worktree.failedAttempts < ORCHESTRATOR_MAX_MERGE_ATTEMPTS) return
  const context = { getAppState: host.getAppState, setAppState: host.setAppState }
  for (const conflict of packet.worktree.conflicts) {
    raiseRunProblem(context, found, {
      kind: 'merge-conflict',
      path: conflict.path,
      packet: packetName,
      agentId: packet.workerAgentIds.at(-1) ?? null,
      owners: ownersOf(found.current.contract, conflict.path, defaultCaseInsensitivePaths()),
      tool: 'merge',
      at: Date.now(),
      detail: `${conflict.reason}; ${packet.worktree.failedAttempts} merge attempts failed, and the worktree is kept at ${packet.worktree.path}`,
    })
  }
}

async function auditMerge(
  run: OrchestrationRun,
  attempt: { packet: string; agentId: string; attempt: number; base: string },
  outcome: MergeOutcome,
): Promise<void> {
  if (!run.auditDir) return
  const plan = outcome.kind === 'error' ? null : outcome.plan
  const summary = summaryOf(outcome)
  await appendAuditEvent(run.auditDir, {
    type: 'worktree_merge',
    ...attempt,
    outcome: outcome.kind,
    ...(plan ? { workerTree: plan.workerTree, mainTree: plan.mainTree } : {}),
    files: outcome.kind === 'merged' ? outcome.applied.map(write => write.path) : [],
    conflicts: summary.kind === 'conflict' ? summary.conflicts : [],
    ...(outcome.kind === 'conflict' ? { syncedBase: outcome.syncedBase } : {}),
    ...(outcome.kind === 'error' ? { error: outcome.message } : {}),
  }).catch(logError)
}

async function removeMergedWorktree(worktree: PacketWorktree, host: PacketWorktreeHost): Promise<void> {
  const remove = host.removeWorktree ?? (item => removeAgentWorktree(item.path, item.branch, item.gitRoot))
  try {
    if (await remove(worktree)) host.onWorktreeRemoved?.()
  } catch (error) {
    logError(error)
  }
}
