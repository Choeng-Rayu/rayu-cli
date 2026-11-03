/**
 * tmux sessions that host external agents' real terminal UIs.
 *
 * The point of this layer is that an agent's own TUI is far better than anything
 * RAYU could re-render: it has the agent's colours, its progress indicators, its
 * diff rendering, its keybindings. So instead of reimplementing that, RAYU runs
 * the agent inside a tmux session it owns and lets the user attach to it.
 *
 * ## Private socket, like the terminal panel
 *
 * Sessions live on a RAYU-private tmux socket (`-L rayu-agent-<session>`), the
 * same isolation `src/utils/terminalPanel.ts` uses for its shell. Three reasons
 * this matters:
 *
 *   - The user's own tmux sessions are untouched — RAYU never appears in their
 *     `tmux ls`, and killing RAYU's server cannot take down their work.
 *   - Two RAYU instances get different sockets (the socket name embeds the RAYU
 *     session id), so they cannot fight over session names.
 *   - `kill-server` on teardown is safe, because the only thing on that server is
 *     ours.
 *
 * ## Session naming
 *
 * An `AgentInstanceId` is `provider:slot`, and tmux treats `:` and `.` as target
 * syntax — `tmux attach -t codex:agent_01` would be parsed as window `agent_01`
 * of session `codex`. Names are therefore sanitized *and* suffixed with a short
 * hash of the original id, so they stay readable without two distinct agents ever
 * mapping to one session.
 */

import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { isTmuxAvailable } from '../../utils/swarm/backends/detection.js'
import { TMUX_COMMAND } from '../../utils/swarm/constants.js'
import type { AgentInstanceId } from '../core/types.js'

/**
 * Socket name for this RAYU instance's agent sessions.
 *
 * Mirrors `getTerminalPanelSocket()`: an 8-char slice of the session UUID keeps
 * the name short while making collisions between concurrent RAYU processes
 * effectively impossible.
 */
export function getAgentTmuxSocket(): string {
  return `rayu-agent-${getSessionId().slice(0, 8)}`
}

/**
 * tmux session name for an agent.
 *
 * Sanitizes everything tmux could misread, then appends a 6-hex-char digest of
 * the full instance id. The digest is what guarantees uniqueness: without it
 * `codex:agent.01` and `codex-agent-01` would both sanitize to the same name and
 * silently share one session.
 */
export function toTmuxSessionName(agentId: AgentInstanceId): string {
  const sanitized = agentId.replace(/[^A-Za-z0-9_-]/g, '-')
  const digest = createHash('sha256').update(agentId).digest('hex').slice(0, 6)
  return `${sanitized}-${digest}`
}

let cleanupRegistered = false

/**
 * Kill RAYU's tmux server when this process exits.
 *
 * Registered lazily on first session creation. Uses a **detached async** spawn
 * rather than `spawnSync`, following the note in `terminalPanel.ts`: a
 * synchronous spawn here would block the event loop and serialize the entire
 * `Promise.all` in graceful shutdown. The `error` handler swallows ENOENT for the
 * case where tmux disappears between session creation and teardown.
 */
function ensureServerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  const socket = getAgentTmuxSocket()
  registerCleanup(async () => {
    spawn(TMUX_COMMAND, ['-L', socket, 'kill-server'], {
      detached: true,
      stdio: 'ignore',
    })
      .on('error', () => {})
      .unref()
  })
}

/** Run a tmux command against RAYU's private socket, synchronously. */
function tmuxSync(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync(TMUX_COMMAND, ['-L', getAgentTmuxSocket(), ...args], {
    encoding: 'utf-8',
  })
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() }
}

/** Run a tmux command against RAYU's private socket, asynchronously. */
async function tmuxAsync(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const result = await execFileNoThrow(TMUX_COMMAND, [
    '-L',
    getAgentTmuxSocket(),
    ...args,
  ])
  return { ok: result.code === 0, stdout: (result.stdout ?? '').trim() }
}

/** True when tmux exists on this machine. Reuses the swarm's probe. */
export async function canHostAgentTerminals(): Promise<boolean> {
  return isTmuxAvailable()
}

/** True when a session for this agent already exists. */
export function hasAgentSession(agentId: AgentInstanceId): boolean {
  return tmuxSync(['has-session', '-t', toTmuxSessionName(agentId)]).ok
}

