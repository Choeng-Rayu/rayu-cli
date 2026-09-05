/**
 * The socket.io client rayu-cli uses to be remote-controlled from the studio.
 *
 * DIRECTION MATTERS AND IS THE WHOLE DESIGN. This dials OUT to rayu-backend. A
 * developer's machine sits behind NAT and a home router, so nothing can dial in to
 * it; the CLI opens the connection and the backend then has a socket it can push
 * prompts down. That is why the feature works with no port forwarding, no tunnel and
 * no configuration beyond being signed in.
 *
 * This module is transport ONLY. It knows how to authenticate, stay connected, and
 * move typed frames in both directions. It knows nothing about permission gates,
 * REPL queues, VS Code, or how a turn is structured — those belong to the per-worker
 * adapters, which is what lets the same client serve both the CLI REPL and the
 * rayucode extension host.
 *
 * TWO NON-OBVIOUS BEHAVIOURS ARE LOAD-BEARING:
 *
 *  1. `cli_hello` is re-sent on EVERY connect, not just the first. The backend
 *     forgets the route when a socket closes (`removeCliSession`), so a reconnected
 *     socket that does not re-announce is authenticated, silent, and unroutable —
 *     the session shows as offline forever while the CLI believes it is connected.
 *
 *  2. Decisions are DE-DUPLICATED by callId. The backend emits every decision twice
 *     on purpose — once as `bridge_decision`, once as legacy `tool_decision` — so a
 *     mid-rollout CLI listening for only one still gets answered. A client that
 *     listens for both and does not de-duplicate answers each permission request
 *     twice, and the second answer resolves whatever request happens to be pending
 *     next. That is a permission gate being decided by a stale frame, so it is
 *     guarded here rather than left to each adapter to remember.
 */

import { io, type Socket } from "socket.io-client";

import {
  CLI_COMMAND,
  CLI_EVENT,
  CLI_NAMESPACE,
  MAX_ACTIVITY_KIND_CHARS,
  MAX_BLOCKED_PATH_CHARS,
  MAX_CWD_CHARS,
  MAX_DELTA_CHARS,
  MAX_FINISH_REASON_CHARS,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MAX_SESSION_LABEL_CHARS,
  MAX_TEXT_CHARS,
  MAX_TOOL_NAME_CHARS,
  WEB_BRIDGE_WS_PATH,
  clampId,
  clampText,
  clampToolInput,
  isValidCallId,
  type ActivityEvent,
  type BridgeDecision,
  type BridgeError,
  type CliHello,
  type HelloAck,
  type PlanRequest,
  type PromptCommand,
  type Question,
  type QuestionRequest,
  type StreamDeltaType,
  type StreamEnd,
  type ToolCallRequest,
} from "./protocol.js";

// --- Public surface ----------------------------------------------------------

/**
 * Connection state, for a status indicator.
 *
 * `registering` is a distinct state on purpose. Between the socket handshake and
 * `hello_ack` the connection is authenticated but has no session id, so the studio
 * cannot list the machine and no prompt can be aimed at it. Collapsing that into
 * `connected` is what let the CLI report success while the studio correctly showed
 * nothing — both accurate, about different things. Only `connected` means usable.
 */
export type WebBridgeConnectionState =
  | "idle"
  | "connecting"
  | "registering"
  | "connected"
  | "reconnecting"
  | "error";

/**
 * What the host worker must supply.
 *
 * Every callback is synchronous and must not throw: they run inside socket.io event
 * handlers, where a throw becomes an unhandled rejection that tells nobody anything.
 * The client wraps each call defensively anyway, but the contract is stated because
 * a swallowed adapter bug is hard to find.
 */
export interface WebBridgeHandlers {
  /** A browser tab sent a prompt. Route it into the worker's input path. */
  onPrompt(prompt: PromptCommand): void;
  /**
   * A pending approval was answered. Guaranteed to fire AT MOST ONCE per callId,
   * regardless of how many aliases the backend emitted.
   */
  onDecision(decision: BridgeDecision): void;
  /** A browser tab asked to stop the current turn. */
  onInterrupt(): void;
  /** The handshake was accepted. Fires again after every reconnect. */
  onHelloAck?(ack: HelloAck): void;
  /** The backend refused a frame or could not route one. Diagnostic only. */
  onBridgeError?(error: BridgeError): void;
  /** Connection state changed. For a footer indicator or status bar item. */
  onConnectionChange?(state: WebBridgeConnectionState): void;
}

