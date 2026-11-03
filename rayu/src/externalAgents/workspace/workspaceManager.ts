/**
 * Decides *where* each external agent runs, and keeps that decision honest.
 *
 * Two isolation modes
 * -------------------
 * `shared`   — the agent runs in the directory the user named. This is the
 *              default because it is what the user usually means ("work on my
 *              repo"), and because a worktree is useless to an agent that was
 *              asked to inspect uncommitted state.
 * `worktree` — the agent gets its own git worktree via `createAgentWorktree`,
 *              so its writes cannot collide with another agent's. This is the
 *              ONLY real prevention mechanism RAYU has.
 *
 * Why leases are on the root, not on files
 * ----------------------------------------
 * `tryAcquireWriteLease` is advisory: RAYU does not perform an external agent's
 * writes, so it cannot block them. Leasing every changed file would add an fs
 * write per event and still only report after the fact. Leasing the workspace
 * ROOT is different — it is checked *before* an agent starts, it is cheap, and
 * it works across RAYU processes, so a second RAYU cannot hand the same
 * exclusive directory to another agent. Overlap inside one shared directory
 * remains detectable (via `changeTracker`) but not preventable, and the code
 * says so rather than implying a guarantee.
 */

import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import {
  createAgentWorktree,
  removeAgentWorktree,
} from '../../utils/worktree.js'
import type { AgentInstanceId } from '../core/types.js'
import {
  releaseAllLeasesForAgent,
  tryAcquireWriteLease,
} from '../persistence/workspaceLease.js'

export type WorkspaceIsolation = 'shared' | 'worktree'

export type AgentWorktree = {
  readonly path: string
  readonly branch?: string
  readonly gitRoot?: string
  /** Created by a user-configured WorktreeCreate hook rather than git. */
  readonly hookBased: boolean
}

export type AgentWorkspace = {
  readonly agentId: AgentInstanceId
  readonly isolation: WorkspaceIsolation
  /** Where the agent should actually be launched. */
  readonly cwd: string
  /** What the caller asked for, retained so reports can explain the mapping. */
  readonly requestedCwd: string
  readonly worktree?: AgentWorktree
  /** True when this agent holds the exclusive root lease. */
  readonly exclusive: boolean
  readonly preparedAtMs: number
}

export type PrepareWorkspaceRequest = {
  readonly agentId: AgentInstanceId
  readonly cwd: string
  readonly isolation?: WorkspaceIsolation
  /**
   * Take an exclusive lease on the resolved root. A second agent asking for the
   * same root is then refused with the holder's identity instead of quietly
   * sharing it.
   */
  readonly exclusive?: boolean
}

export type PrepareWorkspaceResult =
  | { readonly ok: true; readonly workspace: AgentWorkspace }
  /** Another agent holds the exclusive lease on this root. */
  | {
      readonly ok: false
      readonly reason: 'locked'
      readonly heldBy: AgentInstanceId
      readonly message: string
    }
  /** The requested directory does not exist, or the worktree could not be made. */
  | { readonly ok: false; readonly reason: 'unavailable'; readonly message: string }

const workspaces = new Map<AgentInstanceId, AgentWorkspace>()

/**
 * Worktree slug for an agent.
 *
 * `AgentInstanceId` is `provider:slot`, and a worktree slug segment only allows
 * `[A-Za-z0-9._-]`. Sanitizing alone would let `codex:agent.01` and
 * `codex-agent-01` share one worktree, so a 6-hex digest of the full id is
 * appended — the same reasoning as the tmux session names.
 */
export function worktreeSlugForAgent(agentId: AgentInstanceId): string {
  const sanitized = agentId.replace(/[^A-Za-z0-9._-]/g, '-')
  const digest = createHash('sha256').update(agentId).digest('hex').slice(0, 6)
  // Budget: 'rayu-agent-' (11) + sanitized + '-' + digest (6) <= 64.
  const room = 64 - 'rayu-agent-'.length - 1 - digest.length
  return `rayu-agent-${sanitized.slice(0, room)}-${digest}`
}

