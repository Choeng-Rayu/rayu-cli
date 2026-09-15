/**
 * Session control logic — start, stop, attach, and detach conversations.
 *
 * ── SEPARATION OF CONCERNS ──────────────────────────────────────────────────────
 *
 * `ChatViewProvider` (chatViewProvider.ts) owns the WEBVIEW: its HTML, its CSP, its
 * `postMessage` plumbing.  `SessionController` owns WHAT HAPPENS when the user
 * presses a button: start a session, attach to one, detach, etc.
 *
 * The split means session logic is fully testable without mocking VS Code webview
 * APIs, and the webview provider stays about HTML/messaging and nothing else.
 *
 * ── EVENT MODEL ──────────────────────────────────────────────────────────────────
 *
 * Each lifecycle change emits an event through a typed callback.  The webview
 * provider subscribes to these events and forwards the relevant data to the
 * webview.  No direct coupling from session logic to webview APIs.
 *
 * ── ATTACH vs START ──────────────────────────────────────────────────────────────
 *
 * A "started" session owns its own engine child.
 * An "attached" session proxies to an existing CLI process discovered via the
 * sessions registry.  The two use the same transcript/state machinery
 * (`ChatSession`) but different transports.
 */
import type { EngineManager } from './engineManager.js'
import type { IpcBridge } from './ipcBridge.js'

/** Identifies what kind of session backing a session handle has. */
export type SessionKind = 'standalone' | 'attached'

export interface SessionStartOptions {
  /** Resume an existing conversation by its session id. */
  resumeSessionId?: string
}

export interface AttachTarget {
  pid: number
  sessionId: string
  ipcAddress: string
  ipcToken: string
  cwd: string
  startedAt: number
  name?: string
}

/**
 * A thin descriptor returned from `startSession` / `attachToSession`.
 *
 * Does not expose engine internals — callers use the events below.
 */
export interface SessionDescriptor {
  readonly id: string
  readonly kind: SessionKind
}

export interface SessionControllerCallbacks {
  onSessionStarted?: (session: SessionDescriptor) => void
  onSessionEnded?: (id: string) => void
  onSessionAttached?: (session: SessionDescriptor) => void
  onSessionDetached?: (id: string) => void
  onError?: (message: string) => void
}

/**
 * Coordinates the lifecycle of one or more conversations.
 *
 * `ChatViewProvider` creates one instance at activation time and delegates all
 * session-management operations to it.  Nothing here imports `vscode` directly —
 * that keeps the controller testable in plain Node without a VS Code mock.
 */
export class SessionController {
  private activeSessions = new Map<string, SessionDescriptor>()

  constructor(
    private readonly engineManager: EngineManager,
    private readonly ipcBridge: IpcBridge,
    private readonly callbacks: SessionControllerCallbacks = {},
  ) {}

  /**
   * Start a standalone session backed by a new engine child.
   *
   * Returns the session descriptor.  Fires `onSessionStarted` on success.
   */
  async startSession(options: SessionStartOptions = {}): Promise<SessionDescriptor> {
    const session: SessionDescriptor = {
      id: generateId(),
      kind: 'standalone',
    }

    await this.engineManager.spawn({
      resumeSessionId: options.resumeSessionId,
    })

    this.activeSessions.set(session.id, session)
    this.callbacks.onSessionStarted?.(session)
    return session
  }

  /**
   * Stop a running session and dispose its engine child.
   *
   * Fires `onSessionEnded`.  No-op if the session id is unknown.
   */
  async stopSession(id: string): Promise<void> {
    if (!this.activeSessions.has(id)) return
    this.activeSessions.delete(id)
    this.engineManager.kill()
    this.callbacks.onSessionEnded?.(id)
  }

  /**
   * Attach to an existing CLI session discovered via the sessions registry.
   *
   * Returns the session descriptor on success, or `null` if the target could not
   * be reached.  Fires `onSessionAttached` on success.
   */
  async attachToSession(target: AttachTarget): Promise<SessionDescriptor | null> {
    // Dynamic import keeps the IPC client out of the extension's startup path.
    const { connectIpc } = await import('../../../ipc/client.js')
    const { IPC_ATTACH } = await import('../../shared/attachChannels.js')

    let connection: Awaited<ReturnType<typeof connectIpc>>
    try {
      connection = await connectIpc({
        address: target.ipcAddress,
        token: target.ipcToken,
        onNotify: (type, payload) => this.ipcBridge.routeInbound(type, payload),
        onClose: () => {
          // Treat a close as a detach that the remote side initiated.
          if (activeSession) {
            this.activeSessions.delete(activeSession.id)
            this.callbacks.onSessionDetached?.(activeSession.id)
          }
          this.ipcBridge.detach()
        },
      })
    } catch {
      return null
    }

    this.ipcBridge.attach(connection)
    connection.notify(IPC_ATTACH)

    const activeSession: SessionDescriptor = {
      id: `attached:${target.sessionId}`,
      kind: 'attached',
    }
    this.activeSessions.set(activeSession.id, activeSession)
    this.callbacks.onSessionAttached?.(activeSession)
    return activeSession
  }

  /**
   * Detach from an attached session, optionally preserving its state for re-attach.
   *
   * Fires `onSessionDetached`.
   */
  async detachFromSession(id: string): Promise<void> {
    if (!this.activeSessions.has(id)) return
    this.activeSessions.delete(id)

    const { IPC_DETACH } = await import('../../shared/attachChannels.js')
    try {
      this.ipcBridge.sendOutbound(IPC_DETACH)
    } catch {
      // Connection already gone; detach is still complete from our side.
    }
    this.ipcBridge.detach()
    this.callbacks.onSessionDetached?.(id)
  }

  /** All currently open sessions. */
  get sessions(): ReadonlyMap<string, SessionDescriptor> {
    return this.activeSessions
  }

  dispose(): void {
    this.activeSessions.clear()
    this.engineManager.dispose()
    this.ipcBridge.dispose()
  }
}

function generateId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
