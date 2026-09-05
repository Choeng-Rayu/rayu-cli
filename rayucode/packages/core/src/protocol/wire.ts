// The wire contract, re-exported from the single source of truth.
//
// Every type here is DEFINED in `@rayu-dev/agent-protocol`, which owns the Zod
// schemas the engine itself validates against. This module only renames them to
// the shorter identifiers `@rayucode/core` already used, so the migration did
// not have to touch eleven call sites.
//
// There is NO type declaration in this file — only aliases and re-exports. If
// you find yourself about to declare a shape here, it belongs in the protocol
// package instead.
//
// ## Why this replaced hand-written copies
//
// `packages/core/src/protocol/{messages,control,permissions,primitives}.ts`
// used to declare these shapes by hand, "grounded in" the engine's schemas with
// nothing enforcing the grounding. They drifted, and the drift was invisible
// because the engine's own exported types were `any`. Concretely (see
// rayucode/TRIAGE.md):
//
//   D1  every `type: "system"` message was treated as `system/init`
//   D2  `system/api_retry` was unmodelled, so 401s never surfaced
//   D3  the result union was collapsed into one interface, losing `errors[]`
//   D5  `system/init` was missing 4 emitted fields
//   D8  20 of the engine's 24 stdout message types were unmodelled
//
// Renaming a field in the protocol package is now a compile error here.

// ----------------------------------------------------------------------------
// Aggregate unions
// ----------------------------------------------------------------------------

