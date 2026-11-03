/**
 * Bidirectional newline-delimited JSON-RPC 2.0 peer over a pair of streams.
 *
 * Shared by the Codex adapter (`codex app-server`) and the ACP adapter — both
 * speak JSON-RPC 2.0 as JSONL, and both need the *peer* shape rather than a
 * client: the server initiates requests too. Codex sends
 * `item/commandExecution/requestApproval` and expects a reply; ACP sends
 * permission requests the same way. A request/response-only client would
 * deadlock the first time an agent asked for approval.
 *
 * ## One deliberate configuration knob
 *
 * Codex documents that the `"jsonrpc":"2.0"` member is **omitted on the wire**,
 * while ACP follows the spec and includes it. Rather than fork the transport,
 * `includeJsonRpcVersion` controls it. Inbound parsing ignores the field either
 * way, so the same reader serves both.
 *
 * ## Failure handling
 *
 * Framing (chunk-boundary buffering, oversized lines, tail flushing) is handled
 * by the shared `jsonLines.ts` reader. What this module adds on top is
 * request/response correlation and the one hazard specific to it:
 *
 *   - **Pending requests on close.** If the child exits, every in-flight promise
 *     must reject with a diagnosable error. Left unsettled they hang forever,
 *     which looks exactly like a stuck agent.
 */

import type { Readable, Writable } from 'stream'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { createJsonLineReader } from './jsonLines.js'

export type JsonRpcId = number | string

