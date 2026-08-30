/**
 * Per-agent record of which files each external agent has touched.
 *
 * What this is for
 * ----------------
 * The orchestrator can run several agents against one repository. RAYU does not
 * perform their writes, so it cannot serialise them — but it does see a
 * `file_changed` event for each one. Collecting those per agent gives three
 * things the user actually needs: "what did codex change?", "are two agents
 * fighting over the same file?", and a paper trail after a crash.
 *
 * What this is NOT
 * ----------------
 * This is detection, not enforcement. An external agent writes files in its own
 * process; by the time the event arrives the write has happened. Preventing
 * overlap requires giving each agent its own worktree (see `workspaceManager`),
 * which is why conflicts are reported rather than blocked.
 *
 * Relationship to `utils/pendingFileChanges.ts` — DO NOT MERGE THESE
 * -----------------------------------------------------------------
 * RAYU already has a file-change store, but it is a different thing: it backs
 * `/undo`, `/keep` and the review card, and to do that it records the full
 * before AND after CONTENT of every write, captured by the tool performing it.
 *
 * External agent writes cannot be recorded there. RAYU does not perform the
 * write and cannot know a file's prior content — it only learns a path changed,
 * after the fact. Feeding these events into `pendingFileChanges` would add
 * entries to the undo stack with a fabricated `before`, and `/undo` would then
 * either refuse ("file changed since Rayu edited it") or restore content that
 * was never there. So this module deliberately stores only metadata (path,
 * kind, timing, counts) and never claims a change is reversible.
 *
 * Memory shape
 * ------------
 * A long-running agent may rewrite one file hundreds of times, so per-file
 * history is collapsed to first-seen / last-seen / count. The number of
 * *distinct* paths is still unbounded, so it is capped per agent and the
 * overflow is counted rather than silently dropped — an agent that blew the cap
 * is exactly the one you want to know about.
 */

import { isAbsolute, relative, resolve } from 'path'
import type { AgentInstanceId, FileChangedEvent } from '../core/types.js'

/** Distinct paths retained per agent before overflow is merely counted. */
export const MAX_TRACKED_PATHS_PER_AGENT = 5000

export type FileChangeKind = FileChangedEvent['change']

export type AgentFileChange = {
  /** Absolute, normalized. Comparable across agents. */
  readonly path: string
  /** Relative to the agent's workspace root, for display. */
  readonly displayPath: string
  /** Most recent change kind reported for this path. */
  readonly change: FileChangeKind
  /** First kind reported, so create-then-modify stays legible. */
  readonly firstChange: FileChangeKind
  readonly firstSeenMs: number
  readonly lastSeenMs: number
  /** How many `file_changed` events landed on this path. */
  readonly count: number
  /** Whether any event carried a unified diff. */
  readonly hasDiff: boolean
}

export type AgentChangeSummary = {
  readonly agentId: AgentInstanceId
  readonly workspaceRoot: string
  readonly files: readonly AgentFileChange[]
  /** Distinct paths dropped because the per-agent cap was reached. */
  readonly overflowCount: number
}

export type ConflictParticipant = {
  readonly agentId: AgentInstanceId
  readonly change: FileChangeKind
  readonly lastSeenMs: number
}

export type FileConflict = {
  readonly path: string
  /** Ordered by most recent writer first — the likely clobberer. */
  readonly agents: readonly ConflictParticipant[]
}

type AgentEntry = {
  workspaceRoot: string
  readonly files: Map<string, AgentFileChange>
  overflowCount: number
}

const byAgent = new Map<AgentInstanceId, AgentEntry>()

/**
 * Resolve a reported path against the agent's workspace root.
 *
 * Providers are inconsistent: Codex reports absolute paths, OpenCode's
 * `file.edited` may report repo-relative ones. Normalizing to absolute is what
 * makes cross-agent comparison meaningful — and it is also why two agents in
 * separate worktrees never produce a false conflict, since their roots differ.
 */
export function resolveChangePath(
  reportedPath: string,
  workspaceRoot: string,
): string {
  return isAbsolute(reportedPath)
    ? resolve(reportedPath)
    : resolve(workspaceRoot, reportedPath)
}

function displayFor(absolutePath: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, absolutePath)
  // A path outside the workspace keeps its absolute form rather than a
  // confusing pile of `../` segments.
  return rel === '' || rel.startsWith('..') ? absolutePath : rel
}

/**
 * Record one `file_changed` event.
 *
 * `workspaceRoot` comes from the Workspace Manager, which knows where the agent
 * is actually running (its cwd, or its worktree when isolated).
 */
