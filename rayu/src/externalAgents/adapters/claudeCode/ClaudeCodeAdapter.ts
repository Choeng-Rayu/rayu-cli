/**
 * Claude Code adapter — drives `claude -p` over bidirectional `stream-json`.
 *
 * ## What this adapter honestly cannot do
 *
 * Two capabilities are absent, and both are protocol facts rather than
 * unfinished work:
 *
 *   - **`adopt` is impossible.** Claude Code exposes no listener of any kind, so
 *     there is no way to attach to a `claude` session the user already has open.
 *     The method is therefore *omitted*, which makes `AgentManager` report
 *     `adopt: ✗` up front instead of failing at call time. `observe.ts` provides
 *     what is genuinely possible: reading the on-disk transcript.
 *   - **`steer` is impossible.** The CLI reference states that with
 *     `--input-format stream-json` a message sent mid-turn *stays queued and runs
 *     as its own turn*. Writing to stdin while working is safe but it is
 *     queueing, not steering. Omitting `steer` makes admission control choose
 *     `queue`, which is what actually happens.
 *
 * ## Interrupt is process-level, and says so
 *
 * There is no in-band cancel. `interrupt()` sends `SIGINT`, which may end the
 * process — so afterwards the agent is treated as needing relaunch, and the
 * recovery path resumes the *same* session via `--resume <session-id>`. That is
 * why capturing the real session id from the `system/init` envelope matters: it
 * is the only thing that makes an interrupted conversation continuable.
 *
 * ## Security
 *
 * `buildClaudeArgs` never emits `--dangerously-skip-permissions`. Permission
 * prompts are routed back to RAYU through `--permission-prompt-tool` when the
 * broker supplies one; otherwise Claude Code's own prompting stands. The child
 * gets a curated environment, with `CLAUDE_CONFIG_DIR` forwarded by name so it
 * finds its own credentials — and nothing of RAYU's.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import { whichSync } from '../../../utils/which.js'
import type {
  AgentAdapter,
  AgentHandle,
  AgentInput,
  DispatchResult,
  LaunchSpec,
  SessionSummary,
} from '../../core/adapter.js'
import { emitEvents } from '../../core/normalizer.js'
import {
  asAgentSessionId,
  asProviderId,
  type AgentCapabilities,
  type AgentInstanceId,
  type AgentSessionId,
  type AgentStatusSnapshot,
  type TaskRef,
} from '../../core/types.js'
import type { AgentTransport } from '../../persistence/schemas.js'
import { buildChildEnv } from '../../transport/childEnv.js'
import { createJsonLineReader, type JsonLineReader } from '../../transport/jsonLines.js'
import {
  extractSessionId,
  isTurnTerminal,
  normalizeClaudeEnvelope,
} from './normalize.js'
import {
  buildClaudeArgs,
  buildUserMessage,
  newClaudeSessionId,
} from './protocol.js'
import {
  findClaudeTranscriptsForCwd,
  looksRecentlyActive,
} from './observe.js'

export const CLAUDE_CODE_PROVIDER = asProviderId('claude-code')

const CLAUDE_BIN = 'claude'

/**
 * Capabilities, each level chosen against a documented protocol fact.
 *
 *   `messages: 'message'` — can send, cannot steer an in-flight turn.
 *   `terminal: 'observe'`  — the transcript is readable; the TUI is not drivable.
 *   `sessions: 'observe'`  — RAYU can *enumerate* sessions from disk, but cannot
 *                            switch one in place. `--resume` and `--fork-session`
 *                            are **launch** flags, so changing session means
 *                            relaunching via `LaunchSpec.resumeSessionId`. Claiming
 *                            'message' here would oblige a `resumeSession` method,
 *                            and one that always threw would be exactly the lying
 *                            stub `adapter.ts` warns against.
 *   `process: 'full'`      — RAYU owns the child, so interrupt and kill are ours.
 *   `permissions: 'full'`  — `--permission-prompt-tool` routes prompts to RAYU.
 */
const CLAUDE_CAPABILITIES: AgentCapabilities = {
  terminal: 'observe',
  messages: 'message',
  sessions: 'observe',
  process: 'full',
  permissions: 'full',
}

export type ClaudeCodeAdapterOptions = {
  /** MCP config exposing RAYU's tools to Claude Code. Supplied by Task 11. */
  readonly mcpConfigPath?: string
  /** MCP tool that answers permission prompts, e.g. `mcp__rayu__approve`. */
  readonly permissionPromptTool?: string
  readonly maxTurns?: number
  readonly maxBudgetUsd?: number
}

