/**
 * SDK control/protocol types — now REAL types, inferred from the Zod schemas in
 * `@rayu-dev/agent-protocol`.
 *
 * ## History
 *
 * This file previously declared every one of these as `export type X = any`,
 * with a header explaining that the original shapes were "unknowable from the
 * partial source". That was the root cause of an entire class of bugs:
 *
 *  - The Rayucode extension could not import usable types from the engine, so it
 *    hand-wrote a copy of the protocol. Nothing verified the copy, and it drifted
 *    (see rayucode/TRIAGE.md D1–D3, D5, D8).
 *  - Casts like `foo as ApiKeySource` in engine code were completely unchecked,
 *    because casting to `any` always succeeds. That is exactly how the engine
 *    came to emit an `apiKeySource` value its own schema rejected (TRIAGE.md D9).
 *
 * The shapes were never actually unknowable — they are fully determined by the
 * Zod schemas the engine validates against at runtime. Extracting those schemas
 * into `@rayu-dev/agent-protocol` and inferring from them gives real types with
 * no duplication and no guesswork.
 *
 * Type-level only: every consumer uses `import type`, which Bun erases, so this
 * module contributes nothing to the bundle.
 */

export type {
  // --- Control protocol ---
  SDKControlRequest,
  SDKControlResponse,
  SDKControlPermissionRequest,
  StdoutMessage,
  StdinMessage,
  SDKControlCancelRequest,
  SDKControlRequestInner,

  // --- Additional control protocol messages ---
  SDKControlInitializeRequest,
  SDKControlInitializeResponse,
  SDKControlMcpSetServersResponse,
  SDKControlReloadPluginsResponse,
  SDKControlInterruptRequest,
  SDKControlSetModelRequest,
  SDKControlSetPermissionModeRequest,
  SDKControlMcpStatusResponse,

  // --- Status / model / session ---
  SDKStatus,
  SDKStatusMessage,
  ModelUsage,
  ModelInfo,
  ApiKeySource,
  ExitReason,
  SDKRateLimitInfo,
  RewindFilesResult,

  // --- Messages ---
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKToolProgressMessage,
  SDKUserMessageReplay,
  SDKAPIRetryMessage,
  SDKKeepAliveMessage,
  SDKUpdateEnvironmentVariablesMessage,

  // NOTE: SDKResultMessage / SDKResultSuccess / SDKResultError are exported by
  // `./coreTypes.js`, not here. `agentSdkTypes.ts` does `export *` from BOTH
  // modules, so exporting them in both places is an ambiguous re-export
  // (TS2308). They live in coreTypes.ts because they are core message shapes
  // rather than control-protocol envelopes.

  // --- Permissions ---
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKPermissionDenial,

  // --- MCP ---
  McpServerStatus,
  McpServerConfigForProcessTransport,

  // --- Hooks ---
  HookEvent,
  HookInput,
  HookJSONOutput,
  AsyncHookJSONOutput,
  SyncHookJSONOutput,
  ConfigChangeHookInput,
  CwdChangedHookInput,
  ElicitationHookInput,
  ElicitationResultHookInput,
  FileChangedHookInput,
  InstructionsLoadedHookInput,
  NotificationHookInput,
  PermissionDeniedHookInput,
  PermissionRequestHookInput,
  PostCompactHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  SetupHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TaskCompletedHookInput,
  TaskCreatedHookInput,
  TeammateIdleHookInput,
  UserPromptSubmitHookInput,
} from '@rayu-dev/agent-protocol'
