// Control protocol envelope types.
//
// Grounded in the CLI's `controlSchemas.ts` (`SDKControlRequest*`,
// `SDKControlResponseSchema`, `SDKControlCancelRequestSchema`). This module
// declares the request/response envelopes and the `ControlRequestInner`
// subtypes rayucode actually drives: `can_use_tool`, `interrupt`, `set_model`,
// `set_permission_mode`, `mcp_status`, `initialize`, `get_context_usage`.
//
// Type definitions only — request/response correlation lives in the
// ControlProtocolClient (a later task).

import type { PermissionMode, PermissionUpdate } from "./permissions.js";
import type {
  AccountInfo,
  AgentInfo,
  McpServerStatus,
  ModelInfo,
  SlashCommand,
} from "./primitives.js";

// ----------------------------------------------------------------------------
// Control request inner subtypes (discriminated by `subtype`)
// ----------------------------------------------------------------------------

/**
 * CLI → host permission request: the agent asks to use a tool with the given
 * input (R5.1). For bash actions the exact command lives in `input` (R5.6).
 */
export interface CanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  permission_suggestions?: PermissionUpdate[];
  blocked_path?: string;
  decision_reason?: string;
  title?: string;
  display_name?: string;
  agent_id?: string;
  description?: string;
}

/** Host → CLI: interrupt the currently running turn (R3.6). */
export interface InterruptRequest {
  subtype: "interrupt";
}

/** Host → CLI: switch the model for subsequent turns (R7.3). */
export interface SetModelRequest {
  subtype: "set_model";
  model?: string;
}

/** Host → CLI: change the permission mode. */
export interface SetPermissionModeRequest {
  subtype: "set_permission_mode";
  mode: PermissionMode;
}

/** Host → CLI: request the current status of all MCP servers (R11.2). */
export interface McpStatusRequest {
  subtype: "mcp_status";
}

/** Host → CLI: initialise the session (hooks, MCP servers, prompts). */
export interface InitializeRequest {
  subtype: "initialize";
  hooks?: Record<string, unknown>;
  sdkMcpServers?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  promptSuggestions?: boolean;
  agentProgressSummaries?: boolean;
}

/** Host → CLI: request a breakdown of current context-window usage. */
export interface GetContextUsageRequest {
  subtype: "get_context_usage";
}

/** The set of control-request payloads rayucode sends or receives. */
export type ControlRequestInner =
  | CanUseToolRequest
  | InterruptRequest
  | SetModelRequest
  | SetPermissionModeRequest
  | McpStatusRequest
  | InitializeRequest
  | GetContextUsageRequest;

// ----------------------------------------------------------------------------
// Control request / response / cancel envelopes
// ----------------------------------------------------------------------------

/** A control request carried in either direction, correlated by `request_id`. */
export interface ControlRequest {
  type: "control_request";
  request_id: string;
  request: ControlRequestInner;
}

/** A successful control response correlated by `request_id`. */
export interface ControlResponseOk {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response?: Record<string, unknown>;
  };
}

/** An error control response correlated by `request_id` (R15.2). */
export interface ControlResponseErr {
  type: "control_response";
  response: {
    subtype: "error";
    request_id: string;
    error: string;
  };
}

/** Either flavour of control response. */
export type ControlResponse = ControlResponseOk | ControlResponseErr;

/** Cancels a still-open control request by `request_id` (R7.4). */
export interface ControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;
}

// ----------------------------------------------------------------------------
// Control response payloads (the `response` body of a success control_response)
// ----------------------------------------------------------------------------

/** Payload of a successful `initialize` response; `models` drives R7.2. */
export interface InitializeResponse {
  commands: SlashCommand[];
  agents: AgentInfo[];
  output_style: string;
  available_output_styles: string[];
  models: ModelInfo[];
  account: AccountInfo;
  pid?: number;
}

/** Payload of a successful `mcp_status` response (R11.2, R11.5). */
export interface McpStatusResponse {
  mcpServers: McpServerStatus[];
}

/** Payload of a successful `get_context_usage` response. */
export interface ContextUsageResponse {
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  isAutoCompactEnabled: boolean;
}
