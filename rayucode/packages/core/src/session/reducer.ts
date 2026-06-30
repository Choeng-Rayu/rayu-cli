// Conversation reducer and streaming assembler (R3.3, R3.4, R4.1, R4.2, R4.4).
//
// A pure, editor-agnostic reduction of the inbound `StdoutMessage` stream into
// the ordered `ConversationItem` history the Agent_Panel renders. Two
// guarantees anchor the design:
//
//   * Receive-order rendering (R3.4) — every processed message is assigned a
//     monotonic receive-sequence number (`nextSeq`); each conversation item
//     carries the seq of the message that created it. Because items are
//     appended in processing order and seqs increase per message, the history
//     is always in the order the messages were received from the stream.
//
//   * Streaming assembly (R4.1, R4.2) — `stream_event` text deltas are appended
//     to the in-progress assistant item; that item stays `streaming: true`
//     until — and is marked complete exactly when — the terminal `result` for
//     the turn is processed.
//
// `result` also surfaces the turn's token usage / cost as a `usage` item
// (R4.4), and a complete `assistant` message block is surfaced authoritatively
// (R3.3). The reducer is a set of pure functions over an immutable
// `ConversationReducerState`; the thin {@link ConversationReducer} class wraps
// them for ergonomic stream consumption. No `vscode` import (R13.1, R13.5).

import {
  isAssistantMessage,
  isResultMessage,
  isStreamEvent,
  isSystemInit,
} from "../protocol/guards.js";
import type {
  AssistantMessage,
  ResultMessage,
  StdoutMessage,
  StreamEvent,
  SystemInit,
} from "../protocol/messages.js";
import type { PermissionMode } from "../protocol/permissions.js";
import type {
  ApiAssistantMessage,
  RawMessageStreamEvent,
} from "../protocol/primitives.js";
import type {
  AssistantConversationItem,
  ConversationItem,
  UsageConversationItem,
  UserConversationItem,
} from "./state.js";

// ----------------------------------------------------------------------------
// Reducer state
// ----------------------------------------------------------------------------

/**
 * The slice of session state the conversation reducer owns. It is a subset of
 * {@link SessionState} (history, model, permission mode, resumable id) plus the
 * bookkeeping the streaming assembler needs (`nextSeq`, the in-progress
 * assistant item id). Process lifecycle (`status`) and permission bookkeeping
 * (`pendingPermissions`) live with the SessionManager / PermissionCoordinator.
 *
 * Treated as immutable: every reducer function returns a fresh state and never
 * mutates the one passed in.
 */
export interface ConversationReducerState {
  /** Ordered conversation history, rendered strictly in this order (R3.4). */
  history: ConversationItem[];
  /** Next monotonic receive-sequence to assign to a processed message (R3.4). */
  nextSeq: number;
  /** Id of the assistant item currently being assembled, or `null` between turns. */
  inProgressAssistantId: string | null;
  /** Latest effective model from `system/init`, or `null` before init. */
  model: string | null;
  /** Active permission mode from `system/init`. */
  permissionMode: PermissionMode;
  /** Latest `session_id` seen on any message — the resumable id (R12.5). */
  resumableSessionId: string | null;
}

/**
 * Build a fresh reducer state. Accepts overrides so a SessionManager can seed
 * the model / permission mode / sequence base when composing a session.
 */
export function createConversationState(
  init: Partial<ConversationReducerState> = {},
): ConversationReducerState {
  return {
    history: init.history ?? [],
    nextSeq: init.nextSeq ?? 0,
    inProgressAssistantId: init.inProgressAssistantId ?? null,
    model: init.model ?? null,
    permissionMode: init.permissionMode ?? "default",
    resumableSessionId: init.resumableSessionId ?? null,
  };
}

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------

