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
// --- Addressing --------------------------------------------------------------
/**
 * socket.io HTTP path. **Must stay under `/api/`.**
 *
 * The production reverse proxy routes `/api/*` to rayu-backend and everything else
 * to the Next.js site. socket.io's default path is `/socket.io/`, which would be
 * handed to Next.js and 404 — the handshake would fail in production while working
 * perfectly against a local backend on port 4000. That is the failure this constant
 * exists to prevent, so it is spelled out rather than defaulted.
 */
export const WEB_BRIDGE_WS_PATH = "/api/rayu-ws";
/**
 * The namespace rayu-cli connects to.
 *
 * NOT `/web-bridge` — that is the browser's namespace. Connecting to the wrong one
 * authenticates successfully and then receives nothing, because the browser gateway
 * has no `cli_hello` handler. Worth stating because the two strings are similar and
 * the mistake produces no error.
 */
export const CLI_NAMESPACE = "/cli-bridge";
/** The namespace the BROWSER connects to. Here only so the contrast is documented. */
export const BROWSER_NAMESPACE = "/web-bridge";
// --- Events ------------------------------------------------------------------
/** Events rayu-cli SENDS to the backend. */
export const CLI_EVENT = {
    CLI_HELLO: "cli_hello",
    STREAM_DELTA: "stream_delta",
    STREAM_END: "stream_end",
    TOOL_CALL: "tool_call",
    ACTIVITY: "activity",
    PLAN_REQUEST: "plan_request",
    QUESTION_REQUEST: "question_request",
    /** A pending approval is no longer answerable. See CLI_COMMAND docs. */
    CANCEL_REQUEST: "cancel_request",
    INTERRUPT_ACK: "interrupt_ack",
};
/** Events rayu-cli RECEIVES from the backend. */
export const CLI_COMMAND = {
    /** Handshake accepted; carries the server-assigned sessionId. */
    HELLO_ACK: "hello_ack",
    PROMPT: "prompt",
    /**
     * The answer to any pending approval, as a {@link BridgeDecision}.
     *
     * ONE event for tool, plan and question decisions, because rayu-cli has exactly
     * one `sendResponse(requestId, BridgePermissionResponse)`. The three narrower
     * events below are legacy convenience wrappers the backend translates into this;
     * a client should prefer this one and treat the others as aliases.
     */
    DECISION: "bridge_decision",
    TOOL_DECISION: "tool_decision",
    INTERRUPT: "interrupt",
    PLAN_DECISION: "plan_decision",
    QUESTION_ANSWER: "question_answer",
    /** Emitted ~60s before the presented JWT dies, so a refresh can beat the drop. */
    TOKEN_EXPIRED: "token_expired",
    BRIDGE_ERROR: "bridge_error",
};
// --- Limits ------------------------------------------------------------------
//
// These mirror the caps enforced in rayu-backend/src/web-bridge/web-bridge.validate.ts.
// They are duplicated here so this client can CLAMP its own outbound frames instead
// of discovering the limit as a `bridge_error`. That matters for a specific reason:
// the backend answers an oversized frame with an error and drops it, so an
// unclamped 20 KB `stream_delta` does not arrive late — it never arrives, and the
// browser shows a turn that silently loses a chunk of its middle.
/** Longest prompt a browser may send (inbound; here for completeness). */
export const MAX_PROMPT_CHARS = 32_000;
/** Longest single streaming delta. */
export const MAX_DELTA_CHARS = 16_000;
/** Longest plan / question / activity text. */
export const MAX_TEXT_CHARS = 32_000;
/** Serialised size ceiling for a tool's input preview. */
export const MAX_TOOL_INPUT_CHARS = 64_000;
/** `machineId` must match this or the handshake is rejected. */
export const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
/** `callId` must match this or the frame is rejected. */
export const CALL_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;
/** Longest `hostname` the backend stores (its column width). */
export const MAX_HOSTNAME_CHARS = 191;
/** Longest `sessionLabel` the backend stores. */
export const MAX_SESSION_LABEL_CHARS = 191;
/** `cwd` is truncated rather than rejected by the backend; do the same here. */
export const MAX_CWD_CHARS = 512;
/** Longest `toolName`. */
export const MAX_TOOL_NAME_CHARS = 128;
/** Longest `blockedPath`. */
export const MAX_BLOCKED_PATH_CHARS = 1_024;
/** Longest `activity.kind`. */
export const MAX_ACTIVITY_KIND_CHARS = 64;
/** Longest `finishReason`. */
export const MAX_FINISH_REASON_CHARS = 64;
/** Questions per interview, and options per question. */
export const MAX_QUESTIONS = 12;
export const MAX_OPTIONS = 24;
// --- Clamping ----------------------------------------------------------------
/**
 * Truncate a string to `max`, marking the cut.
 *
 * The marker is not decoration. A silently truncated tool input looks like a tool
 * that was called with different arguments than it really was, and consent given on
 * that basis is consent to something the user did not see. Saying so is the minimum.
 */
export function clampText(value, max) {
    if (value.length <= max)
        return value;
    const marker = `…[truncated ${value.length - max} chars]`;
    // Reserve room for the marker so the result still respects `max`.
    const keep = Math.max(0, max - marker.length);
    return value.slice(0, keep) + marker;
}
/**
 * Truncate WITHOUT a marker, for fields where the marker would itself be wrong.
 *
 * A `cwd` or `hostname` is an identifier, not prose: appending an explanation to it
 * produces a value that no longer identifies anything. The backend truncates `cwd`
 * the same way for the same reason.
 */
export function clampId(value, max) {
    return value.length <= max ? value : value.slice(0, max);
}
/**
 * Reduce a tool input until it serialises within `MAX_TOOL_INPUT_CHARS`.
 *
 * Returns the value unchanged when it already fits, and otherwise a REPLACEMENT
 * object naming the tool and the size rather than a mangled half of the original.
 * Partial JSON is the one outcome to avoid here: it would render in the approval
 * card as a complete-looking argument list that is missing fields, which is a worse
 * basis for consent than an explicit "too large to display".
 */
export function clampToolInput(value, max = MAX_TOOL_INPUT_CHARS) {
    let serialised;
    try {
        serialised = JSON.stringify(value ?? null) ?? "null";
    }
    catch {
        return { _unserialisable: true };
    }
    if (serialised.length <= max)
        return value ?? null;
    return {
        _truncated: true,
        _serialisedChars: serialised.length,
        _limit: max,
        _note: "Tool input was too large to relay to the web bridge. Review this action at the terminal.",
    };
}
/** True when `id` is acceptable to the backend as a `machineId`. */
export function isValidMachineId(id) {
    return MACHINE_ID_PATTERN.test(id);
}
/** True when `id` is acceptable to the backend as a `callId`. */
export function isValidCallId(id) {
    return CALL_ID_PATTERN.test(id);
}
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
export function toCallId(requestId) {
    const mapped = requestId.replace(/[^A-Za-z0-9_:.-]/g, "-").slice(0, 128);
    // A pathological id that mapped to nothing still has to be routable.
    return mapped.length > 0 ? mapped : "call";
}
//# sourceMappingURL=protocol.js.map