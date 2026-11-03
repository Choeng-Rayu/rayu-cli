/**
 * OpenCode adapter — drives the OpenCode server over HTTP + SSE.
 *
 * OpenCode is the only provider of the three where **adoption fully works**, and
 * the reason is architectural: the TUI is itself a client of a local HTTP server,
 * so RAYU can connect to a session the user already has open, stream its events,
 * and even type into the real TUI through `/tui/append-prompt` +
 * `/tui/submit-prompt`. That is what makes `terminal: 'full'` honest here where
 * Claude Code only manages `observe`.
 *
 * ## Two consequences of the HTTP model
 *
 *   - **`process-durable`.** The server outlives any single RAYU, so `detach()`
 *     genuinely leaves the agent running and `reconnect()` picks it back up.
 *     Compare Claude Code, where the stdio pipe *is* the agent's lifeline.
 *   - **`pid` may be absent.** When RAYU adopts a server it did not spawn there
 *     is no local pid, so `processState` is `'absent'` — a legitimate state, not
 *     an error, and the reason `classifyLiveness` returns `unknown` rather than
 *     guessing for these agents.
 *
 * ## Security
 *
 * The client refuses any non-loopback host (OpenCode's server is unauthenticated
 * by default) and never logs the basic-auth credential. Spawned servers bind
 * `127.0.0.1` explicitly rather than relying on the default.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'
import { whichSync } from '../../../utils/which.js'
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
  type AdoptionClass,
  type AgentCapabilities,
  type AgentInstanceId,
  type AgentSessionId,
  type AgentStatusSnapshot,
  type Durability,
  type TaskRef,
} from '../../core/types.js'
import type { AgentRecord, AgentTransport } from '../../persistence/schemas.js'
import { buildChildEnv } from '../../transport/childEnv.js'
import {
  createOpenCodeClient,
  discoverOpenCodeServer,
  type OpenCodeClient,
  OPENCODE_DEFAULT_PORT,
  probeOpenCodePort,
} from './httpClient.js'
import {
  createOpenCodeStreamState,
  extractSessionId,
  normalizeOpenCodeEvent,
  type OpenCodeStreamState,
} from './normalize.js'
import { createSseReader, type SseReader } from './sse.js'

export const OPENCODE_PROVIDER = asProviderId('opencode')

const OPENCODE_BIN = 'opencode'

/** How long to wait for a freshly spawned server to answer `/global/health`. */
const STARTUP_TIMEOUT_MS = 15_000
const STARTUP_POLL_MS = 250

/**
 * All five axes at `full`.
 *
 * `terminal: 'full'` is the notable one and it is earned: `/tui/append-prompt`
 * and `/tui/submit-prompt` let RAYU put text into the user's real TUI and submit
 * it. No other provider here can do that.
 */
const OPENCODE_CAPABILITIES: AgentCapabilities = {
  terminal: 'full',
  messages: 'full',
  sessions: 'full',
  process: 'full',
  permissions: 'full',
}

type OpenCodeSession = { id?: string; title?: string; time?: { updated?: number } }

class OpenCodeHandle implements AgentHandle {
  readonly agentId: AgentInstanceId
  readonly provider = OPENCODE_PROVIDER
  readonly capabilities = OPENCODE_CAPABILITIES
  /** The HTTP server outlives RAYU, which is what makes detach meaningful. */
  readonly durability: Durability = 'process-durable'
  readonly adoption: AdoptionClass
  readonly transport: AgentTransport
  readonly pid?: number
  readonly tmuxSession?: string

  #client: OpenCodeClient
  #child?: ChildProcess
  #stream?: SseReader
  #streamState: OpenCodeStreamState = createOpenCodeStreamState()
  #sessionId?: string
  #snapshot: AgentStatusSnapshot
  #turnCounter = 0
  #teardown = false

  constructor(params: {
    agentId: AgentInstanceId
    client: OpenCodeClient
    adoption: AdoptionClass
    child?: ChildProcess
    tmuxSession?: string
  }) {
    this.agentId = params.agentId
    this.#client = params.client
    this.#child = params.child
    this.adoption = params.adoption
    this.pid = params.child?.pid
    this.tmuxSession = params.tmuxSession
    this.transport = { kind: 'http', endpoint: params.client.origin }
    this.#snapshot = {
      // An adopted server RAYU did not spawn has no local pid — 'absent' is
      // correct and is what stops liveness checks from guessing.
      processState: params.child ? 'running' : 'absent',
      connectionState: 'connecting',
      agentState: 'connecting',
    }

