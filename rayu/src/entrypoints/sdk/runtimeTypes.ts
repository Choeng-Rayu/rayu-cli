// Stub: SDK runtime types absent from the leaked tree. Only `EffortLevel` is
// referenced as a type by external consumers; mirror the upstream union.
export type EffortLevel = 'low' | 'medium' | 'high' | 'p100' | 'max'
export {}

// --- Reconstructed runtime SDK types (absent from the leaked source) ---
// Type-only, erased at build; reconstructed permissively. Imported by
// agentSdkTypes.ts (function signatures) and re-exported to consumers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZodRawShape = any
export type InferShape<_Schema = any> = any
export type SdkMcpToolDefinition<_Schema = any> = any
export type McpSdkServerConfigWithInstance = any
export type Options = any
export type Query = any
export type InternalOptions = any
export type InternalQuery = any
export type SDKSession = any
export type SDKSessionOptions = any
export type SessionMessage = any
export type SessionMutationOptions = any
export type ListSessionsOptions = any
export type GetSessionInfoOptions = any
export type GetSessionMessagesOptions = any
export type ForkSessionOptions = any
export type ForkSessionResult = any
