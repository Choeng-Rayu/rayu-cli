// Control protocol client — typed inbound dispatch and host-initiated
// request/response correlation over the bidirectional NDJSON channel.
//
// The client consumes already-decoded `StdoutMessage` objects (the NdjsonCodec
// produces them) via `handleMessage`, and emits typed events the
// SessionManager/webview consume: `system/init`, complete assistant message,
// partial streaming delta, terminal result/usage, inbound permission request,
// and control-protocol errors (R3.2, R4.4, R7.2, R8.3, R11.2, R15.2).
//
// Host-initiated control requests (`interrupt`, `set_model`,
// `set_permission_mode`, `mcp_status`, `initialize`) are correlated through a
// `Map<request_id, PendingRequest>`, mirroring the CLI's
// `StructuredIO.sendRequest`/`pendingRequests` design: a matching
// `control_response` resolves (success) or rejects (error) exactly the pending
// request bearing the same `request_id`. A stream close (`dispose`) or an
// inbound `control_cancel_request` rejects every still-pending request exactly
// once — the host-side complement of the CLI's "reject all pending on stream
// close" behavior (R7.3, R7.4, R15.2).
//
// The transport is injected as a `send(message)` callback so the client stays
// pure, editor-agnostic, and trivially testable — it never touches a process,
// a socket, or any `vscode` API (R13.1, R13.5).
//
// Requirements: 3.2, 3.6, 4.4, 7.2, 7.3, 7.4, 8.3, 11.2, 15.2.

import type { Disposable } from "../editor/adapter.js";
import type {
  CanUseToolRequest,
  ControlRequest,
  ControlRequestInner,
  ControlResponse,
  InitializeRequest,
  InitializeResponse,
  McpStatusResponse,
} from "./control.js";
import {
  isAssistantMessage,
  isControlCancelRequest,
  isControlRequest,
  isControlResponse,
  isResultMessage,
  isStreamEvent,
  isSystemInit,
} from "./guards.js";
import type {
  AssistantMessage,
  ResultMessage,
  StdinMessage,
  StdoutMessage,
  StreamEvent,
  SystemInit,
} from "./messages.js";
import type { PermissionMode } from "./permissions.js";

// ----------------------------------------------------------------------------
// Event payloads
// ----------------------------------------------------------------------------

/**
 * An inbound `can_use_tool` permission request surfaced for the host to decide
 * (R5.1). The {@link PermissionRequestEvent.request} carries the tool name, its
 * input, and — for a bash action — the exact command string inside `input`
 * (R5.6). Answer it by sending a permission `control_response` correlated by
 * {@link PermissionRequestEvent.requestId}.
 */
export interface PermissionRequestEvent {
  requestId: string;
  request: CanUseToolRequest;
}

/**
 * A control-protocol error surfaced for display in the panel (R15.2). Emitted
 * for every error `control_response`; when the error correlates to a pending
 * host-initiated request, that request's promise is also rejected.
 */
export interface ControlErrorEvent {
  /** The `request_id` the error correlates to. */
  requestId: string;
  /** Human-readable error text reported by the agent. */
  error: string;
}

/**
 * The typed event surface the client emits. Each key is an event name; its
 * value type is the payload a listener receives.
 */
export interface ControlClientEvents {
  /** Initial session announcement: model, tools, mcp_servers, slash_commands, skills, permissionMode, session_id (R7.1, R11.2, R12.5). */
  systemInit: SystemInit;
  /** A complete assistant message block; `error` drives auth-failure detection (R3.3, R8.3). */
  assistantMessage: AssistantMessage;
  /** A partial assistant content delta to append to the in-progress message (R4.1). */
  streamEvent: StreamEvent;
  /** The terminal result for a turn; carries `usage`/`total_cost_usd`/`modelUsage` (R4.2, R4.4). */
  result: ResultMessage;
  /** An inbound permission request routed to the PermissionCoordinator (R5.1). */
  permissionRequest: PermissionRequestEvent;
  /** A control-protocol error to render in the panel (R15.2). */
  controlError: ControlErrorEvent;
}

/** A name of one of the {@link ControlClientEvents}. */
export type ControlClientEventName = keyof ControlClientEvents;

/** A listener for a specific {@link ControlClientEvents} entry. */
export type ControlClientListener<K extends ControlClientEventName> = (
  payload: ControlClientEvents[K],
) => void;

