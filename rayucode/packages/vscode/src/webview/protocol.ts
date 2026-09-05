// Webview ↔ host message contract (task 13.1).
//
// This module is the single source of truth for the strict `postMessage`
// contract between the Agent_Panel webview and the host (the core
// `SessionManager`). It is PURE — no DOM, no `vscode`, no Node builtins — so it
// is bundled into the browser-side webview AND unit-tested in plain Node
// (task 13.2).
//
//   - HOST → WEBVIEW: the `PanelOutboundMessage` union the core pushes. We
//     import that type DIRECTLY from `@rayucode/core` (type-only, erased at
//     build time) so the webview's inbound handling stays structurally locked
//     to the core's contract; if the core adds/changes a message the webview's
//     exhaustive dispatch (see `viewModel.ts`) fails to compile.
//   - WEBVIEW → HOST: the intents the core's `handlePanelMessage` accepts,
//     declared here as `WebviewToHostMessage` plus a small set of pure builder
//     functions that construct each message with exactly the right shape.
//
// The type-only core import never pulls core's runtime (which uses Node
// builtins) into the browser bundle: `import type` is fully erased, so esbuild
// bundles nothing from `@rayucode/core` here.

import type { PanelOutboundMessage } from "@rayucode/core";

// ----------------------------------------------------------------------------
// HOST → WEBVIEW
// ----------------------------------------------------------------------------

/**
 * A message pushed from the host to the webview. Aliased from the core's
 * authoritative {@link PanelOutboundMessage} union so the two never drift.
 */
export type HostToWebviewMessage = PanelOutboundMessage;

/** Every `type` discriminant in {@link HostToWebviewMessage}. */
export type HostMessageType = HostToWebviewMessage["type"];

/**
 * The complete set of host→webview message type names. Declared with an
 * exhaustive `Record<HostMessageType, true>` so it is a COMPILE ERROR to forget
 * one (or to leave a stale name) if the core's union changes.
 */
const HOST_MESSAGE_TYPE_TABLE: Record<HostMessageType, true> = {
  restoreHistory: true,
  addMessage: true,
  appendPartial: true,
  completeMessage: true,
  setGenerating: true,
  showPermissionRequest: true,
  showToolAction: true,
  updateToolStatus: true,
  showUsage: true,
  setModelInfo: true,
  setModelList: true,
  setMcpStatus: true,
  showError: true,
  editApplied: true,
  editConflict: true,
  insertPrompt: true,
  // Newly forwarded once the protocol package made them typed and validated.
  // Each was previously discarded by the host, which is why the panel appeared
  // to be missing information (rayucode/TRIAGE.md D8).
  toolProgress: true,
  rateLimit: true,
  authStatus: true,
  compactBoundary: true,
};

/** All host→webview message type names (frozen runtime set). */
export const HOST_MESSAGE_TYPES: ReadonlySet<HostMessageType> = new Set(
  Object.keys(HOST_MESSAGE_TYPE_TABLE) as HostMessageType[],
);

/**
 * Narrowing guard: is `data` a recognized host→webview message? Defensive at
 * the trust boundary — `window`'s `message` events can in principle originate
 * from anything, so the webview only acts on messages whose `type` it knows.
 */
export function isHostMessage(data: unknown): data is HostToWebviewMessage {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const type = (data as { type?: unknown }).type;
  return (
    typeof type === "string" && HOST_MESSAGE_TYPES.has(type as HostMessageType)
  );
}

// ----------------------------------------------------------------------------
// WEBVIEW → HOST
// ----------------------------------------------------------------------------

/** Submit a user prompt for the active session (R3.2). */
export interface SubmitPromptMessage {
  type: "submitPrompt";
  text: string;
}

/** Interrupt the in-progress turn (R3.6). */
export interface InterruptMessage {
  type: "interrupt";
}

/** Approve a surfaced permission request, carrying the approved input (R5.2). */
export interface ApprovePermissionMessage {
  type: "approvePermission";
  requestId: string;
  updatedInput?: Record<string, unknown>;
}

/** Deny a surfaced permission request, with an optional reason (R5.3). */
export interface DenyPermissionMessage {
  type: "denyPermission";
  requestId: string;
  message?: string;
}

/** Approve a File_Edit_Proposal so the host applies it (R6.2). */
export interface ApproveEditMessage {
  type: "approveEdit";
  requestId: string;
}

/** Confirm applying an edit that conflicted with on-disk content (R6.3). */
export interface ConfirmConflictMessage {
  type: "confirmConflict";
  requestId: string;
}

/** Select a model for subsequent turns (R7.3). */
export interface SelectModelMessage {
  type: "selectModel";
  model: string;
}

/** Ask the host for the list of available models (R7.2). */
export interface OpenModelListMessage {
  type: "openModelList";
}

/** Start a fresh, independent session (R12.4). */
export interface NewSessionMessage {
  type: "newSession";
}

/**
 * Change the permission mode for subsequent tool use.
 *
 * The runtime equivalent of the CLI's `/permission-mode`. The host validates the
 * string against the wire schema before applying it — the webview is a separate
 * JS context, and this value decides whether tool actions are auto-approved, so
 * it is never trusted as-is.
 */