/** Concatenate the text of every `text` content block in an assistant message. */
function assembleAssistantText(message: ApiAssistantMessage): string {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

/**
 * The incremental text carried by a streaming event, or `null` when the event
 * is not a text delta. Only `content_block_delta` events with a `text_delta`
 * contribute to the assistant message body; `thinking_delta`,
 * `input_json_delta`, and structural events (`message_start`, `*_stop`, …) do
 * not (R4.1: "append the partial content").
 */
function streamTextDelta(event: RawMessageStreamEvent): string | null {
  if (
    event.type === "content_block_delta" &&
    event.delta.type === "text_delta"
  ) {
    return event.delta.text;
  }
  return null;
}

/**
 * Replace the in-progress assistant item (matched by id) using `update`,
 * returning a new history array. Items of other kinds and other assistant
 * items are left untouched.
 */
function updateAssistantItem(
  history: ConversationItem[],
  id: string,
  update: (item: AssistantConversationItem) => AssistantConversationItem,
): ConversationItem[] {
  return history.map((item) =>
    item.kind === "assistant" && item.id === id ? update(item) : item,
  );
}

// ----------------------------------------------------------------------------
// Per-message reducers
// ----------------------------------------------------------------------------

/** `system/init`: adopt the announced model and permission mode. No item. */
function reduceSystemInit(
  state: ConversationReducerState,
  message: SystemInit,
): ConversationReducerState {
  return {
    ...state,
    model: message.model,
    permissionMode: message.permissionMode,
  };
}

/**
 * `stream_event`: ensure the turn's in-progress assistant item exists (creating
 * it on the first event of the turn, seq = this message's seq), then append any
 * text delta to it (R4.1). The item stays `streaming: true` until the result.
 */
function reduceStreamEvent(
  state: ConversationReducerState,
  message: StreamEvent,
  seq: number,
): ConversationReducerState {
  let history = state.history;
  let inProgressId = state.inProgressAssistantId;

  if (inProgressId === null) {
    const item: AssistantConversationItem = {
      kind: "assistant",
      id: `assistant-${seq}`,
      seq,
      text: "",
      streaming: true,
    };
    history = [...history, item];
    inProgressId = item.id;
  }

  const delta = streamTextDelta(message.event);
  if (delta) {
    const id = inProgressId;
    history = updateAssistantItem(history, id, (item) => ({
      ...item,
      text: item.text + delta,
    }));
  }

  return { ...state, history, inProgressAssistantId: inProgressId };
}

/**
 * `assistant`: surface the complete assistant message block (R3.3). When a turn
 * was being streamed, the complete block's assembled text is authoritative and
 * replaces the in-progress text; otherwise a fresh assistant item is created.
 * Either way the item stays `streaming: true` until the result marks it
 * complete (R4.2). An `error` field is carried for auth-failure surfacing
 * (R8.3).
 */
function reduceAssistant(
  state: ConversationReducerState,
  message: AssistantMessage,
  seq: number,
): ConversationReducerState {
  const text = assembleAssistantText(message.message);
  const { error } = message;

  let history = state.history;
  let inProgressId = state.inProgressAssistantId;

  if (inProgressId !== null) {
    const id = inProgressId;
    history = updateAssistantItem(history, id, (item) => ({
      ...item,
      text,
      ...(error ? { error } : {}),
    }));
  } else {
    const item: AssistantConversationItem = {
      kind: "assistant",
      id: `assistant-${seq}`,
      seq,
      text,
      streaming: true,
      ...(error ? { error } : {}),
    };
    history = [...history, item];
    inProgressId = item.id;
  }

  return { ...state, history, inProgressAssistantId: inProgressId };
}

/**
 * `result`: the terminal message for a turn. Marks the in-progress assistant
 * item complete (R4.2) and appends a `usage` item carrying token usage, total
 * cost, and per-model usage (R4.4). Clears the in-progress tracker so the next
 * `stream_event`/`assistant` starts a fresh turn.
 */
function reduceResult(
  state: ConversationReducerState,
  message: ResultMessage,
  seq: number,
): ConversationReducerState {
  let history = state.history;

  if (state.inProgressAssistantId !== null) {
    const id = state.inProgressAssistantId;
    history = updateAssistantItem(history, id, (item) => ({
      ...item,
      streaming: false,
    }));
  }

  const usageItem: UsageConversationItem = {
    kind: "usage",
    id: `usage-${seq}`,
    seq,
    usage: message.usage,
    totalCostUsd: message.total_cost_usd,
    modelUsage: message.modelUsage,
  };
  history = [...history, usageItem];

  return { ...state, history, inProgressAssistantId: null };
}

/** Record the latest `session_id` seen on a message as the resumable id (R12.5). */
function captureSessionId(
  state: ConversationReducerState,
  message: StdoutMessage,
): ConversationReducerState {
  const sessionId = (message as { session_id?: unknown }).session_id;
  if (typeof sessionId === "string" && sessionId !== state.resumableSessionId) {
    return { ...state, resumableSessionId: sessionId };
  }
  return state;
}

// ----------------------------------------------------------------------------
// Reducer entry points
// ----------------------------------------------------------------------------

/**
 * Reduce one inbound `StdoutMessage` into a new conversation state. Every call
 * consumes exactly one receive-sequence number (`nextSeq`), so item seqs are
 * monotonic in receive order even for messages that produce no item
 * (`keep_alive`, control envelopes) or only append to the in-progress item
 * (subsequent stream deltas). Returns a fresh state; the input is not mutated.
 */
export function reduceConversation(
  state: ConversationReducerState,
  message: StdoutMessage,
): ConversationReducerState {
  const seq = state.nextSeq;
  const advanced = captureSessionId({ ...state, nextSeq: seq + 1 }, message);

  if (isSystemInit(message)) {
    return reduceSystemInit(advanced, message);
  }
  if (isStreamEvent(message)) {
    return reduceStreamEvent(advanced, message, seq);
  }
  if (isAssistantMessage(message)) {
    return reduceAssistant(advanced, message, seq);
  }
  if (isResultMessage(message)) {
    return reduceResult(advanced, message, seq);
  }
  // `keep_alive` and control envelopes carry no conversation item; the seq is
  // still consumed so ordering stays aligned with the raw receive stream.
  return advanced;
}

/**
 * Append a user prompt to the history (the user's submitted text). Consumes one
 * receive-sequence number so the prompt orders correctly relative to the
 * assistant turn it precedes. Returns a fresh state.
 */
export function appendUserPrompt(
  state: ConversationReducerState,
  text: string,
): ConversationReducerState {
  const seq = state.nextSeq;
  const item: UserConversationItem = {
    kind: "user",
    id: `user-${seq}`,
    seq,
    text,
  };
  return {
    ...state,
    history: [...state.history, item],
    nextSeq: seq + 1,
  };
}

// ----------------------------------------------------------------------------
// Stateful wrapper
// ----------------------------------------------------------------------------

/**
 * Ergonomic stateful wrapper around the pure reducer for consuming a live
 * stream: feed decoded messages with {@link accept}, record user prompts with
 * {@link submitUserPrompt}, and read the assembled {@link history} / {@link
 * state}. All mutation is funnelled through the pure functions, so behavior is
 * identical to driving them directly.
 */
export class ConversationReducer {
  private current: ConversationReducerState;

  constructor(init: Partial<ConversationReducerState> = {}) {
    this.current = createConversationState(init);
  }

  /** The full current reducer state (immutable snapshot reference). */
  get state(): ConversationReducerState {
    return this.current;
  }

  /** The current ordered conversation history (R3.4). */
  get history(): ConversationItem[] {
    return this.current.history;
  }

  /** Process one inbound message, advancing the state. */
  accept(message: StdoutMessage): void {
    this.current = reduceConversation(this.current, message);
  }

  /** Record a submitted user prompt, advancing the state. */
  submitUserPrompt(text: string): void {
    this.current = appendUserPrompt(this.current, text);
  }
}