export interface WebBridgeClientOptions {
  /**
   * The rayu-backend REST base URL, INCLUDING its `/api` suffix — exactly what
   * `getRayuApiBaseUrl()` returns. The `/api` is stripped to get the socket origin
   * and reappears in {@link WEB_BRIDGE_WS_PATH}; see {@link bridgeOrigin}.
   */
  apiBaseUrl: string;
  /**
   * Returns a currently-valid access token, refreshing if needed. Called on every
   * connect and reconnect attempt, so a long-lived CLI reconnects with a fresh token
   * instead of retrying a dead one forever.
   */
  getToken: () => Promise<string | null>;
  /** Machine identity for the handshake. See machineId.ts. */
  hello: CliHello;
  handlers: WebBridgeHandlers;
  /** Diagnostic sink. Never receives the token or prompt text. */
  log?: (message: string) => void;
}

/**
 * Derive the socket.io origin from the REST base URL.
 *
 * `getRayuApiBaseUrl()` yields something like `https://rayucode.com/api`, while
 * socket.io wants an ORIGIN plus a separate `path`. Mirrors `bridgeOrigin()` in
 * rayu-web/studio/lib/webBridge/webBridgeTypes.ts.
 */
export function bridgeOrigin(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    // A relative base means same-origin, which cannot happen for a CLI (it has no
    // document to be same-origin with), so this is a misconfiguration. Returning
    // localhost is the least surprising fallback for a dev setup.
    return "http://localhost:4000";
  }
}

/**
 * How many answered callIds to remember for de-duplication.
 *
 * Bounded because this is a long-lived process: an unbounded set would grow for the
 * lifetime of the session. 512 is far more than the number of approvals that can be
 * in flight, and the only cost of evicting an old entry is that a duplicate frame
 * arriving minutes later would be re-delivered — which cannot happen, because the
 * duplicate is emitted in the same tick as the original.
 */
const ANSWERED_CALL_MEMORY = 512;

/**
 * How long to wait for `hello_ack` before re-sending `cli_hello`.
 *
 * Registration is the one frame that CANNOT be allowed to fail quietly. Until the
 * backend answers, the socket is authenticated but unroutable: the studio does not
 * list the machine, prompts cannot be aimed at it, and — because the socket is
 * perfectly healthy — nothing looks wrong from either end.
 *
 * That is not hypothetical. A backend that authenticated the connection
 * asynchronously would reject a `cli_hello` sent in the same tick as `connect`,
 * leaving exactly this state permanently. The server side of that is fixed, but a
 * client whose usability depends on the server never being slow is a client that
 * will break again for a different reason, so the retry stays.
 */
const HELLO_ACK_TIMEOUT_MS = 3_000;

/** Bounded so a genuinely rejecting server is not hammered forever. */
const MAX_HELLO_ATTEMPTS = 5;

// --- Client ------------------------------------------------------------------

export class WebBridgeClient {
  private socket: Socket | null = null;
  private state: WebBridgeConnectionState = "idle";
  private currentSessionId: string | null = null;
  private closed = false;

  /** callIds already delivered to the host, newest last. See ANSWERED_CALL_MEMORY. */
  private readonly answered: string[] = [];
  private readonly answeredSet = new Set<string>();

  /** Pending `hello_ack` retry, and how many attempts this connection has made. */
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private helloAttempts = 0;

  constructor(private readonly options: WebBridgeClientOptions) {}

  // --- Lifecycle -------------------------------------------------------------

  /** The backend-assigned session id, or null before the first `hello_ack`. */
  get sessionId(): string | null {
    return this.currentSessionId;
  }

  get connectionState(): WebBridgeConnectionState {
    return this.state;
  }

  /** True once `hello_ack` has been received on the current socket. */
  get isRoutable(): boolean {
    return this.state === "connected" && this.currentSessionId !== null;
  }

