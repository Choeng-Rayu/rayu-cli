/**
 * The Web Bridge wire protocol, rayu-cli side.
 *
 * A DELIBERATE MIRROR of rayu-backend/src/web-bridge/web-bridge.types.ts, and the
 * third copy of it — the browser holds the second in
 * rayu-web/studio/lib/webBridge/webBridgeTypes.ts. That file's header explains the
 * choice and it applies here for the same reason: rayu-cli and rayu-backend deploy
 * and version independently, so a shared module would be a build-time coupling
 * between two things that are only ever coupled at runtime. A CLI cannot be blocked
 * on a backend release, and a user running last month's CLI must still connect.
 *
 * This is NOT the same situation as `@rayu-dev/agent-protocol`, which is a shared
 * package rather than a copy. That protocol crosses a pipe between two artifacts
 * built from ONE repository at ONE commit, so a single definition is achievable and
 * a mismatch is a packaging bug. This one crosses a network between independently
 * released services, where version skew is normal operation.
 *
 * The copy is not trusted to stay correct by inspection: test/protocolParity.test.ts
 * reads the backend file and asserts every constant here matches it. If these ever
 * drift the symptom is an event that arrives and is silently ignored — the failure
 * mode a test has to catch, because nothing about it looks like an error at runtime.
 *
 * WHAT LIVES HERE: event names, payload shapes, and the size caps the backend
 * enforces. Nothing else. No socket, no auth, no I/O — so the parity test and the
 * clamping helpers can be exercised without a network.
 */
/**
 * socket.io HTTP path. **Must stay under `/api/`.**
 *
 * The production reverse proxy routes `/api/*` to rayu-backend and everything else
 * to the Next.js site. socket.io's default path is `/socket.io/`, which would be
 * handed to Next.js and 404 — the handshake would fail in production while working
 * perfectly against a local backend on port 4000. That is the failure this constant
 * exists to prevent, so it is spelled out rather than defaulted.
 */
export declare const WEB_BRIDGE_WS_PATH = "/api/rayu-ws";
/**
 * The namespace rayu-cli connects to.
 *
 * NOT `/web-bridge` — that is the browser's namespace. Connecting to the wrong one
 * authenticates successfully and then receives nothing, because the browser gateway
 * has no `cli_hello` handler. Worth stating because the two strings are similar and
 * the mistake produces no error.
 */
