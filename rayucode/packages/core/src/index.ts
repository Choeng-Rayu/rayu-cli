// @rayucode/core — editor-agnostic Core_Integration entry point.
//
// This package owns process lifecycle, the NDJSON control protocol, session
// state, and message streaming. It depends ONLY on the EditorAdapter interface
// and contains zero `vscode` imports (Requirements 13.1, 13.5).
//
// Tasks 1.2 and 1.3 add the protocol/control/permission types, the
// EditorAdapter boundary, and session-state shapes. Runtime components (codec,
// protocol client, permission coordinator, edit model, session manager) are
// added by later tasks.

/** Package identifier. Placeholder export so the module is valid and importable. */
export const CORE_PACKAGE_NAME = "@rayucode/core" as const;

// ----------------------------------------------------------------------------
// Protocol — message envelopes (task 1.2)
// ----------------------------------------------------------------------------
export type {
  SystemInit,
  AssistantMessage,
  StreamEvent,
  ResultMessage,
  ResultSubtype,
  KeepAliveMessage,
  UpdateEnvironmentVariablesMessage,
  StdinUserMessage,
  StdoutMessage,
  StdinMessage,
} from "./protocol/messages.js";

// ----------------------------------------------------------------------------
// Protocol — control envelopes, request/response subtypes (task 1.2)
// ----------------------------------------------------------------------------
export type {
  ControlRequest,
  ControlRequestInner,
  ControlResponse,
  ControlResponseOk,
  ControlResponseErr,
  ControlCancelRequest,
  CanUseToolRequest,
  InterruptRequest,
  SetModelRequest,
  SetPermissionModeRequest,
  McpStatusRequest,
  InitializeRequest,
  GetContextUsageRequest,
  InitializeResponse,
  McpStatusResponse,
  ContextUsageResponse,
} from "./protocol/control.js";

// ----------------------------------------------------------------------------
// Protocol — permissions (task 1.2)
// ----------------------------------------------------------------------------
export type {
  PermissionMode,
  PermissionBehavior,
  PermissionUpdateDestination,
  PermissionRuleValue,
  PermissionUpdate,
  PermissionToolOutput,
} from "./protocol/permissions.js";
export { PERMISSION_MODES, isPermissionMode } from "./protocol/permissions.js";

// ----------------------------------------------------------------------------
// Protocol — shared primitives (task 1.2)
// ----------------------------------------------------------------------------
export type {
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  ImageSource,
  ContentBlock,
  ApiAssistantMessage,
  MessageStartEvent,
  ContentBlockStartEvent,
  TextDelta,
  InputJsonDelta,
  ThinkingDelta,
  SignatureDelta,
  RawContentBlockDelta,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageStopEvent,
  RawMessageStreamEvent,
  Usage,
  ModelUsage,
  EffortLevel,
  ModelInfo,
  McpServerState,
  McpServerStatus,
  SlashCommand,
  AgentInfo,
  AccountInfo,
  PermissionDenial,
  AssistantError,
} from "./protocol/primitives.js";

// ----------------------------------------------------------------------------
// Protocol — message type guards (task 1.2)
// ----------------------------------------------------------------------------
export {
  isSystemInit,
  isAssistantMessage,
  isStreamEvent,
  isResultMessage,
  isControlRequest,
  isControlResponse,
  isControlCancelRequest,
} from "./protocol/guards.js";

// ----------------------------------------------------------------------------
// Protocol — NDJSON codec (task 2.1)
// ----------------------------------------------------------------------------
export { NdjsonCodec } from "./protocol/ndjson.js";
export type {
  MalformedLineHandler,
  NdjsonCodecOptions,
} from "./protocol/ndjson.js";

// ----------------------------------------------------------------------------
// Protocol — control protocol client (task 3.1)
// ----------------------------------------------------------------------------
export { ControlProtocolClient } from "./protocol/controlClient.js";
export type {
  ControlProtocolClientOptions,
  ControlClientEvents,
  ControlClientEventName,
  ControlClientListener,
  PermissionRequestEvent,
  ControlErrorEvent,
} from "./protocol/controlClient.js";

// ----------------------------------------------------------------------------
// Editor adapter boundary (task 1.3)
// ----------------------------------------------------------------------------
export type {
  EditorAdapter,
  AgentPanelHandle,
  Disposable,
  FileEditChange,
  FileEditPlan,
  ApplyResult,
  FileSnapshot,
  ContextOptions,
  WorkspaceSelection,
  WorkspaceContext,
} from "./editor/adapter.js";

