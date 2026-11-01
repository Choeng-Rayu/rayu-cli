/**
 * The state of an Orchestrator run, kept in AppState (`orchestration`).
 *
 * A run starts when the Orchestrator publishes its first contract and ends (is
 * archived) when the session leaves Orchestrator mode. Publishing again amends the run
 * with a new contract version. The functions here are pure: they take the current state
 * and return the next one, so they can be tested without a store and applied with
 * `setAppState`.
 */
import type { OrchestrationContract } from './contract.js'
import type { WorkingTreeSnapshot } from './gitSnapshot.js'

// Type-only imports above: AppStateStore loads this module, so it must not pull in
// git, settings or file-system code.

/**
 * How a run detects what changed in the project:
 * - `git`: snapshots of the working tree as git commits (gitSnapshot.ts).
 * - `files`: a scan of file sizes and modification times (fileManifest.ts), for a
 *   project that is not in a git repository.
 * - `none`: neither could be taken; changes cannot be compared with a baseline.
 */
export type TreeTracking = 'git' | 'files' | 'none'

export type RunWorkspace = {
  /** The git repository root, or null when the project is not in one. */
  readonly repoRoot: string | null
  /** Where this run's snapshot refs live; null without a repository. */
  readonly snapshotRefPrefix: string | null
  readonly baseline: WorkingTreeSnapshot | null
  /**
   * The project root: contract paths are relative to it. The git root, or the directory
   * the run started in outside git. Absent on workspaces built before it existed.
   */
  readonly root?: string | null
  readonly tracking?: TreeTracking
}

export const NO_RUN_WORKSPACE: RunWorkspace = { repoRoot: null, snapshotRefPrefix: null, baseline: null, root: null, tracking: 'none' }

/** The directory contract paths are relative to, or null when the run has none recorded. */
export function workspaceRoot(workspace: RunWorkspace): string | null {
  return workspace.root ?? workspace.repoRoot
}

export function workspaceTracking(workspace: RunWorkspace): TreeTracking {
  if (workspace.tracking) return workspace.tracking
  return workspace.repoRoot && workspace.baseline ? 'git' : 'none'
}

export type PacketStatus = 'pending' | 'running' | 'merging' | 'completed' | 'conflicted' | 'failed' | 'stopped'

export type PacketWorktreeConflict = { readonly path: string; readonly reason: string }

/** The git worktree a worktree packet's latest worker works in. */
export type PacketWorktree = {
  readonly path: string
  readonly branch?: string
  /** The main repository, which owns the worktree. */
  readonly gitRoot: string
  /** What the worktree's changes are measured from: the baseline, then each sync. */
  readonly base: string
  /** `open` until its changes are merged and the worktree removed. */
  readonly state: 'open' | 'merged'
  /** Merge attempts that ended in conflict or failed. */
  readonly failedAttempts: number
  /** The last attempt's conflicts. */
  readonly conflicts: readonly PacketWorktreeConflict[]
  /** Files the successful merge changed in the main tree. */
  readonly mergedFiles?: number
}

export type PacketRunState = {
  readonly name: string
  readonly status: PacketStatus
  /** Workers launched for this packet, oldest first. */
  readonly workerAgentIds: readonly string[]
  /** The contract version the latest worker was given. */
  readonly briefedVersion?: number
  /** Worktree packets only: the latest worker's worktree. */
  readonly worktree?: PacketWorktree
}

export type ContractVersion = {
  readonly version: number
  readonly publishedAt: number
  /** Why this version replaced the previous one. */
  readonly reason?: string
  readonly contract: OrchestrationContract
  readonly waves: readonly (readonly string[])[]
}

export type VerificationCheckStatus = 'passed' | 'failed' | 'missing' | 'not-run'