export declare const CLI_NAMESPACE = "/cli-bridge";
/** The namespace the BROWSER connects to. Here only so the contrast is documented. */
export declare const BROWSER_NAMESPACE = "/web-bridge";
/** Events rayu-cli SENDS to the backend. */
export declare const CLI_EVENT: {
    readonly CLI_HELLO: "cli_hello";
    readonly STREAM_DELTA: "stream_delta";
    readonly STREAM_END: "stream_end";
    readonly TOOL_CALL: "tool_call";
    readonly ACTIVITY: "activity";
    readonly PLAN_REQUEST: "plan_request";
    readonly QUESTION_REQUEST: "question_request";
    /** A pending approval is no longer answerable. See CLI_COMMAND docs. */
    readonly CANCEL_REQUEST: "cancel_request";
    readonly INTERRUPT_ACK: "interrupt_ack";
};
/** Events rayu-cli RECEIVES from the backend. */
export declare const CLI_COMMAND: {
    /** Handshake accepted; carries the server-assigned sessionId. */
    readonly HELLO_ACK: "hello_ack";
    readonly PROMPT: "prompt";
    /**
     * The answer to any pending approval, as a {@link BridgeDecision}.
     *
     * ONE event for tool, plan and question decisions, because rayu-cli has exactly
     * one `sendResponse(requestId, BridgePermissionResponse)`. The three narrower
     * events below are legacy convenience wrappers the backend translates into this;
     * a client should prefer this one and treat the others as aliases.
     */
    readonly DECISION: "bridge_decision";
    readonly TOOL_DECISION: "tool_decision";
    readonly INTERRUPT: "interrupt";
    readonly PLAN_DECISION: "plan_decision";
    readonly QUESTION_ANSWER: "question_answer";
    /** Emitted ~60s before the presented JWT dies, so a refresh can beat the drop. */
    readonly TOKEN_EXPIRED: "token_expired";
    readonly BRIDGE_ERROR: "bridge_error";
};
export type CliEventName = (typeof CLI_EVENT)[keyof typeof CLI_EVENT];
export type CliCommandName = (typeof CLI_COMMAND)[keyof typeof CLI_COMMAND];
/** What rayu-cli announces on connect. Until this is sent the socket is unroutable. */
export interface CliHello {
    machineId: string;
    hostname: string;
    cwd: string;
    pid?: number;
    sessionLabel?: string;
}
/** The backend's reply to `cli_hello`. `sessionId` is what later events correlate on. */
export interface HelloAck {
    sessionId: string;
    session?: WebBridgeSessionView;
}
export type StreamDeltaType = "text" | "thinking";
export interface StreamDelta {
    delta: string;
    type: StreamDeltaType;
}
export interface StreamEnd {
    finishReason?: string;
    /** Provider token usage, passed through verbatim; shape is provider-defined. */
    usage?: Record<string, number>;
}
export interface ToolCallRequest {
    callId: string;
    toolName: string;
    toolInput: unknown;
    /** The agent's own one-line justification, shown above the input preview. */
    description?: string;
    /** rayu-cli's `toolUseId`, echoed so the browser can correlate without a lookup. */
    toolUseId?: string;
    /** Rules the CLI proposes granting — what a "don't ask again" checkbox applies. */
    permissionSuggestions?: unknown[];
    /** Set when the tool was refused for touching a path outside the workspace. */
    blockedPath?: string;
}
export interface ActivityEvent {
    kind: string;
    summary: string;
}
export interface PlanRequest {
    callId: string;
    plan: string;
}
export interface QuestionOption {
    label: string;
    description?: string;
}
export interface Question {
    question: string;
    header?: string;
    options: QuestionOption[];
    /** When true the user may pick several options. */
    multiSelect?: boolean;
}
/**
 * An `AskUserQuestion` interview.
 *
 * PLURAL: the tool takes an ARRAY of questions, each with its own options and its
 * own multi-select flag, and answers come back keyed by question text.
 */
export interface QuestionRequest {
    callId: string;
    questions: Question[];
    /**
     * The tool input the CLI was asked about, passed through so the browser can
     * return `updatedInput` as `{ ...toolInput, answers }` — which is HOW the answers
     * reach the tool.
     */
    toolInput?: unknown;
}
export type ToolDecision = "allow" | "deny";
/**
 * The ONE decision shape, matching rayu-cli's `BridgePermissionResponse` field for
 * field (rayu/src/bridge/bridgePermissionCallbacks.ts).
 *
 * Tool approval, plan approval and `AskUserQuestion` are three renderings of one
 * decision channel, all answered through the same `sendResponse` call. The optional
 * fields each carry something a boolean cannot: `message` is the "why" of a denial
 * that the model reads, `updatedPermissions` names a persisted allow-rule or a mode
 * change, and `updatedInput` is how interview answers travel.
 */
