// Local view types for the OPAQUE payloads inside wire messages.
//
// `@rayu-dev/agent-protocol` deliberately types three payloads as `any`, because
// their shape is owned by `@anthropic-ai/sdk` rather than by the Rayu wire
// contract, and the protocol does not validate them:
//
//   - `SDKAssistantMessage.message`        (an Anthropic API message)
//   - `SDKPartialAssistantMessage.event`   (an Anthropic raw stream event)
//   - `usage` on result messages           (an Anthropic usage object)
//
// The extension has to read into those blobs to render a conversation, so it
// declares the minimal structural shapes it depends on here.
//
// This does NOT violate the single-definition rule. That rule is:
//
//   > One definition for data crossing stdin/stdout.
//
// The wire contract says these fields are opaque. What follows is this
// package's *reading* view of an opaque blob, not a competing definition of the
// wire format. Nothing here is used to construct or validate a wire frame.
//
// Because the payloads are unvalidated, treat every field as untrusted: narrow
// on `type` before use and always provide a default branch. Blocks and events
// the engine adds later will simply not match any member below.

// ----------------------------------------------------------------------------
// Message content blocks
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
 * A content block within an assistant or user message, discriminated by `type`.
 *
 * NOT exhaustive by design — the engine may emit block types this union does
 * not list. Every consumer must have a default branch.
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

/** Reading view of an Anthropic API assistant message. */
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
 * Reading view of an Anthropic raw streaming event, carried inside a
 * `stream_event` wire message and assembled into the in-progress assistant
 * message.
 *
 * NOT exhaustive by design — see {@link ContentBlock}.
 */
export type RawMessageStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

// ----------------------------------------------------------------------------
// Usage
// ----------------------------------------------------------------------------

/**
 * Token usage for a turn (Anthropic usage shape).
 *
 * The wire contract types this as opaque, so the numbers are unvalidated. Guard
 * before arithmetic — a missing or non-numeric field must not render as `NaN`.
 */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  service_tier?: string | null;
}