/** One verifier run's result, as RAYU checked it. */
export type VerificationRecord = {
  /** `v<n>`, unique within the run. */
  readonly id: string
  readonly agentId: string
  readonly at: number
  readonly contractVersion: number
  /** The working tree when the verifier finished. The result applies to that tree only. */
  readonly tree: string | null
  readonly verdict: 'PASS' | 'FAIL' | 'PARTIAL' | null
  /** A PASS backed by evidence for every required check, with nothing changed. Only this counts. */
  readonly accepted: boolean
  /**
   * The project itself failed the verification (a FAIL verdict, a failed required
   * check): the Orchestrator can repair that. Other rejections (the verifier did not
   * finish, its report had no verdict) are not repairs. Absent on older records, where
   * every rejection counts.
   */
  readonly failed?: boolean
  /** Things worth knowing that did not stop the PASS from being accepted. */
  readonly warnings?: readonly string[]
  readonly checks: readonly { readonly name: string; readonly command: string; readonly status: VerificationCheckStatus }[]
  /** Failures the verifier reported, and why a PASS was not accepted. */
  readonly findings: readonly string[]
  /** Project files that changed while the verifier ran. */
  readonly changedFiles: readonly string[]
}

/** Where the verification gate stands: the reasons it last acted on, and how often. */
export type GateState = {
  /** The reasons last acted on, joined. */
  readonly key: string
  readonly nudges: number
  readonly finalSent: boolean
}

export type OrchestrationRun = {
  /** `run-<n>`, unique within the session's audit directory. */
  readonly runId: string
  readonly status: 'active' | 'archived'
  readonly startedAt: number
  readonly archivedAt?: number
  /** Where this run's audit history is written; null when it could not be created. */
  readonly auditDir: string | null
  /** The repository and the baseline snapshot every change is measured against. */
  readonly workspace: RunWorkspace
  readonly current: ContractVersion
  readonly history: readonly Omit<ContractVersion, 'contract' | 'waves'>[]
  readonly packets: readonly PacketRunState[]
  /** Changes that did not fit the contract, open until fixed, resolved or accepted. */
  readonly problems: readonly OrchestrationProblem[]
  /** The last checkpoint: a snapshot taken when no packet was running. */
  readonly lastCheckpoint?: RunCheckpoint
  /** Verifier runs, oldest first. */
  readonly verifications?: readonly VerificationRecord[]
  /** The verification gate's last decision (gate.ts). */
  readonly gate?: GateState
}

export type RunCheckpoint = {
  readonly label: string
  readonly commit: string
  readonly at: number
  /** The finished workers it covered; a new checkpoint is due when this changes. */
  readonly key: string
}

/**
 * - `outside-packet`: a worker changed a file another packet owns.
 * - `unowned`: a worker changed a file no packet owns, or one outside the repository.
 * - `overlap`: workers of two packets running at the same time changed the same file.
 * - `untraced`: a file changed during the run that no worker's tools account for: the
 *   user, a background command, or commands of several workers at once.
 * - `interrupted`: a worker failed or was stopped after changing files.
 * - `merge-conflict`: a worktree packet's changes to the file could not be merged into
 *   the main tree, after the worker had its attempts to resolve them.
 * - `verifier-change`: a project file changed while the verifier ran, which must not
 *   change anything.
 */
export type ProblemKind =
  | 'outside-packet'
  | 'unowned'
  | 'overlap'
  | 'untraced'
  | 'interrupted'
  | 'merge-conflict'
  | 'verifier-change'

export type OrchestrationProblem = {
  /** `p<n>`, unique within the run. */
  readonly id: string
  readonly kind: ProblemKind
  /** Repository-relative, or absolute when outside the repository. */
  readonly path: string
  readonly packet: string | null
  readonly agentId: string | null
  /** The packets the contract says own the path. */
  readonly owners: readonly string[]
  /** For `overlap`: the other packets that changed the path. */
  readonly with?: readonly string[]
  readonly tool: string
  readonly at: number
  readonly status: 'open' | 'resolved' | 'accepted'
  readonly resolution?: string
  /** For `merge-conflict`: why the file could not be merged. */
  readonly detail?: string
  /** The change, saved in the audit directory, when it could be recorded. */
  readonly diffFile?: string
}

export type OrchestrationState = {
  /** The current run, or the last one once archived. */
  readonly run: OrchestrationRun | null
}

export const EMPTY_ORCHESTRATION_STATE: OrchestrationState = { run: null }

export function getActiveRun(state: { orchestration: OrchestrationState }): OrchestrationRun | null {
  const run = state.orchestration.run
  return run?.status === 'active' ? run : null
}

