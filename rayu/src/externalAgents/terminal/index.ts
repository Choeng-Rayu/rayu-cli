/**
 * Terminal Manager — the public surface for agent terminals.
 *
 * Three ways to see what an agent is doing, in descending fidelity:
 *
 *   1. **Attach** (`attachAgentTerminal`) — the agent's real TUI takes the whole
 *      screen; `Alt+J` returns to RAYU. Best fidelity, needs tmux.
 *   2. **Split pane** (`openAgentInPane`) — the agent's TUI beside RAYU, via the
 *      swarm's existing tmux/iTerm2 pane backends. Needs the user to already be
 *      in tmux or iTerm2.
 *   3. **Event view** — RAYU's normalized stream. Always available, and the only
 *      option on Windows. Not implemented here: it is what the event sinks
 *      already produce.
 *
 * `describeTerminalOptions` reports which of these are actually available so the
 * UI can offer them truthfully rather than presenting an option that will fail.
 */

import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getPlatform } from '../../utils/platform.js'
import type { AgentInstanceId } from '../core/types.js'
import {
  attachToAgentTerminal,
  describeAttachFallback,
  isAttachSupported,
  type AttachResult,
} from './attach.js'
import {
  buildAttachCommand,
  canHostAgentTerminals,
  captureAgentPane,
  ensureAgentSession,
  getAgentTmuxSocket,
  hasAgentSession,
  killAgentSession,
  listAgentSessions,
  sendToAgentSession,
  toTmuxSessionName,
} from './tmuxSession.js'

export type { AttachResult }
export {
  attachToAgentTerminal,
  buildAttachCommand,
  captureAgentPane,
  describeAttachFallback,
  ensureAgentSession,
  getAgentTmuxSocket,
  hasAgentSession,
  isAttachSupported,
  killAgentSession,
  listAgentSessions,
  sendToAgentSession,
  toTmuxSessionName,
}

export type TerminalOptions = {
  /** Full-screen attach is available. */
  readonly canAttach: boolean
  /** A side-by-side pane is available. */
  readonly canSplit: boolean
  /** Which pane backend would be used, when one is available. */
  readonly paneBackend?: 'tmux' | 'iterm2'
  /** Always true — the streamed view needs nothing. */
  readonly canStreamEvents: true
  /** Explanation when richer options are unavailable. */
  readonly note?: string
}

/**
 * What terminal surfaces this environment actually supports.
 *
 * Probes rather than assumes: the pane backends spawn subprocesses to detect
 * tmux/iTerm2, and a wrong guess would offer the user an action that fails.
 * A probe that throws counts as unavailable — `detectAndGetBackend` throws by
 * design when nothing is usable.
 */
export async function describeTerminalOptions(): Promise<TerminalOptions> {
  const canAttach = await isAttachSupported()
  let canSplit = false
  let paneBackend: 'tmux' | 'iterm2' | undefined

  if (getPlatform() !== 'windows') {
    try {
      const { detectAndGetBackend } = await import(
        '../../utils/swarm/backends/registry.js'
      )
      const detection = await detectAndGetBackend()
      // Only a *native* backend gives a usable side-by-side view: the fallback
      // creates an external session the user is not looking at, which would be a
      // pane they never see.
      if (detection.isNative && detection.backend.type !== 'in-process') {
        canSplit = true
        paneBackend = detection.backend.type as 'tmux' | 'iterm2'
      }
    } catch {
      // No pane backend available. Not an error — attach and the event view remain.
    }
  }

  return {
    canAttach,
    canSplit,
    paneBackend,
    canStreamEvents: true,
    note: canAttach ? undefined : describeAttachFallback(),
  }
}

/**
 * Provision an agent's terminal session.
 *
 * Returns null when tmux is unavailable, which is a normal outcome rather than a
 * failure — the agent still runs and its output still streams through the event
 * sinks; the user simply cannot attach. Callers pass the returned name as
 * `LaunchSpec.tmuxSession` so it is persisted on the agent record.
 */
export function provisionAgentTerminal(params: {
  agentId: AgentInstanceId
  cwd: string
  command?: string
}): string | null {
  return ensureAgentSession(params)
}

/** Hand the screen to an agent's TUI until the user detaches. */
export async function attachAgentTerminal(
  agentId: AgentInstanceId,
): Promise<AttachResult> {
  return attachToAgentTerminal(agentId)
}

export type SplitResult =
  | { readonly opened: true; readonly paneId: string; readonly backend: string }
  | { readonly opened: false; readonly reason: string }

/**
 * Open an agent's terminal in a pane beside RAYU.
 *
 * Reuses the swarm's `PaneBackend`, which already abstracts tmux and iTerm2 —
 * reimplementing pane creation for two backends would duplicate working,
 * platform-tested code.
 *
 * Two honest caveats, both surfaced rather than hidden:
 *
 *   - The pane runs its own tmux client against RAYU's private socket, so the
 *     user ends up with tmux nested inside tmux. That works, but the inner
 *     session's prefix key belongs to the inner server.
 *   - `createTeammatePaneInSwarmView` is the swarm's layout entry point and may
 *     arrange panes in a dedicated swarm-view window. That is a visible side
 *     effect on the user's layout, which is why this is an explicit action and
 *     never automatic.
 */
export async function openAgentInPane(
  agentId: AgentInstanceId,
  color: string = 'blue',
): Promise<SplitResult> {
  if (!hasAgentSession(agentId)) {
    return {
      opened: false,
      reason: `${agentId} has no terminal session to show.`,
    }
  }
  if (!(await canHostAgentTerminals())) {
    return { opened: false, reason: describeAttachFallback() }
  }

  try {
    const { detectAndGetBackend } = await import(
      '../../utils/swarm/backends/registry.js'
    )
    const detection = await detectAndGetBackend()
    if (!detection.isNative) {
      return {
        opened: false,
        reason:
          'A side-by-side pane needs RAYU to be running inside tmux or iTerm2. Use full-screen attach instead.',
      }
    }

    const { paneId } = await detection.backend.createTeammatePaneInSwarmView(
      toTmuxSessionName(agentId),
      color as never,
    )
    await detection.backend.sendCommandToPane(paneId, buildAttachCommand(agentId))
    logForDebugging(
      `[agentTerminal] opened ${agentId} in ${detection.backend.type} pane ${paneId}`,
    )
    return { opened: true, paneId, backend: detection.backend.type }
  } catch (e) {
    return {
      opened: false,
      reason: `Could not open a pane: ${errorMessage(e)}`,
    }
  }
}

/**
 * Terminals RAYU is currently hosting, as tmux session names.
 *
 * Names are the sanitized-plus-hashed form, not instance ids — callers that need
 * to correlate should map their known agent ids through `toTmuxSessionName`
 * rather than trying to reverse the hash.
 */
export async function listHostedTerminals(): Promise<string[]> {
  return listAgentSessions()
}

/** Tear down an agent's terminal. Safe when none exists. */
export async function releaseAgentTerminal(
  agentId: AgentInstanceId,
): Promise<boolean> {
  return killAgentSession(agentId)
}