    params.child?.once('exit', () => {
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
      turnId: this.#snapshot.activeTurn?.id,
    }
  }

  #markDisconnected(reason: 'process_exit' | 'protocol_disconnect'): void {
    this.#patch({
      processState: reason === 'process_exit' ? 'exited' : this.#snapshot.processState,
      connectionState: 'lost',
      agentState: 'dead',
      activeTurn: undefined,
    })
    emitEvents(this.#context(), [{ type: 'agent_disconnected', reason }])
  }

  // ---- event stream ------------------------------------------------------

  /**
   * Subscribe to `/event`.
   *
   * Filtered to this handle's session: one OpenCode server can host many
   * sessions, and forwarding another session's output would attribute a
   * different conversation's work to this agent's task. Events with no session id
   * (server-level notices) are passed through.
   */
  async attachStream(): Promise<void> {
    const response = await this.#client.stream('/event')
    this.#stream = createSseReader({
      body: response.body!,
      label: `opencode ${this.agentId}`,
      onValue: value => this.#onEvent(value),
      onClose: reason => {
        if (!this.#teardown) {
          logForDebugging(`[opencode ${this.agentId}] event stream closed: ${reason}`)
          this.#markDisconnected('protocol_disconnect')
        }
      },
    })
    this.#patch({ connectionState: 'connected', agentState: 'idle' })
  }

  #onEvent(value: unknown): void {
    const eventSession = extractSessionId(value)
    if (eventSession && this.#sessionId && eventSession !== this.#sessionId) {
      return
    }
    const payloads = normalizeOpenCodeEvent(value, this.#streamState)
    if (payloads.length === 0) return

    // A terminal event ends the turn; reflect that before publishing so the
    // AgentManager queue drain sees an idle agent.
    if (payloads.some(p => p.type === 'agent_idle')) {
      this.#patch({ agentState: 'idle', activeTurn: undefined })
    }
    if (payloads.some(p => p.type === 'permission_requested')) {
      this.#patch({ agentState: 'waiting' })
    }
    emitEvents(this.#context(), payloads)
  }

  setSession(sessionId: string): void {
    this.#sessionId = sessionId
    // A new session invalidates snapshot bookkeeping from the previous one.
    this.#streamState.reset()
  }

  // ---- operations --------------------------------------------------------

  /**
   * Send a prompt with `prompt_async`.
   *
   * Chosen over `POST /session/:id/message`, which blocks until the whole
   * response is ready: RAYU streams progress from `/event`, so a blocking call
   * would hold a request open for the length of a turn and deliver nothing extra.
   */
  async send(input: AgentInput, taskRef?: TaskRef): Promise<DispatchResult> {
    const sessionId = this.#requireSession()
    const turnId = `turn_${++this.#turnCounter}`
    this.#patch({
      agentState: 'working',
      activeTurn: { id: turnId, kind: 'regular' },
    })
    if (taskRef) {
      emitEvents(this.#context(taskRef), [])
    }
    await this.#client.post(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      parts: [{ type: 'text', text: input.text }],
    })
    return { turnId, sessionId: asAgentSessionId(sessionId) }
  }

  /**
   * Add to the running turn by submitting another prompt.
   *
   * OpenCode accepts a prompt while a session is busy and folds it into the work
   * in progress, which is genuine steering rather than queueing — unlike Claude
   * Code, where a mid-turn message becomes its own turn.
   */
  async steer(_turnId: string, input: AgentInput): Promise<void> {
    const sessionId = this.#requireSession()
    await this.#client.post(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      parts: [{ type: 'text', text: input.text }],
    })
  }

  async interrupt(_turnId: string): Promise<void> {
    const sessionId = this.#requireSession()
    await this.#client.post(`/session/${encodeURIComponent(sessionId)}/abort`)
    this.#patch({ agentState: 'interrupted', activeTurn: undefined })
  }

  /**
   * Stop the agent.
   *
   * Only kills a process RAYU spawned. For an adopted server, "stop" means
   * disconnect — terminating a server RAYU does not own would close the TUI the
   * user is sitting in front of.
   */
  async stop(): Promise<void> {
    this.#teardown = true
    this.#stream?.close('stopped by RAYU')
    if (this.#child) {
      this.#child.kill('SIGTERM')
      this.#patch({
        processState: 'killed',
        connectionState: 'disconnected',
        agentState: 'stopped',
        activeTurn: undefined,
      })
      return
    }
    logForDebugging(
      `[opencode ${this.agentId}] adopted server left running; RAYU only disconnected`,
    )
    this.#patch({
      connectionState: 'disconnected',
      agentState: 'stopped',
      activeTurn: undefined,
    })
  }

  /** Drop the event stream, leaving the server running and reconnectable. */
  async detach(): Promise<void> {
    this.#teardown = true
    this.#stream?.close('detached by RAYU')
    this.#patch({ connectionState: 'disconnected' })
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = await this.#client.get<OpenCodeSession[]>('/session')
    return (sessions ?? [])
      .filter(session => typeof session.id === 'string')
      .map(session => ({
        agentSessionId: asAgentSessionId(session.id!),
        title: session.title,
        updatedAt: session.time?.updated,
      }))
  }

  /** Switch to another session on the same server. */
  async resumeSession(sessionId: AgentSessionId): Promise<void> {
    await this.#client.get(`/session/${encodeURIComponent(sessionId)}`)
    this.setSession(sessionId)
    this.#patch({ agentState: 'idle', activeTurn: undefined })
  }

  async forkSession(sessionId: AgentSessionId): Promise<AgentSessionId> {
    const forked = await this.#client.post<OpenCodeSession>(
      `/session/${encodeURIComponent(sessionId)}/fork`,
      {},
    )
    if (!forked?.id) {
      throw new Error(`OpenCode fork of ${sessionId} returned no session id`)
    }
    return asAgentSessionId(forked.id)
  }

  async respondToPermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const sessionId = this.#requireSession()
    await this.#client.post(
      `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`,
      { response: toOpenCodeDecision(decision) },
    )
    this.#patch({ agentState: 'working' })
  }

  /**
   * Type into the user's real TUI.
   *
   * This is what `terminal: 'full'` means for OpenCode: `append-prompt` puts text
   * in the visible composer and `submit-prompt` presses enter. `submit=false`
   * leaves it staged so the user can review before sending, which is the polite
   * default for anything RAYU's model composed on its own.
   */
  async driveTerminal(text: string, submit: boolean): Promise<void> {
    await this.#client.post('/tui/append-prompt', { text })
    if (submit) {
      await this.#client.post('/tui/submit-prompt')
    }
  }

  #requireSession(): string {
    if (!this.#sessionId) {
      throw new Error(
        `${this.agentId} has no active OpenCode session; connection did not complete.`,
      )
    }
    return this.#sessionId
  }
}