// ----------------------------------------------------------------------------
// Construction options
// ----------------------------------------------------------------------------

/** Construction options for a {@link ControlProtocolClient}. */
export interface ControlProtocolClientOptions {
  /**
   * Transport sink: write one outbound `StdinMessage` to the agent's stdin.
   * Injected so the client never depends on a concrete process/transport and
   * stays editor-agnostic (R13.1, R13.5).
   */
  send: (message: StdinMessage) => void;
  /**
   * Factory for unique outbound `request_id`s. Defaults to a monotonic
   * per-client counter, which is sufficient because ids only need to be unique
   * among this client's own outstanding requests.
   */
  generateRequestId?: () => string;
}

// ----------------------------------------------------------------------------
// Internal pending-request bookkeeping
// ----------------------------------------------------------------------------

/** A host-initiated request awaiting its correlated `control_response`. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  /** The inner subtype, retained for diagnostics. */
  subtype: ControlRequestInner["subtype"];
}

/** Rejection reason when the stream is closed before a response arrives. */
const STREAM_CLOSED_MESSAGE =
  "ControlProtocolClient: stream closed before a control response was received";

/** Rejection reason when a pending request is cancelled by the agent. */
const CANCELLED_MESSAGE =
  "ControlProtocolClient: pending control request cancelled";

// ----------------------------------------------------------------------------
// Client
// ----------------------------------------------------------------------------

/**
 * Owns the typed view of the control protocol and request/response correlation.
 * Pure and editor-agnostic: feed it decoded messages via {@link handleMessage},
 * drive host-initiated requests via the outbound methods, and subscribe to
 * typed events via {@link on}.
 */
export class ControlProtocolClient {
  private readonly send: (message: StdinMessage) => void;
  private readonly generateRequestId: () => string;

  /** Outstanding host-initiated requests, keyed by `request_id`. */
  private readonly pending = new Map<string, PendingRequest>();

  /** Listener sets per event name. */
  private readonly listeners: {
    [K in ControlClientEventName]: Set<ControlClientListener<K>>;
  };

  /** Monotonic counter backing the default request-id factory. */
  private requestCounter = 0;

  /** Set once {@link dispose} is called; further outbound requests reject. */
  private closed = false;

  constructor(options: ControlProtocolClientOptions) {
    this.send = options.send;
    this.generateRequestId =
      options.generateRequestId ??
      (() => `rayucode-req-${(this.requestCounter += 1)}`);
    this.listeners = {
      systemInit: new Set(),
      assistantMessage: new Set(),
      streamEvent: new Set(),
      result: new Set(),
      permissionRequest: new Set(),
      controlError: new Set(),
    };
  }

  /** Number of host-initiated requests currently awaiting a response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // --------------------------------------------------------------------------
  // Event registration
  // --------------------------------------------------------------------------

  /**
   * Subscribe to a typed event. Returns a {@link Disposable} that removes the
   * listener. Multiple listeners per event are supported and invoked in
   * registration order.
   */
  on<K extends ControlClientEventName>(
    event: K,
    listener: ControlClientListener<K>,
  ): Disposable {
    const set = this.listeners[event];
    set.add(listener);
    return {
      dispose: () => {
        set.delete(listener);
      },
    };
  }

  private emit<K extends ControlClientEventName>(
    event: K,
    payload: ControlClientEvents[K],
  ): void {
    // Snapshot so a listener that unsubscribes during dispatch can't perturb
    // the in-progress iteration.
    for (const listener of [...this.listeners[event]]) {
      listener(payload);
    }
  }

  // --------------------------------------------------------------------------
  // Inbound dispatch
  // --------------------------------------------------------------------------

  /**
   * Dispatch one decoded inbound `StdoutMessage`. Recognised message types are
   * surfaced as typed events or correlated against pending requests; unmodelled
   * types (e.g. `keep_alive`) are ignored.
   */
  handleMessage(message: StdoutMessage): void {
    if (isSystemInit(message)) {
      this.emit("systemInit", message);
      return;
    }
    if (isAssistantMessage(message)) {
      // The full message is surfaced, including its optional `error` field so
      // the host can detect an authentication failure (R8.3).
      this.emit("assistantMessage", message);
      return;
    }
    if (isStreamEvent(message)) {
      this.emit("streamEvent", message);
      return;
    }
    if (isResultMessage(message)) {
      this.emit("result", message);
      return;
    }
    if (isControlRequest(message)) {
      this.handleInboundControlRequest(message);
      return;
    }
    if (isControlResponse(message)) {
      this.handleControlResponse(message);
      return;
    }
    if (isControlCancelRequest(message)) {
      // A cancel from the agent tears down the outstanding exchange: reject
      // every still-pending host-initiated request exactly once (R7.4).
      this.rejectAllPending(new Error(CANCELLED_MESSAGE));
      return;
    }
    // `keep_alive` and any unmodelled type carry no host-side action.
  }

