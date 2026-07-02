// PermissionCoordinator (R5, R10).
//
// Owns the host side of the tool-permission flow. It consumes inbound
// `can_use_tool` requests (surfaced by the ControlProtocolClient), applies the
// pure auto-approval policy, and answers the CLI with allow/deny permission
// `control_response` payloads. Requests that the policy neither auto-approves
// nor auto-denies are surfaced to the user for an explicit decision (R5.1,
// R5.6) and tracked as pending until answered.
//
// Default-deny on close (R5.5, Property 6): closing a session issues exactly
// one `deny` for every still-pending request, and does so before the agent
// process is terminated — `close()` denies, then awaits the injected
// `terminate`.
//
// Tool actions and their results are forwarded to the conversation history with
// running indicators (R10.1, R10.2, R10.3) via produced `tool_action` items.
//
// The transport and history sink are injected, so the coordinator is pure and
// editor-agnostic — no process, socket, or `vscode` dependency (R13.1, R13.5).

import type { CanUseToolRequest } from "../protocol/control.js";
import type { PermissionRequestEvent } from "../protocol/controlClient.js";
import type { StdinMessage } from "../protocol/messages.js";
import type {
  PermissionMode,
  PermissionToolOutput,
} from "../protocol/permissions.js";
import type {
  ConversationItem,
  PermissionRequestConversationItem,
  ToolActionConversationItem,
  ToolActionStatus,
} from "../session/state.js";
import {
  categorizeTool,
  decidePermission,
  type PermissionDecision,
} from "./policy.js";

// ----------------------------------------------------------------------------
// Construction options
// ----------------------------------------------------------------------------

/** Construction options for a {@link PermissionCoordinator}. */
export interface PermissionCoordinatorOptions {
  /**
   * Transport sink: write one outbound permission `control_response` to the
   * agent's stdin. Injected so the coordinator never touches a concrete
   * process/transport and stays editor-agnostic (R13.1, R13.5).
   */
  send: (message: StdinMessage) => void;
  /** Initial permission mode; defaults to `default`. Updated via {@link setMode}. */
  initialMode?: PermissionMode;
  /**
   * Allocates the monotonic receive-sequence for each produced conversation
   * item so coordinator items interleave correctly with reducer items in the
   * single shared history (R3.4). Defaults to a private counter for standalone
   * use; the SessionManager injects a shared allocator when composing.
   */
  allocateSeq?: () => number;
  /**
   * Notified with a fresh snapshot of the coordinator's produced conversation
   * items whenever they change (a permission request surfaced/resolved, a tool
   * action added, a tool result recorded). Lets the host re-render history.
   */
  onItemsChanged?: (items: ConversationItem[]) => void;
  /** Message used for a default-deny on session close (R5.5). */
  denyOnCloseMessage?: string;
  /** Message used when `dontAsk` denies a non-preapproved action. */
  denyByModeMessage?: string;
}

/** A surfaced permission request awaiting an explicit user decision (R5.5). */
interface PendingEntry {
  request: CanUseToolRequest;
  command: string | undefined;
  itemId: string;
}

const DEFAULT_DENY_ON_CLOSE =
  "Session closed before the permission request was answered.";
const DEFAULT_DENY_BY_MODE =
  "Denied: this tool action is not pre-approved under the current permission mode.";
const DEFAULT_DENY_BY_USER = "Denied by user.";

/** Extract the exact bash command string for a Bash tool action (R5.6, R10.2). */
function extractBashCommand(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName !== "Bash") {
    return undefined;
  }
  const command = input["command"];
  return typeof command === "string" ? command : undefined;
}

// ----------------------------------------------------------------------------
// Coordinator
// ----------------------------------------------------------------------------

/**
 * Coordinates tool-permission decisions for one session. Feed it inbound
 * requests via {@link handlePermissionRequest}; resolve surfaced requests via
 * {@link approve} / {@link deny}; forward tool output via
 * {@link recordToolResult}; and tear down via {@link close} (default-deny then
 * terminate).
 */
export class PermissionCoordinator {
  private readonly send: (message: StdinMessage) => void;
  private readonly allocateSeq: () => number;
  private readonly onItemsChanged:
    | ((items: ConversationItem[]) => void)
    | undefined;
  private readonly denyOnCloseMessage: string;
  private readonly denyByModeMessage: string;

  /** Active permission mode (R5.4). */
  private currentMode: PermissionMode;