function toOpenCodeDecision(decision: PermissionDecision): string {
  switch (decision) {
    case 'accept':
      return 'once'
    case 'accept-for-session':
      return 'always'
    case 'decline':
    case 'cancel':
      return 'reject'
  }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

/**
 * Resolve `opencode` to an absolute path.
 *
 * The runtime resolves a relative executable from its own startup environment
 * rather than the `env` passed to `spawn`, so a bare name is unreliable, and
 * resolving here guarantees `isAvailable()` and `launch()` mean the same binary.
 */
function resolveOpenCodeBinary(): string {
  const resolved = whichSync(OPENCODE_BIN)
  if (!resolved) {
    throw new Error(
      `Cannot find the '${OPENCODE_BIN}' CLI on PATH. Install OpenCode, or add it to PATH, then retry.`,
    )
  }
  return resolved
}

/** Wait for a spawned server to start answering health checks. */
async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probeOpenCodePort(port)) return
    await new Promise(resolve => setTimeout(resolve, STARTUP_POLL_MS))
  }
  throw new Error(
    `OpenCode server did not become healthy on 127.0.0.1:${port} within ${STARTUP_TIMEOUT_MS}ms.`,
  )
}

/**
 * Pick a port for a server RAYU spawns.
 *
 * Always explicit. Letting OpenCode choose a random port would leave RAYU unable
 * to reconnect after a restart, which would silently downgrade a `process-durable`
 * agent to a single-session one.
 */
function choosePort(spec: LaunchSpec): number {
  const requested = Number.parseInt(spec.env?.OPENCODE_PORT ?? '', 10)
  if (Number.isInteger(requested) && requested > 0) return requested
  return OPENCODE_DEFAULT_PORT
}