  private handleInboundControlRequest(message: ControlRequest): void {
    const inner = message.request;
    if (inner.subtype === "can_use_tool") {
      this.emit("permissionRequest", {
        requestId: message.request_id,
        request: inner,
      });
      return;
    }
    // rayucode does not service other inbound control_request subtypes; the
    // agent only initiates `can_use_tool` toward the host.
  }

  private handleControlResponse(message: ControlResponse): void {
    const { response } = message;
    const { request_id: requestId } = response;
    const pending = this.pending.get(requestId);

    if (response.subtype === "error") {
      // Surface the error text for display regardless of correlation (R15.2)…
      this.emit("controlError", { requestId, error: response.error });
      // …and reject the correlated pending request, if any.
      if (pending) {
        this.pending.delete(requestId);
        pending.reject(new Error(response.error));
      }
      return;
    }

    // A success response for an unknown/duplicate id has nothing to resolve;
    // ignore it, mirroring the CLI's orphan-response handling.
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    pending.resolve(response.response ?? {});
  }

  // --------------------------------------------------------------------------
  // Outbound host-initiated requests
  // --------------------------------------------------------------------------

  /** Interrupt the currently running turn (R3.6). */
  interrupt(): Promise<Record<string, unknown>> {
    return this.sendRequest({ subtype: "interrupt" });
  }

  /** Switch the model for subsequent turns (R7.3). */
  setModel(model?: string): Promise<Record<string, unknown>> {
    return this.sendRequest({ subtype: "set_model", model });
  }

  /** Change the active permission mode. */
  setPermissionMode(mode: PermissionMode): Promise<Record<string, unknown>> {
    return this.sendRequest({ subtype: "set_permission_mode", mode });
  }

  /** Request the current status of all MCP servers (R11.2). */
  mcpStatus(): Promise<McpStatusResponse> {
    return this.sendRequest<McpStatusResponse>({ subtype: "mcp_status" });
  }

  /** Initialise the session (hooks, MCP servers, prompts); `models` drives R7.2. */
  initialize(
    params: Omit<InitializeRequest, "subtype"> = {},
  ): Promise<InitializeResponse> {
    const request: InitializeRequest = { subtype: "initialize", ...params };
    return this.sendRequest<InitializeResponse>(request);
  }

  /**
   * Generate a `request_id`, register a pending entry, and write the
   * `control_request` envelope through the injected transport. The returned
   * promise settles when the correlated `control_response` arrives, or rejects
   * if the stream closes / the request is cancelled first.
   */
  private sendRequest<T = Record<string, unknown>>(
    request: ControlRequestInner,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(STREAM_CLOSED_MESSAGE));
    }
    const requestId = this.generateRequestId();
    const envelope: ControlRequest = {
      type: "control_request",
      request_id: requestId,
      request,
    };
    return new Promise<T>((resolve, reject) => {
      // Register before sending so a synchronous response can never race ahead
      // of the pending entry.
      this.pending.set(requestId, {
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
        subtype: request.subtype,
      });
      try {
        this.send(envelope);
      } catch (error) {
        // The transport failed; the request can never be answered.
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // --------------------------------------------------------------------------
  // Teardown
  // --------------------------------------------------------------------------

  /**
   * Close the client on stream end. Marks the client closed (subsequent
   * outbound requests reject) and rejects every still-pending request exactly
   * once. Idempotent: a second call settles nothing further.
   */
  dispose(): void {
    this.closed = true;
    this.rejectAllPending(new Error(STREAM_CLOSED_MESSAGE));
  }

  /**
   * Reject every still-pending request exactly once. Snapshots and clears the
   * map first, so each entry settles a single time and any later
   * close/cancel/late-response finds nothing to settle.
   */
  private rejectAllPending(reason: Error): void {
    if (this.pending.size === 0) {
      return;
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.reject(reason);
    }
  }
}