  /**
   * Open the connection.
   *
   * Resolves once the socket has been created, NOT once it is connected: a CLI must
   * not block its startup on a network round-trip to an optional feature. Progress is
   * reported through `onConnectionChange`.
   *
   * Returns false when there is no token, i.e. the user is not signed in. That is a
   * normal outcome, not an error — the caller surfaces "run /login first".
   */
  async connect(): Promise<boolean> {
    if (this.socket) return true;
    this.closed = false;

    const token = await this.safeToken();
    if (!token) {
      this.setState("error");
      return false;
    }

    this.setState("connecting");

    const socket = io(`${bridgeOrigin(this.options.apiBaseUrl)}${CLI_NAMESPACE}`, {
      path: WEB_BRIDGE_WS_PATH,
      // The handshake payload, not a query parameter: a token in the URL ends up in
      // proxy access logs on every reconnect.
      auth: { token },
      // WebSocket only. The polling fallback would work, but each poll re-sends the
      // whole handshake including the token, and a long-lived CLI has no reason to
      // degrade to it — a failure to upgrade is something to see, not to paper over.
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      // Unlimited: a CLI left open overnight on a flaky connection should still be
      // there in the morning. socket.io's default of Infinity is made explicit
      // because relying on a default for the property that defines the feature's
      // reliability is how it silently changes.
      reconnectionAttempts: Infinity,
      timeout: 20_000,
      autoConnect: true,
    });

    this.socket = socket;
    this.bind(socket);
    return true;
  }

  /**
   * Close the connection for good.
   *
   * Idempotent, and sets `closed` FIRST so an in-flight token refresh triggered by
   * `token_expired` cannot resurrect the socket after teardown.
   */
  stop(): void {
    this.closed = true;
    this.clearHelloTimer();
    const socket = this.socket;
    this.socket = null;
    this.currentSessionId = null;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    this.setState("idle");
  }

  // --- Outbound frames -------------------------------------------------------

  /**
   * A streaming token.
   *
   * Clamped to the backend's cap. An oversized delta is not delayed, it is REJECTED
   * and dropped, so an unclamped frame would silently remove a chunk from the middle
   * of the answer the browser is watching.
   */
  streamDelta(delta: string, type: StreamDeltaType = "text"): void {
    if (!delta) return;
    this.emit(CLI_EVENT.STREAM_DELTA, {
      delta: clampText(delta, MAX_DELTA_CHARS),
      type,
    });
  }

  streamEnd(end: StreamEnd = {}): void {
    const usage = end.usage
      ? Object.fromEntries(
          Object.entries(end.usage)
            .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
            // 24 keys and 48-character names are the backend's own limits; anything
            // beyond them is dropped there, so it is dropped here too rather than
            // being sent to be discarded.
            .slice(0, 24)
            .map(([k, v]) => [clampId(k, 48), v]),
        )
      : undefined;
    this.emit(CLI_EVENT.STREAM_END, {
      ...(end.finishReason
        ? { finishReason: clampId(end.finishReason, MAX_FINISH_REASON_CHARS) }
        : {}),
      ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    });
  }

  /**
   * Ask the browser for permission to run a tool.
   *
   * Returns false when the frame could not be sent — no connection, or a callId the
   * backend would reject. The caller MUST treat false as "the browser will never
   * answer this" and fall back to whatever gate it already had. Returning void here
   * would mean a permission request that blocks forever on a socket that was never
   * open, which is the worst failure this feature can have.
   */
  toolCall(request: ToolCallRequest): boolean {
    if (!isValidCallId(request.callId)) {
      this.log(`refusing tool_call with unroutable callId`);
      return false;
    }
    return this.emit(CLI_EVENT.TOOL_CALL, {
      callId: request.callId,
      toolName: clampId(request.toolName, MAX_TOOL_NAME_CHARS),
      toolInput: clampToolInput(request.toolInput),
      ...(request.description
        ? { description: clampText(request.description, MAX_TEXT_CHARS) }
        : {}),
      ...(request.toolUseId ? { toolUseId: clampId(request.toolUseId, 128) } : {}),
      ...(request.permissionSuggestions
        ? { permissionSuggestions: request.permissionSuggestions }
        : {}),
      ...(request.blockedPath
        ? { blockedPath: clampId(request.blockedPath, MAX_BLOCKED_PATH_CHARS) }
        : {}),
    });
  }

