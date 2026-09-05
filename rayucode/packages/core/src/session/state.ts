// Session state and conversation history shapes (R12, R5.5).
//
// The host owns this state (not the webview), so history survives panel
// close/reopen (R12.2). Conversation items carry a monotonic receive-sequence
// number so the panel renders in the order messages arrived (R3.4).
//
// Type definitions only — the SessionStore/reducer logic is added by later
// tasks.

import type {
  ModelUsage,
} from "../protocol/wire.js";
import type {
  Usage,
} from "../protocol/contentBlocks.js";
import type { PermissionMode, PermissionToolOutput } from "../protocol/wire.js";

/** Lifecycle status of a session. */
export type SessionStatus = "starting" | "idle" | "generating" | "exited";

/** Fields common to every conversation item. */
export interface ConversationItemBase {
  /** Stable id (message uuid, request id, or generated). */
  id: string;
  /** Monotonic receive-sequence assigned as the codec yields the message (R3.4). */
  seq: number;
}

/** A prompt submitted by the user. */
export interface UserConversationItem extends ConversationItemBase {
  kind: "user";
  text: string;
}

/** An assistant message, assembled incrementally from stream deltas (R4.1, R4.2). */
export interface AssistantConversationItem extends ConversationItemBase {
  kind: "assistant";
  /** Assembled text; appended as `stream_event` deltas arrive. */
  text: string;
  /** True until the terminal `result` for the turn is processed (R4.2). */
  streaming: boolean;
  /** Set when the assistant message reported an error (R8.3, R15.2). */
  error?: string;
}

/** Execution status of a tool action shown in history (R10.1–R10.3). */
export type ToolActionStatus = "pending" | "running" | "complete" | "failed";

/** A tool action (e.g. Write/Edit/Bash) and its result (R10.1, R10.2). */
export interface ToolActionConversationItem extends ConversationItemBase {
  kind: "tool_action";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Exact command string for a bash tool action (R5.6, R10.2). */
  command?: string;
  status: ToolActionStatus;
  /** Output produced by the tool action (R10.2). */
  output?: string;
}

/** A permission request surfaced for user decision (R5.1, R5.6). */
export interface PermissionRequestConversationItem extends ConversationItemBase {
  kind: "permission_request";
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Exact bash command string when applicable (R5.6). */
  command?: string;
  /** The decision once answered by the user or by policy. */
  resolution?: PermissionToolOutput;
}

/** Token-usage / cost summary for a completed turn (R4.4). */
export interface UsageConversationItem extends ConversationItemBase {
  kind: "usage";
  usage: Usage;
  totalCostUsd: number;
  modelUsage: Record<string, ModelUsage>;
}

/** An error surfaced in the conversation (R15.2). */
export interface ErrorConversationItem extends ConversationItemBase {
  kind: "error";
  message: string;
}

/** A single ordered entry in a session's history. Discriminated by `kind`. */
export type ConversationItem =
  | UserConversationItem
  | AssistantConversationItem
  | ToolActionConversationItem
  | PermissionRequestConversationItem
  | UsageConversationItem
  | ErrorConversationItem;

/** A permission request awaiting a decision (R5.5 default-deny on close). */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  command?: string;
  /** Receive-sequence at which the request arrived. */
  seq: number;
}

/** The in-memory state for one session. */
export interface SessionState {
  /** Workspace-derived stable key. */
  key: string;
  /** Latest resumable session identifier seen over the protocol (R12.5). */
  resumableSessionId: string | null;
  /** Ordered conversation history (R12.1). */
  history: ConversationItem[];
  /** Currently effective model, or `null` before init. */
  model: string | null;
  /** Active permission mode. */
  permissionMode: PermissionMode;
  /** Permission requests awaiting a decision, keyed by `request_id`. */
  pendingPermissions: Map<string, PendingPermission>;
  /** Lifecycle status. */
  status: SessionStatus;
}