export interface SelectPermissionModeMessage {
  type: "selectPermissionMode";
  mode: string;
}

/**
 * A message the webview posts back to the host. Matches exactly the cases the
 * core `SessionManager.handlePanelMessage` accepts.
 */
export type WebviewToHostMessage =
  | SubmitPromptMessage
  | InterruptMessage
  | ApprovePermissionMessage
  | DenyPermissionMessage
  | ApproveEditMessage
  | ConfirmConflictMessage
  | SelectModelMessage
  | OpenModelListMessage
  | NewSessionMessage
  | SelectPermissionModeMessage;

// ----------------------------------------------------------------------------
// Permission modes offered in the panel
// ----------------------------------------------------------------------------

/**
 * The permission modes the panel offers, with the wording shown to the user.
 *
 * A deliberate SUBSET of the wire schema's modes. The schema also carries
 * `dontAsk`, `auto`, `bubble` and `fullManage`, which are either engine-internal
 * or deny-by-default variants that would strand a user who picked one without
 * understanding it. Restricting the picker does not restrict the setting: a mode
 * outside this list, arriving from `rayucode.permissionMode`, is still displayed
 * (see the picker's preserved-value option) and still honoured.
 *
 * Ordered least to most permissive so the riskiest choice is last.
 */
export const SELECTABLE_PERMISSION_MODES: readonly {
  value: string;
  label: string;
  hint: string;
}[] = [
  {
    value: "plan",
    label: "Plan",
    hint: "Read and analyse only. No file edits and no commands.",
  },
  {
    value: "default",
    label: "Ask every time",
    hint: "Prompt before each file edit and each command.",
  },
  {
    value: "acceptEdits",
    label: "Auto-accept edits",
    hint: "Apply file edits without asking. Still prompt before commands.",
  },
  {
    value: "bypassPermissions",
    label: "Bypass all prompts",
    hint: "Run edits AND commands with no prompt. Use only in a throwaway workspace.",
  },
];

// ----------------------------------------------------------------------------
// WEBVIEW → HOST — pure builders
//
// One builder per intent. Each returns a plain object with EXACTLY the fields
// the host reads (optional fields are omitted, never set to `undefined`, so the
// serialized message is minimal). These are pure functions — trivial to assert
// on in unit tests (task 13.2).
// ----------------------------------------------------------------------------

/** Build a {@link SubmitPromptMessage}. */
export function submitPrompt(text: string): SubmitPromptMessage {
  return { type: "submitPrompt", text };
}

/** Build an {@link InterruptMessage}. */
export function interrupt(): InterruptMessage {
  return { type: "interrupt" };
}

/** Build an {@link ApprovePermissionMessage}, omitting `updatedInput` if absent. */
export function approvePermission(
  requestId: string,
  updatedInput?: Record<string, unknown>,
): ApprovePermissionMessage {
  return updatedInput === undefined
    ? { type: "approvePermission", requestId }
    : { type: "approvePermission", requestId, updatedInput };
}

/** Build a {@link DenyPermissionMessage}, omitting `message` if absent. */
export function denyPermission(
  requestId: string,
  message?: string,
): DenyPermissionMessage {
  return message === undefined
    ? { type: "denyPermission", requestId }
    : { type: "denyPermission", requestId, message };
}

/** Build an {@link ApproveEditMessage}. */
export function approveEdit(requestId: string): ApproveEditMessage {
  return { type: "approveEdit", requestId };
}

/** Build a {@link ConfirmConflictMessage}. */
export function confirmConflict(requestId: string): ConfirmConflictMessage {
  return { type: "confirmConflict", requestId };
}

/** Build a {@link SelectModelMessage}. */
export function selectModel(model: string): SelectModelMessage {
  return { type: "selectModel", model };
}

/** Build an {@link OpenModelListMessage}. */
export function openModelList(): OpenModelListMessage {
  return { type: "openModelList" };
}

/** Build a {@link NewSessionMessage}. */
export function newSession(): NewSessionMessage {
  return { type: "newSession" };
}

/** Build a {@link SelectPermissionModeMessage}. */
export function selectPermissionMode(mode: string): SelectPermissionModeMessage {
  return { type: "selectPermissionMode", mode };
}

// ----------------------------------------------------------------------------
// Edit-tool predicate
//
// The host surfaces a file-edit proposal as a permission request whose
// `toolName` is one of the edit tools. The webview must know whether an
// "approve" on such a request is a plain permission approval (→ approvePermission)
// or an edit that the host should additionally APPLY (→ approveEdit). The core
// owns the authoritative `isEditToolName`, but importing it would drag core's
// Node-bound runtime into the browser bundle, so the small, stable set is
// mirrored here. Kept in lockstep with @rayucode/core's proposalModel.
// ----------------------------------------------------------------------------

/** The file-edit tool names (mirrors @rayucode/core `proposalModel`). */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
]);

/** Whether `toolName` denotes a file-edit tool (so approval should apply it). */
export function isEditToolName(toolName: string): boolean {
  return EDIT_TOOL_NAMES.has(toolName);
}
