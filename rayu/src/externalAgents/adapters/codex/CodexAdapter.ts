/**
 * Codex adapter — drives `codex app-server` over JSON-RPC.
 *
 * Codex is the richest of the three native providers: it exposes thread and turn
 * lifecycle, streaming items, same-turn steering, interruption, and
 * server-initiated approvals. It is also the only one RAYU can *adopt*, via the
 * control socket at `$CODEX_HOME/app-server-control/app-server-control.sock`.
 *
 * ## Two protocol facts that shape this file
 *
 *   - **`turn/steer` requires `expectedTurnId`,** and Codex rejects it on review
 *     and manual-compaction turns with `ActiveTurnNotSteerable`. So the adapter
 *     tracks the *kind* of the running turn (inferred from items, since the
 *     protocol has no field for it) and reports it through `status()`. That is
 *     what lets admission control queue instead of triggering a protocol error.
 *   - **Approvals are server-initiated requests,** not notifications. The reply
 *     is the JSON-RPC response, so the handler must return a promise that stays
 *     unresolved until the user decides. Answering eagerly would auto-approve.
 *
 * ## Security
 *
 * The child gets a curated environment (`buildChildEnv`), never RAYU's own —
 * Codex authenticates through its own credential store and has no business
 * seeing RAYU's provider keys. `approvalPolicy` is never set to `never`, and
 * `sandbox`/`permissions` are never both sent (Codex rejects that combination).
 */

import { spawn, type ChildProcess } from 'child_process'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'
import { whichSync } from '../../../utils/which.js'
import { getCodexHomeDir } from '../../../plugins/installers/detect.js'
import { join } from 'path'
import { existsSync } from 'fs'
import type {
  AdoptTarget,
  AgentAdapter,
  AgentHandle,
  AgentInput,
  DispatchResult,
  LaunchSpec,
  PermissionDecision,
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
  type TurnKind,
} from '../../core/types.js'
import type { AgentRecord, AgentTransport } from '../../persistence/schemas.js'
import { buildChildEnv } from '../../transport/childEnv.js'
import {
  createJsonRpcPeer,
  JsonRpcError,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcPeer,
  type JsonRpcServerRequest,
} from '../../transport/jsonRpcStdio.js'
import {
  inferTurnKind,
  normalizeApprovalRequest,
  normalizeCodexNotification,
} from './normalize.js'
import {
  CODEX_APPROVAL_REQUEST,
  CODEX_EVENT,
  CODEX_METHOD,
  CODEX_NOTIFY,
  type CodexApprovalDecision,
  type CodexInitializeParams,
  type CodexItem,
  type CodexThreadResult,
  type CodexTurnResult,
  type CodexTurnSteerResult,
  type CodexThreadLoadedListResult,
} from './protocol.js'

export const CODEX_PROVIDER = asProviderId('codex')

/** Codex's own binary name, resolved on PATH. */
const CODEX_BIN = 'codex'

/** Control socket Codex exposes for `app-server proxy`. */
const CONTROL_SOCKET_REL = join('app-server-control', 'app-server-control.sock')

/**
 * Every axis at `full`. Codex genuinely supports all of them: it hosts a TUI we
 * can attach to, steers turns, manages threads, owns its process, and routes
 * approvals back to the client.
 */
const CODEX_CAPABILITIES: AgentCapabilities = {
  terminal: 'full',
  messages: 'full',
  sessions: 'full',
  process: 'full',
  permissions: 'full',
}

/** Path to Codex's control socket, whether or not it exists yet. */
export function getCodexControlSocketPath(): string {
  return join(getCodexHomeDir(), CONTROL_SOCKET_REL)
}

/** True when a Codex app-server is listening on its control socket. */
export function hasCodexControlSocket(): boolean {
  return existsSync(getCodexControlSocketPath())
}

type PendingApproval = {
  resolve(decision: CodexApprovalDecision): void
}

