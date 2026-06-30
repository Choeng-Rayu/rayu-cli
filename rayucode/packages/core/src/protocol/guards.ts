// Small runtime type guards over the inbound `StdoutMessage` union.
//
// These narrow a received message by its `type` discriminant so the protocol
// client can dispatch without hand-written casts. Pure predicates only — no
// protocol logic.

import type {
  ControlCancelRequest,
  ControlRequest,
  ControlResponse,
} from "./control.js";
import type {
  AssistantMessage,
  ResultMessage,
  StdoutMessage,
  StreamEvent,
  SystemInit,
} from "./messages.js";

/** Narrows to the `system/init` announcement. */
export function isSystemInit(message: StdoutMessage): message is SystemInit {
  return message.type === "system";
}

/** Narrows to a complete assistant message. */
export function isAssistantMessage(
  message: StdoutMessage,
): message is AssistantMessage {
  return message.type === "assistant";
}

/** Narrows to a streaming content delta. */
export function isStreamEvent(message: StdoutMessage): message is StreamEvent {
  return message.type === "stream_event";
}

/** Narrows to a terminal result message. */
export function isResultMessage(
  message: StdoutMessage,
): message is ResultMessage {
  return message.type === "result";
}

/** Narrows to a control request (e.g. an inbound `can_use_tool`). */
export function isControlRequest(
  message: StdoutMessage,
): message is ControlRequest {
  return message.type === "control_request";
}

/** Narrows to a control response correlated to a host-initiated request. */
export function isControlResponse(
  message: StdoutMessage,
): message is ControlResponse {
  return message.type === "control_response";
}

/** Narrows to a control-request cancellation. */
export function isControlCancelRequest(
  message: StdoutMessage,
): message is ControlCancelRequest {
  return message.type === "control_cancel_request";
}