export function recordFileChange(
  event: FileChangedEvent,
  workspaceRoot: string,
): void {
  const entry = byAgent.get(event.agentId) ?? {
    workspaceRoot,
    files: new Map<string, AgentFileChange>(),
    overflowCount: 0,
  }
  // A relaunch into a fresh worktree changes the root; keep the newest.
  entry.workspaceRoot = workspaceRoot
  byAgent.set(event.agentId, entry)

  const path = resolveChangePath(event.path, workspaceRoot)
  const existing = entry.files.get(path)
  const atMs = event.at

  if (existing) {
    entry.files.set(path, {
      ...existing,
      change: event.change,
      lastSeenMs: Math.max(existing.lastSeenMs, atMs),
      count: existing.count + 1,
      hasDiff: existing.hasDiff || typeof event.diff === 'string',
    })
    return
  }

  if (entry.files.size >= MAX_TRACKED_PATHS_PER_AGENT) {
    entry.overflowCount++
    return
  }

  entry.files.set(path, {
    path,
    displayPath: displayFor(path, workspaceRoot),
    change: event.change,
    firstChange: event.change,
    firstSeenMs: atMs,
    lastSeenMs: atMs,
    count: 1,
    hasDiff: typeof event.diff === 'string',
  })
}

/** Files this agent has touched, most recently changed first. */
export function listChangedFiles(
  agentId: AgentInstanceId,
): readonly AgentFileChange[] {
  const entry = byAgent.get(agentId)
  if (!entry) return []
  return [...entry.files.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs)
}

export function getChangeSummary(
  agentId: AgentInstanceId,
): AgentChangeSummary | undefined {
  const entry = byAgent.get(agentId)
  if (!entry) return undefined
  return {
    agentId,
    workspaceRoot: entry.workspaceRoot,
    files: listChangedFiles(agentId),
    overflowCount: entry.overflowCount,
  }
}

export function listChangeSummaries(): readonly AgentChangeSummary[] {
  return [...byAgent.keys()]
    .map(agentId => getChangeSummary(agentId))
    .filter((summary): summary is AgentChangeSummary => summary !== undefined)
}

/**
 * Paths written by more than one agent.
 *
 * Overflowed paths are invisible to this check. That is a deliberate accuracy
 * limit rather than a guess: the alternative is unbounded memory. Callers that
 * see a non-zero `overflowCount` should say the report is partial.
 */
export function findConflicts(): readonly FileConflict[] {
  const owners = new Map<string, ConflictParticipant[]>()
  for (const [agentId, entry] of byAgent) {
    for (const file of entry.files.values()) {
      const list = owners.get(file.path)
      const participant: ConflictParticipant = {
        agentId,
        change: file.change,
        lastSeenMs: file.lastSeenMs,
      }
      if (list) {
        list.push(participant)
      } else {
        owners.set(file.path, [participant])
      }
    }
  }

  const conflicts: FileConflict[] = []
  for (const [path, agents] of owners) {
    if (agents.length < 2) continue
    conflicts.push({
      path,
      agents: [...agents].sort((a, b) => b.lastSeenMs - a.lastSeenMs),
    })
  }
  return conflicts.sort((a, b) => {
    const aLatest = a.agents[0]?.lastSeenMs ?? 0
    const bLatest = b.agents[0]?.lastSeenMs ?? 0
    return bLatest - aLatest
  })
}

/** Conflicts involving one agent, for a targeted warning at assignment time. */
export function findConflictsForAgent(
  agentId: AgentInstanceId,
): readonly FileConflict[] {
  return findConflicts().filter(conflict =>
    conflict.agents.some(participant => participant.agentId === agentId),
  )
}

/** True when any agent's path set was capped, making reports partial. */
export function hasPartialCoverage(): boolean {
  for (const entry of byAgent.values()) {
    if (entry.overflowCount > 0) return true
  }
  return false
}

/**
 * Forget an agent's changes.
 *
 * Called when a record is pruned, NOT when an agent stops — a stopped agent's
 * edits are still on disk and still the answer to "what changed?".
 */
export function clearAgentChanges(agentId: AgentInstanceId): void {
  byAgent.delete(agentId)
}

export function resetChangeTracker(): void {
  byAgent.clear()
}

/** Human-readable conflict report, shared by commands and non-interactive output. */
export function formatConflictReport(
  conflicts: readonly FileConflict[],
): string {
  if (conflicts.length === 0) return 'No overlapping file changes detected.'
  const lines: string[] = [
    `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} changed by more than one agent:`,
  ]
  for (const conflict of conflicts) {
    const who = conflict.agents
      .map(participant => `${participant.agentId} (${participant.change})`)
      .join(', ')
    lines.push(`  ${conflict.path}`)
    lines.push(`    ${who}`)
  }
  lines.push(
    'RAYU cannot serialise external agents\u2019 writes. To prevent overlap,',
  )
  lines.push('give each agent its own worktree when starting it.')
  return lines.join('\n')
}