/**
 * Choose and prepare an agent's workspace.
 *
 * Never throws for an expected condition — a missing directory or a held lease
 * comes back as a reasoned result so the caller can surface it verbatim.
 */
export async function prepareWorkspace(
  request: PrepareWorkspaceRequest,
): Promise<PrepareWorkspaceResult> {
  const { agentId } = request
  const isolation = request.isolation ?? 'shared'
  const requestedCwd = resolve(request.cwd)

  // Checked before spawning anything: a missing cwd otherwise surfaces as
  // ENOENT on the *executable*, which reads as "agent not installed".
  if (!existsSync(requestedCwd)) {
    return {
      ok: false,
      reason: 'unavailable',
      message: `Working directory does not exist: ${requestedCwd}`,
    }
  }

  const existing = workspaces.get(agentId)
  if (existing) {
    // Re-preparing the same agent (relaunch, reconnect) reuses its workspace
    // instead of creating a second worktree for one logical agent.
    return { ok: true, workspace: existing }
  }

  let cwd = requestedCwd
  let worktree: AgentWorktree | undefined

  if (isolation === 'worktree') {
    try {
      // `createAgentWorktree` locates the repo via RAYU's own `getCwd()`, not an
      // argument. Without this override an agent asked to work in a DIFFERENT
      // repository would silently get a worktree of RAYU's repo instead — a
      // wrong answer that looks like a right one.
      const created = await runWithCwdOverride(requestedCwd, () =>
        createAgentWorktree(worktreeSlugForAgent(agentId)),
      )
      worktree = {
        path: created.worktreePath,
        branch: created.worktreeBranch,
        gitRoot: created.gitRoot,
        hookBased: created.hookBased === true,
      }
      cwd = created.worktreePath
    } catch (error) {
      // Deliberately NOT falling back to the shared directory. The caller asked
      // for isolation; silently running in the shared repo would hand back a
      // workspace that does not have the property they requested.
      return {
        ok: false,
        reason: 'unavailable',
        message: `Could not create an isolated worktree for ${agentId}: ${errorMessage(error)}`,
      }
    }
  }

  if (request.exclusive) {
    const lease = await tryAcquireWriteLease(cwd, agentId)
    if (!lease.acquired && lease.heldBy) {
      await rollbackWorktree(agentId, worktree)
      return {
        ok: false,
        reason: 'locked',
        heldBy: lease.heldBy.agentInstanceId as AgentInstanceId,
        message:
          `${cwd} is exclusively held by ${lease.heldBy.agentInstanceId}. ` +
          `Stop that agent, or start this one with worktree isolation.`,
      }
    }
    if (!lease.acquired) {
      // The lease directory itself was unusable. Proceeding unprotected is the
      // documented behaviour of tryAcquireWriteLease; say so rather than
      // pretending exclusivity was granted.
      logForDebugging(
        `[externalAgents] exclusive lease unavailable for ${agentId}: ${lease.error}`,
        { level: 'warn' },
      )
      const workspace: AgentWorkspace = {
        agentId,
        isolation,
        cwd,
        requestedCwd,
        worktree,
        exclusive: false,
        preparedAtMs: Date.now(),
      }
      workspaces.set(agentId, workspace)
      return { ok: true, workspace }
    }
  }

  const workspace: AgentWorkspace = {
    agentId,
    isolation,
    cwd,
    requestedCwd,
    worktree,
    exclusive: request.exclusive === true,
    preparedAtMs: Date.now(),
  }
  workspaces.set(agentId, workspace)
  return { ok: true, workspace }
}