class ClaudeCodeHandle implements AgentHandle {
  readonly agentId: AgentInstanceId
  readonly provider = CLAUDE_CODE_PROVIDER
  readonly capabilities = CLAUDE_CAPABILITIES
  /** A stdio pipe belongs to this RAYU process, so the agent cannot outlive it. */
  readonly durability = 'session-bound' as const
  readonly adoption = 'managed' as const
  readonly transport: AgentTransport = { kind: 'stdio' }
  readonly pid?: number
  readonly tmuxSession?: string

  #child: ChildProcess
  #reader: JsonLineReader
  #cwd: string
  #sessionId?: string
  #snapshot: AgentStatusSnapshot
  #turnCounter = 0
  /** Turn currently open, if any. Claude Code has no turn ids, so RAYU mints them. */
  #openTurnId?: string
  #teardown = false

  constructor(params: {
    agentId: AgentInstanceId
    child: ChildProcess
    cwd: string
    /** Session id we requested, before Claude Code confirms it. */
    requestedSessionId?: string
    tmuxSession?: string
  }) {
    this.agentId = params.agentId
    this.#child = params.child
    this.#cwd = params.cwd
    this.pid = params.child.pid
    this.tmuxSession = params.tmuxSession
    this.#sessionId = params.requestedSessionId
    this.#snapshot = {
      processState: 'running',
      connectionState: 'connecting',
      agentState: 'connecting',
    }

    this.#reader = createJsonLineReader({
      input: params.child.stdout!,
      label: `claude ${params.agentId}`,
      onValue: value => this.#onEnvelope(value),
      onClose: () => {
        if (!this.#teardown) this.#markDisconnected('process_exit')
      },
    })

    params.child.once('exit', () => {
      if (!this.#teardown) this.#markDisconnected('process_exit')
    })
  }

  // ---- state -------------------------------------------------------------

  status(): AgentStatusSnapshot {
    return this.#snapshot
  }

  activeSessionId(): AgentSessionId | undefined {
    return this.#sessionId ? asAgentSessionId(this.#sessionId) : undefined
  }

  #patch(patch: Partial<AgentStatusSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
  }

  #context(taskRef?: TaskRef) {
    return {
      agentId: this.agentId,
      sessionId: this.activeSessionId(),
      taskRef,
      turnId: this.#openTurnId,
    }
  }

  /**
   * Process one output envelope.
   *
   * Session capture happens on every envelope, not just `system/init`: Claude
   * Code stamps `session_id` throughout, and on `--resume` the authoritative id
   * may differ from the one RAYU asked for.
   */
  #onEnvelope(value: unknown): void {
    const reported = extractSessionId(value)
    if (reported && reported !== this.#sessionId) {
      this.#sessionId = reported
    }
    if (this.#snapshot.connectionState !== 'connected') {
      this.#patch({ connectionState: 'connected', agentState: 'idle' })
    }

    const payloads = normalizeClaudeEnvelope(value)
    if (payloads.length > 0) {
      emitEvents(this.#context(), payloads)
    }

    if (isTurnTerminal(value)) {
      this.#openTurnId = undefined
      this.#patch({ agentState: 'idle', activeTurn: undefined })
    }
  }

  #markDisconnected(reason: 'process_exit' | 'protocol_disconnect'): void {
    this.#patch({
      processState: reason === 'process_exit' ? 'exited' : this.#snapshot.processState,
      connectionState: 'lost',
      agentState: 'dead',
      activeTurn: undefined,
    })
    this.#openTurnId = undefined
    emitEvents(this.#context(), [{ type: 'agent_disconnected', reason }])
  }

  // ---- operations --------------------------------------------------------

  /**
   * Write a user message to stdin.
   *
   * Safe at any time — Claude Code queues a message that arrives mid-turn and
   * runs it as its own turn. The returned `turnId` is minted by RAYU because the
   * protocol has none; it exists so events can be grouped and so `interrupt`
   * has something to name.
   */
  async send(input: AgentInput, taskRef?: TaskRef): Promise<DispatchResult> {
    if (!this.#child.stdin || this.#child.stdin.destroyed) {
      throw new Error(
        `${this.agentId} cannot receive input: its stdin is closed (process ${this.#snapshot.processState}).`,
      )
    }
    const turnId = `turn_${++this.#turnCounter}`
    this.#openTurnId = turnId
    this.#patch({
      agentState: 'working',
      activeTurn: { id: turnId, kind: 'regular' },
    })
    if (taskRef) {
      emitEvents(this.#context(taskRef), [])
    }
    this.#child.stdin.write(`${jsonStringify(buildUserMessage(input.text))}\n`)
    return {
      turnId,
      sessionId: this.activeSessionId() ?? asAgentSessionId('pending'),
    }
  }

  /**
   * Cancel the current turn with `SIGINT`.
   *
   * Process-level by necessity: `stream-json` has no cancel message. If the
   * child exits the agent becomes `dead`, admission returns `relaunch`, and
   * recovery resumes the same conversation with `--resume`. Marked `interrupted`
   * rather than `stopped` so that path is taken rather than treating it as a
   * clean shutdown.
   */
  async interrupt(_turnId: string): Promise<void> {
    this.#child.kill('SIGINT')
    this.#openTurnId = undefined
    this.#patch({ agentState: 'interrupted', activeTurn: undefined })
  }

  async stop(): Promise<void> {
    this.#teardown = true
    this.#reader.close('stopped by RAYU')
    this.#child.stdin?.end()
    this.#child.kill('SIGTERM')
    this.#patch({
      processState: 'killed',
      connectionState: 'disconnected',
      agentState: 'stopped',
      activeTurn: undefined,
    })
  }

  /**
   * Closing the pipe *is* stopping this agent.
   *
   * A session-bound child cannot survive losing its stdio, so detach delegates
   * to stop rather than pretending the agent stays reachable. `AgentManager`
   * only calls detach on `process-durable` agents, so this is a safety net.
   */
  async detach(): Promise<void> {
    await this.stop()
  }

  /**
   * Sessions RAYU could resume, read from Claude Code's own transcripts.
   *
   * Comes from disk rather than a protocol call because there is no method to
   * ask a running instance what sessions exist.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const transcripts = await findClaudeTranscriptsForCwd(this.#cwd)
    return transcripts.map(transcript => ({
      agentSessionId: asAgentSessionId(transcript.sessionId),
      title: looksRecentlyActive(transcript) ? 'recently active' : undefined,
      updatedAt: transcript.modifiedAt,
    }))
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Resolve `claude` to an absolute path.
 *
 * Spawning the bare name is unreliable — the runtime resolves relative
 * executables from its own startup environment, not from the `env` passed to
 * `spawn` — and resolving here guarantees `isAvailable()` and `launch()` refer to
 * the same binary.
 */