  /** Ask the browser to approve a plan. Same false-means-unanswerable contract. */
  planRequest(request: PlanRequest): boolean {
    if (!isValidCallId(request.callId)) return false;
    return this.emit(CLI_EVENT.PLAN_REQUEST, {
      callId: request.callId,
      plan: clampText(request.plan, MAX_TEXT_CHARS),
    });
  }

  /** Ask the browser to answer an `AskUserQuestion` interview. */
  questionRequest(request: QuestionRequest): boolean {
    if (!isValidCallId(request.callId)) return false;
    const questions = request.questions.slice(0, MAX_QUESTIONS).map(
      (q): Question => ({
        question: clampText(q.question, MAX_TEXT_CHARS),
        ...(q.header ? { header: clampId(q.header, 191) } : {}),
        options: q.options.slice(0, MAX_OPTIONS).map((o) => ({
          label: clampId(o.label, 512),
          ...(o.description ? { description: clampId(o.description, 2_048) } : {}),
        })),
        ...(q.multiSelect ? { multiSelect: true } : {}),
      }),
    );
    if (questions.length === 0) return false;
    return this.emit(CLI_EVENT.QUESTION_REQUEST, {
      callId: request.callId,
      questions,
      ...(request.toolInput !== undefined
        ? { toolInput: clampToolInput(request.toolInput) }
        : {}),
    });
  }

  /**
   * Withdraw a pending approval.
   *
   * Also marks the callId answered locally, so a decision that was already in flight
   * when the request was cancelled does not get delivered to a gate that has moved on.
   */
  cancelRequest(callId: string): void {
    this.rememberAnswered(callId);
    if (!isValidCallId(callId)) return;
    this.emit(CLI_EVENT.CANCEL_REQUEST, { callId });
  }

  activity(event: ActivityEvent): void {
    this.emit(CLI_EVENT.ACTIVITY, {
      kind: clampId(event.kind || "activity", MAX_ACTIVITY_KIND_CHARS),
      summary: clampText(event.summary ?? "", MAX_TEXT_CHARS),
    });
  }

  interruptAck(): void {
    this.emit(CLI_EVENT.INTERRUPT_ACK, {});
  }

  /**
   * Update the label shown in the studio's session picker.
   *
   * Implemented as a re-announce rather than a dedicated event, because the backend
   * has no `set_label` command and `registerCliSession` already upserts on
   * `(userId, machineId)` — so re-sending the handshake is the supported way to
   * change the row, and it reuses a path that is exercised on every reconnect.
   */
  setSessionLabel(label: string): void {
    this.options.hello.sessionLabel = clampId(label, MAX_SESSION_LABEL_CHARS);
    if (this.socket?.connected) this.sendHello();
  }

  // --- Internals -------------------------------------------------------------