/** Every agent session on RAYU's socket, by tmux name. */
export async function listAgentSessions(): Promise<string[]> {
  const result = await tmuxAsync(['list-sessions', '-F', '#{session_name}'])
  // A socket with no server yet exits non-zero; that is "none", not an error.
  return result.ok && result.stdout ? result.stdout.split('\n') : []
}

export type CreateAgentSessionOptions = {
  readonly agentId: AgentInstanceId
  readonly cwd: string
  /**
   * Command to run inside the session. When omitted the session hosts a plain
   * login shell, which is what an adopted agent gets — RAYU has nothing to launch
   * for it, but a session still gives the user somewhere to attach.
   */
  readonly command?: string
}

/**
 * Create a detached session for an agent, if one does not already exist.
 *
 * Detached on purpose: creating it attached would seize the user's terminal the
 * moment an agent starts. Attaching is a separate, explicit action.
 *
 * @returns the tmux session name, or null when tmux is unusable.
 */
export function ensureAgentSession(
  options: CreateAgentSessionOptions,
): string | null {
  const name = toTmuxSessionName(options.agentId)
  if (hasAgentSession(options.agentId)) return name

  const args = ['new-session', '-d', '-s', name, '-c', options.cwd]
  if (options.command) {
    args.push(options.command)
  } else {
    args.push(process.env.SHELL || '/bin/bash', '-l')
  }

  const created = tmuxSync(args)
  if (!created.ok) {
    logForDebugging(
      `[agentTerminal] failed to create tmux session ${name} — tmux may be unavailable`,
    )
    return null
  }

  configureSession(name)
  ensureServerCleanup()
  logForDebugging(`[agentTerminal] created tmux session ${name}`)
  return name
}

/**
 * Bind the detach key and set a status hint.
 *
 * `Alt+J` matches the terminal panel's binding, so the muscle memory for "get
 * back to RAYU" is the same wherever the user is. `-n` binds without the prefix
 * key, which is what makes it a single keystroke.
 *
 * Chained with `;` into one invocation, as `terminalPanel.ts` does, to avoid five
 * separate process spawns on a latency-sensitive path.
 */
function configureSession(name: string): void {
  tmuxSync([
    'bind-key', '-n', 'M-j', 'detach-client', ';',
    'set-option', '-g', 'status-style', 'bg=default', ';',
    'set-option', '-g', 'status-left', '', ';',
    'set-option', '-g', 'status-right', ` ${name} — Alt+J returns to RAYU `, ';',
    'set-option', '-g', 'status-right-style', 'fg=brightblack',
  ])
}

/**
 * Type a command into an agent's session.
 *
 * `send-keys -l` sends the text literally (no key-name interpretation), then a
 * separate `Enter` submits it. Without `-l`, text containing words like `Enter`
 * or `C-c` would be reinterpreted as keys.
 */
export async function sendToAgentSession(
  agentId: AgentInstanceId,
  text: string,
  submit = true,
): Promise<boolean> {
  const name = toTmuxSessionName(agentId)
  const literal = await tmuxAsync(['send-keys', '-t', name, '-l', text])
  if (!literal.ok) return false
  if (!submit) return true
  return (await tmuxAsync(['send-keys', '-t', name, 'Enter'])).ok
}

/** Capture the visible contents of an agent's session, for a non-attach preview. */
export async function captureAgentPane(
  agentId: AgentInstanceId,
  lines = 200,
): Promise<string | null> {
  const result = await tmuxAsync([
    'capture-pane',
    '-p',
    '-t',
    toTmuxSessionName(agentId),
    '-S',
    `-${lines}`,
  ])
  return result.ok ? result.stdout : null
}

/** Kill an agent's session. Safe to call when it does not exist. */
export async function killAgentSession(
  agentId: AgentInstanceId,
): Promise<boolean> {
  return (await tmuxAsync(['kill-session', '-t', toTmuxSessionName(agentId)])).ok
}

/**
 * Command a *different* terminal would run to attach to this agent.
 *
 * Used when opening the agent in a split pane: that pane runs its own tmux client
 * against RAYU's private socket. Exposed as a string because the pane backends
 * take a shell command, not argv.
 */
export function buildAttachCommand(agentId: AgentInstanceId): string {
  return `${TMUX_COMMAND} -L ${getAgentTmuxSocket()} attach-session -t ${toTmuxSessionName(agentId)}`
}

/** argv for attaching in-place, used by the full-screen attach path. */
export function buildAttachArgs(agentId: AgentInstanceId): string[] {
  return [
    '-L',
    getAgentTmuxSocket(),
    'attach-session',
    '-t',
    toTmuxSessionName(agentId),
  ]
}
