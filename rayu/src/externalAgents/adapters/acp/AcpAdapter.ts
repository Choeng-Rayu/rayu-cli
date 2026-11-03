/**
 * Adapter for any agent that speaks the Agent Client Protocol over stdio.
 *
 * Configured, not hardcoded
 * -------------------------
 * ACP is a protocol rather than a product, so this adapter is built from a
 * command (`createAcpAdapter({provider, command, args})`) instead of naming one
 * binary. Gemini CLI's ACP mode, a bespoke in-house agent and a community agent
 * are all the same code path. `registerAcpAgentsFromEnv` reads a declared list
 * so a user can plug one in without a RAYU release.
 *
 * Capabilities come from the handshake
 * -----------------------------------
 * Unlike the other three adapters, this one cannot state a fixed ceiling:
 * conforming ACP agents genuinely differ in whether they support
 * `session/load`, `session/list` and friends. `capabilitiesFromHandshake`
 * derives the PER-INSTANCE level from what the agent advertised in
 * `initialize`, which is precisely what per-instance capabilities are for.
 *
 * No steer, by protocol
 * --------------------
 * ACP has `session/prompt` and the `session/cancel` notification, but nothing
 * that injects into a turn already in flight. So `steer` is absent and
 * `messages` is capped at `'message'` — admission control then chooses `queue`
 * rather than attempting something the protocol cannot do.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { z } from 'zod/v4'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'
import { safeParseJSON } from '../../../utils/json.js'
import { whichSync } from '../../../utils/which.js'
import type {
  AgentAdapter,
  AgentHandle,
  AgentInput,
  DispatchResult,
  LaunchSpec,
  PermissionDecision,
} from '../../core/adapter.js'
import { emitEvent, emitEvents } from '../../core/normalizer.js'
import {
  asAgentSessionId,
  asProviderId,
  type AgentCapabilities,
  type AgentInstanceId,
  type AgentSessionId,
  type AgentStatusSnapshot,
  type ProviderId,
  type TaskRef,
} from '../../core/types.js'
import { buildChildEnv } from '../../transport/childEnv.js'
import {
  createJsonRpcPeer,
  type JsonRpcPeer,
} from '../../transport/jsonRpcStdio.js'
import {
  capabilitiesFromHandshake,
  describeAgentCapabilities,
  describePermissionRequest,
  normalizeAcpUpdate,
  selectPermissionOption,
  stopReasonToEvents,
} from './normalize.js'
import {
  ACP_INBOUND,
  ACP_METHOD,
  ACP_NOTIFY,
  ACP_PROTOCOL_VERSION,
  buildPromptParams,
  clientCapabilities,
  isSupportedProtocolVersion,
  type AcpAgentCapabilities,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPermissionOption,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpSessionUpdateParams,
} from './protocol.js'

export type AcpAgentConfig = {
  /** Provider id, e.g. `gemini-acp`. Must be unique in the registry. */
  readonly provider: string
  readonly displayName?: string
  /** Executable to spawn. Resolved to an absolute path before spawning. */
  readonly command: string
  readonly args?: readonly string[]
  /** Extra env for the child. Bypasses the allowlist by design. */
  readonly env?: Readonly<Record<string, string>>
  /** Env var names to forward from RAYU, subject to the secret blocklist. */
  readonly forwardEnv?: readonly string[]
}

type PendingApproval = {
  readonly options: readonly AcpPermissionOption[]
  readonly resolve: (value: unknown) => void
}

class AcpHandle implements AgentHandle {
  readonly agentId: AgentInstanceId
  readonly provider: ProviderId
  readonly capabilities: AgentCapabilities
  readonly durability = 'session-bound' as const
  readonly adoption = 'managed' as const
  readonly transport = { kind: 'stdio' as const }
  readonly pid?: number
  /** What the agent said it can do, surfaced by `/agent inspect`. */
  readonly advertised: readonly string[]

  #child: ChildProcess
  #peer: JsonRpcPeer
  #sessionId: AgentSessionId
  #snapshot: AgentStatusSnapshot
  #turnCounter = 0
  #pendingApprovals = new Map<string, PendingApproval>()
  #currentTaskRef?: TaskRef