  /** Requests surfaced for explicit decision and not yet answered (R5.5). */
  private readonly pending = new Map<string, PendingEntry>();

  /** Per-request decision, doubling as a duplicate-request guard. */
  private readonly decisions = new Map<string, PermissionDecision>();

  /** Conversation items this coordinator has produced, in seq order. */
  private produced: ConversationItem[] = [];

  /** tool_use_id → produced tool_action item id, for result correlation (R10.2). */
  private readonly toolActionByToolUseId = new Map<string, string>();

  /** Backing counter for the default sequence allocator. */
  private seqCounter = 0;

  constructor(options: PermissionCoordinatorOptions) {
    this.send = options.send;
    this.allocateSeq =
      options.allocateSeq ?? (() => this.seqCounter++);
    this.onItemsChanged = options.onItemsChanged;
    this.currentMode = options.initialMode ?? "default";
    this.denyOnCloseMessage =
      options.denyOnCloseMessage ?? DEFAULT_DENY_ON_CLOSE;
    this.denyByModeMessage =
      options.denyByModeMessage ?? DEFAULT_DENY_BY_MODE;
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  /** The active permission mode. */
  get permissionMode(): PermissionMode {
    return this.currentMode;
  }

  /** Number of requests surfaced and still awaiting a decision. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** The request ids currently awaiting a decision. */
  pendingRequestIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Snapshot of the conversation items this coordinator has produced. */
  get conversationItems(): ConversationItem[] {
    return [...this.produced];
  }

  /** Update the active permission mode (e.g. from `system/init` or a user change). */
  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
  }

  // --------------------------------------------------------------------------
  // Inbound permission requests
  // --------------------------------------------------------------------------

  /**
   * Process one inbound `can_use_tool` request. Applies the policy: auto-approve
   * (allow), auto-deny (`dontAsk`), or surface for an explicit decision. Returns
   * the decision taken. A duplicate request id is ignored and its prior decision
   * is returned.
   */
  handlePermissionRequest(event: PermissionRequestEvent): PermissionDecision {
    const { requestId, request } = event;

    const prior = this.decisions.get(requestId);
    if (prior !== undefined) {
      return prior;
    }

    const command = extractBashCommand(request.tool_name, request.input);
    const category = categorizeTool(request.tool_name);
    const decision = decidePermission(this.currentMode, category);

    if (decision === "allow") {
      // Auto-approved (R5.4): the approved input is the input as requested.
      this.sendAllow(requestId, request.input);
      // Surface the now-executing action with a running indicator (R10.1, R10.3).
      this.appendToolAction(request, command, "running");
      this.decisions.set(requestId, "allow");
      return "allow";
    }

    if (decision === "deny") {
      // dontAsk + non-preapproved: deny without prompting.
      const message = this.denyByModeMessage;
      this.sendDeny(requestId, message);
      // Record the auto-denied request for transparency (already resolved).
      this.appendPermissionRequest(requestId, request, command, {
        behavior: "deny",
        message,
      });
      this.decisions.set(requestId, "deny");
      return "deny";
    }

    // Surface for an explicit user decision (R5.1, R5.6); answer later.
    const itemId = this.appendPermissionRequest(
      requestId,
      request,
      command,
      undefined,
    );
    this.pending.set(requestId, { request, command, itemId });
    this.decisions.set(requestId, "prompt");
    return "prompt";
  }

  /**
   * Approve a surfaced permission request (R5.2). The emitted allow
   * `control_response` carries `updatedInput` equal to the input the user
   * approved — the supplied `updatedInput` if the user edited it, otherwise the
   * input as originally requested. Returns `false` if no such request is
   * pending (already answered / unknown).
   */
  approve(requestId: string, updatedInput?: Record<string, unknown>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }
    this.pending.delete(requestId);

