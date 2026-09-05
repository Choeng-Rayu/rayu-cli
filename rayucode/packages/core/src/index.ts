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
} from "./protocol/wire.js";

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
} from "./protocol/wire.js";

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
} from "./protocol/wire.js";
export { PERMISSION_MODES, isPermissionMode } from "./protocol/wire.js";

// ----------------------------------------------------------------------------
// Protocol — version contract
// ----------------------------------------------------------------------------
//
// Re-exported from the single source of truth so the extension host and its
// tests compare against the SAME constant the decode boundary uses. Without
// this, a consumer importing from `@rayucode/core` silently got `undefined` and
// every version comparison would have been meaningless.
export {
  PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  StdoutMessageSchema,
  StdinMessageSchema,
  PermissionModeSchema,
} from "./protocol/wire.js";

// ----------------------------------------------------------------------------
// Protocol — wire metadata types (defined in @rayu-dev/agent-protocol)
// ----------------------------------------------------------------------------
export type {
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
} from "./protocol/wire.js";

// ----------------------------------------------------------------------------
// Protocol — local view types for OPAQUE payloads
// ----------------------------------------------------------------------------
//
// The wire contract types `message`, `event` and `usage` as opaque, because
// their shapes are owned by `@anthropic-ai/sdk`. These are this package's
// reading views of those blobs — not competing wire definitions. See
// protocol/contentBlocks.ts.
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
} from "./protocol/contentBlocks.js";

// ----------------------------------------------------------------------------
// Protocol — message type guards (task 1.2)
// ----------------------------------------------------------------------------
export {
  isSystemMessage,
  isSystemInit,
  isApiRetryMessage,
  isStatusMessage,
  isCompactBoundaryMessage,
  isPostTurnSummaryMessage,
  isToolProgressMessage,
  isResultSuccess,
  isResultError,
  isKeepAlive,
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
export {
  NdjsonCodec,
  createSchemaValidator,
  truncateForDiagnostics,
  MAX_DIAGNOSTIC_FRAME_CHARS,
} from "./protocol/ndjson.js";
export type {
  DecodeFailure,
  DecodeFailureKind,
  DecodeFailureHandler,
  DecodeIssue,
  ValidationResult,
  FrameValidator,
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
  EngineResolverLike,
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
// Web Bridge — remote control from the rayu-web studio
// ----------------------------------------------------------------------------
//
// The extension's half of the feature the rayu CLI REPL also has: the studio lists
// every signed-in worker and routes a browser prompt to the one the user picked. Both
// workers speak one protocol via `@rayu-dev/web-bridge-client`, so a browser tab
// cannot tell them apart.
//
// Editor-agnostic like everything else here (R13.1, R13.5): the VS Code host supplies
// the token and the activation lifecycle.
export { WebBridgeController } from "./webBridge/webBridgeController.js";
export type {
  WebBridgeControllerOptions,
  WebBridgeSessionHost,
} from "./webBridge/webBridgeController.js";

// ----------------------------------------------------------------------------
// CLI — bundled engine resolution & integrity verification
// ----------------------------------------------------------------------------
//
// Replaces the former `CliLocator`. The engine ships inside the VSIX, so there
// is nothing to locate; what remains is verifying that the shipped artifact is
// the one this extension was built against.
export {
  EngineResolver,
  EngineResolutionError,
  BUILD_INFO_FILENAME,
  defaultEngineDistDir,
  resolveEngineConfigDir,
  ensureFirstRunMarkerSuppressed,
} from "./cli/engineResolver.js";
export type {
  BuildInfo,
  EngineResolution,
  EngineResolverOptions,
  EngineFileSystem,
} from "./cli/engineResolver.js";

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