  constructor(params: {
    agentId: AgentInstanceId
    provider: ProviderId
    child: ChildProcess
    peer: JsonRpcPeer
    sessionId: string
    agentCapabilities: AcpAgentCapabilities | undefined
  }) {
    this.agentId = params.agentId
    this.provider = params.provider
    this.#child = params.child
    this.#peer = params.peer
    this.#sessionId = asAgentSessionId(params.sessionId)
    this.pid = params.child.pid ?? undefined
    this.capabilities = capabilitiesFromHandshake(params.agentCapabilities)
    this.advertised = describeAgentCapabilities(params.agentCapabilities)
    this.#snapshot = {
      processState: 'running',
      connectionState: 'connected',
      agentState: 'idle',
    }
  }

  status(): AgentStatusSnapshot {
    return this.#snapshot
  }

  activeSessionId(): AgentSessionId | undefined {
    return this.#sessionId
  }

  /** Internal: react to an inbound notification or request. */
  handleUpdate(params: AcpSessionUpdateParams): void {
    // One agent process holds one session here, but the guard costs nothing and
    // an agent that multiplexes would otherwise cross-attribute output.
    if (params.sessionId && params.sessionId !== String(this.#sessionId)) return
    const payloads = normalizeAcpUpdate(params)
    if (payloads.length === 0) return
    emitEvents(this.#context(), payloads)
  }

  /**
   * The agent is asking for a human decision.
   *
   * The returned promise is left UNRESOLVED until `respondToPermission`
   * supplies an answer. Resolving early would silently approve or deny on the
   * user's behalf, which is the one thing a permission broker must never do.
   */
  handlePermissionRequest(
    params: AcpRequestPermissionParams,
  ): Promise<unknown> {
    const { description, kind } = describePermissionRequest(params)
    const requestId = `${params.toolCall?.toolCallId ?? 'perm'}_${++this.#turnCounter}`

    this.#patch({ agentState: 'waiting' })
    return new Promise<unknown>(resolve => {
      this.#pendingApprovals.set(requestId, {
        options: params.options ?? [],
        resolve,
      })
      emitEvent(this.#context(), {
        type: 'permission_requested',
        requestId,
        kind,
        description,
      })
    })
  }

  async send(input: AgentInput, taskRef?: TaskRef): Promise<DispatchResult> {
    const turnId = `turn_${++this.#turnCounter}`
    this.#currentTaskRef = taskRef
    this.#patch({
      agentState: 'working',
      activeTurn: { id: turnId, kind: 'regular' },
    })

    // `session/prompt` resolves only when the WHOLE turn ends, so it is not
    // awaited here — awaiting would block `send` for the entire turn while the
    // caller is already consuming the streamed events. The resolution is
    // handled asynchronously and turned into terminal events.
    void this.#peer
      .request<AcpPromptResult>(ACP_METHOD.prompt, {
        ...buildPromptParams(String(this.#sessionId), input.text),
      })
      .then(
        result => this.#finishTurn(turnId, taskRef, result?.stopReason),
        error => this.#failTurn(turnId, taskRef, errorMessage(error)),
      )

    return { turnId, sessionId: this.#sessionId }
  }

  /**
   * Cancel the in-flight turn.
   *
   * `session/cancel` is a NOTIFICATION, so there is nothing to await; the
   * confirmation arrives as the pending `session/prompt` resolving with
   * stopReason `cancelled`. The spec also requires the agent to answer any
   * outstanding permission requests with a cancelled outcome, so those are
   * settled locally too rather than left dangling.
   *
   * `interrupted` here is deliberately TRANSIENT. It marks "cancel requested,
   * not yet confirmed", and `#finishTurn` moves the agent to `idle` when the
   * cancelled stop reason arrives. That is the honest end state for ACP: the
   * cancel is in-band and the session survives, so the agent can take a new
   * prompt immediately — unlike Claude Code, where interrupting means SIGINT and
   * the agent genuinely needs relaunching before it can work again.
   */
  async interrupt(_turnId: string): Promise<void> {
    this.#peer.notify(ACP_NOTIFY.cancel, {
      sessionId: String(this.#sessionId),
    })
    this.#settlePendingApprovals('cancelled')
    this.#patch({ agentState: 'interrupted', activeTurn: undefined })
  }

  async respondToPermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const pending = this.#pendingApprovals.get(requestId)
    if (!pending) {
      throw new Error(
        `${this.agentId} has no pending permission request "${requestId}".`,
      )
    }

    const selection = selectPermissionOption(decision, pending.options)
    if (selection.kind === 'unavailable') {
      // Refuse rather than pick an arbitrary option: sending the wrong optionId
      // could approve exactly what the user declined. The request stays pending
      // so the user can answer it differently.
      throw new Error(
        `Cannot express "${decision}" to ${this.agentId}: ${selection.reason}.`,
      )
    }

    this.#pendingApprovals.delete(requestId)
    pending.resolve(
      selection.kind === 'cancelled'
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: selection.optionId } },
    )
    this.#patch({ agentState: 'working' })
  }

  async stop(): Promise<void> {
    this.#settlePendingApprovals('cancelled')
    this.#peer.close()
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill('SIGTERM')
    }
    this.#patch({
      processState: 'killed',
      connectionState: 'disconnected',
      agentState: 'stopped',
      activeTurn: undefined,
    })
  }

  /**
   * A session-bound agent cannot survive losing its stdio pipe, so detaching is
   * stopping. Pretending otherwise would leave an unreachable orphan that
   * recovery would then offer to reconnect to.
   */
  async detach(): Promise<void> {
    await this.stop()
  }

  #finishTurn(
    turnId: string,
    taskRef: TaskRef | undefined,
    stopReason: string | undefined,
  ): void {
    this.#settlePendingApprovals('cancelled')
    this.#patch({ agentState: 'idle', activeTurn: undefined })
    emitEvents(
      { ...this.#context(), taskRef, turnId },
      stopReasonToEvents(stopReason ?? ''),
    )
  }

  #failTurn(
    turnId: string,
    taskRef: TaskRef | undefined,
    message: string,
  ): void {
    this.#settlePendingApprovals('cancelled')
    this.#patch({ agentState: 'idle', activeTurn: undefined })
    emitEvents({ ...this.#context(), taskRef, turnId }, [
      { type: 'task_failed', message },
      { type: 'agent_idle' },
    ])
  }

  /**
   * Answer every outstanding approval so the agent is never left blocked.
   *
   * Always CANCELLED, never approved: teardown must not grant a permission the
   * user never saw.
   */
  #settlePendingApprovals(outcome: 'cancelled'): void {
    for (const [requestId, pending] of this.#pendingApprovals) {
      pending.resolve({ outcome: { outcome } })
      this.#pendingApprovals.delete(requestId)
    }
  }

  /** Internal: called when the transport closes for any reason. */
  noteDisconnected(reason: 'process_exit' | 'protocol_disconnect', exitCode?: number): void {
    this.#settlePendingApprovals('cancelled')
    this.#patch({
      processState: reason === 'process_exit' ? 'exited' : this.#snapshot.processState,
      connectionState: 'lost',
      activeTurn: undefined,
    })
    emitEvent(this.#context(), {
      type: 'agent_disconnected',
      reason,
      exitCode,
    })
  }

  #patch(patch: Partial<AgentStatusSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
  }

  #context() {
    return {
      agentId: this.agentId,
      sessionId: this.#sessionId,
      taskRef: this.#currentTaskRef,
    }
  }
}

