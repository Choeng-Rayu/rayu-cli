// Runtime type guards over the inbound `StdoutMessage` union.
//
// ## The bug these guards exist to prevent
//
// The previous implementation was:
//
//     export function isSystemInit(m: StdoutMessage): m is SystemInit {
//       return m.type === "system";        // <-- no subtype check
//     }
//
// The engine emits at least FIVE distinct messages with `type: "system"`:
// `init`, `api_retry`, `status`, `compact_boundary` and `post_turn_summary`.
// All five satisfied that predicate, so all five were dispatched to the
// `systemInit` handler, which then assigned `undefined` over the session's
// model and permission mode.
//
// Reproduced against the real engine: one authentication-failure run emitted
// `system/init` followed by NINE `system/api_retry` frames, so the init handler
// ran ten times and the model indicator blanked mid-turn (TRIAGE.md D1).
//
// Every guard below therefore narrows on BOTH `type` and, where the type is
// shared, `subtype`.
//
// Pure predicates only — no protocol logic, no side effects.

import type {
  ApiRetryMessage,
  AuthStatusMessage,
  RateLimitEvent,
  AssistantMessage,
  CompactBoundaryMessage,
  ControlCancelRequest,
  ControlRequest,
  ControlResponse,
  KeepAliveMessage,
  PostTurnSummaryMessage,
  ResultError,
  ResultMessage,
  ResultSuccess,
  StatusMessage,
  StdoutMessage,
  StreamEvent,
  SystemInit,
  ToolProgressMessage,
} from "./wire.js";

/**
 * A minimal structural view for reading the discriminants off an arbitrary
 * frame. The union members do not all declare `subtype`, so narrowing reads go
 * through this instead of a cast at each call site.
 */
type Discriminated = { type?: unknown; subtype?: unknown };

function typeOf(message: StdoutMessage): unknown {
  return (message as Discriminated).type;
}

function subtypeOf(message: StdoutMessage): unknown {
  return (message as Discriminated).subtype;
}

// ----------------------------------------------------------------------------
// `system` family — ALWAYS discriminate on `subtype` as well
// ----------------------------------------------------------------------------

/** True for any `type: "system"` frame, regardless of subtype. */
export function isSystemMessage(message: StdoutMessage): boolean {
  return typeOf(message) === "system";
}

/**
 * Narrows to the `system/init` session announcement.
 *
 * Checks `subtype` — see the note at the top of this file for why.
 */
export function isSystemInit(message: StdoutMessage): message is SystemInit {
  return typeOf(message) === "system" && subtypeOf(message) === "init";
}

/**
 * Narrows to `system/api_retry`.
 *
 * Carries `error_status` (e.g. `401`) and `error` (e.g.
 * `"authentication_failed"`). Surfacing this is what turns a blank, silent
 * panel into an actionable authentication error (TRIAGE.md D2).
 */
export function isApiRetryMessage(
  message: StdoutMessage,
): message is ApiRetryMessage {
  return typeOf(message) === "system" && subtypeOf(message) === "api_retry";
}

/** Narrows to `system/status`. */
export function isStatusMessage(
  message: StdoutMessage,
): message is StatusMessage {
  return typeOf(message) === "system" && subtypeOf(message) === "status";
}

/** Narrows to `system/compact_boundary`. */
export function isCompactBoundaryMessage(
  message: StdoutMessage,
): message is CompactBoundaryMessage {
  return (
    typeOf(message) === "system" && subtypeOf(message) === "compact_boundary"
  );
}

/** Narrows to `system/post_turn_summary`. */
export function isPostTurnSummaryMessage(
  message: StdoutMessage,
): message is PostTurnSummaryMessage {
  return (
    typeOf(message) === "system" && subtypeOf(message) === "post_turn_summary"
  );
}

// ----------------------------------------------------------------------------
// Conversation messages
// ----------------------------------------------------------------------------

/** Narrows to a complete assistant message. */
export function isAssistantMessage(
  message: StdoutMessage,
): message is AssistantMessage {
  return typeOf(message) === "assistant";
}

/** Narrows to a streaming content delta. */
export function isStreamEvent(message: StdoutMessage): message is StreamEvent {
  return typeOf(message) === "stream_event";
}

/** Narrows to a rate-limit notice from the model provider. */
export function isRateLimitEvent(
  message: StdoutMessage,
): message is RateLimitEvent {
  return typeOf(message) === "rate_limit_event";
}

/** Narrows to an authentication status change. */
export function isAuthStatusMessage(
  message: StdoutMessage,
): message is AuthStatusMessage {
  return typeOf(message) === "auth_status";
}

/** Narrows to live progress for an in-flight tool call. */
export function isToolProgressMessage(
  message: StdoutMessage,
): message is ToolProgressMessage {
  return typeOf(message) === "tool_progress";
}

// ----------------------------------------------------------------------------
// Turn results
// ----------------------------------------------------------------------------

/** Narrows to a terminal result message (either variant of the union). */
export function isResultMessage(
  message: StdoutMessage,
): message is ResultMessage {
  return typeOf(message) === "result";
}

/**
 * Narrows to the SUCCESS variant, which guarantees `result: string`.
 *
 * The error variant has no `result` field at all, so this check is required
 * before reading it.
 */
export function isResultSuccess(
  message: StdoutMessage,
): message is ResultSuccess {
  return typeOf(message) === "result" && subtypeOf(message) === "success";
}

/**
 * Narrows to the ERROR variant, which guarantees `errors: string[]`.
 *
 * That array is the only place a turn's failure reason appears. The previous
 * hand-written `ResultMessage` had no field for it, so failures rendered with
 * no explanation (TRIAGE.md D3).
 */
export function isResultError(message: StdoutMessage): message is ResultError {
  return (
    typeOf(message) === "result" &&
    typeof subtypeOf(message) === "string" &&
    subtypeOf(message) !== "success"
  );
}

// ----------------------------------------------------------------------------
// Control protocol
// ----------------------------------------------------------------------------

/** Narrows to a control request (e.g. an inbound `can_use_tool`). */
export function isControlRequest(
  message: StdoutMessage,
): message is ControlRequest {
  return typeOf(message) === "control_request";
}

/** Narrows to a control response correlated to a host-initiated request. */
export function isControlResponse(
  message: StdoutMessage,
): message is ControlResponse {
  return typeOf(message) === "control_response";
}

/** Narrows to a control-request cancellation. */
export function isControlCancelRequest(
  message: StdoutMessage,
): message is ControlCancelRequest {
  return typeOf(message) === "control_cancel_request";
}

// ----------------------------------------------------------------------------
// Transport housekeeping
// ----------------------------------------------------------------------------

/** Narrows to a keep-alive heartbeat, which carries no host-side action. */
export function isKeepAlive(
  message: StdoutMessage,
): message is KeepAliveMessage {
  return typeOf(message) === "keep_alive";
}