export interface BridgeDecision {
    callId: string;
    behavior: ToolDecision;
    message?: string;
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: unknown[];
}
/** A prompt pushed down from a browser tab. */
export interface PromptCommand {
    sessionId?: string;
    text: string;
    /** Base64 attachments, if the composer sent any. Opaque to the transport. */
    attachments?: unknown[];
}
/** The backend refused a frame, or could not route one. */
export interface BridgeError {
    message: string;
}
export type WebBridgeSessionStatus = "live" | "idle" | "offline";
/** A session as the browser sees it. Returned inside {@link HelloAck}. */
export interface WebBridgeSessionView {
    id: string;
    machineId: string;
    hostname: string;
    cwd: string;
    sessionLabel: string | null;
    pid: number | null;
    isAttached: boolean;
    status: WebBridgeSessionStatus;
    lastSeenAt: string;
}
/** Longest prompt a browser may send (inbound; here for completeness). */
export declare const MAX_PROMPT_CHARS = 32000;
/** Longest single streaming delta. */
export declare const MAX_DELTA_CHARS = 16000;
/** Longest plan / question / activity text. */
export declare const MAX_TEXT_CHARS = 32000;
/** Serialised size ceiling for a tool's input preview. */
export declare const MAX_TOOL_INPUT_CHARS = 64000;
/** `machineId` must match this or the handshake is rejected. */
export declare const MACHINE_ID_PATTERN: RegExp;
/** `callId` must match this or the frame is rejected. */
export declare const CALL_ID_PATTERN: RegExp;
/** Longest `hostname` the backend stores (its column width). */
export declare const MAX_HOSTNAME_CHARS = 191;
/** Longest `sessionLabel` the backend stores. */
export declare const MAX_SESSION_LABEL_CHARS = 191;
/** `cwd` is truncated rather than rejected by the backend; do the same here. */
export declare const MAX_CWD_CHARS = 512;
/** Longest `toolName`. */
export declare const MAX_TOOL_NAME_CHARS = 128;
/** Longest `blockedPath`. */
export declare const MAX_BLOCKED_PATH_CHARS = 1024;
/** Longest `activity.kind`. */
export declare const MAX_ACTIVITY_KIND_CHARS = 64;
/** Longest `finishReason`. */
export declare const MAX_FINISH_REASON_CHARS = 64;
/** Questions per interview, and options per question. */
export declare const MAX_QUESTIONS = 12;
export declare const MAX_OPTIONS = 24;
/**
 * Truncate a string to `max`, marking the cut.
 *
 * The marker is not decoration. A silently truncated tool input looks like a tool
 * that was called with different arguments than it really was, and consent given on
 * that basis is consent to something the user did not see. Saying so is the minimum.
 */
export declare function clampText(value: string, max: number): string;
/**
 * Truncate WITHOUT a marker, for fields where the marker would itself be wrong.
 *
 * A `cwd` or `hostname` is an identifier, not prose: appending an explanation to it
 * produces a value that no longer identifies anything. The backend truncates `cwd`
 * the same way for the same reason.
 */
export declare function clampId(value: string, max: number): string;
/**
 * Reduce a tool input until it serialises within `MAX_TOOL_INPUT_CHARS`.
 *
 * Returns the value unchanged when it already fits, and otherwise a REPLACEMENT
 * object naming the tool and the size rather than a mangled half of the original.
 * Partial JSON is the one outcome to avoid here: it would render in the approval
 * card as a complete-looking argument list that is missing fields, which is a worse
 * basis for consent than an explicit "too large to display".
 */
export declare function clampToolInput(value: unknown, max?: number): unknown;
/** True when `id` is acceptable to the backend as a `machineId`. */
export declare function isValidMachineId(id: string): boolean;
/** True when `id` is acceptable to the backend as a `callId`. */
export declare function isValidCallId(id: string): boolean;
/**
 * Coerce an arbitrary request id into the backend's `callId` charset.
 *
 * rayu-cli mints permission request ids internally and is not obliged to keep them
 * URL-safe. A rejected `callId` would mean a permission prompt that never reaches
 * the browser while the CLI blocks forever waiting for an answer, so the id is
 * rewritten rather than gambled on. Disallowed characters become `-`, which is
 * collision-safe in practice because the source ids are already unique per session
 * and the mapping is applied consistently in both directions.
 */
export declare function toCallId(requestId: string): string;
//# sourceMappingURL=protocol.d.ts.map