    const approvedInput = updatedInput ?? entry.request.input;
    this.sendAllow(requestId, approvedInput);
    this.resolvePermissionItem(entry.itemId, {
      behavior: "allow",
      updatedInput: approvedInput,
    });
    // Forward the now-executing action with a running indicator (R10.1, R10.3).
    this.appendToolAction(entry.request, entry.command, "running");
    this.decisions.set(requestId, "allow");
    return true;
  }

  /**
   * Deny a surfaced permission request (R5.3). Returns `false` if no such
   * request is pending (already answered / unknown).
   */
  deny(requestId: string, message: string = DEFAULT_DENY_BY_USER): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }
    this.pending.delete(requestId);

    this.sendDeny(requestId, message);
    this.resolvePermissionItem(entry.itemId, { behavior: "deny", message });
    this.decisions.set(requestId, "deny");
    return true;
  }

  // --------------------------------------------------------------------------
  // Tool action results
  // --------------------------------------------------------------------------

  /**
   * Record the output of a previously-approved tool action and mark it complete
   * (or failed). Correlated by `tool_use_id` to the running `tool_action` item
   * (R10.1, R10.2). Returns `false` when no matching action is tracked.
   */
  recordToolResult(
    toolUseId: string,
    output: string,
    isError = false,
  ): boolean {
    const itemId = this.toolActionByToolUseId.get(toolUseId);
    if (itemId === undefined) {
      return false;
    }
    const status: ToolActionStatus = isError ? "failed" : "complete";
    this.produced = this.produced.map((item) =>
      item.kind === "tool_action" && item.id === itemId
        ? { ...item, status, output }
        : item,
    );
    this.notify();
    return true;
  }

  // --------------------------------------------------------------------------
  // Teardown — default-deny on close (R5.5)
  // --------------------------------------------------------------------------

  /**
   * Close the session: issue exactly one `deny` for every still-pending request
   * (R5.5), then terminate the agent process. Denies are sent synchronously
   * before `terminate` is invoked, guaranteeing all deny responses are issued
   * before the process is terminated (Property 6).
   */
  async close(terminate?: () => void | Promise<void>): Promise<void> {
    this.denyAllPending();
    if (terminate) {
      await terminate();
    }
  }

  /**
   * Issue exactly one `deny` `control_response` for every still-pending
   * permission request and clear the pending set. Idempotent: a second call
   * finds nothing pending and sends nothing.
   */
  denyAllPending(message: string = this.denyOnCloseMessage): void {
    if (this.pending.size === 0) {
      return;
    }
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [requestId, entry] of entries) {
      this.sendDeny(requestId, message);
      this.resolvePermissionItem(entry.itemId, { behavior: "deny", message });
      this.decisions.set(requestId, "deny");
    }
  }

  // --------------------------------------------------------------------------
  // Outbound control_response builders
  // --------------------------------------------------------------------------

  /** Send an allow permission `control_response` carrying the approved input (R5.2). */
  private sendAllow(
    requestId: string,
    updatedInput: Record<string, unknown>,
  ): void {
    const payload: PermissionToolOutput = { behavior: "allow", updatedInput };
    this.send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: payload },
    });
  }

  /** Send a deny permission `control_response` carrying the reason (R5.3). */
  private sendDeny(requestId: string, message: string): void {
    const payload: PermissionToolOutput = { behavior: "deny", message };
    this.send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: payload },
    });
  }

  // --------------------------------------------------------------------------
  // History item production
  // --------------------------------------------------------------------------

  /** Append a permission_request item, returning its id (R5.1, R5.6). */
  private appendPermissionRequest(
    requestId: string,
    request: CanUseToolRequest,
    command: string | undefined,
    resolution: PermissionToolOutput | undefined,
  ): string {
    const seq = this.allocateSeq();
    const id = `permission-${seq}`;
    const item: PermissionRequestConversationItem = {
      kind: "permission_request",
      id,
      seq,
      requestId,
      toolName: request.tool_name,
      input: request.input,
      ...(command !== undefined ? { command } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
    };
    this.produced.push(item);
    this.notify();
    return id;
  }

  /** Append a tool_action item with the given status (R10.1, R10.3). */
  private appendToolAction(
    request: CanUseToolRequest,
    command: string | undefined,
    status: ToolActionStatus,
  ): string {
    const seq = this.allocateSeq();
    const id = `tool-${seq}`;
    const item: ToolActionConversationItem = {
      kind: "tool_action",
      id,
      seq,
      toolUseId: request.tool_use_id,
      toolName: request.tool_name,
      input: request.input,
      ...(command !== undefined ? { command } : {}),
      status,
    };
    this.produced.push(item);
    this.toolActionByToolUseId.set(request.tool_use_id, id);
    this.notify();
    return id;
  }

  /** Set the resolution on a previously-surfaced permission_request item. */
  private resolvePermissionItem(
    itemId: string,
    resolution: PermissionToolOutput,
  ): void {
    this.produced = this.produced.map((item) =>
      item.kind === "permission_request" && item.id === itemId
        ? { ...item, resolution }
        : item,
    );
    this.notify();
  }

  private notify(): void {
    this.onItemsChanged?.([...this.produced]);
  }
}
