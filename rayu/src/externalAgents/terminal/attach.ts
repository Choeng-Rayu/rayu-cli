/**
 * Full-screen attach to an agent's terminal, and back again.
 *
 * This is the "watch Codex work live" experience: RAYU steps out of the way, the
 * agent's real TUI takes the whole terminal, and `Alt+J` brings RAYU back with
 * the agent still running.
 *
 * ## Why it reuses the terminal-panel sequence exactly
 *
 * Handing the terminal to a child process and taking it back is genuinely
 * delicate — raw mode, the alternate screen buffer, kitty keyboard protocol, and
 * Ink's frame state all have to be unwound and rewound in the right order.
 * `src/utils/terminalPanel.ts` and `src/utils/promptEditor.ts` already solved it:
 * `enterAlternateScreen()` internally pauses Ink and suspends stdin, and
 * `exitAlternateScreen()` undoes both and resets frame state so the next render
 * writes from scratch. Reproducing that by hand would drift; this module calls
 * the same two methods and puts the restore in a `finally`.
 *
 * ## Why the attach is synchronous
 *
 * `spawnSync` with `stdio: 'inherit'` hands the real TTY to the tmux client and
 * blocks until the user detaches. An async spawn would return immediately while
 * the child fought Ink for the terminal, producing interleaved output and a
 * terminal left in raw mode. This is the one place where blocking the event loop
 * is correct: nothing else should be drawing while another program owns the
 * screen.
 */

import { spawnSync } from 'child_process'
import instances from '../../ink/instances.js'
import { logForDebugging } from '../../utils/debug.js'
import { getPlatform } from '../../utils/platform.js'
import { TMUX_COMMAND } from '../../utils/swarm/constants.js'
import type { AgentInstanceId } from '../core/types.js'
import {
  buildAttachArgs,
  canHostAgentTerminals,
  hasAgentSession,
  toTmuxSessionName,
} from './tmuxSession.js'

/**
 * Outcome of an attach attempt.
 *
 * Never throws: every failure is a reportable condition the caller shows the
 * user, because "tmux is not installed" and "that agent has no terminal" are
 * normal situations, not exceptions.
 */
export type AttachResult =
  | { readonly attached: true; readonly sessionName: string }
  | {
      readonly attached: false
      readonly reason: string
      /** What the user can do instead. */
      readonly fallback: 'event-view' | 'install-tmux' | 'start-agent'
    }

/** True when this platform can host attachable agent terminals. */
export async function isAttachSupported(): Promise<boolean> {
  if (getPlatform() === 'windows') return false
  return canHostAgentTerminals()
}

/**
 * Why attach is unavailable, phrased for the user.
 *
 * Windows is a hard no rather than a soft failure: there is no tmux, so the
 * normalized event view is the only option and saying so up front is better than
 * a failed attempt.
 */
export function describeAttachFallback(): string {
  return getPlatform() === 'windows'
    ? 'Live terminal attach needs tmux, which is unavailable on Windows. RAYU will stream the agent\'s output into its own view instead.'
    : 'Live terminal attach needs tmux. Install tmux to watch agents in their own TUI, or use RAYU\'s streamed event view.'
}

/**
 * Hand the terminal to an agent's tmux session until the user detaches.
 *
 * Requires an interactive Ink instance: without one there is no TTY to hand over
 * and no renderer to restore, so the attempt is refused rather than attempted
 * blindly (which would corrupt output in a piped or `-p` session).
 */
export async function attachToAgentTerminal(
  agentId: AgentInstanceId,
): Promise<AttachResult> {
  if (getPlatform() === 'windows') {
    return {
      attached: false,
      reason: describeAttachFallback(),
      fallback: 'event-view',
    }
  }
  if (!(await canHostAgentTerminals())) {
    return {
      attached: false,
      reason: describeAttachFallback(),
      fallback: 'install-tmux',
    }
  }
  if (!hasAgentSession(agentId)) {
    return {
      attached: false,
      reason: `${agentId} has no terminal session. Only agents RAYU launched with a hosted terminal can be attached to.`,
      fallback: 'start-agent',
    }
  }

  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) {
    return {
      attached: false,
      reason:
        'No interactive terminal to hand over — attach is only available in an interactive RAYU session.',
      fallback: 'event-view',
    }
  }

  const sessionName = toTmuxSessionName(agentId)
  logForDebugging(`[agentTerminal] attaching to ${sessionName}`)

  inkInstance.enterAlternateScreen()
  try {
    // Blocks until the user detaches (Alt+J) or the session ends.
    spawnSync(TMUX_COMMAND, buildAttachArgs(agentId), { stdio: 'inherit' })
  } finally {
    // In `finally` so a tmux crash or a signal still restores RAYU's renderer —
    // otherwise the terminal would be left in raw mode with no visible prompt.
    inkInstance.exitAlternateScreen()
  }

  logForDebugging(`[agentTerminal] detached from ${sessionName}`)
  return { attached: true, sessionName }
}
