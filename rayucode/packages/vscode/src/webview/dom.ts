// PanelView — the DOM rendering + intent wiring for the Agent_Panel (task 13.1).
//
// This is the ONLY browser-bound module of the webview that touches the DOM. It
// observes the pure {@link PanelViewModel} and paints it, and translates user
// gestures into {@link WebviewToHostMessage}s via the pure builders in
// `protocol.ts`. It owns NO protocol/ordering logic (that is the view model's
// job) — keeping the view "thin" per the design.
//
// Rendering is keyed + incremental: each conversation item maps to a cached DOM
// node addressed by its stable `id`, re-rendered only when its content changes
// and reordered to match the model's host-assigned order (R3.4). Assistant text
// is the ONLY place HTML is injected, and only via the escape-first
// {@link renderMarkdown} (R3.7) whose output is safe by construction; every
// other value is written with `textContent`.

import { renderMarkdown } from "./markdown.js";
import {
  approveEdit,
  approvePermission,
  denyPermission,
  interrupt,
  isEditToolName,
  newSession,
  openModelList,
  selectModel,
  submitPrompt,
} from "./protocol.js";
import type { WebviewToHostMessage } from "./protocol.js";
import type { PanelViewModel, RenderItem } from "./viewModel.js";

/** Posts a webview→host message (injected so the view stays testable/decoupled). */
export type PostMessage = (message: WebviewToHostMessage) => void;

/** A cached conversation node plus the signature of the item it was rendered from. */
interface CachedNode {
  el: HTMLElement;
  sig: string;
}

/** Create an element with an optional class and text content. */
function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className !== undefined) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

/** Pretty-print a tool input object for display (as plain, escaped text). */
function formatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Renders the Agent_Panel and wires its controls. Construct once with the root
 * element and a `post` callback, then call {@link update} on every view-model
 * change.
 */
export class PanelView {
  private readonly post: PostMessage;

  private readonly conversationEl: HTMLElement;
  private readonly modelNameEl: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly modelSelectEl: HTMLSelectElement;
  private readonly modelButtonEl: HTMLButtonElement;
  private readonly mcpEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly interruptButtonEl: HTMLButtonElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly sendButtonEl: HTMLButtonElement;

  private readonly itemNodes = new Map<string, CachedNode>();