export type JsonRpcErrorPayload = {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcNotification = {
  method: string
  params?: unknown
}

export type JsonRpcServerRequest = {
  id: JsonRpcId
  method: string
  params?: unknown
}

/** Thrown when the peer answers a request with an error object. */
export class JsonRpcError extends Error {
  readonly code: number
  readonly data?: unknown
  readonly method: string

  constructor(method: string, payload: JsonRpcErrorPayload) {
    super(`${method} failed (${payload.code}): ${payload.message}`)
    this.name = 'JsonRpcError'
    this.code = payload.code
    this.data = payload.data
    this.method = method
  }
}

/** Thrown when the transport closed before a request was answered. */
export class JsonRpcClosedError extends Error {
  constructor(method: string, reason: string) {
    super(`${method} did not complete: transport closed (${reason})`)
    this.name = 'JsonRpcClosedError'
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs}ms`)
    this.name = 'JsonRpcTimeoutError'
  }
}

/**
 * Codex's "Server overloaded; retry later." Documented as retryable, so the
 * transport backs off rather than surfacing it — a caller cannot do anything
 * more useful with it than wait.
 */
export const CODEX_SERVER_OVERLOADED = -32001

/** JSON-RPC "method not found". Adapters use this to degrade a capability. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601

export type JsonRpcPeerOptions = {
  /** Where to write outbound messages (the child's stdin). */
  readonly output: Writable
  /** Where inbound messages arrive (the child's stdout). */
  readonly input: Readable
  /**
   * Emit `"jsonrpc":"2.0"` on outbound messages. Codex omits it; ACP requires
   * it. Inbound parsing does not care.
   */
  readonly includeJsonRpcVersion?: boolean
  readonly onNotification?: (notification: JsonRpcNotification) => void
  /**
   * Handle a request the peer initiated. Resolve with the result; throw to
   * return a JSON-RPC error. Unhandled server requests get a `-32601` reply, so
   * the peer is never left waiting.
   */
  readonly onServerRequest?: (
    request: JsonRpcServerRequest,
  ) => Promise<unknown>
  /** Non-fatal transport diagnostics (unparseable line, oversized line). */
  readonly onTransportError?: (error: Error) => void
  readonly onClose?: (reason: string) => void
  readonly requestTimeoutMs?: number
  readonly maxLineBytes?: number
  /** Error codes worth retrying. Defaults to Codex's overload code. */
  readonly retryableCodes?: readonly number[]
  readonly maxRetries?: number
  /** Label used in log lines, e.g. the agent instance id. */
  readonly label?: string
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 250

type Pending = {
  readonly method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export type JsonRpcPeer = {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; retry?: boolean },
  ): Promise<T>
  notify(method: string, params?: unknown): void
  /** Reply to a server-initiated request handled out of band. */
  respond(id: JsonRpcId, result: unknown): void
  respondWithError(id: JsonRpcId, error: JsonRpcErrorPayload): void
  close(reason?: string): void
  readonly closed: boolean
}

/**
 * Wire a peer onto an existing stream pair.
 *
 * The caller owns process lifecycle; this owns framing and correlation.
 */
export function createJsonRpcPeer(options: JsonRpcPeerOptions): JsonRpcPeer {
  const label = options.label ?? 'jsonrpc'
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const retryableCodes = options.retryableCodes ?? [CODEX_SERVER_OVERLOADED]
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES

  const pending = new Map<JsonRpcId, Pending>()
  let nextId = 1
  let closed = false

  function reportTransportError(message: string): void {
    const error = new Error(`[${label}] ${message}`)
    logForDebugging(error.message)
    options.onTransportError?.(error)
  }

  function write(message: Record<string, unknown>): void {
    if (closed) return
    const envelope = options.includeJsonRpcVersion
      ? { jsonrpc: '2.0', ...message }
      : message
    try {
      options.output.write(`${jsonStringify(envelope)}\n`)
    } catch (e) {
      // EPIPE means the child is gone. Closing settles every pending request
      // rather than leaving callers hanging on a dead pipe.
      reportTransportError(`write failed: ${errorMessage(e)}`)
      close('write failed')
    }
  }

  function settleAllPending(reason: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new JsonRpcClosedError(entry.method, reason))
      pending.delete(id)
    }
  }

  function close(reason = 'closed by caller'): void {
    if (closed) return
    closed = true
    settleAllPending(reason)
    reader.close(reason)
    options.onClose?.(reason)
  }

  function handleResponse(message: Record<string, unknown>): void {
    const id = message.id as JsonRpcId
    const entry = pending.get(id)
    if (!entry) {
      // A late reply after a timeout, or an id we never sent. Log rather than
      // throw — a peer echoing an unknown id must not kill the connection.
      reportTransportError(`response for unknown id ${String(id)}`)
      return
    }
    pending.delete(id)
    clearTimeout(entry.timer)
    if (message.error) {
      entry.reject(
        new JsonRpcError(entry.method, message.error as JsonRpcErrorPayload),
      )
      return
    }
    entry.resolve(message.result)
  }

  function handleServerRequest(message: Record<string, unknown>): void {
    const request: JsonRpcServerRequest = {
      id: message.id as JsonRpcId,
      method: String(message.method),
      params: message.params,
    }
    const handler = options.onServerRequest
    if (!handler) {
      // Always answer. An unanswered server request blocks the agent's turn.
      write({
        id: request.id,
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `RAYU does not handle ${request.method}`,
        },
      })
      return
    }
    void handler(request).then(
      result => write({ id: request.id, result: result ?? {} }),
      (e: unknown) =>
        write({
          id: request.id,
          error: { code: -32603, message: errorMessage(e) },
        }),
    )
  }

  function dispatch(parsed: unknown): void {
    if (parsed === null || typeof parsed !== 'object') {
      reportTransportError('message is not a JSON object')
      return
    }
    const message = parsed as Record<string, unknown>
    const hasId = message.id !== undefined && message.id !== null
    const hasMethod = typeof message.method === 'string'

    if (hasId && !hasMethod) {
      handleResponse(message)
      return
    }
    if (hasId && hasMethod) {
      handleServerRequest(message)
      return
    }
    if (hasMethod) {
      options.onNotification?.({
        method: String(message.method),
        params: message.params,
      })
      return
    }
    reportTransportError('message with neither id nor method')
  }

  // Framing is delegated to the shared JSONL reader — chunk-boundary buffering,
  // oversized-line handling and tail flushing are identical for every JSONL
  // protocol and must not be reimplemented per adapter.
  const reader = createJsonLineReader({
    input: options.input,
    label,
    maxLineBytes: options.maxLineBytes,
    onValue: dispatch,
    onError: error => options.onTransportError?.(error),
    onClose: reason => {
      // The reader closing means the peer is gone; settle everything waiting.
      if (!closed) close(reason)
    },
  })

  function sendOnce<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<T> {
    if (closed) {
      return Promise.reject(new JsonRpcClosedError(method, 'already closed'))
    }
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new JsonRpcTimeoutError(method, timeoutMs))
      }, timeoutMs)
      timer.unref()
      pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      write({ id, method, params })
    })
  }

  /**
   * Retry with exponential backoff plus jitter.
   *
   * Jitter matters because several agents driven by one RAYU can hit an
   * overloaded server simultaneously; without it they would retry in lockstep
   * and keep it overloaded.
   */
  async function requestWithRetry<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await sendOnce<T>(method, params, timeoutMs)
      } catch (e) {
        lastError = e
        const retryable =
          e instanceof JsonRpcError && retryableCodes.includes(e.code)
        if (!retryable || attempt === maxRetries || closed) break
        const backoff =
          RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * RETRY_BASE_DELAY_MS
        logForDebugging(
          `[${label}] ${method} retryable error ${e.code}; retrying in ${Math.round(backoff)}ms`,
        )
        await new Promise(resolve => setTimeout(resolve, backoff))
      }
    }
    throw lastError
  }

  return {
    request<T = unknown>(
      method: string,
      params?: unknown,
      opts?: { timeoutMs?: number; retry?: boolean },
    ): Promise<T> {
      const timeoutMs = opts?.timeoutMs ?? requestTimeoutMs
      return opts?.retry === false
        ? sendOnce<T>(method, params, timeoutMs)
        : requestWithRetry<T>(method, params, timeoutMs)
    },

    notify(method: string, params?: unknown): void {
      write({ method, params })
    },

    respond(id: JsonRpcId, result: unknown): void {
      write({ id, result })
    },

    respondWithError(id: JsonRpcId, error: JsonRpcErrorPayload): void {
      write({ id, error })
    },

    close,

    get closed(): boolean {
      return closed
    },
  }
}
