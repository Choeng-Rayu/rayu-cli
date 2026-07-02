// Shared protocol primitive types.
//
// These mirror the serializable shapes the Rayu CLI emits over the streaming
// control protocol. They are grounded in the CLI's Zod schemas
// (`src/entrypoints/sdk/coreSchemas.ts`). The CLI itself types several of these
// as opaque placeholders backed by `@anthropic-ai/sdk` (assistant message,
// streaming event, usage); `@rayucode/core` re-declares structural equivalents
// so the package stays dependency-free and editor-agnostic (R13.1, R13.5).
//
// Type definitions only — no runtime logic.

// ----------------------------------------------------------------------------
// Message content blocks (Anthropic content block shapes)
// ----------------------------------------------------------------------------

/** A plain text content block. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** An extended-thinking content block. */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/** A tool invocation requested by the assistant. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result of a tool invocation supplied back to the model. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

/** Source descriptor for an image content block. */
export interface ImageSource {
  type: "base64" | "url";
  media_type?: string;
  data?: string;
  url?: string;
}

/** An image content block. */
export interface ImageBlock {
  type: "image";
  source: ImageSource;
}

/**
 * A content block within an assistant or user message. Discriminated by
 * `type`. Unmodelled block types arriving over the wire are handled at the
 * call site's default branch.
 */
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock;

// ----------------------------------------------------------------------------
// Assistant message (Anthropic API message shape)
// ----------------------------------------------------------------------------

/** Structural equivalent of an Anthropic API assistant message. */
export interface ApiAssistantMessage {
  id?: string;
  type?: "message";
  role: "assistant";
  model?: string;
  content: ContentBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: Usage;
}

// ----------------------------------------------------------------------------
// Streaming events (Anthropic RawMessageStreamEvent shape)
// ----------------------------------------------------------------------------

export interface MessageStartEvent {
  type: "message_start";
  message: ApiAssistantMessage;
}

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}

export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}

export interface ThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}

export interface SignatureDelta {
  type: "signature_delta";
  signature: string;
}

/** The `delta` payload carried by a `content_block_delta` event. */
export type RawContentBlockDelta =
  | TextDelta
  | InputJsonDelta
  | ThinkingDelta
  | SignatureDelta;

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: RawContentBlockDelta;
}

export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface MessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason?: string | null; stop_sequence?: string | null };
  usage?: Partial<Usage>;
}

export interface MessageStopEvent {
  type: "message_stop";
}

/**
 * Structural equivalent of an Anthropic raw streaming event. Carried inside a
 * `stream_event` protocol message and assembled into the in-progress assistant
 * message (R4.1).
 */
export type RawMessageStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

// ----------------------------------------------------------------------------
// Usage & model metadata
// ----------------------------------------------------------------------------

/** Token usage for a turn (Anthropic usage shape). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  service_tier?: string | null;
}

/** Per-model usage/cost breakdown reported on a `result` message. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

/** Reasoning effort levels a model may advertise. */
export type EffortLevel = "low" | "medium" | "high" | "max";

/** Information about an available model (R7.2). */
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

// ----------------------------------------------------------------------------
// MCP, commands, agents, account
// ----------------------------------------------------------------------------

/** Connection state of an MCP server (R11.2, R11.5). */
export type McpServerState =
  | "connected"
  | "failed"
  | "needs-auth"
  | "pending"
  | "disabled";

/** Status information for an MCP server connection. */
export interface McpServerStatus {
  name: string;
  status: McpServerState;
  serverInfo?: { name: string; version: string };
  error?: string;
  scope?: string;
  tools?: { name: string; description?: string }[];
}

/** An available slash command / skill entry point. */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/** Information about an available subagent. */
export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
}

/** Information about the logged-in account. */
export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: "anthropic" | "bedrock" | "vertex" | "foundry";
}

// ----------------------------------------------------------------------------
// Result-message support types
// ----------------------------------------------------------------------------

/** A tool action that was denied during a turn, reported on `result`. */
export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

/**
 * Error classification carried on an assistant message or surfaced from a
 * result. `authentication_failed` drives auth-failure handling (R8.3).
 */
export type AssistantError =
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown"
  | "max_output_tokens";