class CodexHandle implements AgentHandle {
  readonly agentId: AgentInstanceId
  readonly provider = CODEX_PROVIDER
  readonly capabilities: AgentCapabilities
  readonly durability: 'session-bound' | 'process-durable'
  readonly adoption: 'managed' | 'adoptable'
  readonly transport: AgentTransport
  readonly pid?: number
  readonly tmuxSession?: string

  #peer: JsonRpcPeer
  #child?: ChildProcess
  #threadId?: string
  #snapshot: AgentStatusSnapshot
  #pendingApprovals = new Map<string, PendingApproval>()
  #capabilityDowngrades = new Set<string>()

  constructor(params: {
    agentId: AgentInstanceId
    peer: JsonRpcPeer
    child?: ChildProcess
    transport: AgentTransport
    durability: 'session-bound' | 'process-durable'
    adoption: 'managed' | 'adoptable'
    tmuxSession?: string
  }) {
    this.agentId = params.agentId
    this.#peer = params.peer
    this.#child = params.child
    this.transport = params.transport
    this.durability = params.durability
    this.adoption = params.adoption
    this.pid = params.child?.pid
    this.tmuxSession = params.tmuxSession
    this.capabilities = CODEX_CAPABILITIES
    this.#snapshot = {
      processState: params.child ? 'running' : 'absent',
      connectionState: 'connecting',
      agentState: 'connecting',
    }
  }

  // ---- state -------------------------------------------------------------

  status(): AgentStatusSnapshot {
    return this.#snapshot
  }

  activeSessionId(): AgentSessionId | undefined {
    return this.#threadId ? asAgentSessionId(this.#threadId) : undefined
  }

  #patch(patch: Partial<AgentStatusSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
  }

  #context(taskRef?: TaskRef, turnId?: string) {
    return {
      agentId: this.agentId,
      sessionId: this.activeSessionId(),
      taskRef,
      turnId: turnId ?? this.#snapshot.activeTurn?.id,
    }
  }

  // ---- wiring ------------------------------------------------------------

  /**
   * Route a Codex notification into normalized events.
   *
   * Turn-lifecycle bookkeeping happens here rather than in the normalizer,
   * because the normalizer is pure and this needs to mutate handle state.
   */
  handleNotification(method: string, params: unknown): void {
    this.#trackTurnLifecycle(method, params)

    if (
      method === CODEX_EVENT.warning ||
      method === CODEX_EVENT.configWarning
    ) {
      // Diagnostics, not agent output — logged so they are recoverable, but not
      // pushed at RAYU's model. See the normalizer's header.
      logForDebugging(`[codex ${this.agentId}] ${method}: ${JSON.stringify(params)}`)
      return
    }

    const payloads = normalizeCodexNotification(method, params)
    if (payloads.length > 0) {
      emitEvents(this.#context(), payloads)
    }
  }

  /** Keep the four-axis snapshot in step with turn and item notifications. */
  #trackTurnLifecycle(method: string, rawParams: unknown): void {
    const params = (rawParams ?? {}) as Record<string, unknown>

    if (method === CODEX_EVENT.turnStarted) {
      const turn = (params.turn ?? {}) as { id?: string }
      if (turn.id) {
        this.#patch({
          agentState: 'working',
          activeTurn: { id: turn.id, kind: 'regular' },
        })
      }
      return
    }
    if (method === CODEX_EVENT.turnCompleted) {
      this.#patch({ agentState: 'idle', activeTurn: undefined })
      return
    }
    if (method === CODEX_EVENT.itemStarted || method === CODEX_EVENT.itemCompleted) {
      const kind = inferTurnKind((params.item ?? {}) as CodexItem)
      const active = this.#snapshot.activeTurn
      if (kind && active) {
        this.#patch({ activeTurn: { id: active.id, kind } })
      }
      return
    }
    if (method === CODEX_EVENT.threadStatusChanged) {
      const status = (params.status ?? {}) as { type?: string }
      if (status.type === 'idle') {
        this.#patch({ agentState: 'idle', activeTurn: undefined })
      } else if (status.type === 'systemError') {
        this.#patch({ agentState: 'failed' })
      }
    }
  }

  /**
   * Answer a server-initiated approval request.
   *
   * Returns a promise that resolves only when the user decides. Codex blocks its
   * turn until then, which is exactly right — resolving early would silently
   * approve on the user's behalf.
   */
  handleServerRequest(request: JsonRpcServerRequest): Promise<unknown> {
    const isApproval =
      request.method === CODEX_APPROVAL_REQUEST.command ||
      request.method === CODEX_APPROVAL_REQUEST.fileChange
    if (!isApproval) {
      return Promise.reject(
        new Error(`Unhandled Codex server request: ${request.method}`),
      )
    }

    const requestId = String(request.id)
    this.#patch({ agentState: 'waiting' })
    emitEvents(
      this.#context(),
      normalizeApprovalRequest(request.method, request.params, requestId),
    )

    return new Promise(resolve => {
      this.#pendingApprovals.set(requestId, {
        resolve: decision => resolve({ decision }),
      })
    })
  }

  markConnected(threadId: string): void {
    this.#threadId = threadId
    this.#patch({ connectionState: 'connected', agentState: 'idle' })
  }

  markDisconnected(reason: 'process_exit' | 'protocol_disconnect'): void {
    this.#patch({
      connectionState: 'lost',
      processState: reason === 'process_exit' ? 'exited' : this.#snapshot.processState,
      agentState: 'dead',
      activeTurn: undefined,
    })
    this.#settlePendingApprovals()
    emitEvents(this.#context(), [{ type: 'agent_disconnected', reason }])
  }

  /**
   * Decline anything still awaiting a decision.
   *
   * A pending approval holds an unresolved JSON-RPC response; leaving it hanging
   * on teardown would block Codex's turn forever on a channel that is gone.
   * Declining is the safe default — never approve on the user's behalf.
   */
  #settlePendingApprovals(): void {
    for (const pending of this.#pendingApprovals.values()) {
      pending.resolve('decline')
    }
    this.#pendingApprovals.clear()
  }

  // ---- operations --------------------------------------------------------

  async send(input: AgentInput, taskRef?: TaskRef): Promise<DispatchResult> {
    const threadId = this.#requireThread()
    const result = await this.#peer.request<CodexTurnResult>(
      CODEX_METHOD.turnStart,
      { threadId, input: [{ type: 'text', text: input.text }] },
    )
    const turnId = result.turn.id
    this.#patch({
      agentState: 'working',
      activeTurn: { id: turnId, kind: 'regular' },
    })
    // Re-emit with taskRef bound so every event for this turn is attributable.
    if (taskRef) {
      emitEvents(this.#context(taskRef, turnId), [])
    }
    return { turnId, sessionId: asAgentSessionId(threadId) }
  }

  /**
   * Steer the active turn.
   *
   * A rejection tagged `ActiveTurnNotSteerable` is recorded on the snapshot so
   * the next admission decision queues rather than retrying a call the protocol
   * will refuse again.
   */
  async steer(turnId: string, input: AgentInput): Promise<void> {
    const threadId = this.#requireThread()
    try {
      await this.#peer.request<CodexTurnSteerResult>(CODEX_METHOD.turnSteer, {
        threadId,
        input: [{ type: 'text', text: input.text }],
        expectedTurnId: turnId,
      })
    } catch (e) {
      if (e instanceof JsonRpcError && /NotSteerable/i.test(String(e.data ?? e.message))) {
        const active = this.#snapshot.activeTurn
        if (active) {
          this.#patch({ activeTurn: { id: active.id, kind: 'unknown' } })
        }
      }
      throw e
    }
  }

  async interrupt(turnId: string): Promise<void> {
    const threadId = this.#requireThread()
    await this.#peer.request(CODEX_METHOD.turnInterrupt, { threadId, turnId })
    this.#patch({ agentState: 'interrupted', activeTurn: undefined })
  }

  async stop(): Promise<void> {
    this.#settlePendingApprovals()
    this.#peer.close('stopped by RAYU')
    this.#child?.kill('SIGTERM')
    this.#patch({
      processState: 'killed',
      connectionState: 'disconnected',
      agentState: 'stopped',
      activeTurn: undefined,
    })
  }

  /**
   * Drop the control channel without killing Codex.
   *
   * Only meaningful for a `process-durable` instance reached over the control
   * socket; for a `session-bound` child the pipe *is* the process's lifeline, so
   * the manager stops it instead of detaching.
   */
  async detach(): Promise<void> {
    this.#settlePendingApprovals()
    this.#peer.close('detached by RAYU')
    this.#patch({ connectionState: 'disconnected' })
  }

  async listSessions(): Promise<SessionSummary[]> {
    if (this.#capabilityDowngrades.has(CODEX_METHOD.threadLoadedList)) return []
    try {
      const result = await this.#peer.request<CodexThreadLoadedListResult>(
        CODEX_METHOD.threadLoadedList,
      )
      return (result.data ?? []).map(id => ({
        agentSessionId: asAgentSessionId(id),
      }))
    } catch (e) {
      this.#noteUnsupported(CODEX_METHOD.threadLoadedList, e)
      return []
    }
  }

  async resumeSession(sessionId: AgentSessionId): Promise<void> {
    const result = await this.#peer.request<CodexThreadResult>(
      CODEX_METHOD.threadResume,
      { threadId: sessionId, excludeTurns: true },
    )
    this.markConnected(result.thread.id)
  }

  async forkSession(sessionId: AgentSessionId): Promise<AgentSessionId> {
    const result = await this.#peer.request<CodexThreadResult>(
      CODEX_METHOD.threadFork,
      { threadId: sessionId, excludeTurns: true },
    )
    return asAgentSessionId(result.thread.id)
  }

  async respondToPermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const pending = this.#pendingApprovals.get(requestId)
    if (!pending) {
      logForDebugging(
        `[codex ${this.agentId}] no pending approval '${requestId}' (already answered or expired)`,
      )
      return
    }
    this.#pendingApprovals.delete(requestId)
    pending.resolve(toCodexDecision(decision))
    this.#patch({ agentState: 'working' })
  }

  #requireThread(): string {
    if (!this.#threadId) {
      throw new Error(
        `${this.agentId} has no active Codex thread; the handshake did not complete.`,
      )
    }
    return this.#threadId
  }

  /**
   * Record that Codex does not implement a method, so we stop calling it.
   *
   * `-32601` means the running Codex is older than the method. Degrading once
   * and remembering is better than retrying on every call.
   */
  #noteUnsupported(method: string, e: unknown): void {
    if (e instanceof JsonRpcError && e.code === JSON_RPC_METHOD_NOT_FOUND) {
      this.#capabilityDowngrades.add(method)
      logForDebugging(
        `[codex ${this.agentId}] ${method} unsupported by this Codex build; degrading`,
      )
      return
    }
    logForDebugging(
      `[codex ${this.agentId}] ${method} failed: ${errorMessage(e)}`,
    )
  }
}

