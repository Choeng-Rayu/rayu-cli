/**
 * `src/webBridge/client` — the rayu side of the rayu-backend Web Bridge.
 *
 * The socket client, wire protocol and permission relay that let the rayu-web
 * studio drive a local session remotely. `src/webBridge/webBridgeSession.ts` is
 * its consumer; see that file for how a browser prompt reaches the REPL queue.
 *
 * Was `@rayu-dev/web-bridge-client` at the git root, positioned there so the
 * previous VS Code extension could consume it alongside the CLI. With both
 * consumers now built from `rayu/src` it belongs beside its consumer instead.
 *
 * It imports nothing else from this repository, so it cannot participate in a
 * cycle. `socket.io-client` is its only external dependency.
 */

export {
  WEB_BRIDGE_WS_PATH,
  CLI_NAMESPACE,
  BROWSER_NAMESPACE,
  CLI_EVENT,
  CLI_COMMAND,
  MAX_PROMPT_CHARS,
  MAX_DELTA_CHARS,
  MAX_TEXT_CHARS,
  MAX_TOOL_INPUT_CHARS,
  MAX_HOSTNAME_CHARS,
  MAX_SESSION_LABEL_CHARS,
  MAX_CWD_CHARS,
  MAX_TOOL_NAME_CHARS,
  MAX_BLOCKED_PATH_CHARS,
  MAX_ACTIVITY_KIND_CHARS,
  MAX_FINISH_REASON_CHARS,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  MACHINE_ID_PATTERN,
  CALL_ID_PATTERN,
  clampText,
  clampId,
  clampToolInput,
  isValidMachineId,
  isValidCallId,
  toCallId,
} from "./protocol.js";

export type {
  CliEventName,
  CliCommandName,
  CliHello,
  HelloAck,
  StreamDelta,
  StreamDeltaType,
  StreamEnd,
  ToolCallRequest,
  ActivityEvent,
  PlanRequest,
  Question,
  QuestionOption,
  QuestionRequest,
  ToolDecision,
  BridgeDecision,
  PromptCommand,
  BridgeError,
  WebBridgeSessionStatus,
  WebBridgeSessionView,
} from "./protocol.js";

export { WebBridgeClient, bridgeOrigin } from "./client.js";
export type {
  WebBridgeClientOptions,
  WebBridgeHandlers,
  WebBridgeConnectionState,
} from "./client.js";

export { WebBridgePermissionRelay } from "./permissionRelay.js";

export {
  WEB_BRIDGE_STATE_FILE,
  defaultStateDir,
  generateMachineId,
  resolveMachineId,
  resolveHostname,
} from "./machineId.js";
export type { WebBridgeState } from "./machineId.js";
