/**
 * The control protocol, correlated.
 *
 * Sits directly on top of {@link EngineProcess} and turns a stream of frames into
 * three clean things: awaitable outbound requests, inbound requests we must
 * answer, and plain session messages.
 *
 * ── THE PROTOCOL IS BIDIRECTIONAL, AND THAT IS THE WHOLE DESIGN ────────────────
 *
 * It is tempting to model this as a client calling a server. It is not. Frames
 * flow both ways over the same pipe:
 *
 *   host → engine   `initialize`, `set_model`, `set_permission_mode`, `interrupt`,
 *                   `mcp_status`, `get_context_usage`, `rewind_files`, …
 *   engine → host   `can_use_tool` — "may I run this tool?" — plus `hook_callback`
 *                   and `elicitation`
 *
 * `can_use_tool` is the one that matters most. Because the engine runs with
 * `--permission-prompt-tool=stdio`, `getCanUseToolFn` in print.ts returns
 * `structuredIO.createCanUseTool()`, which BLOCKS the tool until a
 * `control_response` with a matching `request_id` comes back. If the host does not
 * answer, the turn hangs with no error — so an unanswered inbound request is not a
 * dropped message, it is a stuck session.
 *
 * ── VALIDATION IS MANDATORY AND `safeParse` ONLY ───────────────────────────────
 *
 * Every frame is validated against the vendored wire schemas. `parse` is never
 * used: a throw inside a stdout data handler cannot be surfaced to the user
 * recoverably. A frame that fails validation is fatal for the session rather than
 * skipped, because the protocol is correlated and the frame we drop may be the
 * response something is awaiting.
 *
 * The schemas are LAZY THUNKS — `lazySchema()` defers Zod construction to first
 * access — so they must be CALLED: `StdoutMessageSchema().safeParse(frame)`.
 * Forgetting the call yields a function where an object is expected and every
 * frame appears invalid.
 */
import {
  SDKControlResponseSchema,
  SDKControlRequestSchema,
  SDKControlCancelRequestSchema,
  StdoutMessageSchema,
} from '../../../entrypoints/sdk/controlSchemas.js'

/** An inbound request the host must answer, handed to the owner. */
export interface InboundControlRequest {
  requestId: string
  /** e.g. `can_use_tool`, `hook_callback`, `elicitation`. */
  subtype: string
  /** The full inner request; the owner narrows on `subtype`. */
  request: Record<string, unknown>
}

export interface ControlClientCallbacks {
  /**
   * A session message — assistant text, tool use, results, `system/init`, the
   * final `result`. Anything that is not a control envelope.
   */
  onMessage: (message: Record<string, unknown>) => void
  /**
   * The engine is asking us something and is BLOCKED until `respond()` or
   * `respondError()` is called with the same `requestId`.
   */
  onRequest: (request: InboundControlRequest) => void
  /**
   * The engine withdrew an inbound request — it resolved the decision another way.
   * The owner must dismiss any UI for it. It must NOT answer it afterwards.
   */
  onRequestCancelled: (requestId: string) => void
  /** A frame failed schema validation, or the stream broke. Fatal by contract. */
  onProtocolError: (message: string, excerpt: string) => void
  /**
   * A one-way session message this build does not recognise.
   *
   * NOT fatal: nothing is blocked on it. Surfaced so a version skew between the
   * engine and the extension is diagnosable instead of invisible, without killing a
   * session over narration it did not need.
   */
  onUnknownFrame?: (declaredType: string, excerpt: string) => void
}

/** Default ceiling for an OUTBOUND request. */
const DEFAULT_TIMEOUT_MS = 60_000

interface Pending {
  resolve: (response: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** The frame sink this client writes to — `EngineProcess.send` satisfies it. */
export type FrameSink = (frame: unknown) => boolean

export class ControlClient {
  private readonly pending = new Map<string, Pending>()
  /** Inbound ids still awaiting our answer, so we can refuse a double-answer. */
  private readonly inbound = new Set<string>()
  private counter = 0
  private disposed = false

  constructor(
    private readonly send: FrameSink,
    private readonly callbacks: ControlClientCallbacks,
  ) {}

  /**
   * Send a control request and await its response.
   *
   * `timeoutMs: null` waits indefinitely. That is right for a request whose
   * completion depends on real work — `rewind_files` over a large diff — and wrong
   * for everything else, because a request that never settles is a spinner with no
   * end state.
   */
  request(
    subtype: string,
    payload: Record<string, unknown> = {},
    timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.disposed) {
      return Promise.reject(new Error('The engine connection is closed.'))
    }

    const requestId = `req_${++this.counter}_${Date.now().toString(36)}`

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(requestId)
              // Tell the engine to stop working on it. Without this the engine
              // completes an operation whose result nothing will read, and for
              // `interrupt` or `rewind_files` that is a real side effect.
              this.send({ type: 'control_cancel_request', request_id: requestId })
              reject(
                new Error(`Engine did not answer "${subtype}" within ${timeoutMs}ms.`),
              )
            }, timeoutMs)
      timer?.unref?.()

      this.pending.set(requestId, { resolve, reject, timer })

      const delivered = this.send({
        type: 'control_request',
        request_id: requestId,
        request: { subtype, ...payload },
      })