/** Undo a worktree created moments before a later step failed. */
async function rollbackWorktree(
  agentId: AgentInstanceId,
  worktree: AgentWorktree | undefined,
): Promise<void> {
  if (!worktree) return
  try {
    await removeAgentWorktree(
      worktree.path,
      worktree.branch,
      worktree.gitRoot,
      worktree.hookBased,
    )
  } catch (error) {
    logForDebugging(
      `[externalAgents] could not roll back worktree for ${agentId}: ${errorMessage(error)}`,
      { level: 'warn' },
    )
  }
}

export function getWorkspace(
  agentId: AgentInstanceId,
): AgentWorkspace | undefined {
  return workspaces.get(agentId)
}

export function listWorkspaces(): readonly AgentWorkspace[] {
  return [...workspaces.values()]
}

/**
 * The root to attribute an agent's file changes to.
 *
 * Falls back to the process cwd for an agent RAYU never prepared (an adopted
 * instance discovered mid-flight), so change tracking still resolves relative
 * paths instead of dropping them.
 */
export function workspaceRootFor(
  agentId: AgentInstanceId,
  fallbackCwd: string,
): string {
  return workspaces.get(agentId)?.cwd ?? resolve(fallbackCwd)
}

export type ReleaseWorkspaceOptions = {
  /**
   * Remove the worktree directory. Defaults to FALSE: a stopped agent's work is
   * still on disk and deleting it is the one mistake that cannot be undone.
   * Callers must ask explicitly.
   */
  readonly removeWorktree?: boolean
}

export type ReleaseWorkspaceResult = {
  readonly releasedLeases: readonly string[]
  readonly worktreeRemoved: boolean
  /** Set when removal was requested but did not happen, with the reason. */
  readonly worktreeRetainedBecause?: string
}

/**
 * Release an agent's workspace.
 *
 * Leases always go (they are only meaningful while the agent runs). The
 * worktree is preserved unless removal is explicitly requested.
 */
export async function releaseWorkspace(
  agentId: AgentInstanceId,
  options: ReleaseWorkspaceOptions = {},
): Promise<ReleaseWorkspaceResult> {
  const workspace = workspaces.get(agentId)
  const releasedLeases = await releaseAllLeasesForAgent(agentId)
  workspaces.delete(agentId)

  if (!workspace?.worktree) {
    return { releasedLeases, worktreeRemoved: false }
  }
  if (!options.removeWorktree) {
    return {
      releasedLeases,
      worktreeRemoved: false,
      worktreeRetainedBecause: `worktree kept at ${workspace.worktree.path}; removal was not requested`,
    }
  }

  const removed = await removeAgentWorktree(
    workspace.worktree.path,
    workspace.worktree.branch,
    workspace.worktree.gitRoot,
    workspace.worktree.hookBased,
  ).catch(error => {
    logForDebugging(
      `[externalAgents] worktree removal failed for ${agentId}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    return false
  })

  return {
    releasedLeases,
    worktreeRemoved: removed,
    worktreeRetainedBecause: removed
      ? undefined
      : `git could not remove ${workspace.worktree.path}; it is still on disk`,
  }
}

/** Test/teardown helper. Does not touch git or the filesystem. */
export function resetWorkspaceManager(): void {
  workspaces.clear()
}

export function formatWorkspaceReport(
  spaces: readonly AgentWorkspace[],
): string {
  if (spaces.length === 0) return 'No external agent workspaces.'
  const lines: string[] = []
  for (const space of spaces) {
    const marks: string[] = [space.isolation]
    if (space.exclusive) marks.push('exclusive')
    if (space.worktree?.hookBased) marks.push('hook-based')
    lines.push(`${space.agentId}  [${marks.join(', ')}]`)
    lines.push(`  cwd: ${space.cwd}`)
    if (space.worktree) {
      lines.push(
        `  worktree: ${space.worktree.path}${
          space.worktree.branch ? ` (branch ${space.worktree.branch})` : ''
        }`,
      )
      if (space.cwd !== space.requestedCwd) {
        lines.push(`  isolated from: ${space.requestedCwd}`)
      }
    }
  }
  return lines.join('\n')
}