function resolveClaudeBinary(): string {
  const resolved = whichSync(CLAUDE_BIN)
  if (!resolved) {
    throw new Error(
      `Cannot find the '${CLAUDE_BIN}' CLI on PATH. Install Claude Code, or add it to PATH, then retry.`,
    )
  }
  return resolved
}

export function createClaudeCodeAdapter(
  options: ClaudeCodeAdapterOptions = {},
): AgentAdapter {
  return {
    provider: CLAUDE_CODE_PROVIDER,
    displayName: 'Claude Code',
    capabilityCeiling: CLAUDE_CAPABILITIES,

    async isAvailable(): Promise<boolean> {
      return whichSync(CLAUDE_BIN) !== null
    },

    async launch(spec: LaunchSpec): Promise<AgentHandle> {
      // Validate cwd first: a missing working directory makes Node report ENOENT
      // on the executable, which sends the user looking for a missing install.
      if (!existsSync(spec.cwd)) {
        throw new Error(
          `Cannot start Claude Code: working directory does not exist: ${spec.cwd}`,
        )
      }

      const sessionId = spec.resumeSessionId ? undefined : newClaudeSessionId()
      const args = buildClaudeArgs({
        sessionId,
        resumeSessionId: spec.resumeSessionId,
        model: spec.model,
        mcpConfigPath: options.mcpConfigPath,
        permissionPromptTool: options.permissionPromptTool,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
      })

      const child = spawn(resolveClaudeBinary(), args, {
        cwd: spec.cwd,
        // CLAUDE_CONFIG_DIR is forwarded by name so Claude Code finds its own
        // config and credentials. RAYU's provider keys are not forwarded.
        env: buildChildEnv({
          forward: ['CLAUDE_CONFIG_DIR'],
          set: spec.env,
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      if (!child.stdin || !child.stdout) {
        child.kill('SIGKILL')
        throw new Error('claude did not expose stdio pipes')
      }

      child.stderr?.setEncoding('utf-8')
      child.stderr?.on('data', (chunk: string) => {
        logForDebugging(`[claude stderr] ${chunk.trimEnd()}`)
      })
      child.once('error', e => {
        logForDebugging(
          `[claude ${spec.agentId}] spawn error: ${errorMessage(e)}`,
        )
      })

      return new ClaudeCodeHandle({
        agentId: spec.agentId,
        child,
        cwd: spec.cwd,
        requestedSessionId: sessionId ?? spec.resumeSessionId,
        tmuxSession: spec.tmuxSession,
      })
    },

    // No `adopt`: Claude Code exposes no listener, so attaching to a running
    // instance is impossible. No `reconnect`: a session-bound stdio child cannot
    // outlive the RAYU process that owns its pipe. Both omissions are how this
    // adapter tells AgentManager the truth — see the module header.
    //
    // Resuming or forking a conversation is done by calling `launch` again with
    // `resumeSessionId` set, because `--resume` / `--fork-session` are launch
    // flags. There is no in-place equivalent to expose.
  }
}

export type { ClaudeCodeHandle }