  constructor(root: HTMLElement, post: PostMessage) {
    this.post = post;

    const panel = make("div", "rc-panel");

    // Header: current model + permission mode, model picker, new session.
    const header = make("header", "rc-header");
    const modelInfo = make("div", "rc-model-info");
    this.modelNameEl = make("span", "rc-model-name", "No model");
    this.modeEl = make("span", "rc-mode");
    modelInfo.append(this.modelNameEl, this.modeEl);

    const actions = make("div", "rc-actions");
    this.modelSelectEl = make("select", "rc-model-select");
    this.modelSelectEl.hidden = true;
    this.modelSelectEl.title = "Select model";
    this.modelSelectEl.addEventListener("change", () => {
      const value = this.modelSelectEl.value;
      if (value !== "") {
        this.post(selectModel(value));
      }
    });
    this.modelButtonEl = make("button", "rc-btn rc-model-btn", "Model");
    this.modelButtonEl.type = "button";
    this.modelButtonEl.addEventListener("click", () => {
      this.post(openModelList());
    });
    const newButton = make("button", "rc-btn rc-new-btn", "New session");
    newButton.type = "button";
    newButton.addEventListener("click", () => {
      this.post(newSession());
    });
    actions.append(this.modelSelectEl, this.modelButtonEl, newButton);
    header.append(modelInfo, actions);

    // MCP status strip (R11.2, R11.5).
    this.mcpEl = make("section", "rc-mcp");
    this.mcpEl.hidden = true;

    // Conversation flow.
    this.conversationEl = make("main", "rc-conversation");

    // Footer: in-progress status + interrupt, then the prompt input.
    const footer = make("footer", "rc-footer");
    this.statusEl = make("div", "rc-status");
    this.statusEl.hidden = true;
    const statusText = make("span", "rc-status-text", "Generating…");
    this.interruptButtonEl = make(
      "button",
      "rc-btn rc-interrupt-btn",
      "Interrupt",
    );
    this.interruptButtonEl.type = "button";
    this.interruptButtonEl.addEventListener("click", () => {
      this.post(interrupt());
    });
    this.statusEl.append(statusText, this.interruptButtonEl);

    const inputRow = make("div", "rc-input-row");
    this.inputEl = make("textarea", "rc-input");
    this.inputEl.rows = 3;
    this.inputEl.placeholder = "Ask the agent…";
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
    });
    this.sendButtonEl = make("button", "rc-btn rc-send-btn", "Send");
    this.sendButtonEl.type = "button";
    this.sendButtonEl.addEventListener("click", () => this.submit());
    inputRow.append(this.inputEl, this.sendButtonEl);
    footer.append(this.statusEl, inputRow);

    panel.append(header, this.mcpEl, this.conversationEl, footer);
    root.append(panel);
  }

  /** Re-paint everything from the current model state. */
  update(model: PanelViewModel): void {
    const state = model.state;

    this.modelNameEl.textContent = state.model ?? "No model";
    this.modeEl.textContent =
      state.permissionMode !== null ? `mode: ${state.permissionMode}` : "";

    this.renderModelOptions(state.models, state.model);
    this.renderMcp(state.mcpServers);

    // In-progress indicator + interrupt control (R3.5).
    this.statusEl.hidden = !state.generating;

    this.reconcileConversation(state.items);
    this.conversationEl.scrollTop = this.conversationEl.scrollHeight;

    // R9.5: drain any text staged by `insertPrompt` into the prompt input. This
    // is one-shot (the model clears it on consume), so a given reference is
    // appended exactly once and never auto-submitted.
    const pending = model.consumePendingInput();
    if (pending !== null && pending !== "") {
      this.appendToInput(pending);
    }
  }

  // --------------------------------------------------------------------------
  // Header / status sub-renders
  // --------------------------------------------------------------------------

  private renderModelOptions(
    models: readonly { value: string; displayName: string }[],
    current: string | null,
  ): void {
    if (models.length === 0) {
      this.modelSelectEl.hidden = true;
      this.modelButtonEl.hidden = false;
      return;
    }
    // Populate the picker once the host has returned the list (R7.2).
    this.modelSelectEl.replaceChildren();
    for (const model of models) {
      const option = make("option", undefined, model.displayName);
      option.value = model.value;
      if (model.value === current) {
        option.selected = true;
      }
      this.modelSelectEl.append(option);
    }
    this.modelSelectEl.hidden = false;
    this.modelButtonEl.hidden = true;
  }

  private renderMcp(
    servers: readonly { name: string; status: string }[],
  ): void {
    if (servers.length === 0) {
      this.mcpEl.hidden = true;
      this.mcpEl.replaceChildren();
      return;
    }
    this.mcpEl.replaceChildren();
    const label = make("span", "rc-mcp-label", "MCP:");
    this.mcpEl.append(label);
    for (const server of servers) {
      const failed = isFailedStatus(server.status);
      const chip = make(
        "span",
        `rc-mcp-chip${failed ? " rc-mcp-failed" : ""}`,
        `${server.name}: ${server.status}`,
      );
      this.mcpEl.append(chip);
    }
    this.mcpEl.hidden = false;
  }

  // --------------------------------------------------------------------------
  // Conversation reconciliation (keyed by id, ordered by the model; R3.4)
  // --------------------------------------------------------------------------

  private reconcileConversation(items: readonly RenderItem[]): void {
    // Phase 1: ensure every desired item has an up-to-date node.
    for (const item of items) {
      const sig = signatureOf(item);
      const cached = this.itemNodes.get(item.id);
      if (cached === undefined) {
        this.itemNodes.set(item.id, { el: this.renderItem(item), sig });
      } else if (cached.sig !== sig) {
        const fresh = this.renderItem(item);
        if (cached.el.parentNode !== null) {
          cached.el.replaceWith(fresh);
        }
        cached.el = fresh;
        cached.sig = sig;
      }
    }

    // Phase 2: order the nodes to match the model exactly.
    const container = this.conversationEl;
    items.forEach((item, index) => {
      const node = this.itemNodes.get(item.id)?.el;
      if (node === undefined) {
        return;
      }
      const current = container.childNodes[index] ?? null;
      if (current !== node) {
        container.insertBefore(node, current);
      }
    });

    // Phase 3: drop nodes whose items are gone.
    const liveIds = new Set(items.map((item) => item.id));
    for (const [id, cached] of [...this.itemNodes]) {
      if (!liveIds.has(id)) {
        cached.el.remove();
        this.itemNodes.delete(id);
      }
    }
  }

  private renderItem(item: RenderItem): HTMLElement {
    switch (item.kind) {
      case "user":
        return this.renderUser(item.text);
      case "assistant":
        return this.renderAssistant(item.text, item.streaming, item.error);
      case "tool_action":
        return this.renderToolAction(item);
      case "permission_request":
        return this.renderPermission(item);
      case "usage":
        return this.renderUsage(item.usage, item.totalCostUsd);
      case "error":
        return this.renderError(item.message);
      case "notice":
        return this.renderNotice(item);
      default: {
        const unexpected: never = item;
        void unexpected;
        return make("div");
      }
    }
  }

  private renderUser(text: string): HTMLElement {
    const wrap = make("div", "rc-msg rc-user");
    wrap.append(make("div", "rc-role", "You"));
    wrap.append(make("div", "rc-user-text", text));
    return wrap;
  }

  private renderAssistant(
    text: string,
    streaming: boolean,
    error: string | undefined,
  ): HTMLElement {
    const wrap = make("div", `rc-msg rc-assistant${streaming ? " rc-streaming" : ""}`);
    wrap.append(make("div", "rc-role", "Agent"));
    const md = make("div", "rc-md");
    // SAFE: renderMarkdown is escape-first and emits only a fixed tag subset.
    md.innerHTML = renderMarkdown(text);
    wrap.append(md);
    if (streaming) {
      wrap.append(make("span", "rc-cursor", "▋"));
    }
    if (error !== undefined) {
      wrap.append(make("div", "rc-error", `Error: ${error}`));
    }
    return wrap;
  }

  private renderToolAction(item: {
    toolName: string;
    command?: string;
    status: string;
    output?: string;
  }): HTMLElement {
    const wrap = make("div", "rc-msg rc-tool");
    const head = make("div", "rc-tool-head");
    head.append(make("span", "rc-tool-name", `Tool: ${item.toolName}`));
    head.append(
      make("span", `rc-tool-status rc-status-${item.status}`, item.status),
    );
    // Running indicator while a tool action is in progress (R10.3).
    if (item.status === "running" || item.status === "pending") {
      head.append(make("span", "rc-spinner", "…"));
    }
    wrap.append(head);
    // Exact command for a bash tool action (R10.2).
    if (item.command !== undefined && item.command !== "") {
      wrap.append(this.codeBlock(item.command));
    }
    // Tool output (R10.2).
    if (item.output !== undefined && item.output !== "") {
      wrap.append(this.codeBlock(item.output));
    }
    return wrap;
  }

  private renderPermission(item: {
    requestId: string;
    toolName: string;
    input: Record<string, unknown>;
    command?: string;
    resolution?: { behavior: string };
  }): HTMLElement {
    const wrap = make("div", "rc-msg rc-perm");
    wrap.append(
      make("div", "rc-perm-head", `Permission requested: ${item.toolName}`),
    );

    const isEdit = isEditToolName(item.toolName);
    // For an edit proposal, show a per-file before/after diff (R6.1).
    const diff = isEdit ? renderEditDiff(item.toolName, item.input) : null;
    if (diff !== null) {
      wrap.append(diff);
    } else {
      // Otherwise show the tool parameters verbatim (R5.1).
      wrap.append(make("div", "rc-perm-label", "Parameters"));
      wrap.append(this.codeBlock(formatInput(item.input)));
    }

    // The EXACT bash command, shown before approve/deny (R5.6).
    if (item.command !== undefined && item.command !== "") {
      wrap.append(make("div", "rc-perm-label", "Command"));
      wrap.append(this.codeBlock(item.command));
    }

    if (item.resolution !== undefined) {
      wrap.append(
        make(
          "div",
          "rc-perm-resolved",
          item.resolution.behavior === "allow" ? "Approved" : "Denied",
        ),
      );
      return wrap;
    }

    // Unanswered ⇒ approve/deny controls (R5.1).
    const controls = make("div", "rc-perm-controls");
    const approve = make("button", "rc-btn rc-approve", "Approve");
    approve.type = "button";
    const deny = make("button", "rc-btn rc-deny", "Deny");
    deny.type = "button";
    const lock = (): void => {
      approve.disabled = true;
      deny.disabled = true;
    };
    approve.addEventListener("click", () => {
      lock();
      // Edit tools route through approveEdit so the host APPLIES the change
      // (R6.2); other tools are a plain permission approval (R5.2).
      this.post(
        isEdit
          ? approveEdit(item.requestId)
          : approvePermission(item.requestId),
      );
    });
    deny.addEventListener("click", () => {
      lock();
      this.post(denyPermission(item.requestId));
    });
    controls.append(approve, deny);
    wrap.append(controls);
    return wrap;
  }

  private renderUsage(
    usage: { input_tokens: number; output_tokens: number },
    totalCostUsd: number,
  ): HTMLElement {
    const wrap = make("div", "rc-msg rc-usage");
    const tokens = `${usage.input_tokens} in / ${usage.output_tokens} out`;
    const cost = `$${totalCostUsd.toFixed(4)}`;
    wrap.textContent = `Usage: ${tokens} · ${cost}`;
    return wrap;
  }

  private renderError(message: string): HTMLElement {
    return make("div", "rc-msg rc-error", message);
  }

  private renderNotice(item: {
    level: "info" | "warn";
    message: string;
    requestId?: string;
  }): HTMLElement {
    const wrap = make("div", `rc-msg rc-notice rc-notice-${item.level}`);
    wrap.append(make("span", "rc-notice-text", item.message));
    // A conflict notice carries a requestId and offers explicit confirmation
    // before overriding the on-disk content (R6.3).
    if (item.requestId !== undefined) {
      const confirm = make("button", "rc-btn rc-confirm", "Apply anyway");
      confirm.type = "button";
      const requestId = item.requestId;
      confirm.addEventListener("click", () => {
        confirm.disabled = true;
        this.post({ type: "confirmConflict", requestId });
      });
      wrap.append(confirm);
    }
    return wrap;
  }

  private codeBlock(text: string): HTMLElement {
    const pre = make("pre", "rc-code");
    pre.append(make("code", undefined, text));
    return pre;
  }

  private submit(): void {
    const text = this.inputEl.value.trim();
    if (text === "") {
      return;
    }
    this.post(submitPrompt(text));
    this.inputEl.value = "";
    this.inputEl.focus();
  }

  /**
   * Append staged text to the prompt input WITHOUT submitting (R9.5 add-
   * selection-to-prompt). A newline separates the inserted reference from any
   * existing draft; focus moves to the input and the caret is placed at the end
   * so the user can keep typing after the inserted reference.
   */
  private appendToInput(text: string): void {
    const current = this.inputEl.value;
    this.inputEl.value = current.length > 0 ? `${current}\n${text}` : text;
    this.inputEl.focus();
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
  }
}