/**
 * Resolve the executable to an ABSOLUTE path before spawning.
 *
 * Bun's `child_process.spawn` resolves a relative executable from its own
 * startup environ, ignoring both `process.env` mutations and the `env` option —
 * so a relative command can silently run a different binary than the one
 * `isAvailable()` probed.
 */
function resolveBinary(command: string): string {
  const resolved = whichSync(command)
  if (!resolved) {
    throw new Error(
      `"${command}" was not found on PATH, so this ACP agent cannot be started.`,
    )
  }
  return resolved
}

export function createAcpAdapter(config: AcpAgentConfig): AgentAdapter {
  const provider = asProviderId(config.provider)
  const displayName = config.displayName ?? config.provider

  return {
    provider,
    displayName,
    // The CEILING, not a promise: the real per-instance level is computed from
    // the handshake, and is often lower.
    capabilityCeiling: {
      terminal: 'none',
      messages: 'message',
      sessions: 'full',
      process: 'full',
      permissions: 'full',
    },

    async isAvailable() {
      return whichSync(config.command) !== null
    },

    async launch(spec: LaunchSpec): Promise<AgentHandle> {
      // Checked FIRST: a missing cwd makes Node report ENOENT on the
      // EXECUTABLE, which reads as "the agent is not installed".
      if (!existsSync(spec.cwd)) {
        throw new Error(
          `Working directory does not exist: ${spec.cwd}. ACP requires an absolute, existing cwd.`,
        )
      }

      const binary = resolveBinary(config.command)
      const child = spawn(binary, [...(config.args ?? [])], {
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildChildEnv({
          forward: config.forwardEnv ? [...config.forwardEnv] : [],
          set: { ...config.env, ...spec.env },
        }),
      })

      if (!child.stdin || !child.stdout) {
        child.kill('SIGKILL')
        throw new Error(`${displayName} did not provide a usable stdio pipe.`)
      }

      // stderr is the agent's diagnostics, not protocol. Logged, never parsed
      // as events — an agent's warning must not become task output.
      child.stderr?.on('data', (chunk: Buffer) => {
        logForDebugging(`[acp:${config.provider}] ${chunk.toString().trimEnd()}`)
      })

      let handle: AcpHandle | undefined

      const peer = createJsonRpcPeer({
        input: child.stdout,
        output: child.stdin,
        // ACP DOES include the envelope field, unlike Codex's app-server.
        includeJsonRpcVersion: true,
        label: `acp:${config.provider}`,
        onNotification: notification => {
          if (notification.method === ACP_INBOUND.sessionUpdate) {
            handle?.handleUpdate(
              (notification.params ?? {}) as AcpSessionUpdateParams,
            )
          }
        },
        onServerRequest: async request => {
          if (request.method === ACP_INBOUND.requestPermission) {
            if (!handle) {
              // Before the handshake completes there is nobody to ask, so
              // cancel rather than approve.
              return { outcome: { outcome: 'cancelled' } }
            }
            return handle.handlePermissionRequest(
              (request.params ?? {}) as AcpRequestPermissionParams,
            )
          }
          // fs/* and terminal/* are not advertised, so an agent calling them is
          // out of contract. Returning undefined lets the peer answer -32601,
          // which is the correct protocol-level reply.
          return undefined
        },
        onClose: () => {
          handle?.noteDisconnected('protocol_disconnect')
        },
      })

      child.on('exit', (code, signal) => {
        handle?.noteDisconnected('process_exit', code ?? undefined)
        logForDebugging(
          `[acp:${config.provider}] exited code=${code} signal=${signal}`,
        )
      })

      try {
        const init = await peer.request<AcpInitializeResult>(
          ACP_METHOD.initialize,
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: clientCapabilities(),
          },
        )

        // The spec is explicit: the client should DISCONNECT if it does not
        // support the version the agent answers with. Continuing would send
        // messages the agent may interpret differently.
        if (!isSupportedProtocolVersion(init?.protocolVersion)) {
          throw new Error(
            `${displayName} speaks ACP protocol version ${String(
              init?.protocolVersion,
            )}, but RAYU implements version ${ACP_PROTOCOL_VERSION}.`,
          )
        }

        if ((init.authMethods?.length ?? 0) > 0) {
          logForDebugging(
            `[acp:${config.provider}] advertises auth methods; RAYU does not run "authenticate" automatically`,
          )
        }

        const session = await peer.request<AcpNewSessionResult>(
          ACP_METHOD.newSession,
          {
            // Both required by the spec. `mcpServers` is sent EMPTY rather than
            // omitted: RAYU does not hand its own MCP servers to a third-party
            // agent, because that would give it RAYU's tool access.
            cwd: spec.cwd,
            mcpServers: [],
          },
        )
        if (!session?.sessionId) {
          throw new Error(
            `${displayName} did not return a sessionId from ${ACP_METHOD.newSession}.`,
          )
        }

        handle = new AcpHandle({
          agentId: spec.agentId,
          provider,
          child,
          peer,
          sessionId: session.sessionId,
          agentCapabilities: init.agentCapabilities,
        })

        emitEvent(
          { agentId: spec.agentId, sessionId: asAgentSessionId(session.sessionId) },
          {
            type: 'agent_started',
            provider,
            adoption: handle.adoption,
            capabilities: handle.capabilities,
          },
        )

        return handle
      } catch (error) {
        peer.close()
        child.kill('SIGKILL')
        throw error
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Declared agents
// ---------------------------------------------------------------------------

const acpConfigSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  forwardEnv: z.array(z.string()).optional(),
})

/** Env var holding a JSON array of `AcpAgentConfig`. */
export const ACP_AGENTS_ENV_VAR = 'RAYU_ACP_AGENTS'

/**
 * Read declared ACP agents from the environment.
 *
 * Each entry is validated individually and a malformed one is SKIPPED with a
 * log rather than failing the whole list — one bad entry must not cost the user
 * their other working agents. Returns `[]` when unset, which is the normal case.
 */
export function readDeclaredAcpAgents(
  raw = process.env[ACP_AGENTS_ENV_VAR],
): AcpAgentConfig[] {
  if (!raw || raw.trim() === '') return []
  const parsed = safeParseJSON(raw, false)
  if (!Array.isArray(parsed)) {
    logForDebugging(
      `[acp] ${ACP_AGENTS_ENV_VAR} must be a JSON array of agent definitions; ignoring it`,
      { level: 'warn' },
    )
    return []
  }

  const agents: AcpAgentConfig[] = []
  for (const [index, entry] of parsed.entries()) {
    const result = acpConfigSchema.safeParse(entry)
    if (!result.success) {
      logForDebugging(
        `[acp] ${ACP_AGENTS_ENV_VAR}[${index}] is not a valid agent definition; skipping it`,
        { level: 'warn' },
      )
      continue
    }
    agents.push(result.data)
  }
  return agents
}