  private bind(socket: Socket): void {
    socket.on("connect", () => {
      /*
       * NOT `connected` yet — see the state contract below.
       *
       * The transport is up and the handshake passed, but until `hello_ack` arrives
       * this socket has no session id and the backend cannot route a prompt to it.
       * Reporting "connected" here is what made the earlier failure so hard to see:
       * the CLI told the user it was connected while the studio correctly showed
       * nothing, and both were telling the truth about different things.
       */
      this.setState("registering");
      this.helloAttempts = 0;
      this.sendHelloWithRetry();
    });

    socket.on("disconnect", (reason: string) => {
      this.currentSessionId = null;
      this.clearHelloTimer();
      // `io client disconnect` is our own stop() and is not a fault.
      this.setState(reason === "io client disconnect" ? "idle" : "reconnecting");
      this.log(`disconnected: ${reason}`);
    });

    socket.on("connect_error", (error: Error) => {
      this.setState(this.socket?.active ? "reconnecting" : "error");
      this.log(`connect error: ${error.message}`);
    });

    /*
     * Refresh the token before each reconnect attempt.
     *
     * Without this, a CLI that loses its connection for longer than the token's
     * lifetime retries forever with a token the server will never accept again —
     * reconnecting successfully at the transport layer and being disconnected at the
     * handshake, indefinitely.
     */
    socket.io.on("reconnect_attempt", () => {
      void this.safeToken().then((token) => {
        if (token && this.socket) this.socket.auth = { token };
      });
    });

    socket.on(CLI_COMMAND.HELLO_ACK, (payload: unknown) => {
      const ack = payload as HelloAck | undefined;
      if (ack && typeof ack.sessionId === "string") {
        this.clearHelloTimer();
        this.currentSessionId = ack.sessionId;
        // Only NOW is the machine usable from a browser.
        this.setState("connected");
        this.log(`hello_ack: session=${ack.sessionId}`);
        this.guard(() => this.options.handlers.onHelloAck?.(ack));
      }
    });

    /*
     * Nest's `WsException` surfaces as an `exception` event, NOT as `bridge_error`.
     *
     * Listening for only the latter is why a rejected `cli_hello` was invisible: the
     * server was reporting the refusal on a channel nothing was reading, so the
     * client sat "connected" and unregistered with no diagnostic at all.
     */
    socket.on("exception", (payload: unknown) => {
      const raw = (payload ?? {}) as { message?: unknown };
      const message = typeof raw.message === "string" ? raw.message : "unknown";
      this.log(`server rejected a frame: ${message}`);
      // A refusal while unregistered is almost certainly about the handshake, so let
      // the retry keep trying rather than treating it as terminal.
      this.guard(() => this.options.handlers.onBridgeError?.({ message }));
    });

    socket.on(CLI_COMMAND.PROMPT, (payload: unknown) => {
      const raw = (payload ?? {}) as Partial<PromptCommand>;
      if (typeof raw.text !== "string") return;
      this.guard(() =>
        this.options.handlers.onPrompt({
          text: raw.text as string,
          ...(raw.sessionId ? { sessionId: raw.sessionId } : {}),
          ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments } : {}),
        }),
      );
    });

    socket.on(CLI_COMMAND.INTERRUPT, () => {
      this.guard(() => this.options.handlers.onInterrupt());
    });

    // The canonical decision, plus every legacy alias. All funnel through
    // `deliverDecision`, which is where the de-duplication lives.
    socket.on(CLI_COMMAND.DECISION, (payload: unknown) => {
      this.deliverDecision(this.readDecision(payload));
    });
    socket.on(CLI_COMMAND.TOOL_DECISION, (payload: unknown) => {
      this.deliverDecision(this.readLegacyDecision(payload));
    });
    socket.on(CLI_COMMAND.PLAN_DECISION, (payload: unknown) => {
      this.deliverDecision(this.readLegacyDecision(payload));
    });
    socket.on(CLI_COMMAND.QUESTION_ANSWER, (payload: unknown) => {
      this.deliverDecision(this.readDecision(payload));
    });

    socket.on(CLI_COMMAND.TOKEN_EXPIRED, () => {
      this.log("token expiring — refreshing and reconnecting");
      void this.refreshAndReconnect();
    });

    socket.on(CLI_COMMAND.BRIDGE_ERROR, (payload: unknown) => {
      const error = (payload ?? {}) as BridgeError;
      const message = typeof error.message === "string" ? error.message : "unknown";
      this.log(`bridge_error: ${message}`);
      this.guard(() => this.options.handlers.onBridgeError?.({ message }));
    });
  }

  /**
   * Read the canonical `BridgeDecision` shape.
   *
   * `behavior` is the discriminant and anything other than `allow` becomes `deny`.
   * Defaulting the other way would turn a malformed frame into an approval, and a
   * permission gate must fail closed.
   */
  private readDecision(payload: unknown): BridgeDecision | null {
    const raw = (payload ?? {}) as Partial<BridgeDecision>;
    if (typeof raw.callId !== "string" || !raw.callId) return null;
    return {
      callId: raw.callId,
      behavior: raw.behavior === "allow" ? "allow" : "deny",
      ...(typeof raw.message === "string" ? { message: raw.message } : {}),
      ...(raw.updatedInput && typeof raw.updatedInput === "object"
        ? { updatedInput: raw.updatedInput as Record<string, unknown> }
        : {}),
      ...(Array.isArray(raw.updatedPermissions)
        ? { updatedPermissions: raw.updatedPermissions }
        : {}),
    };
  }

  /** The legacy narrow shape: `{ callId, decision, message }`. */
  private readLegacyDecision(payload: unknown): BridgeDecision | null {
    const raw = (payload ?? {}) as { callId?: unknown; decision?: unknown; message?: unknown };
    if (typeof raw.callId !== "string" || !raw.callId) return null;
    return {
      callId: raw.callId,
      behavior: raw.decision === "allow" ? "allow" : "deny",
      ...(typeof raw.message === "string" ? { message: raw.message } : {}),
    };
  }

  /** Deliver at most one decision per callId. See the header note. */
  private deliverDecision(decision: BridgeDecision | null): void {
    if (!decision) return;
    if (this.answeredSet.has(decision.callId)) return;
    this.rememberAnswered(decision.callId);
    this.guard(() => this.options.handlers.onDecision(decision));
  }

  private rememberAnswered(callId: string): void {
    if (this.answeredSet.has(callId)) return;
    this.answeredSet.add(callId);
    this.answered.push(callId);
    while (this.answered.length > ANSWERED_CALL_MEMORY) {
      const evicted = this.answered.shift();
      if (evicted !== undefined) this.answeredSet.delete(evicted);
    }
  }

  /**
   * Announce this machine, and keep announcing until the backend acknowledges.
   *
   * Re-sent on EVERY connect, not just the first: the backend forgets the route when
   * a socket closes (`removeCliSession`), so a reconnected socket that does not
   * re-announce is authenticated, silent and unroutable.
   */
  private sendHelloWithRetry(): void {
    this.clearHelloTimer();
    this.helloAttempts += 1;
    this.sendHello();

    if (this.helloAttempts >= MAX_HELLO_ATTEMPTS) {
      this.log(
        `no hello_ack after ${MAX_HELLO_ATTEMPTS} attempts — the bridge is connected but unroutable`,
      );
      // Surfaced as an error rather than left as `registering`, so a status display
      // stops implying that registration is still in progress when it has given up.
      this.setState("error");
      return;
    }

    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      // Still no session id, so the previous attempt was not answered.
      if (!this.currentSessionId && this.socket?.connected) {
        this.log(`hello_ack not received — retrying (attempt ${this.helloAttempts + 1})`);
        this.sendHelloWithRetry();
      }
    }, HELLO_ACK_TIMEOUT_MS);
    // Never let a retry timer hold a CLI process open.
    (this.helloTimer as { unref?: () => void }).unref?.();
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private sendHello(): void {
    const hello = this.options.hello;
    this.emit(CLI_EVENT.CLI_HELLO, {
      machineId: hello.machineId,
      hostname: clampId(hello.hostname, 191),
      cwd: clampId(hello.cwd ?? "", MAX_CWD_CHARS),
      ...(typeof hello.pid === "number" && hello.pid > 0 ? { pid: hello.pid } : {}),
      ...(hello.sessionLabel
        ? { sessionLabel: clampId(hello.sessionLabel, MAX_SESSION_LABEL_CHARS) }
        : {}),
    });
  }

  /**
   * Tear down and rebuild the socket with a fresh token.
   *
   * A reconnect rather than an in-place auth update, because socket.io only reads
   * `auth` during a handshake — mutating it on a live socket changes nothing until
   * the next disconnect, which is exactly the moment the old token has already died.
   */
  private async refreshAndReconnect(): Promise<void> {
    if (this.closed) return;
    const token = await this.safeToken();
    if (this.closed) return;
    if (!token) {
      this.log("token refresh failed — bridge going offline");
      this.setState("error");
      return;
    }
    const socket = this.socket;
    if (!socket) return;
    this.setState("reconnecting");
    socket.auth = { token };
    socket.disconnect();
    socket.connect();
  }

  /** Never let a token provider's failure escape into a socket handler. */
  private async safeToken(): Promise<string | null> {
    try {
      return await this.options.getToken();
    } catch (e) {
      this.log(`token lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Emit a frame. Returns false when there is no live socket to emit on. */
  private emit(event: string, payload: unknown): boolean {
    const socket = this.socket;
    if (!socket || !socket.connected) return false;
    try {
      socket.emit(event, payload);
      return true;
    } catch (e) {
      this.log(`emit ${event} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  private setState(state: WebBridgeConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.guard(() => this.options.handlers.onConnectionChange?.(state));
  }

  /** Run host code without letting it break the socket. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log(`handler threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private log(message: string): void {
    this.options.log?.(`[web-bridge] ${message}`);
  }
}