// ----------------------------------------------------------------------------
// Session state (task 1.2)
// ----------------------------------------------------------------------------
export type {
  SessionStatus,
  ConversationItemBase,
  UserConversationItem,
  AssistantConversationItem,
  ToolActionStatus,
  ToolActionConversationItem,
  PermissionRequestConversationItem,
  UsageConversationItem,
  ErrorConversationItem,
  ConversationItem,
  PendingPermission,
  SessionState,
} from "./session/state.js";

// ----------------------------------------------------------------------------
// Session — conversation reducer & streaming assembler (task 4.1)
// ----------------------------------------------------------------------------
export {
  ConversationReducer,
  createConversationState,
  reduceConversation,
  appendUserPrompt,
} from "./session/reducer.js";
export type { ConversationReducerState } from "./session/reducer.js";

// ----------------------------------------------------------------------------
// Session — in-memory session store / history retention (task 10.1)
// ----------------------------------------------------------------------------
export { SessionStore, SessionStoreEntry } from "./session/sessionStore.js";
export type {
  SessionStoreOptions,
  HistorySnapshotBuilder,
} from "./session/sessionStore.js";

// ----------------------------------------------------------------------------
// Session — session manager (task 10.3)
// ----------------------------------------------------------------------------
export {
  SessionManager,
  buildContextPreamble,
  SETTING_INCLUDE_ACTIVE_FILE,
  SETTING_INCLUDE_SELECTION,
  SETTING_UNRESPONSIVE_TIMEOUT_MS,
  SETTING_PERMISSION_MODE,
  DEFAULT_UNRESPONSIVE_TIMEOUT_MS,
} from "./session/sessionManager.js";
export type {
  SessionManagerOptions,
  AgentProcessLike,
  AgentProcessFactory,
  AgentProcessFactoryOptions,
  CliLocatorLike,
  TimerProvider,
  PanelOutboundMessage,
} from "./session/sessionManager.js";

// ----------------------------------------------------------------------------
// Permission — auto-approval policy & coordinator (task 5.1, 5.2)
// ----------------------------------------------------------------------------
export {
  shouldAutoApprove,
  categorizeTool,
  decidePermission,
} from "./permission/policy.js";
export type { ToolCategory, PermissionDecision } from "./permission/policy.js";
export { PermissionCoordinator } from "./permission/coordinator.js";
export type { PermissionCoordinatorOptions } from "./permission/coordinator.js";

// ----------------------------------------------------------------------------
// Edit — proposal model, pure apply engine, content hash (task 6.1)
// ----------------------------------------------------------------------------
export { hashContent } from "./edit/contentHash.js";
export { applyEditPlan } from "./edit/applyEngine.js";
export type {
  FileModel,
  FailurePredicate,
  ApplyEngineOptions,
  ApplyEngineResult,
} from "./edit/applyEngine.js";
export { EditProposalModel, isEditToolName } from "./edit/proposalModel.js";
export type {
  BaseContentProvider,
  EditProposalModelOptions,
} from "./edit/proposalModel.js";

// ----------------------------------------------------------------------------
// Redaction — credential redaction filter (task 7.1)
// ----------------------------------------------------------------------------
export { Redactor, redactSecrets, REDACTION_PLACEHOLDER } from "./redaction/redactor.js";
export type { RedactorOptions } from "./redaction/redactor.js";

// ----------------------------------------------------------------------------
// CLI — executable location & version resolution (task 9.1)
// ----------------------------------------------------------------------------
export {
  CliLocator,
  MINIMUM_RAYU_VERSION,
  RAYU_BINARY_NAME,
  CLI_PATH_SETTING,
  compareVersions,
  extractVersionToken,
} from "./cli/cliLocator.js";
export type {
  CliResolution,
  CliLocatorOptions,
  VersionRunner,
  PathProbe,
} from "./cli/cliLocator.js";

// ----------------------------------------------------------------------------
// CLI — agent process lifecycle (task 9.3)
// ----------------------------------------------------------------------------
export {
  AgentProcess,
  AGENT_STREAMING_ARGS,
  DEFAULT_TERMINATE_GRACE_MS,
} from "./cli/agentProcess.js";
export type {
  AgentProcessOptions,
  AgentExitInfo,
  AgentSpawnOptions,
  SpawnFn,
  ChildProcessLike,
  ChildStdinLike,
  ChildReadableLike,
  StdoutMessageListener,
  ExitListener,
} from "./cli/agentProcess.js";
