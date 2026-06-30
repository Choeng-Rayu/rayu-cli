// Protocol message envelopes.
//
// The inbound `StdoutMessage` union and the outbound `StdinMessage` union
// exchanged with the Rayu CLI over NDJSON. Grounded in the CLI's
// `StdoutMessageSchema` / `StdinMessageSchema` (`controlSchemas.ts`) and the
// underlying `coreSchemas.ts` message schemas. rayucode consumes the subset of
// stdout message types listed in the design; the unions below model that
// subset plus the control envelopes shared in both directions.
//
// Type definitions only.

import type { PermissionMode } from "./permissions.js";
import type {
  ApiAssistantMessage,
  AssistantError,
  ContentBlock,
  ModelUsage,
  PermissionDenial,
  RawMessageStreamEvent,
  Usage,
} from "./primitives.js";
import type {
  ControlCancelRequest,
  ControlRequest,
  ControlResponse,
} from "./control.js";

// ----------------------------------------------------------------------------
// Inbound (stdout) SDK message envelopes
// ----------------------------------------------------------------------------

/** Initial session announcement (R7.1, R11.2, R12.5). */
export interface SystemInit {
  type: "system";
  subtype: "init";
  model: string;
  permissionMode: PermissionMode;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  slash_commands: string[];
  skills: string[];
  apiKeySource: string;
  cwd: string;
  claude_code_version: string;
  uuid: string;
  session_id: string;
}

/** A complete assistant message block (R3.3). */
export interface AssistantMessage {
  type: "assistant";
  message: ApiAssistantMessage;
  parent_tool_use_id: string | null;
  error?: AssistantError;
  uuid: string;
  session_id: string;
}

/** A partial assistant content delta to append to the in-progress message (R4.1). */
export interface StreamEvent {
  type: "stream_event";
  event: RawMessageStreamEvent;
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

/** The terminal result subtypes for a turn. */
export type ResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

/** Terminal message for a turn; marks completion and carries usage (R4.2, R4.4). */
export interface ResultMessage {
  type: "result";
  subtype: ResultSubtype;
  is_error: boolean;
  result?: string;
  num_turns: number;
  total_cost_usd: number;
  usage: Usage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: PermissionDenial[];
  uuid: string;
  session_id: string;
}

/** Keep-alive heartbeat (both directions). */
export interface KeepAliveMessage {
  type: "keep_alive";
}

/** Host → CLI runtime environment-variable update (stdin only). */
export interface UpdateEnvironmentVariablesMessage {
  type: "update_environment_variables";
  variables: Record<string, string>;
}

// ----------------------------------------------------------------------------
// Outbound (stdin) user message envelope
// ----------------------------------------------------------------------------

/** A user prompt sent to the CLI (matches the SDK user-message envelope). */
export interface StdinUserMessage {
  type: "user";
  message: { role: "user"; content: string | ContentBlock[] };
  parent_tool_use_id: string | null;
  session_id?: string;
}

// ----------------------------------------------------------------------------
// Aggregate unions
// ----------------------------------------------------------------------------

/**
 * The inbound message union read from the CLI's stdout. Discriminated by
 * `type` (and `subtype` for `system`). Modelled subset per the design.
 */
export type StdoutMessage =
  | SystemInit
  | AssistantMessage
  | StreamEvent
  | ResultMessage
  | ControlRequest
  | ControlResponse
  | ControlCancelRequest
  | KeepAliveMessage;

/** The outbound message union written to the CLI's stdin. */
export type StdinMessage =
  | StdinUserMessage
  | ControlRequest
  | ControlResponse
  | KeepAliveMessage
  | UpdateEnvironmentVariablesMessage;
