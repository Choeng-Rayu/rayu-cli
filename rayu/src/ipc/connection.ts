/**
 * A framed, authenticated, BIDIRECTIONAL message channel over one socket.
 *
 * Both ends use this same class. That symmetry is required, not cosmetic: in the
 * multi-session design the leader connects OUT to a session to hand it a prompt,
 * while that same session pushes permission requests and streaming output BACK
 * over the identical connection. Modelling it as request/response in one
 * direction only would have forced a second socket in the opposite direction.
 *
 * Every outbound frame carries the shared per-session token, and every inbound
 * request/notify is verified against it before a handler runs.
 */

import type { Socket } from 'net'
import { randomUUID } from 'crypto'
import {
  encodeFrame,
  FrameSplitter,
  IPC_PROTOCOL_VERSION,
  ipcTokensMatch,
  MAX_AUTH_FAILURES,
  parseFrame,
  type IpcFrame,
} from './protocol.js'

/** Handles an inbound request. Returning a value resolves the peer's promise. */
export type RequestHandler = (
  type: string,
  payload: unknown,
) => Promise<unknown> | unknown

/** Handles an inbound notification. Return value is ignored. */
export type NotifyHandler = (type: string, payload: unknown) => void

export interface IpcConnectionOptions {
  socket: Socket
  /** Shared secret for this session's socket. */
  token: string
  /** Default timeout for `request()`, in ms. */
  requestTimeoutMs?: number
  onRequest?: RequestHandler
  onNotify?: NotifyHandler
  onClose?: () => void
  /** Called when a frame is refused. Diagnostics only — never the frame body. */
  onReject?: (reason: string) => void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class IpcConnection {
  private readonly socket: Socket
  private readonly token: string
  private readonly requestTimeoutMs: number
  private readonly splitter = new FrameSplitter()
  private readonly pending = new Map<string, Pending>()
  private authFailures = 0
  private closed = false

  private readonly onRequest?: RequestHandler
  private readonly onNotify?: NotifyHandler
  private readonly onCloseCb?: () => void
  private readonly onReject?: (reason: string) => void

  constructor(options: IpcConnectionOptions) {
    this.socket = options.socket
    this.token = options.token
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.onRequest = options.onRequest
    this.onNotify = options.onNotify
    this.onCloseCb = options.onClose
    this.onReject = options.onReject

    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => this.handleChunk(chunk))
    this.socket.on('error', () => this.destroy())
    this.socket.on('close', () => this.finish())
  }

  private handleChunk(chunk: string): void {
    let lines: string[]
    try {
      lines = this.splitter.push(chunk)
    } catch {
      // Buffer blew past the frame cap with no newline — the stream cannot be
      // resynchronised, so drop the peer instead of accumulating.
      this.onReject?.('oversize')
      this.destroy()
      return
    }
    for (const line of lines) {
      const parsed = parseFrame(line)
      if (!parsed.ok) {
        this.onReject?.(parsed.reason)
        // A malformed frame is not necessarily hostile (version skew between two
        // installed builds), so the connection survives — but an oversize one
        // already destroyed it above.
        continue
      }
      this.dispatch(parsed.frame)
    }
  }

  private dispatch(frame: IpcFrame): void {
    if (frame.kind === 'response') {
      const pending = this.pending.get(frame.id)
      if (!pending) return // late or duplicate response — nothing to settle
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.ok) pending.resolve(frame.payload)
      else pending.reject(new Error(frame.error))
      return
    }

    // Requests and notifications are authenticated; responses are not, because
    // they can only ever settle a promise we ourselves created with an id we
    // generated, and an unknown id is dropped above.
    if (!ipcTokensMatch(frame.token, this.token)) {
      this.onReject?.('bad-token')
      if (++this.authFailures >= MAX_AUTH_FAILURES) this.destroy()
      return
    }

    if (frame.kind === 'notify') {
      try {
        this.onNotify?.(frame.type, frame.payload)
      } catch {
        // A handler throwing must not kill the connection.
      }
      return
    }

    void this.serveRequest(frame.id, frame.type, frame.payload)
  }

  private async serveRequest(
    id: string,
    type: string,
    payload: unknown,
  ): Promise<void> {
    if (!this.onRequest) {
      this.write({
        v: IPC_PROTOCOL_VERSION,
        kind: 'response',
        id,
        ok: false,
        error: `unsupported request: ${type}`,
      })
      return
    }
    try {
      const result = await this.onRequest(type, payload)
      this.write({
        v: IPC_PROTOCOL_VERSION,
        kind: 'response',
        id,
        ok: true,
        payload: result,
      })
    } catch (e) {
      this.write({
        v: IPC_PROTOCOL_VERSION,
        kind: 'response',
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  private write(frame: IpcFrame): void {
    if (this.closed || this.socket.destroyed) return
    try {
      this.socket.write(encodeFrame(frame))
    } catch {
      this.destroy()
    }
  }

  /** Send a request and await the peer's response. */
  request(
    type: string,
    payload?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('ipc connection closed'))
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ipc request timed out: ${type}`))
      }, timeoutMs)
      try {
        ;(timer as unknown as { unref(): void }).unref()
      } catch {
        // Not available in every runtime.
      }
      this.pending.set(id, { resolve, reject, timer })
      this.write({
        v: IPC_PROTOCOL_VERSION,
        kind: 'request',
        id,
        token: this.token,
        type,
        payload,
      })
    })
  }

  /** Send a fire-and-forget message. Used for streaming deltas and status. */
  notify(type: string, payload?: unknown): void {
    this.write({
      v: IPC_PROTOCOL_VERSION,
      kind: 'notify',
      token: this.token,
      type,
      payload,
    })
  }

  /** Close the socket, failing anything still in flight. */
  destroy(): void {
    if (this.closed) return
    try {
      this.socket.destroy()
    } catch {
      // already gone
    }
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    // Never leave a caller awaiting a promise that can no longer be answered.
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('ipc connection closed'))
    }
    this.pending.clear()
    this.onCloseCb?.()
  }

  get isClosed(): boolean {
    return this.closed
  }
}
