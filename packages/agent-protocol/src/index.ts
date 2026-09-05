/**
 * `@rayu-dev/agent-protocol` — the Rayu agent wire protocol.
 *
 * This package is the SINGLE SOURCE OF TRUTH for every message that crosses the
 * engine child process's stdin/stdout boundary. Both the Rayu CLI (`rayu/`) and
 * the Rayucode VS Code extension (`rayucode/`) import from here. There is no
 * second definition anywhere in the repository.
 *
 * Ownership rule (WORKSPACE.md §4):
 *
 *   > One definition for data crossing stdin/stdout. NOT "no local types."
 *
 * Editor-side domain concepts — conversation items, render state, editor
 * actions, edit-review models — deliberately stay in `@rayucode/core`. They
 * never cross this boundary, so duplicating them here would couple the engine to
 * the editor for no benefit.
 *
 * ## Schemas are thunks — you must CALL them
 *
 * Every schema is wrapped in {@link lazySchema}, which defers Zod construction to
 * first access. A schema is therefore a FUNCTION:
 *
 * ```ts
 * import { StdoutMessageSchema, type StdoutMessage } from "@rayu-dev/agent-protocol";
 *
 * const result = StdoutMessageSchema().safeParse(frame);
 * //                                ^^ call the thunk
 * ```
 *
 * ## Always `safeParse` at the process boundary
 *
 * Never `parse`. A throw inside a stdout data handler cannot be surfaced to the
 * user recoverably. On failure the consumer MUST run the five-step fail-safe in
 * PROTOCOL.md §7: log redacted and truncated, mark the session failed, terminate
 * the child, default-deny pending permissions, surface an actionable error.
 *
 * Skipping a malformed frame is FORBIDDEN. The control protocol is
 * request/response correlated, so a dropped frame can be the very response the
 * UI is waiting on — the panel then spins forever with no error.
 *
 * ## Discriminate on `subtype`, not just `type`
 *
 * Several distinct messages share `type: "system"` — `init`, `api_retry`,
 * `status`, `compact_boundary`, `post_turn_summary`. Narrowing on `type` alone
 * routes all of them into the `system/init` handler, which was a live
 * high-severity bug before this package existed (rayucode/TRIAGE.md D1).
 */

import type { z } from "zod/v4";

import type * as Control from "./controlSchemas.js";
import type * as Core from "./coreSchemas.js";

// ----------------------------------------------------------------------------
// Protocol version
// ----------------------------------------------------------------------------

/**
 * The wire-contract version. A single monotonically increasing integer —
 * deliberately not semver, because there is exactly one producer and one
 * consumer, both built from this repository.
 *
 * The engine emits this as `protocolVersion` on `system/init`. The extension
 * requires EXACT equality with the value it was built against: the engine ships
 * inside the VSIX, so a mismatch means the packaging step is broken, not that a
 * user has an old CLI.
 *
 * Bump when a change can make an existing consumer misbehave — removing or
 * renaming a field, narrowing a type or enum, making an optional field required,
 * changing a union discriminant, or removing a union member.
 *
 * Do NOT bump for additive changes: a new optional field, a new union member, or
 * a WIDENED enum. Consumers must tolerate unknown message *types* (log at debug,
 * ignore, continue), which is what makes those additions safe.
 *
 * See PROTOCOL.md §3.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The version attributed to an engine that omits `protocolVersion` entirely.
 * Such an engine predates this contract; consumers treat it as incompatible and
 * fail the check explicitly rather than attempting best-effort operation.
 */
export const LEGACY_PROTOCOL_VERSION = 0;

// ----------------------------------------------------------------------------
// Schema re-exports
// ----------------------------------------------------------------------------
//
// `export *` rather than an explicit list, so a schema added to either source
// module joins the public surface automatically and cannot silently fall out of
// it. Verified: the two modules share no exported names.

export * from "./controlSchemas.js";
export * from "./coreSchemas.js";
export { lazySchema } from "./lazySchema.js";

