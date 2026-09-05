/**
 * `@rayu-dev/web-bridge-client` — the rayu-cli side of the rayu-backend Web Bridge.
 *
 * Consumed by BOTH workers that can be remote-controlled from the studio:
 *
 *   rayu/                        the interactive CLI REPL
 *   rayucode/packages/core       the VS Code extension host
 *
 * It lives at the git root, beside `packages/agent-protocol`, for the same reason
 * that package does (WORKSPACE.md §2): both sides consume it, so putting it under
 * either one would make the other reach across a boundary it does not own.
 *
 * It depends on nothing in this repository, so it cannot participate in a cycle.
 */
export { WEB_BRIDGE_WS_PATH, CLI_NAMESPACE, BROWSER_NAMESPACE, CLI_EVENT, CLI_COMMAND, MAX_PROMPT_CHARS, MAX_DELTA_CHARS, MAX_TEXT_CHARS, MAX_TOOL_INPUT_CHARS, MAX_HOSTNAME_CHARS, MAX_SESSION_LABEL_CHARS, MAX_CWD_CHARS, MAX_TOOL_NAME_CHARS, MAX_BLOCKED_PATH_CHARS, MAX_ACTIVITY_KIND_CHARS, MAX_FINISH_REASON_CHARS, MAX_QUESTIONS, MAX_OPTIONS, MACHINE_ID_PATTERN, CALL_ID_PATTERN, clampText, clampId, clampToolInput, isValidMachineId, isValidCallId, toCallId, } from "./protocol.js";
export type { CliEventName, CliCommandName, CliHello, HelloAck, StreamDelta, StreamDeltaType, StreamEnd, ToolCallRequest, ActivityEvent, PlanRequest, Question, QuestionOption, QuestionRequest, ToolDecision, BridgeDecision, PromptCommand, BridgeError, WebBridgeSessionStatus, WebBridgeSessionView, } from "./protocol.js";
export { WebBridgeClient, bridgeOrigin } from "./client.js";
export type { WebBridgeClientOptions, WebBridgeHandlers, WebBridgeConnectionState, } from "./client.js";
export { WebBridgePermissionRelay } from "./permissionRelay.js";
export { WEB_BRIDGE_STATE_FILE, defaultStateDir, generateMachineId, resolveMachineId, resolveHostname, } from "./machineId.js";
export type { WebBridgeState } from "./machineId.js";
//# sourceMappingURL=index.d.ts.map