/**
 * Apply `update` to run `runId` if it is still the active run. Work that finishes later
 * (a merge, an audit write) must not touch a run that was archived or replaced meanwhile.
 */
export function updateActiveRun<S extends { orchestration: OrchestrationState }>(
  setAppState: (update: (prev: S) => S) => void,
  runId: string,
  update: (run: OrchestrationRun) => OrchestrationRun,
): void {
  setAppState(prev => {
    const run = prev.orchestration.run
    if (!run || run.runId !== runId || run.status !== 'active') return prev
    const next = update(run)
    return next === run ? prev : { ...prev, orchestration: { ...prev.orchestration, run: next } }
  })
}

export type PublishedContract = {
  readonly contract: OrchestrationContract
  readonly waves: readonly (readonly string[])[]
  readonly reason?: string
  readonly now: number
}

/** A new run whose first contract version is `published`. */
export function startRun(
  published: PublishedContract,
  ids: { runId: string; auditDir: string | null; workspace?: RunWorkspace },
): OrchestrationRun {
  const current = versionOf(1, published)
  return {
    runId: ids.runId,
    status: 'active',
    startedAt: published.now,
    auditDir: ids.auditDir,
    workspace: ids.workspace ?? NO_RUN_WORKSPACE,
    current,
    history: [summaryOf(current)],
    packets: published.contract.packets.map(packet => ({
      name: packet.name,
      status: 'pending',
      workerAgentIds: [],
    })),
    problems: [],
  }
}

/**
 * Why `contract` cannot replace the run's current one, or null when it can. A packet
 * that has started cannot be dropped: its worker's changes and history belong to it.
 */
export function amendmentProblem(run: OrchestrationRun, contract: OrchestrationContract): string | null {
  const kept = new Set(contract.packets.map(packet => packet.name))
  const dropped = run.packets.filter(packet => packet.status !== 'pending' && !kept.has(packet.name))
  if (dropped.length === 0) return null
  const names = dropped.map(packet => `"${packet.name}" (${packet.status})`).join(', ')
  return `The new contract drops ${names}, which already started. Keep those packets in the contract; change their objective or ownership instead.`
}

/** The run with `published` as its next contract version. Call amendmentProblem first. */
export function amendRun(run: OrchestrationRun, published: PublishedContract): OrchestrationRun {
  const current = versionOf(run.current.version + 1, published)
  const previous = new Map(run.packets.map(packet => [packet.name, packet]))
  return {
    ...run,
    current,
    history: [...run.history, summaryOf(current)],
    packets: published.contract.packets.map(
      packet => previous.get(packet.name) ?? { name: packet.name, status: 'pending', workerAgentIds: [] },
    ),
  }
}

/** The run with `problem` added, unless the same open problem is already recorded. */
export function withProblem(
  run: OrchestrationRun,
  problem: Omit<OrchestrationProblem, 'id' | 'status'>,
): { run: OrchestrationRun; added: OrchestrationProblem | null } {
  const problems = run.problems ?? []
  const duplicate = problems.find(
    item => item.status === 'open' && item.kind === problem.kind && item.path === problem.path && item.packet === problem.packet,
  )
  if (duplicate) return { run, added: null }
  const added: OrchestrationProblem = { ...problem, id: `p${problems.length + 1}`, status: 'open' }
  return { run: { ...run, problems: [...problems, added] }, added }
}

/** Problems still open, optionally for one packet. */
export function openProblems(run: OrchestrationRun, packet?: string): OrchestrationProblem[] {
  return (run.problems ?? []).filter(problem => problem.status === 'open' && (packet === undefined || problem.packet === packet))
}

export function archiveRun(run: OrchestrationRun, now: number): OrchestrationRun {
  return run.status === 'archived' ? run : { ...run, status: 'archived', archivedAt: now }
}

function versionOf(version: number, published: PublishedContract): ContractVersion {
  return {
    version,
    publishedAt: published.now,
    ...(published.reason?.trim() ? { reason: published.reason.trim() } : {}),
    contract: published.contract,
    waves: published.waves,
  }
}

function summaryOf(version: ContractVersion): Omit<ContractVersion, 'contract' | 'waves'> {
  return {
    version: version.version,
    publishedAt: version.publishedAt,
    ...(version.reason ? { reason: version.reason } : {}),
  }
}
