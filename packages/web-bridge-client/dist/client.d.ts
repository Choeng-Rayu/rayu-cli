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
import { type ActivityEvent, type BridgeDecision, type BridgeError, type CliHello, type HelloAck, type PlanRequest, type PromptCommand, type QuestionRequest, type StreamDeltaType, type StreamEnd, type ToolCallRequest } from "./protocol.js";
/**
 * Connection state, for a status indicator.
 *
 * `registering` is a distinct state on purpose. Between the socket handshake and
 * `hello_ack` the connection is authenticated but has no session id, so the studio
 * cannot list the machine and no prompt can be aimed at it. Collapsing that into
 * `connected` is what let the CLI report success while the studio correctly showed
 * nothing — both accurate, about different things. Only `connected` means usable.
 */
export type WebBridgeConnectionState = "idle" | "connecting" | "registering" | "connected" | "reconnecting" | "error";
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
export declare function bridgeOrigin(apiBaseUrl: string): string;
export declare class WebBridgeClient {
    private readonly options;
    private socket;
    private state;
    private currentSessionId;
    private closed;
    /** callIds already delivered to the host, newest last. See ANSWERED_CALL_MEMORY. */
    private readonly answered;
    private readonly answeredSet;
    /** Pending `hello_ack` retry, and how many attempts this connection has made. */
    private helloTimer;
    private helloAttempts;
    constructor(options: WebBridgeClientOptions);
    /** The backend-assigned session id, or null before the first `hello_ack`. */
    get sessionId(): string | null;
    get connectionState(): WebBridgeConnectionState;
    /** True once `hello_ack` has been received on the current socket. */
    get isRoutable(): boolean;
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
    connect(): Promise<boolean>;
    /**
     * Close the connection for good.
     *
     * Idempotent, and sets `closed` FIRST so an in-flight token refresh triggered by
     * `token_expired` cannot resurrect the socket after teardown.
     */
    stop(): void;
    /**
     * A streaming token.
     *
     * Clamped to the backend's cap. An oversized delta is not delayed, it is REJECTED
     * and dropped, so an unclamped frame would silently remove a chunk from the middle
     * of the answer the browser is watching.
     */
    streamDelta(delta: string, type?: StreamDeltaType): void;
    streamEnd(end?: StreamEnd): void;
    /**
     * Ask the browser for permission to run a tool.
     *
     * Returns false when the frame could not be sent — no connection, or a callId the
     * backend would reject. The caller MUST treat false as "the browser will never
     * answer this" and fall back to whatever gate it already had. Returning void here
     * would mean a permission request that blocks forever on a socket that was never
     * open, which is the worst failure this feature can have.
     */
    toolCall(request: ToolCallRequest): boolean;
    /** Ask the browser to approve a plan. Same false-means-unanswerable contract. */
    planRequest(request: PlanRequest): boolean;
    /** Ask the browser to answer an `AskUserQuestion` interview. */
    questionRequest(request: QuestionRequest): boolean;
    /**
     * Withdraw a pending approval.
     *
     * Also marks the callId answered locally, so a decision that was already in flight
     * when the request was cancelled does not get delivered to a gate that has moved on.
     */
    cancelRequest(callId: string): void;
    activity(event: ActivityEvent): void;
    interruptAck(): void;
    /**
     * Update the label shown in the studio's session picker.
     *
     * Implemented as a re-announce rather than a dedicated event, because the backend
     * has no `set_label` command and `registerCliSession` already upserts on
     * `(userId, machineId)` — so re-sending the handshake is the supported way to
     * change the row, and it reuses a path that is exercised on every reconnect.
     */
    setSessionLabel(label: string): void;
    private bind;
    /**
     * Read the canonical `BridgeDecision` shape.
     *
     * `behavior` is the discriminant and anything other than `allow` becomes `deny`.
     * Defaulting the other way would turn a malformed frame into an approval, and a
     * permission gate must fail closed.
     */
    private readDecision;
    /** The legacy narrow shape: `{ callId, decision, message }`. */
    private readLegacyDecision;
    /** Deliver at most one decision per callId. See the header note. */
    private deliverDecision;
    private rememberAnswered;
    /**
     * Announce this machine, and keep announcing until the backend acknowledges.
     *
     * Re-sent on EVERY connect, not just the first: the backend forgets the route when
     * a socket closes (`removeCliSession`), so a reconnected socket that does not
     * re-announce is authenticated, silent and unroutable.
     */
    private sendHelloWithRetry;
    private clearHelloTimer;
    private sendHello;
    /**
     * Tear down and rebuild the socket with a fresh token.
     *
     * A reconnect rather than an in-place auth update, because socket.io only reads
     * `auth` during a handshake — mutating it on a live socket changes nothing until
     * the next disconnect, which is exactly the moment the old token has already died.
     */
    private refreshAndReconnect;
    /** Never let a token provider's failure escape into a socket handler. */
    private safeToken;
    /** Emit a frame. Returns false when there is no live socket to emit on. */
    private emit;
    private setState;
    /** Run host code without letting it break the socket. */
    private guard;
    private log;
}
//# sourceMappingURL=client.d.ts.map