export type {
  /** Every message the engine may write to stdout. */
  StdoutMessage,
  /** Every message the host may write to the engine's stdin. */
  StdinMessage,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Conversation messages
// ----------------------------------------------------------------------------

export type {
  /** `system` + `subtype: "init"` — the session announcement. */
  SDKSystemMessage as SystemInit,
  /** A complete assistant message. */
  SDKAssistantMessage as AssistantMessage,
  /** A streaming content delta (`type: "stream_event"`). */
  SDKPartialAssistantMessage as StreamEvent,
  /** A user prompt sent to the engine. */
  SDKUserMessage as StdinUserMessage,
  /** Error classification on an assistant message; `authentication_failed` drives auth handling. */
  SDKAssistantMessageError as AssistantError,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Other `system` subtypes
// ----------------------------------------------------------------------------
//
// These share `type: "system"` with `system/init`. Discriminating on `type`
// alone routes all of them into the init handler — that was D1. Use the guards
// in `./guards.js`, which check `subtype`.

export type {
  /** `system/api_retry` — carries `error_status` (e.g. 401) and `error`. */
  SDKAPIRetryMessage as ApiRetryMessage,
  /** `system/status` — agent status transitions. */
  SDKStatusMessage as StatusMessage,
  /** `system/compact_boundary` — a context-compaction boundary. */
  SDKCompactBoundaryMessage as CompactBoundaryMessage,
  /** `system/post_turn_summary` — a background post-turn summary. */
  SDKPostTurnSummaryMessage as PostTurnSummaryMessage,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Turn results
// ----------------------------------------------------------------------------
//
// NOTE: this is a DISCRIMINATED UNION, not one shape.
//   success ⇒ requires `result: string`
//   error   ⇒ has NO `result`, and requires `errors: string[]`
// Collapsing it into a single interface with `result?: string` is what lost
// every failure reason (D3).

export type {
  /** The result union: success | error. Narrow on `subtype` before reading. */
  SDKResultMessage as ResultMessage,
  /** The successful variant. */
  SDKResultSuccess as ResultSuccess,
  /** The error variant — carries `errors: string[]`. */
  SDKResultError as ResultError,
  /** A tool action denied during the turn, reported on `result`. */
  SDKPermissionDenial as PermissionDenial,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Progress, lifecycle and notification messages
// ----------------------------------------------------------------------------

export type {
  SDKToolProgressMessage as ToolProgressMessage,
  SDKToolUseSummaryMessage as ToolUseSummaryMessage,
  SDKAuthStatusMessage as AuthStatusMessage,
  SDKRateLimitEvent as RateLimitEvent,
  SDKSessionStateChangedMessage as SessionStateChangedMessage,
  SDKFilesPersistedEvent as FilesPersistedEvent,
  SDKTaskStartedMessage as TaskStartedMessage,
  SDKTaskProgressMessage as TaskProgressMessage,
  SDKTaskNotificationMessage as TaskNotificationMessage,
  SDKStreamlinedTextMessage as StreamlinedTextMessage,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Control protocol
// ----------------------------------------------------------------------------

export type {
  /** A control request envelope (either direction). */
  SDKControlRequest as ControlRequest,
  /** The inner payload of a control request, discriminated by `subtype`. */
  SDKControlRequestInner as ControlRequestInner,
  /** A control response correlated to a request by `request_id`. */
  SDKControlResponse as ControlResponse,
  /** A cancellation of an outstanding control request. */
  SDKControlCancelRequest as ControlCancelRequest,
  /** `can_use_tool` — the engine asking the host to approve a tool action. */
  SDKControlPermissionRequest as CanUseToolRequest,
  SDKControlInterruptRequest as InterruptRequest,
  SDKControlSetModelRequest as SetModelRequest,
  SDKControlSetPermissionModeRequest as SetPermissionModeRequest,
  SDKControlMcpStatusRequest as McpStatusRequest,
  SDKControlInitializeRequest as InitializeRequest,
  SDKControlGetContextUsageRequest as GetContextUsageRequest,
  SDKControlInitializeResponse as InitializeResponse,
  SDKControlMcpStatusResponse as McpStatusResponse,
  SDKControlGetContextUsageResponse as ContextUsageResponse,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Permissions
// ----------------------------------------------------------------------------

export type {
  /**
   * The active permission mode.
   *
   * Includes the engine's INTERNAL modes (`auto`, `bubble`, `fullManage`) as
   * well as the five external ones, because the engine puts its internal value
   * straight onto a `system/status` frame (D10.2). A consumer that does not
   * implement an internal mode MUST fall back to prompting — never to
   * auto-approval.
   */
  PermissionMode,
  /** A suggested permission-rule change accompanying a permission request. */
  PermissionUpdate,
  PermissionUpdateDestination,
  PermissionBehavior,
  PermissionRuleValue,
  /** The allow/deny payload the host returns inside a permission response. */
  PermissionResult as PermissionToolOutput,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Model, MCP, command and account metadata
// ----------------------------------------------------------------------------

export type {
  ModelInfo,
  ModelUsage,
  McpServerStatus,
  SlashCommand,
  AgentInfo,
  AccountInfo,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Transport housekeeping
// ----------------------------------------------------------------------------

export type {
  SDKKeepAliveMessage as KeepAliveMessage,
  SDKUpdateEnvironmentVariablesMessage as UpdateEnvironmentVariablesMessage,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Runtime values
// ----------------------------------------------------------------------------

export {
  /** The wire-contract version this build was compiled against. */
  PROTOCOL_VERSION,
  /** Attributed to an engine that omits `protocolVersion` entirely. */
  LEGACY_PROTOCOL_VERSION,
  /** Schemas for validating frames. Each is a thunk — CALL it: `Schema().safeParse(x)`. */
  StdoutMessageSchema,
  StdinMessageSchema,
  PermissionModeSchema,
} from "@rayu-dev/agent-protocol";

// ----------------------------------------------------------------------------
// Derived helpers
// ----------------------------------------------------------------------------

import type {
  McpServerStatus as McpServerStatusType,
  ModelInfo as ModelInfoType,
  PermissionMode as PermissionModeType,
  SDKControlResponse as SDKControlResponseType,
  SDKResultMessage,
} from "@rayu-dev/agent-protocol";
import { PermissionModeSchema as PermissionModeSchemaFn } from "@rayu-dev/agent-protocol";

/** The terminal result subtypes for a turn, derived from the result union. */
export type ResultSubtype = SDKResultMessage["subtype"];

/**
 * The success variant of a control response, derived from the union rather than
 * re-declared. Carries the `response` payload for a completed request.
 */
export type ControlResponseOk = Extract<
  SDKControlResponseType,
  { response: { subtype: "success" } }
>;

/**
 * The error variant of a control response, derived from the union. Carries
 * `error` text for a failed request.
 */
export type ControlResponseErr = Extract<
  SDKControlResponseType,
  { response: { subtype: "error" } }
>;

/** Connection state of an MCP server, derived from its status shape. */
export type McpServerState = McpServerStatusType["status"];

/** Reasoning effort levels a model may advertise, derived from {@link ModelInfoType}. */
export type EffortLevel = NonNullable<
  ModelInfoType["supportedEffortLevels"]
>[number];

/**
 * Every permission mode, derived from the schema rather than re-listed, so this
 * cannot fall out of step with the wire contract.
 */
export const PERMISSION_MODES: readonly PermissionModeType[] =
  PermissionModeSchemaFn().options;

/** Runtime guard: is the value a recognised {@link PermissionModeType}? */
export function isPermissionMode(value: unknown): value is PermissionModeType {
  return (
    typeof value === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}