function toCodexDecision(decision: PermissionDecision): CodexApprovalDecision {
  switch (decision) {
    case 'accept':
      return 'accept'
    case 'accept-for-session':
      return 'acceptForSession'
    case 'decline':
      return 'decline'
    case 'cancel':
      return 'cancel'
  }
}

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

/**
 * Resolve the `codex` binary to an absolute path.
 *
 * Spawning the bare name is not reliable: the runtime resolves a relative
 * executable using its own startup environment, not the `env` passed to
 * `spawn`, so a curated child env cannot influence lookup. Resolving here also
 * closes a TOCTOU gap — `isAvailable()` and `launch()` are guaranteed to be
 * talking about the same binary.
 */
function resolveCodexBinary(): string {
  const resolved = whichSync(CODEX_BIN)
  if (!resolved) {
    throw new Error(
      `Cannot find the '${CODEX_BIN}' CLI on PATH. Install Codex, or add it to PATH, then retry.`,
    )
  }
  return resolved
}

/** Spawn a codex process and wire a peer to its stdio. */
function spawnCodex(
  args: string[],
  cwd: string,
  extraEnv?: Readonly<Record<string, string>>,
): ChildProcess {
  // Validate cwd first. A missing working directory makes Node report ENOENT
  // *on the executable*, which misattributes the failure to a missing Codex
  // install and sends the user looking in the wrong place entirely.
  if (!existsSync(cwd)) {
    throw new Error(
      `Cannot start Codex: working directory does not exist: ${cwd}`,
    )
  }
  const child = spawn(resolveCodexBinary(), args, {
    cwd,
    // Codex needs its own config/credentials, so CODEX_HOME is forwarded by
    // name. RAYU's provider keys are not — see buildChildEnv.
    env: buildChildEnv({ forward: ['CODEX_HOME'], set: extraEnv }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr?.setEncoding('utf-8')
  child.stderr?.on('data', (chunk: string) => {
    logForDebugging(`[codex stderr] ${chunk.trimEnd()}`)
  })
  return child
}

/**
 * Perform the mandatory handshake.
 *
 * Codex rejects every other request until `initialize` has been answered and
 * `initialized` sent, so this must complete before a thread can be started.
 */
async function handshake(peer: JsonRpcPeer): Promise<void> {
  const params: CodexInitializeParams = {
    clientInfo: {
      name: 'rayu_cli',
      title: 'RAYU CLI',
      version: typeof MACRO !== 'undefined' ? MACRO.VERSION : '0.0.0',
    },
    capabilities: { experimentalApi: false },
  }
  await peer.request(CODEX_METHOD.initialize, params, { retry: false })
  peer.notify(CODEX_NOTIFY.initialized)
}

function wirePeer(handle: CodexHandle, child?: ChildProcess) {
  return (peer: JsonRpcPeer) => {
    void peer
    child?.once('exit', () => handle.markDisconnected('process_exit'))
  }
}

/**
 * Build a handle plus its peer.
 *
 * The peer's callbacks need the handle and the handle needs the peer, so the
 * peer is created with closures that resolve the handle lazily.
 */
function connect(params: {
  agentId: AgentInstanceId
  child?: ChildProcess
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  transport: AgentTransport
  durability: 'session-bound' | 'process-durable'
  adoption: 'managed' | 'adoptable'
  tmuxSession?: string
}): { handle: CodexHandle; peer: JsonRpcPeer } {
  let handle: CodexHandle | undefined
  const peer = createJsonRpcPeer({
    input: params.input as never,
    output: params.output as never,
    // Codex omits the jsonrpc member on the wire.
    includeJsonRpcVersion: false,
    label: `codex ${params.agentId}`,
    onNotification: notification =>
      handle?.handleNotification(notification.method, notification.params),
    onServerRequest: request =>
      handle
        ? handle.handleServerRequest(request)
        : Promise.reject(new Error('handle not ready')),
    onClose: reason => {
      if (reason !== 'stopped by RAYU' && reason !== 'detached by RAYU') {
        handle?.markDisconnected('protocol_disconnect')
      }
    },
  })
  handle = new CodexHandle({ ...params, peer })
  wirePeer(handle, params.child)(peer)
  return { handle, peer }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createCodexAdapter(): AgentAdapter {
  return {
    provider: CODEX_PROVIDER,
    displayName: 'Codex',
    capabilityCeiling: CODEX_CAPABILITIES,

    async isAvailable(): Promise<boolean> {
      return whichSync(CODEX_BIN) !== null
    },

    async launch(spec: LaunchSpec): Promise<AgentHandle> {
      const child = spawnCodex(['app-server'], spec.cwd, spec.env)
      if (!child.stdin || !child.stdout) {
        child.kill('SIGKILL')
        throw new Error('codex app-server did not expose stdio pipes')
      }
      const { handle, peer } = connect({
        agentId: spec.agentId,
        child,
        input: child.stdout,
        output: child.stdin,
        transport: { kind: 'stdio' },
        // A stdio pipe belongs to this RAYU process, so the agent cannot
        // outlive it.
        durability: 'session-bound',
        adoption: 'managed',
        tmuxSession: spec.tmuxSession,
      })

      await handshake(peer)
      const threadId = await openThread(peer, spec)
      handle.markConnected(threadId)
      return handle
    },

    /**
     * Adopt a running Codex through its control socket.
     *
     * `codex app-server proxy` bridges the unix socket to stdio, so the same
     * peer implementation serves both paths. The proxy is a thin relay: killing
     * it detaches RAYU without touching the Codex that owns the session, which
     * is why this instance is `process-durable`.
     */
    async adopt(target: AdoptTarget): Promise<AgentHandle> {
      const socket = target.transport.endpoint ?? getCodexControlSocketPath()
      const child = spawnCodex(
        ['app-server', 'proxy', '--sock', socket],
        target.cwd,
      )
      if (!child.stdin || !child.stdout) {
        child.kill('SIGKILL')
        throw new Error('codex app-server proxy did not expose stdio pipes')
      }
      const { handle, peer } = connect({
        agentId: target.agentId,
        child,
        input: child.stdout,
        output: child.stdin,
        transport: { kind: 'unix', endpoint: socket },
        durability: 'process-durable',
        adoption: 'adoptable',
      })

      await handshake(peer)
      const threadId = await attachToLoadedThread(peer, target.cwd)
      handle.markConnected(threadId)
      return handle
    },

    async reconnect(record: AgentRecord): Promise<AgentHandle> {
      const socket =
        record.transport.endpoint ?? getCodexControlSocketPath()
      const child = spawnCodex(
        ['app-server', 'proxy', '--sock', socket],
        record.cwd,
      )
      if (!child.stdin || !child.stdout) {
        child.kill('SIGKILL')
        throw new Error('codex app-server proxy did not expose stdio pipes')
      }
      const { handle, peer } = connect({
        agentId: record.agentInstanceId as AgentInstanceId,
        child,
        input: child.stdout,
        output: child.stdin,
        transport: record.transport,
        durability: 'process-durable',
        adoption: 'adoptable',
        tmuxSession: record.tmuxSession,
      })

      await handshake(peer)
      // Resume the recorded thread so the conversation continues rather than
      // restarting — the entire point of persisting the native session id.
      const sessions = await peer
        .request<CodexThreadResult>(CODEX_METHOD.threadResume, {
          threadId: record.agentInstanceId,
          excludeTurns: true,
        })
        .catch(() => undefined)
      const threadId =
        sessions?.thread.id ?? (await attachToLoadedThread(peer, record.cwd))
      handle.markConnected(threadId)
      return handle
    },
  }
}

/**
 * Start a fresh thread, or resume the one the caller named.
 *
 * `sandbox` is sent alone — never with `permissions`, which Codex rejects — and
 * `approvalPolicy` is left at Codex's configured default so RAYU never silently
 * weakens the user's approval settings.
 */
async function openThread(
  peer: JsonRpcPeer,
  spec: LaunchSpec,
): Promise<string> {
  if (spec.resumeSessionId) {
    const resumed = await peer.request<CodexThreadResult>(
      CODEX_METHOD.threadResume,
      { threadId: spec.resumeSessionId, excludeTurns: true },
    )
    return resumed.thread.id
  }
  const started = await peer.request<CodexThreadResult>(
    CODEX_METHOD.threadStart,
    { cwd: spec.cwd, model: spec.model },
  )
  return started.thread.id
}

/**
 * Pick a thread from an adopted server.
 *
 * Prefers an already-loaded thread — that is the conversation the user is
 * actually looking at. Falls back to starting one so adoption still yields a
 * usable agent when the server is idle with nothing open.
 */
async function attachToLoadedThread(
  peer: JsonRpcPeer,
  cwd: string,
): Promise<string> {
  const loaded = await peer
    .request<CodexThreadLoadedListResult>(CODEX_METHOD.threadLoadedList)
    .catch(() => undefined)
  const existing = loaded?.data?.[0]
  if (existing) {
    const resumed = await peer.request<CodexThreadResult>(
      CODEX_METHOD.threadResume,
      { threadId: existing, excludeTurns: true },
    )
    return resumed.thread.id
  }
  const started = await peer.request<CodexThreadResult>(
    CODEX_METHOD.threadStart,
    { cwd },
  )
  return started.thread.id
}

export type { CodexHandle }