export function createOpenCodeAdapter(): AgentAdapter {
  return {
    provider: OPENCODE_PROVIDER,
    displayName: 'OpenCode',
    capabilityCeiling: OPENCODE_CAPABILITIES,

    async isAvailable(): Promise<boolean> {
      // Available if the CLI exists *or* a server is already reachable — an
      // adoptable server is usable even when the binary is not on RAYU's PATH.
      if (whichSync(OPENCODE_BIN) !== null) return true
      return (await discoverOpenCodeServer()) !== null
    },

    async launch(spec: LaunchSpec): Promise<AgentHandle> {
      if (!existsSync(spec.cwd)) {
        throw new Error(
          `Cannot start OpenCode: working directory does not exist: ${spec.cwd}`,
        )
      }
      const port = choosePort(spec)
      const child = spawn(
        resolveOpenCodeBinary(),
        ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
        {
          cwd: spec.cwd,
          env: buildChildEnv({
            // OpenCode finds its own config and auth under HOME; the server's
            // optional basic-auth vars are forwarded so a user who exported them
            // gets the same behaviour as running `opencode serve` by hand.
            forward: ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME'],
            set: spec.env,
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      child.stdout?.setEncoding('utf-8')
      child.stderr?.setEncoding('utf-8')
      child.stderr?.on('data', (chunk: string) => {
        logForDebugging(`[opencode stderr] ${chunk.trimEnd()}`)
      })

      try {
        await waitForServer(port)
      } catch (e) {
        child.kill('SIGKILL')
        throw e
      }

      const client = createOpenCodeClient({ port })
      const handle = new OpenCodeHandle({
        agentId: spec.agentId,
        client,
        adoption: 'managed',
        child,
        tmuxSession: spec.tmuxSession,
      })
      await handle.attachStream()
      handle.setSession(
        spec.resumeSessionId ?? (await createSession(client, spec.model)),
      )
      return handle
    },

    /**
     * Attach to a server the user already has running.
     *
     * Prefers the session most recently updated — that is the conversation the
     * user is actually looking at — and creates one only if the server has none,
     * so adoption still yields a usable agent against a freshly started server.
     */
    async adopt(target: AdoptTarget): Promise<AgentHandle> {
      const port = portFromEndpoint(target.transport.endpoint)
      const found = await discoverOpenCodeServer(port)
      if (!found) {
        throw new Error(
          `No OpenCode server answered on 127.0.0.1${port ? `:${port}` : ''}. ` +
            `Start one with 'opencode serve --port ${OPENCODE_DEFAULT_PORT}', or pass the port explicitly — ` +
            `a TUI started without --port binds a random port that cannot be discovered.`,
        )
      }
      const client = createOpenCodeClient({ port: found.port })
      const handle = new OpenCodeHandle({
        agentId: target.agentId,
        client,
        adoption: 'adoptable',
      })
      await handle.attachStream()
      handle.setSession(await pickExistingSession(client))
      return handle
    },

    async reconnect(record: AgentRecord): Promise<AgentHandle> {
      const port = portFromEndpoint(record.transport.endpoint)
      const found = await discoverOpenCodeServer(port)
      if (!found) {
        throw new Error(
          `Cannot reconnect ${record.agentInstanceId}: no OpenCode server on ${record.transport.endpoint ?? '127.0.0.1'}.`,
        )
      }
      const client = createOpenCodeClient({ port: found.port })
      const handle = new OpenCodeHandle({
        agentId: record.agentInstanceId as AgentInstanceId,
        client,
        adoption: record.adoption === 'managed' ? 'managed' : 'adoptable',
        tmuxSession: record.tmuxSession,
      })
      await handle.attachStream()
      // Resume the recorded session so the conversation continues rather than
      // restarting — the point of persisting the native session id.
      const sessions = await handle.listSessions()
      const recorded = sessions.find(
        session => session.agentSessionId === record.agentInstanceId,
      )
      handle.setSession(
        recorded?.agentSessionId ?? (await pickExistingSession(client)),
      )
      return handle
    },
  }
}

function portFromEndpoint(endpoint?: string): number | undefined {
  if (!endpoint) return undefined
  try {
    const parsed = Number.parseInt(new URL(endpoint).port, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

async function createSession(
  client: OpenCodeClient,
  title?: string,
): Promise<string> {
  const session = await client.post<OpenCodeSession>('/session', {
    title: title ? `RAYU: ${title}` : 'RAYU',
  })
  if (!session?.id) {
    throw new Error('OpenCode POST /session returned no session id')
  }
  return session.id
}

/** Most recently updated session, creating one when the server has none. */
async function pickExistingSession(client: OpenCodeClient): Promise<string> {
  const sessions = await client
    .get<OpenCodeSession[]>('/session')
    .catch(() => [] as OpenCodeSession[])
  const usable = (sessions ?? []).filter(
    session => typeof session.id === 'string',
  )
  if (usable.length === 0) return createSession(client)
  const newest = usable.reduce((best, candidate) =>
    (candidate.time?.updated ?? 0) > (best.time?.updated ?? 0) ? candidate : best,
  )
  return newest.id!
}

export type { OpenCodeHandle }
