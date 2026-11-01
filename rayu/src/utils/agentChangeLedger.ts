/**
 * A per-agent record of which files each agent touched, and where two agents touched
 * the same file.
 *
 * Extracted from the external-agents change tracker
 * (src/externalAgents/workspace/changeTracker.ts, now a wrapper over one ledger) so
 * Orchestrator mode can keep its own ledger per run without importing the
 * external-agents subsystem, which is feature-gated and must stay out of engine code.
 *
 * Metadata only: path, kind, timing, counts. It never stores content and never claims
 * a change can be undone; `utils/pendingFileChanges.ts` owns that, for writes RAYU
 * performs itself. A long-running agent may rewrite one file many times, so each path
 * collapses to first-seen / last-seen / count, and distinct paths are capped per agent
 * with the overflow counted rather than dropped silently.
 */
import { isAbsolute, relative, resolve } from 'path'

/** Distinct paths retained per agent before overflow is merely counted. */
export const DEFAULT_MAX_TRACKED_PATHS_PER_AGENT = 5000

export type AgentFileChangeKind = 'created' | 'modified' | 'deleted' | 'renamed'

/** One change as reported, before it is folded into the ledger. */
export type AgentChangeReport<AgentKey extends string = string> = {
  readonly agentId: AgentKey
  /** Absolute, or relative to `workspaceRoot`. */
  readonly path: string
  readonly change: AgentFileChangeKind
  readonly at: number
  readonly hasDiff?: boolean
}

export type AgentFileChange = {
  /** Absolute, normalized. Comparable across agents. */
  readonly path: string
  /** Relative to the agent's workspace root, for display. */
  readonly displayPath: string
  /** Most recent change kind reported for this path. */
  readonly change: AgentFileChangeKind
  /** First kind reported, so create-then-modify stays legible. */
  readonly firstChange: AgentFileChangeKind
  readonly firstSeenMs: number
  readonly lastSeenMs: number
  /** How many changes landed on this path. */
  readonly count: number
  /** Whether any change carried a unified diff. */
  readonly hasDiff: boolean
}

export type AgentChangeSummary<AgentKey extends string = string> = {
  readonly agentId: AgentKey
  readonly workspaceRoot: string
  readonly files: readonly AgentFileChange[]
  /** Distinct paths dropped because the per-agent cap was reached. */
  readonly overflowCount: number
}

export type ConflictParticipant<AgentKey extends string = string> = {
  readonly agentId: AgentKey
  readonly change: AgentFileChangeKind
  readonly lastSeenMs: number
}

export type FileConflict<AgentKey extends string = string> = {
  readonly path: string
  /** Ordered by most recent writer first — the likely clobberer. */
  readonly agents: readonly ConflictParticipant<AgentKey>[]
}

export type AgentChangeLedgerOptions = {
  maxPathsPerAgent?: number
  /**
   * Treat paths that differ only in letter case as one file, as the file systems of
   * Windows and macOS do by default. The first-seen spelling is kept for display.
   */
  caseInsensitivePaths?: boolean
}

export type AgentChangeLedger<AgentKey extends string = string> = {
  record: (report: AgentChangeReport<AgentKey>, workspaceRoot: string) => void
  /** Files this agent touched, most recently changed first. */
  listChangedFiles: (agentId: AgentKey) => readonly AgentFileChange[]
  getSummary: (agentId: AgentKey) => AgentChangeSummary<AgentKey> | undefined
  listSummaries: () => readonly AgentChangeSummary<AgentKey>[]
  /** Paths changed by more than one agent, most recent first. Overflowed paths are not seen. */
  findConflicts: () => readonly FileConflict<AgentKey>[]
  findConflictsForAgent: (agentId: AgentKey) => readonly FileConflict<AgentKey>[]
  /** True when any agent's path set was capped, making reports partial. */
  hasPartialCoverage: () => boolean
  clearAgent: (agentId: AgentKey) => void
  reset: () => void
}

type AgentEntry = {
  workspaceRoot: string
  /** Keyed by the comparison key (case-folded when configured). */
  readonly files: Map<string, AgentFileChange>
  overflowCount: number
}

/**
 * Resolve a reported path against the agent's workspace root. Agents report absolute
 * or workspace-relative paths; normalizing to absolute is what makes cross-agent
 * comparison meaningful, and why two agents in separate worktrees never conflict.
 */
export function resolveChangePath(reportedPath: string, workspaceRoot: string): string {
  return isAbsolute(reportedPath) ? resolve(reportedPath) : resolve(workspaceRoot, reportedPath)
}

