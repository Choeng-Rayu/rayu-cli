/**
 * IPC message routing between the extension host and attached CLI sessions.
 *
 * ── WHAT THIS OWNS ──────────────────────────────────────────────────────────────
 *
 * `IpcBridge` is a registry and dispatcher for the bi-directional message flow
 * that occurs during an ATTACHED session (extension → CLI session and CLI session →
 * extension).  It does NOT own:
 *
 *   - The attach/detach lifecycle (`cliAttachment.ts`)
 *   - The engine child process (`EngineManager`)
 *   - The transcript/state (`ChatSession`)
 *
 * Its job is: "given a channel name and a payload, call the right handler on the
 * right side" — nothing more.
 *
 * ── USAGE PATTERN ───────────────────────────────────────────────────────────────
 *
 * ```ts
 * const bridge = new IpcBridge()
 *
 * // Register handlers the extension should invoke when a CLI message arrives.
 * bridge.registerInbound('telegram:stream-delta', payload => {
 *   session.appendMirroredDelta((payload as { delta: string }).delta)
 * })
 *
 * // Route a notification through all registered inbound handlers.
 * bridge.routeInbound('telegram:stream-delta', { delta: 'Hello' })
 *
 * // Send a message outbound to the attached CLI.
 * bridge.sendOutbound('telegram:prompt', { value: 'Hi' })
 * ```
 *
 * `sendOutbound` is a no-op when no connection is attached, so callers need not
 * guard against that case themselves.
 */
import type { IpcConnection } from '../../../ipc/connection.js'

type InboundHandler = (payload: unknown) => void

/**
 * Thin message-routing layer between the extension host and an attached CLI.
 *
 * All in-memory routing is synchronous; async operations are on the caller's side.
 */
export class IpcBridge {
  private readonly inboundHandlers = new Map<string, InboundHandler[]>()
  private _connection: IpcConnection | null = null

  /** Attach to a live IPC connection. Replaces any previous connection. */
  attach(connection: IpcConnection): void {
    this._connection = connection
  }

  /** Drop the connection reference. Subsequent `sendOutbound` calls are no-ops. */
  detach(): void {
    this._connection = null
  }

  /** True while a connection is attached. */
  get isAttached(): boolean {
    return this._connection !== null
  }

  /**
   * Register a handler for inbound notifications arriving from the CLI.
   *
   * Multiple handlers for the same channel are called in registration order.
   * Returns an unregister function.
   */
  registerInbound(channel: string, handler: InboundHandler): () => void {
    const list = this.inboundHandlers.get(channel)
    if (list) {
      list.push(handler)
    } else {
      this.inboundHandlers.set(channel, [handler])
    }
    return () => {
      const current = this.inboundHandlers.get(channel)
      if (!current) return
      const idx = current.indexOf(handler)
      if (idx !== -1) current.splice(idx, 1)
      if (current.length === 0) this.inboundHandlers.delete(channel)
    }
  }

  /**
   * Dispatch an inbound message to all registered handlers.
   *
   * Called by the `onNotify` callback passed to `connectIpc` in `cliAttachment`.
   * Errors thrown by individual handlers are swallowed so one bad handler cannot
   * drop subsequent messages.
   */
  routeInbound(channel: string, payload: unknown): void {
    const handlers = this.inboundHandlers.get(channel)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(payload)
      } catch {
        // Individual handler failures must not affect other handlers or the
        // connection.  The caller already has error reporting at a higher level.
      }
    }
  }

  /**
   * Send a notification to the attached CLI.  No-op when not attached.
   */
  sendOutbound(channel: string, payload?: unknown): void {
    this._connection?.notify(channel, payload)
  }

  /**
   * Send a request to the attached CLI and return its response.
   *
   * Throws when not attached.
   */
  async requestOutbound(channel: string, payload?: unknown): Promise<unknown> {
    if (!this._connection) throw new Error('IpcBridge: not attached.')
    return this._connection.request(channel, payload ?? {})
  }

  /** Remove all registered handlers and drop the connection. */
  dispose(): void {
    this.inboundHandlers.clear()
    this._connection = null
  }
}
