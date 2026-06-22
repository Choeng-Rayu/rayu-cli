// Reconstructed SDK control/protocol types — absent from the leaked source.
//
// These were never bundled (all consumers import them `import type`, which Bun
// erases), so this file only exists to satisfy `tsc`. The original shapes are
// derived from zod schemas at runtime; here they are reconstructed permissively
// (`any`) because their exact structure is unknowable from the partial source
// and they are purely type-level. agentSdkTypes.ts re-exports these.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any

// --- Control protocol ---
export type SDKControlRequest = any
export type SDKControlResponse = any
export type SDKControlPermissionRequest = any
export type StdoutMessage = any

// --- Status / model / session ---
export type SDKStatus = any
export type SDKStatusMessage = any
export type ModelUsage = any
export type ModelInfo = any
export type ApiKeySource = any
export type ExitReason = any
export type SDKRateLimitInfo = any
export type RewindFilesResult = any

// --- Messages ---
export type SDKAssistantMessage = any
export type SDKAssistantMessageError = any
export type SDKPartialAssistantMessage = any
export type SDKSystemMessage = any
export type SDKCompactBoundaryMessage = any
export type SDKToolProgressMessage = any
export type SDKUserMessageReplay = any

// --- Permissions ---
export type PermissionMode = any
export type PermissionResult = any
export type PermissionUpdate = any
export type SDKPermissionDenial = any

// --- MCP ---
export type McpServerStatus = any
export type McpServerConfigForProcessTransport = any

// --- Hooks ---
export type HookEvent = any
export type HookInput = any
export type HookJSONOutput = any
export type AsyncHookJSONOutput = any
export type SyncHookJSONOutput = any
export type ConfigChangeHookInput = any
export type CwdChangedHookInput = any
export type ElicitationHookInput = any
export type ElicitationResultHookInput = any
export type FileChangedHookInput = any
export type InstructionsLoadedHookInput = any
export type NotificationHookInput = any
export type PermissionDeniedHookInput = any
export type PermissionRequestHookInput = any
export type PostCompactHookInput = any
export type PostToolUseFailureHookInput = any
export type PostToolUseHookInput = any
export type PreCompactHookInput = any
export type PreToolUseHookInput = any
export type SessionEndHookInput = any
export type SessionStartHookInput = any
export type SetupHookInput = any
export type StopFailureHookInput = any
export type StopHookInput = any
export type SubagentStartHookInput = any
export type SubagentStopHookInput = any
export type TaskCompletedHookInput = any
export type TaskCreatedHookInput = any
export type TeammateIdleHookInput = any
export type UserPromptSubmitHookInput = any

// --- Additional control protocol messages ---
export type SDKControlInitializeRequest = any
export type SDKControlInitializeResponse = any
export type SDKControlMcpSetServersResponse = any
export type SDKControlReloadPluginsResponse = any
export type StdinMessage = any