// ----------------------------------------------------------------------------
// Free helpers
// ----------------------------------------------------------------------------

function isFailedStatus(status: string): boolean {
  const lower = status.toLowerCase();
  return (
    lower.includes("fail") ||
    lower.includes("error") ||
    lower === "needs-auth"
  );
}

/** A content signature so an item is only re-rendered when it actually changes. */
function signatureOf(item: RenderItem): string {
  try {
    return JSON.stringify(item);
  } catch {
    return `${item.kind}:${item.id}`;
  }
}

/**
 * Build a per-file before/after diff element for an edit tool's input (R6.1).
 * Returns `null` when the input does not match a known edit shape.
 */
function renderEditDiff(
  toolName: string,
  input: Record<string, unknown>,
): HTMLElement | null {
  const filePath = asString(input["file_path"]);
  if (filePath === undefined) {
    return null;
  }
  const wrap = make("div", "rc-diff");
  wrap.append(make("div", "rc-diff-file", filePath));

  const addBeforeAfter = (before: string | null, after: string): void => {
    if (before !== null) {
      const beforeBlock = make("pre", "rc-code rc-diff-before");
      beforeBlock.append(make("code", undefined, before));
      wrap.append(make("div", "rc-diff-label", "Before"));
      wrap.append(beforeBlock);
    }
    const afterBlock = make("pre", "rc-code rc-diff-after");
    afterBlock.append(make("code", undefined, after));
    wrap.append(make("div", "rc-diff-label", before !== null ? "After" : "New file"));
    wrap.append(afterBlock);
  };

  if (toolName === "Write") {
    addBeforeAfter(null, asString(input["content"]) ?? "");
    return wrap;
  }
  if (toolName === "Edit") {
    addBeforeAfter(
      asString(input["old_string"]) ?? "",
      asString(input["new_string"]) ?? "",
    );
    return wrap;
  }
  if (toolName === "MultiEdit") {
    const edits = input["edits"];
    if (!Array.isArray(edits)) {
      return wrap;
    }
    edits.forEach((edit, index) => {
      if (typeof edit !== "object" || edit === null) {
        return;
      }
      const record = edit as Record<string, unknown>;
      wrap.append(make("div", "rc-diff-label", `Edit ${index + 1}`));
      addBeforeAfter(
        asString(record["old_string"]) ?? "",
        asString(record["new_string"]) ?? "",
      );
    });
    return wrap;
  }
  return null;
}