      if (!delivered) {
        this.settleReject(requestId, new Error('The engine is not running.'))
      }
    })
  }

  /** Answer an inbound request successfully. */
  respond(requestId: string, response: Record<string, unknown> = {}): void {
    // An id we do not hold was already cancelled or already answered. Replying
    // again would have the engine correlate a response to nothing, and for a
    // permission that means a second decision on a resolved gate.
    if (!this.inbound.delete(requestId)) return
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    })
  }

  /** Answer an inbound request with a failure. */
  respondError(requestId: string, error: string): void {
    if (!this.inbound.delete(requestId)) return
    this.send({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    })
  }

  /** True while the engine is still waiting on us for this id. */
  isAwaitingResponse(requestId: string): boolean {
    return this.inbound.has(requestId)
  }

  /**
   * Feed one raw frame from the engine's stdout.
   *
   * Validation happens here, once, so nothing downstream handles unvalidated data.
   *
   * ── WHY A BAD FRAME IS NOT ALWAYS FATAL ────────────────────────────────────────
   *
   * The rule "never skip a malformed frame" exists because the CONTROL protocol is
   * correlated by `request_id`: a dropped `control_response` is the very reply
   * something is awaiting, so the session hangs with no error. That reasoning is
   * exact, and it applies exactly to control envelopes.
   *
   * It does NOT apply to session messages. Those are one-way narration — an
   * `assistant` block, a `system` notice, a progress update. Nothing is blocked on
   * them, and treating an unrecognised one as fatal makes the panel brittle in the one
   * situation that is guaranteed to happen: a newer engine emitting a message type
   * this extension's vendored schema does not yet know about, or an existing type
   * gaining a required field. The engine and the extension ship together today, but
   * they are separately installable, and a version skew must degrade rather than
   * brick the session.
   *
   * So: control envelopes are validated strictly and fail hard; anything else that
   * fails validation is reported as a non-fatal warning and skipped. The distinction
   * is made on `type` BEFORE the union parse, because a frame that fails the union
   * has no trustworthy `type` otherwise.
   */
  handleFrame(raw: unknown): void {
    if (this.disposed) return

    const declaredType =
      raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>).type
        : undefined
    const isControlEnvelope =
      declaredType === 'control_request' ||
      declaredType === 'control_response' ||
      declaredType === 'control_cancel_request'

    const parsed = StdoutMessageSchema().safeParse(raw)
    if (!parsed.success) {
      if (isControlEnvelope) {
        // Correlation is broken. Nothing downstream can recover from this.
        this.callbacks.onProtocolError(
          'Engine sent a malformed control frame.',
          summariseFrame(raw),
        )
        return
      }
      // One-way narration this build does not understand. Report it and carry on —
      // the alternative is a session killed by a message it did not need.
      this.callbacks.onUnknownFrame?.(
        typeof declaredType === 'string' ? declaredType : 'unknown',
        summariseFrame(raw),
      )
      return
    }

    const frame = parsed.data as Record<string, unknown>

    switch (frame.type) {
      case 'control_response': {
        const response = SDKControlResponseSchema().safeParse(frame)
        if (!response.success) {
          this.callbacks.onProtocolError(
            'Engine sent a malformed control_response.',
            summariseFrame(raw),
          )
          return
        }
        this.resolvePending(response.data.response)
        return
      }

      case 'control_request': {
        const request = SDKControlRequestSchema().safeParse(frame)
        if (!request.success) {
          this.callbacks.onProtocolError(
            'Engine sent a malformed control_request.',
            summariseFrame(raw),
          )
          return
        }
        const inner = request.data.request as Record<string, unknown>
        const requestId = request.data.request_id
        this.inbound.add(requestId)
        this.callbacks.onRequest({
          requestId,
          subtype: String(inner.subtype),
          request: inner,
        })
        return
      }

      case 'control_cancel_request': {
        const cancel = SDKControlCancelRequestSchema().safeParse(frame)
        if (!cancel.success) {
          this.callbacks.onProtocolError(
            'Engine sent a malformed control_cancel_request.',
            summariseFrame(raw),
          )
          return
        }
        // Drop it BEFORE notifying, so a handler that synchronously tries to
        // respond is correctly refused by respond()'s membership check.
        this.inbound.delete(cancel.data.request_id)
        this.callbacks.onRequestCancelled(cancel.data.request_id)
        return
      }

      case 'keep_alive':
        // Nothing to do. It exists to hold a socket open; over a pipe it is inert.
        return

      default:
        this.callbacks.onMessage(frame)
    }
  }

  /**
   * Close down. Every pending outbound request is REJECTED, never left hanging.
   *
   * Inbound requests are dropped WITHOUT an answer on purpose. Fabricating a
   * response here would mean inventing a permission decision the user never made —
   * the engine is going away with the session, so there is nothing to tell.
   */
  dispose(reason = 'The engine connection was closed.'): void {
    if (this.disposed) return
    this.disposed = true
    for (const requestId of [...this.pending.keys()]) {
      this.settleReject(requestId, new Error(reason))
    }
    this.inbound.clear()
  }

  private resolvePending(
    response:
      | { subtype: 'success'; request_id: string; response?: Record<string, unknown> }
      | { subtype: 'error'; request_id: string; error: string },
  ): void {
    const entry = this.pending.get(response.request_id)
    // An unknown request_id means we already timed out and cancelled it. Not worth
    // failing the session over — the requester has already been rejected.
    if (!entry) return
    this.pending.delete(response.request_id)
    if (entry.timer) clearTimeout(entry.timer)

    if (response.subtype === 'error') {
      entry.reject(new Error(response.error))
      return
    }
    entry.resolve(response.response ?? {})
  }

  private settleReject(requestId: string, error: Error): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    if (entry.timer) clearTimeout(entry.timer)
    entry.reject(error)
  }
}

/** A short, loggable description of a frame that failed validation. */
function summariseFrame(raw: unknown): string {
  try {
    const text = JSON.stringify(raw)
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return String(raw)
  }
}