// ----------------------------------------------------------------------------
// Inferred types
// ----------------------------------------------------------------------------
//
// GENERATED — one alias per exported schema, named by dropping the `Schema`
// suffix. Because these are derived mechanically from the schemas rather than
// written by hand, they cannot drift from them. Regenerate with:
//
//   node -e '<see git history for the generator>'
//
// Notable shapes worth reading before you use them:
//
//   SDKResultMessage  is a DISCRIMINATED UNION of SDKResultSuccess and
//                     SDKResultError. Success requires `result: string`; the
//                     error variant has NO `result` and instead carries a
//                     required `errors: string[]`. Modelling it as one
//                     optional-field interface loses every failure reason
//                     (TRIAGE.md D3).
//
//   ApiKeySource      accepts the engine's real values
//                     ('RAYU_ANTHROPIC_API_KEY' | 'rayuProvider' | 'none')
//                     as well as the legacy upstream set. The engine emitted
//                     values its own schema rejected until this was widened
//                     (TRIAGE.md D9).

export type AccountInfo                           = z.infer<ReturnType<typeof Core.AccountInfoSchema>>;
export type AgentDefinition                       = z.infer<ReturnType<typeof Core.AgentDefinitionSchema>>;
export type AgentInfo                             = z.infer<ReturnType<typeof Core.AgentInfoSchema>>;
export type AgentMcpServerSpec                    = z.infer<ReturnType<typeof Core.AgentMcpServerSpecSchema>>;
export type ApiKeySource                          = z.infer<ReturnType<typeof Core.ApiKeySourceSchema>>;
export type AsyncHookJSONOutput                   = z.infer<ReturnType<typeof Core.AsyncHookJSONOutputSchema>>;
export type BaseHookInput                         = z.infer<ReturnType<typeof Core.BaseHookInputSchema>>;
export type BaseOutputFormat                      = z.infer<ReturnType<typeof Core.BaseOutputFormatSchema>>;
export type ConfigChangeHookInput                 = z.infer<ReturnType<typeof Core.ConfigChangeHookInputSchema>>;
export type ConfigScope                           = z.infer<ReturnType<typeof Core.ConfigScopeSchema>>;
export type CwdChangedHookInput                   = z.infer<ReturnType<typeof Core.CwdChangedHookInputSchema>>;
export type CwdChangedHookSpecificOutput          = z.infer<ReturnType<typeof Core.CwdChangedHookSpecificOutputSchema>>;
export type ElicitationHookInput                  = z.infer<ReturnType<typeof Core.ElicitationHookInputSchema>>;
export type ElicitationHookSpecificOutput         = z.infer<ReturnType<typeof Core.ElicitationHookSpecificOutputSchema>>;
export type ElicitationResultHookInput            = z.infer<ReturnType<typeof Core.ElicitationResultHookInputSchema>>;
export type ElicitationResultHookSpecificOutput   = z.infer<ReturnType<typeof Core.ElicitationResultHookSpecificOutputSchema>>;
export type ExitReason                            = z.infer<ReturnType<typeof Core.ExitReasonSchema>>;
export type FastModeState                         = z.infer<ReturnType<typeof Core.FastModeStateSchema>>;
export type FileChangedHookInput                  = z.infer<ReturnType<typeof Core.FileChangedHookInputSchema>>;
export type FileChangedHookSpecificOutput         = z.infer<ReturnType<typeof Core.FileChangedHookSpecificOutputSchema>>;
export type HookEvent                             = z.infer<ReturnType<typeof Core.HookEventSchema>>;
export type HookInput                             = z.infer<ReturnType<typeof Core.HookInputSchema>>;
export type HookJSONOutput                        = z.infer<ReturnType<typeof Core.HookJSONOutputSchema>>;
export type InstructionsLoadedHookInput           = z.infer<ReturnType<typeof Core.InstructionsLoadedHookInputSchema>>;
export type JsonSchemaOutputFormat                = z.infer<ReturnType<typeof Core.JsonSchemaOutputFormatSchema>>;
export type McpHttpServerConfig                   = z.infer<ReturnType<typeof Core.McpHttpServerConfigSchema>>;
export type McpSSEServerConfig                    = z.infer<ReturnType<typeof Core.McpSSEServerConfigSchema>>;
export type McpSdkServerConfig                    = z.infer<ReturnType<typeof Core.McpSdkServerConfigSchema>>;
export type McpServerConfigForProcessTransport    = z.infer<ReturnType<typeof Core.McpServerConfigForProcessTransportSchema>>;
export type McpServerStatusConfig                 = z.infer<ReturnType<typeof Core.McpServerStatusConfigSchema>>;
export type McpServerStatus                       = z.infer<ReturnType<typeof Core.McpServerStatusSchema>>;
export type McpSetServersResult                   = z.infer<ReturnType<typeof Core.McpSetServersResultSchema>>;
export type McpStdioServerConfig                  = z.infer<ReturnType<typeof Core.McpStdioServerConfigSchema>>;
export type ModelInfo                             = z.infer<ReturnType<typeof Core.ModelInfoSchema>>;
export type ModelUsage                            = z.infer<ReturnType<typeof Core.ModelUsageSchema>>;
export type NotificationHookInput                 = z.infer<ReturnType<typeof Core.NotificationHookInputSchema>>;
export type NotificationHookSpecificOutput        = z.infer<ReturnType<typeof Core.NotificationHookSpecificOutputSchema>>;
export type OutputFormat                          = z.infer<ReturnType<typeof Core.OutputFormatSchema>>;
export type OutputFormatType                      = z.infer<ReturnType<typeof Core.OutputFormatTypeSchema>>;
export type PermissionBehavior                    = z.infer<ReturnType<typeof Core.PermissionBehaviorSchema>>;
export type PermissionDecisionClassification      = z.infer<ReturnType<typeof Core.PermissionDecisionClassificationSchema>>;
export type PermissionDeniedHookInput             = z.infer<ReturnType<typeof Core.PermissionDeniedHookInputSchema>>;
export type PermissionDeniedHookSpecificOutput    = z.infer<ReturnType<typeof Core.PermissionDeniedHookSpecificOutputSchema>>;
export type PermissionMode                        = z.infer<ReturnType<typeof Core.PermissionModeSchema>>;
export type PermissionRequestHookInput            = z.infer<ReturnType<typeof Core.PermissionRequestHookInputSchema>>;
export type PermissionRequestHookSpecificOutput   = z.infer<ReturnType<typeof Core.PermissionRequestHookSpecificOutputSchema>>;
export type PermissionResult                      = z.infer<ReturnType<typeof Core.PermissionResultSchema>>;
export type PermissionRuleValue                   = z.infer<ReturnType<typeof Core.PermissionRuleValueSchema>>;
export type PermissionUpdateDestination           = z.infer<ReturnType<typeof Core.PermissionUpdateDestinationSchema>>;
export type PermissionUpdate                      = z.infer<ReturnType<typeof Core.PermissionUpdateSchema>>;
export type PostCompactHookInput                  = z.infer<ReturnType<typeof Core.PostCompactHookInputSchema>>;
export type PostToolUseFailureHookInput           = z.infer<ReturnType<typeof Core.PostToolUseFailureHookInputSchema>>;
export type PostToolUseFailureHookSpecificOutput  = z.infer<ReturnType<typeof Core.PostToolUseFailureHookSpecificOutputSchema>>;
export type PostToolUseHookInput                  = z.infer<ReturnType<typeof Core.PostToolUseHookInputSchema>>;
export type PostToolUseHookSpecificOutput         = z.infer<ReturnType<typeof Core.PostToolUseHookSpecificOutputSchema>>;
export type PreCompactHookInput                   = z.infer<ReturnType<typeof Core.PreCompactHookInputSchema>>;
export type PreToolUseHookInput                   = z.infer<ReturnType<typeof Core.PreToolUseHookInputSchema>>;
export type PreToolUseHookSpecificOutput          = z.infer<ReturnType<typeof Core.PreToolUseHookSpecificOutputSchema>>;
export type PromptRequestOption                   = z.infer<ReturnType<typeof Core.PromptRequestOptionSchema>>;
export type PromptRequest                         = z.infer<ReturnType<typeof Core.PromptRequestSchema>>;
export type PromptResponse                        = z.infer<ReturnType<typeof Core.PromptResponseSchema>>;
export type RewindFilesResult                     = z.infer<ReturnType<typeof Core.RewindFilesResultSchema>>;
export type SDKAPIRetryMessage                    = z.infer<ReturnType<typeof Core.SDKAPIRetryMessageSchema>>;
export type SDKAssistantMessageError              = z.infer<ReturnType<typeof Core.SDKAssistantMessageErrorSchema>>;
export type SDKAssistantMessage                   = z.infer<ReturnType<typeof Core.SDKAssistantMessageSchema>>;
export type SDKAuthStatusMessage                  = z.infer<ReturnType<typeof Core.SDKAuthStatusMessageSchema>>;
export type SDKCompactBoundaryMessage             = z.infer<ReturnType<typeof Core.SDKCompactBoundaryMessageSchema>>;
export type SDKElicitationCompleteMessage         = z.infer<ReturnType<typeof Core.SDKElicitationCompleteMessageSchema>>;
export type SDKFilesPersistedEvent                = z.infer<ReturnType<typeof Core.SDKFilesPersistedEventSchema>>;
export type SDKHookProgressMessage                = z.infer<ReturnType<typeof Core.SDKHookProgressMessageSchema>>;
export type SDKHookResponseMessage                = z.infer<ReturnType<typeof Core.SDKHookResponseMessageSchema>>;
export type SDKHookStartedMessage                 = z.infer<ReturnType<typeof Core.SDKHookStartedMessageSchema>>;
export type SDKLocalCommandOutputMessage          = z.infer<ReturnType<typeof Core.SDKLocalCommandOutputMessageSchema>>;
export type SDKMessage                            = z.infer<ReturnType<typeof Core.SDKMessageSchema>>;
export type SDKPartialAssistantMessage            = z.infer<ReturnType<typeof Core.SDKPartialAssistantMessageSchema>>;
export type SDKPermissionDenial                   = z.infer<ReturnType<typeof Core.SDKPermissionDenialSchema>>;
export type SDKPostTurnSummaryMessage             = z.infer<ReturnType<typeof Core.SDKPostTurnSummaryMessageSchema>>;
export type SDKPromptSuggestionMessage            = z.infer<ReturnType<typeof Core.SDKPromptSuggestionMessageSchema>>;
export type SDKRateLimitEvent                     = z.infer<ReturnType<typeof Core.SDKRateLimitEventSchema>>;
export type SDKRateLimitInfo                      = z.infer<ReturnType<typeof Core.SDKRateLimitInfoSchema>>;
export type SDKResultError                        = z.infer<ReturnType<typeof Core.SDKResultErrorSchema>>;
export type SDKResultMessage                      = z.infer<ReturnType<typeof Core.SDKResultMessageSchema>>;
export type SDKResultSuccess                      = z.infer<ReturnType<typeof Core.SDKResultSuccessSchema>>;
export type SDKSessionInfo                        = z.infer<ReturnType<typeof Core.SDKSessionInfoSchema>>;
export type SDKSessionStateChangedMessage         = z.infer<ReturnType<typeof Core.SDKSessionStateChangedMessageSchema>>;
export type SDKStatusMessage                      = z.infer<ReturnType<typeof Core.SDKStatusMessageSchema>>;
export type SDKStatus                             = z.infer<ReturnType<typeof Core.SDKStatusSchema>>;
export type SDKStreamlinedTextMessage             = z.infer<ReturnType<typeof Core.SDKStreamlinedTextMessageSchema>>;
export type SDKStreamlinedToolUseSummaryMessage   = z.infer<ReturnType<typeof Core.SDKStreamlinedToolUseSummaryMessageSchema>>;
export type SDKSystemMessage                      = z.infer<ReturnType<typeof Core.SDKSystemMessageSchema>>;
export type SDKTaskNotificationMessage            = z.infer<ReturnType<typeof Core.SDKTaskNotificationMessageSchema>>;
export type SDKTaskProgressMessage                = z.infer<ReturnType<typeof Core.SDKTaskProgressMessageSchema>>;
export type SDKTaskStartedMessage                 = z.infer<ReturnType<typeof Core.SDKTaskStartedMessageSchema>>;
export type SDKToolProgressMessage                = z.infer<ReturnType<typeof Core.SDKToolProgressMessageSchema>>;
export type SDKToolUseSummaryMessage              = z.infer<ReturnType<typeof Core.SDKToolUseSummaryMessageSchema>>;
export type SDKUserMessageReplay                  = z.infer<ReturnType<typeof Core.SDKUserMessageReplaySchema>>;
export type SDKUserMessage                        = z.infer<ReturnType<typeof Core.SDKUserMessageSchema>>;
export type SdkBeta                               = z.infer<ReturnType<typeof Core.SdkBetaSchema>>;
export type SdkPluginConfig                       = z.infer<ReturnType<typeof Core.SdkPluginConfigSchema>>;
export type SessionEndHookInput                   = z.infer<ReturnType<typeof Core.SessionEndHookInputSchema>>;
export type SessionStartHookInput                 = z.infer<ReturnType<typeof Core.SessionStartHookInputSchema>>;
export type SessionStartHookSpecificOutput        = z.infer<ReturnType<typeof Core.SessionStartHookSpecificOutputSchema>>;
export type SettingSource                         = z.infer<ReturnType<typeof Core.SettingSourceSchema>>;
export type SetupHookInput                        = z.infer<ReturnType<typeof Core.SetupHookInputSchema>>;
export type SetupHookSpecificOutput               = z.infer<ReturnType<typeof Core.SetupHookSpecificOutputSchema>>;
export type SlashCommand                          = z.infer<ReturnType<typeof Core.SlashCommandSchema>>;
export type StopFailureHookInput                  = z.infer<ReturnType<typeof Core.StopFailureHookInputSchema>>;
export type StopHookInput                         = z.infer<ReturnType<typeof Core.StopHookInputSchema>>;
export type SubagentStartHookInput                = z.infer<ReturnType<typeof Core.SubagentStartHookInputSchema>>;
export type SubagentStartHookSpecificOutput       = z.infer<ReturnType<typeof Core.SubagentStartHookSpecificOutputSchema>>;
export type SubagentStopHookInput                 = z.infer<ReturnType<typeof Core.SubagentStopHookInputSchema>>;
export type SyncHookJSONOutput                    = z.infer<ReturnType<typeof Core.SyncHookJSONOutputSchema>>;
export type TaskCompletedHookInput                = z.infer<ReturnType<typeof Core.TaskCompletedHookInputSchema>>;
export type TaskCreatedHookInput                  = z.infer<ReturnType<typeof Core.TaskCreatedHookInputSchema>>;
export type TeammateIdleHookInput                 = z.infer<ReturnType<typeof Core.TeammateIdleHookInputSchema>>;
export type ThinkingAdaptive                      = z.infer<ReturnType<typeof Core.ThinkingAdaptiveSchema>>;
export type ThinkingConfig                        = z.infer<ReturnType<typeof Core.ThinkingConfigSchema>>;
export type ThinkingDisabled                      = z.infer<ReturnType<typeof Core.ThinkingDisabledSchema>>;
export type ThinkingEnabled                       = z.infer<ReturnType<typeof Core.ThinkingEnabledSchema>>;
export type UserPromptSubmitHookInput             = z.infer<ReturnType<typeof Core.UserPromptSubmitHookInputSchema>>;
export type UserPromptSubmitHookSpecificOutput    = z.infer<ReturnType<typeof Core.UserPromptSubmitHookSpecificOutputSchema>>;
export type WorktreeCreateHookInput               = z.infer<ReturnType<typeof Core.WorktreeCreateHookInputSchema>>;
export type WorktreeCreateHookSpecificOutput      = z.infer<ReturnType<typeof Core.WorktreeCreateHookSpecificOutputSchema>>;
export type WorktreeRemoveHookInput               = z.infer<ReturnType<typeof Core.WorktreeRemoveHookInputSchema>>;
export type ControlErrorResponse                  = z.infer<ReturnType<typeof Control.ControlErrorResponseSchema>>;
export type ControlResponse                       = z.infer<ReturnType<typeof Control.ControlResponseSchema>>;
export type SDKControlApplyFlagSettingsRequest    = z.infer<ReturnType<typeof Control.SDKControlApplyFlagSettingsRequestSchema>>;
export type SDKControlCancelAsyncMessageRequest   = z.infer<ReturnType<typeof Control.SDKControlCancelAsyncMessageRequestSchema>>;
export type SDKControlCancelAsyncMessageResponse  = z.infer<ReturnType<typeof Control.SDKControlCancelAsyncMessageResponseSchema>>;
export type SDKControlCancelRequest               = z.infer<ReturnType<typeof Control.SDKControlCancelRequestSchema>>;
export type SDKControlElicitationRequest          = z.infer<ReturnType<typeof Control.SDKControlElicitationRequestSchema>>;
export type SDKControlElicitationResponse         = z.infer<ReturnType<typeof Control.SDKControlElicitationResponseSchema>>;
export type SDKControlGetContextUsageRequest      = z.infer<ReturnType<typeof Control.SDKControlGetContextUsageRequestSchema>>;
export type SDKControlGetContextUsageResponse     = z.infer<ReturnType<typeof Control.SDKControlGetContextUsageResponseSchema>>;
export type SDKControlGetSettingsRequest          = z.infer<ReturnType<typeof Control.SDKControlGetSettingsRequestSchema>>;
export type SDKControlGetSettingsResponse         = z.infer<ReturnType<typeof Control.SDKControlGetSettingsResponseSchema>>;
export type SDKControlInitializeRequest           = z.infer<ReturnType<typeof Control.SDKControlInitializeRequestSchema>>;
export type SDKControlInitializeResponse          = z.infer<ReturnType<typeof Control.SDKControlInitializeResponseSchema>>;
export type SDKControlInterruptRequest            = z.infer<ReturnType<typeof Control.SDKControlInterruptRequestSchema>>;
export type SDKControlMcpMessageRequest           = z.infer<ReturnType<typeof Control.SDKControlMcpMessageRequestSchema>>;
export type SDKControlMcpReconnectRequest         = z.infer<ReturnType<typeof Control.SDKControlMcpReconnectRequestSchema>>;
export type SDKControlMcpSetServersRequest        = z.infer<ReturnType<typeof Control.SDKControlMcpSetServersRequestSchema>>;
export type SDKControlMcpSetServersResponse       = z.infer<ReturnType<typeof Control.SDKControlMcpSetServersResponseSchema>>;
export type SDKControlMcpStatusRequest            = z.infer<ReturnType<typeof Control.SDKControlMcpStatusRequestSchema>>;
export type SDKControlMcpStatusResponse           = z.infer<ReturnType<typeof Control.SDKControlMcpStatusResponseSchema>>;
export type SDKControlMcpToggleRequest            = z.infer<ReturnType<typeof Control.SDKControlMcpToggleRequestSchema>>;
export type SDKControlPermissionRequest           = z.infer<ReturnType<typeof Control.SDKControlPermissionRequestSchema>>;
export type SDKControlReloadPluginsRequest        = z.infer<ReturnType<typeof Control.SDKControlReloadPluginsRequestSchema>>;
export type SDKControlReloadPluginsResponse       = z.infer<ReturnType<typeof Control.SDKControlReloadPluginsResponseSchema>>;
export type SDKControlRequestInner                = z.infer<ReturnType<typeof Control.SDKControlRequestInnerSchema>>;
export type SDKControlRequest                     = z.infer<ReturnType<typeof Control.SDKControlRequestSchema>>;
export type SDKControlResponse                    = z.infer<ReturnType<typeof Control.SDKControlResponseSchema>>;
export type SDKControlRewindFilesRequest          = z.infer<ReturnType<typeof Control.SDKControlRewindFilesRequestSchema>>;
export type SDKControlRewindFilesResponse         = z.infer<ReturnType<typeof Control.SDKControlRewindFilesResponseSchema>>;
export type SDKControlSeedReadStateRequest        = z.infer<ReturnType<typeof Control.SDKControlSeedReadStateRequestSchema>>;
export type SDKControlSetMaxThinkingTokensRequest = z.infer<ReturnType<typeof Control.SDKControlSetMaxThinkingTokensRequestSchema>>;
export type SDKControlSetModelRequest             = z.infer<ReturnType<typeof Control.SDKControlSetModelRequestSchema>>;
export type SDKControlSetPermissionModeRequest    = z.infer<ReturnType<typeof Control.SDKControlSetPermissionModeRequestSchema>>;
export type SDKControlStopTaskRequest             = z.infer<ReturnType<typeof Control.SDKControlStopTaskRequestSchema>>;
export type SDKHookCallbackMatcher                = z.infer<ReturnType<typeof Control.SDKHookCallbackMatcherSchema>>;
export type SDKHookCallbackRequest                = z.infer<ReturnType<typeof Control.SDKHookCallbackRequestSchema>>;
export type SDKKeepAliveMessage                   = z.infer<ReturnType<typeof Control.SDKKeepAliveMessageSchema>>;
export type SDKUpdateEnvironmentVariablesMessage  = z.infer<ReturnType<typeof Control.SDKUpdateEnvironmentVariablesMessageSchema>>;
export type StdinMessage                          = z.infer<ReturnType<typeof Control.StdinMessageSchema>>;
export type StdoutMessage                         = z.infer<ReturnType<typeof Control.StdoutMessageSchema>>;
