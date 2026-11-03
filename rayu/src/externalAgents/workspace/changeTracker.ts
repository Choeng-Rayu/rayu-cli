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
 * Implementation
 * --------------
 * The bookkeeping (path normalization, the per-agent cap, conflict detection)
 * lives in `utils/agentChangeLedger.ts`, which Orchestrator mode also uses for
 * its own workers. This module is the process-wide ledger for external agents
 * plus the event adapter and the report text.
 */

import {
  type AgentChangeSummary as LedgerSummary,
  type AgentFileChange as LedgerFileChange,
  type ConflictParticipant as LedgerParticipant,
  createAgentChangeLedger,
  DEFAULT_MAX_TRACKED_PATHS_PER_AGENT,
  type FileConflict as LedgerConflict,
} from '../../utils/agentChangeLedger.js'
import type { AgentInstanceId, FileChangedEvent } from '../core/types.js'

export { resolveChangePath } from '../../utils/agentChangeLedger.js'

/** Distinct paths retained per agent before overflow is merely counted. */
export const MAX_TRACKED_PATHS_PER_AGENT = DEFAULT_MAX_TRACKED_PATHS_PER_AGENT

export type FileChangeKind = FileChangedEvent['change']
export type AgentFileChange = LedgerFileChange
export type AgentChangeSummary = LedgerSummary<AgentInstanceId>
export type ConflictParticipant = LedgerParticipant<AgentInstanceId>
export type FileConflict = LedgerConflict<AgentInstanceId>

const ledger = createAgentChangeLedger<AgentInstanceId>({
  maxPathsPerAgent: MAX_TRACKED_PATHS_PER_AGENT,
})

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
  ledger.record(
    {
      agentId: event.agentId,
      path: event.path,
      change: event.change,
      at: event.at,
      hasDiff: typeof event.diff === 'string',
    },
    workspaceRoot,
  )
}

/** Files this agent has touched, most recently changed first. */
export function listChangedFiles(
  agentId: AgentInstanceId,
): readonly AgentFileChange[] {
  return ledger.listChangedFiles(agentId)
}

export function getChangeSummary(
  agentId: AgentInstanceId,
): AgentChangeSummary | undefined {
  return ledger.getSummary(agentId)
}

export function listChangeSummaries(): readonly AgentChangeSummary[] {
  return ledger.listSummaries()
}

/**
 * Paths written by more than one agent.
 *
 * Overflowed paths are invisible to this check. That is a deliberate accuracy
 * limit rather than a guess: the alternative is unbounded memory. Callers that
 * see a non-zero `overflowCount` should say the report is partial.
 */
export function findConflicts(): readonly FileConflict[] {
  return ledger.findConflicts()
}

/** Conflicts involving one agent, for a targeted warning at assignment time. */
export function findConflictsForAgent(
  agentId: AgentInstanceId,
): readonly FileConflict[] {
  return ledger.findConflictsForAgent(agentId)
}

/** True when any agent's path set was capped, making reports partial. */
export function hasPartialCoverage(): boolean {
  return ledger.hasPartialCoverage()
}

/**
 * Forget an agent's changes.
 *
 * Called when a record is pruned, NOT when an agent stops — a stopped agent's
 * edits are still on disk and still the answer to "what changed?".
 */
export function clearAgentChanges(agentId: AgentInstanceId): void {
  ledger.clearAgent(agentId)
}

export function resetChangeTracker(): void {
  ledger.reset()
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