function displayFor(absolutePath: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, absolutePath)
  // A path outside the workspace keeps its absolute form rather than `../` segments.
  return rel === '' || rel.startsWith('..') ? absolutePath : rel
}

function foldChange(existing: AgentFileChange, report: AgentChangeReport<string>): AgentFileChange {
  return {
    ...existing,
    change: report.change,
    lastSeenMs: Math.max(existing.lastSeenMs, report.at),
    count: existing.count + 1,
    hasDiff: existing.hasDiff || report.hasDiff === true,
  }
}

function firstChange(path: string, workspaceRoot: string, report: AgentChangeReport<string>): AgentFileChange {
  return {
    path,
    displayPath: displayFor(path, workspaceRoot),
    change: report.change,
    firstChange: report.change,
    firstSeenMs: report.at,
    lastSeenMs: report.at,
    count: 1,
    hasDiff: report.hasDiff === true,
  }
}

function newestFirst<T extends { lastSeenMs: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.lastSeenMs - a.lastSeenMs)
}

/** Group every agent's files by comparison key. */
function participantsByPath<AgentKey extends string>(
  byAgent: ReadonlyMap<AgentKey, AgentEntry>,
): Map<string, { path: string; agents: ConflictParticipant<AgentKey>[] }> {
  const owners = new Map<string, { path: string; agents: ConflictParticipant<AgentKey>[] }>()
  for (const [agentId, entry] of byAgent) {
    for (const [key, file] of entry.files) {
      const participant = { agentId, change: file.change, lastSeenMs: file.lastSeenMs }
      const group = owners.get(key)
      if (group) group.agents.push(participant)
      else owners.set(key, { path: file.path, agents: [participant] })
    }
  }
  return owners
}

export function createAgentChangeLedger<AgentKey extends string = string>(
  options: AgentChangeLedgerOptions = {},
): AgentChangeLedger<AgentKey> {
  const maxPaths = options.maxPathsPerAgent ?? DEFAULT_MAX_TRACKED_PATHS_PER_AGENT
  const keyOf = (path: string) => (options.caseInsensitivePaths ? path.toLowerCase() : path)
  const byAgent = new Map<AgentKey, AgentEntry>()

  const record = (report: AgentChangeReport<AgentKey>, workspaceRoot: string): void => {
    const entry = byAgent.get(report.agentId) ?? { workspaceRoot, files: new Map(), overflowCount: 0 }
    // A relaunch into a fresh worktree changes the root; keep the newest.
    entry.workspaceRoot = workspaceRoot
    byAgent.set(report.agentId, entry)
    const path = resolveChangePath(report.path, workspaceRoot)
    const key = keyOf(path)
    const existing = entry.files.get(key)
    if (existing) {
      entry.files.set(key, foldChange(existing, report))
    } else if (entry.files.size >= maxPaths) {
      entry.overflowCount++
    } else {
      entry.files.set(key, firstChange(path, workspaceRoot, report))
    }
  }

  const listChangedFiles = (agentId: AgentKey): readonly AgentFileChange[] =>
    newestFirst([...(byAgent.get(agentId)?.files.values() ?? [])])

  const getSummary = (agentId: AgentKey): AgentChangeSummary<AgentKey> | undefined => {
    const entry = byAgent.get(agentId)
    if (!entry) return undefined
    return { agentId, workspaceRoot: entry.workspaceRoot, files: listChangedFiles(agentId), overflowCount: entry.overflowCount }
  }

  const findConflicts = (): readonly FileConflict<AgentKey>[] =>
    [...participantsByPath(byAgent).values()]
      .filter(group => group.agents.length > 1)
      .map(group => ({ path: group.path, agents: newestFirst(group.agents) }))
      .sort((a, b) => (b.agents[0]?.lastSeenMs ?? 0) - (a.agents[0]?.lastSeenMs ?? 0))

  return {
    record,
    listChangedFiles,
    getSummary,
    listSummaries: () =>
      [...byAgent.keys()]
        .map(getSummary)
        .filter((summary): summary is AgentChangeSummary<AgentKey> => summary !== undefined),
    findConflicts,
    findConflictsForAgent: agentId =>
      findConflicts().filter(conflict => conflict.agents.some(p => p.agentId === agentId)),
    hasPartialCoverage: () => [...byAgent.values()].some(entry => entry.overflowCount > 0),
    clearAgent: agentId => {
      byAgent.delete(agentId)
    },
    reset: () => byAgent.clear(),
  }
}
