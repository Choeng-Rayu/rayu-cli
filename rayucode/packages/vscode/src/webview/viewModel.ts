// PanelViewModel — the webview's PURE render state (task 13.1).
//
// The webview is a thin view (design "Process model"): it holds NO protocol
// logic. This module is the in-webview state it DOES own — an ordered list of
// renderable items plus a little ambient status (generating flag, current
// model/mode, model list, MCP status) — produced entirely by folding the
// host's {@link PanelOutboundMessage} stream.
//
// It is deliberately DOM-free and `vscode`-free so it can be unit-tested in
// Node (task 13.2). The DOM layer (`dom.ts`) observes this model and paints; it
// never decides ordering or content itself.
//
// ORDER PRESERVATION (R3.4): the host assigns every conversation item a
// monotonic receive-sequence (`seq`) as the codec yields the underlying
// protocol message. This model renders strictly by that host-assigned `seq`
// (ties broken by arrival), so the panel shows messages in exactly the order
// the host received them — regardless of the order the individual `postMessage`
// notifications happen to be observed in.

import type {
  ConversationItem,
  ModelInfo,
  ModelUsage,
  PanelOutboundMessage,
  PermissionMode,
  Usage,
} from "@rayucode/core";

/**
 * A host-pushed notice that is not a conversation item: an applied edit (R6.2)
 * or an on-disk conflict awaiting confirmation (R6.3). Carried in the ordered
 * flow so it appears in context.
 */
export interface NoticeRenderItem {
  kind: "notice";
  id: string;
  seq: number;
  level: "info" | "warn";
  message: string;
  /** Present for a conflict notice; enables a "confirm" action (R6.3). */
  requestId?: string;
  /** Conflicting file paths, for a conflict notice. */
  paths?: string[];
}

/** A single entry the panel renders, in host-assigned order. */
export type RenderItem = ConversationItem | NoticeRenderItem;

/** The model/cost summary most recently reported for a completed turn (R4.4). */
export interface UsageSummary {
  usage: Usage;
  totalCostUsd: number;
  modelUsage: Record<string, ModelUsage>;
}

/** A read-only snapshot of the panel's render state (what the DOM paints). */
export interface PanelRenderState {
  /** Conversation flow, ordered by host-assigned `seq` (R3.4). */
  readonly items: readonly RenderItem[];
  /** Whether a turn is in progress — drives the indicator + interrupt (R3.5). */
  readonly generating: boolean;
  /** Current model in effect, or `null` before init (R7.1). */
  readonly model: string | null;
  /** Active permission mode, or `null` before init. */
  readonly permissionMode: PermissionMode | null;
  /** Available models for the picker (R7.2); empty until requested. */
  readonly models: readonly ModelInfo[];
  /** MCP server statuses, including failures (R11.2, R11.5). */
  readonly mcpServers: readonly { name: string; status: string }[];
  /** The latest usage/cost summary, or `null` if none yet (R4.4). */
  readonly usage: UsageSummary | null;
  /**
   * One-shot text staged for the prompt input by `insertPrompt` (R9.5), or
   * `null` when nothing is pending. The DOM layer drains it via
   * {@link PanelViewModel.consumePendingInput} on the next paint.
   */
  readonly pendingInput: string | null;
}

/** Internal wrapper pairing a render item with its sort keys. */
interface OrderedEntry {
  /** Primary sort key: the host-assigned `seq`. */
  order: number;
  /** Secondary sort key: observation order, for a stable tie-break. */
  arrival: number;
  item: RenderItem;
}

/**
 * Holds and folds the webview's render state. Construct one per panel; feed it
 * every host message via {@link handle}; read {@link state} / {@link items} to
 * paint. All updates are deterministic functions of the message stream, so a
 * test can drive it with a scripted sequence and assert the resulting order and
 * content.
 */
export class PanelViewModel {
  private entries: OrderedEntry[] = [];
  private arrivalCounter = 0;
  /** Highest `seq` observed; seq-less notices/usage sort just after it. */
  private maxSeq = 0;

  private generating = false;
  private model: string | null = null;
  private permissionMode: PermissionMode | null = null;
  private models: ModelInfo[] = [];
  private mcpServers: { name: string; status: string }[] = [];
  private usage: UsageSummary | null = null;
  /** One-shot prompt-input text staged by `insertPrompt` (R9.5). */
  private pendingInput: string | null = null;

  /** The ordered render items (host-assigned `seq` order, R3.4). */
  get items(): readonly RenderItem[] {
    return this.entries.map((entry) => entry.item);
  }

  /** A snapshot of the full render state. */
  get state(): PanelRenderState {
    return {
      items: this.items,
      generating: this.generating,
      model: this.model,
      permissionMode: this.permissionMode,
      models: this.models,
      mcpServers: this.mcpServers,
      usage: this.usage,
      pendingInput: this.pendingInput,
    };
  }

  /**
   * Take and clear the one-shot pending prompt input staged by `insertPrompt`
   * (R9.5). Returns `null` when nothing is pending. The DOM layer calls this on
   * each paint and appends any returned text to the prompt textarea (without
   * submitting), so a given insert is applied exactly once.
   */
  consumePendingInput(): string | null {
    const pending = this.pendingInput;
    this.pendingInput = null;
    return pending;
  }

  /**
   * Fold one host→webview message into the state. The `switch` is exhaustive
   * over {@link PanelOutboundMessage}; the `never` default makes it a COMPILE
   * ERROR to leave a core message type unhandled, keeping the webview locked to
   * the host contract.
   */
  handle(message: PanelOutboundMessage): void {
    switch (message.type) {
      case "restoreHistory":
        this.restore(message.items);
        return;
      case "addMessage":
        this.upsertItem(message.item);
        return;
      case "appendPartial":
        this.appendPartial(message.itemId, message.delta);
        return;
      case "completeMessage":
        this.completeMessage(message.itemId);
        return;
      case "setGenerating":
        this.generating = message.generating;
        return;
      case "showPermissionRequest":
        this.upsertItem(message.item);
        return;
      case "showToolAction":
        this.upsertItem(message.item);
        return;
      case "updateToolStatus":
        this.updateToolStatus(message.itemId, message.status, message.output);
        return;
      case "showUsage":
        this.showUsage(
          message.usage,
          message.totalCostUsd,
          message.modelUsage,
        );
        return;
      case "setModelInfo":
        this.model = message.model;
        this.permissionMode = message.permissionMode;
        return;
      case "setModelList":
        this.models = message.models;
        return;
      case "setMcpStatus":
        this.mcpServers = message.servers;
        return;
      case "showError":
        this.appendNotice("warn", message.message);
        return;
      case "editApplied":
        this.appendNotice("info", `Applied edit to ${message.path}`);
        return;
      case "editConflict":
        this.appendConflictNotice(message.paths, message.requestId);
        return;
      case "insertPrompt":
        this.bufferInput(message.text);
        return;
      default: {
        // Exhaustiveness guard: a new core message type must be handled here.
        const unexpected: never = message;
        void unexpected;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Folding helpers
  // --------------------------------------------------------------------------

  /** Replace the entire flow from a restored, host-ordered history (R12.2). */
  private restore(items: readonly ConversationItem[]): void {
    this.entries = [];
    this.arrivalCounter = 0;
    this.maxSeq = 0;
    for (const item of items) {
      this.upsertItem(item);
    }
  }

  /**
   * Insert a fresh item or update an existing one in place (matched by `id`).
   * A new item is placed to keep the flow sorted by (`seq`, arrival), which is
   * the host's receive order (R3.4).
   */
  private upsertItem(item: ConversationItem): void {
    this.observeSeq(item.seq);
    const existing = this.entries.find((entry) => entry.item.id === item.id);
    if (existing !== undefined) {
      existing.item = item;
      return;
    }
    this.insert({ order: item.seq, arrival: this.arrivalCounter++, item });
  }

  /** Append a streaming delta to the in-progress assistant item (R4.1). */
  private appendPartial(itemId: string, delta: string): void {
    const entry = this.entries.find((e) => e.item.id === itemId);
    if (entry !== undefined && entry.item.kind === "assistant") {
      entry.item = { ...entry.item, text: entry.item.text + delta };
    }
  }

  /** Mark the in-progress assistant item complete (R4.2). */
  private completeMessage(itemId: string): void {
    const entry = this.entries.find((e) => e.item.id === itemId);
    if (entry !== undefined && entry.item.kind === "assistant") {
      entry.item = { ...entry.item, streaming: false };
    }
  }

  /** Update a tool action's status and (optionally) its output (R10.2, R10.3). */
  private updateToolStatus(
    itemId: string,
    status: string,
    output: string | undefined,
  ): void {
    const entry = this.entries.find((e) => e.item.id === itemId);
    if (entry === undefined || entry.item.kind !== "tool_action") {
      return;
    }
    const next = { ...entry.item, status: status as typeof entry.item.status };
    if (output !== undefined) {
      next.output = output;
    }
    entry.item = next;
  }

  /** Record usage (R4.4) and surface it as an ordered usage item. */
  private showUsage(
    usage: Usage,
    totalCostUsd: number,
    modelUsage: Record<string, ModelUsage>,
  ): void {
    this.usage = { usage, totalCostUsd, modelUsage };
    const arrival = this.arrivalCounter++;
    this.insert({
      order: this.maxSeq,
      arrival,
      item: {
        kind: "usage",
        id: `usage-${arrival}`,
        seq: this.maxSeq,
        usage,
        totalCostUsd,
        modelUsage,
      },
    });
  }

  /** Append a seq-less notice (error or applied-edit) at the current tail. */
  private appendNotice(level: "info" | "warn", message: string): void {
    const arrival = this.arrivalCounter++;
    this.insert({
      order: this.maxSeq,
      arrival,
      item: {
        kind: "notice",
        id: `notice-${arrival}`,
        seq: this.maxSeq,
        level,
        message,
      },
    });
  }

  /** Append a conflict notice carrying the requestId for confirmation (R6.3). */
  private appendConflictNotice(paths: string[], requestId: string): void {
    const arrival = this.arrivalCounter++;
    const list = paths.join(", ");
    this.insert({
      order: this.maxSeq,
      arrival,
      item: {
        kind: "notice",
        id: `conflict-${requestId}`,
        seq: this.maxSeq,
        level: "warn",
        message: `These files changed on disk since the proposal: ${list}.`,
        requestId,
        paths,
      },
    });
  }

  /**
   * Buffer text staged for the prompt input by `insertPrompt` (R9.5). It is NOT
   * a conversation item, so it does not enter the ordered flow. Multiple inserts
   * before the DOM drains the buffer are concatenated (newline-separated) so no
   * inserted reference is lost.
   */
  private bufferInput(text: string): void {
    this.pendingInput =
      this.pendingInput === null ? text : `${this.pendingInput}\n${text}`;
  }

  // --------------------------------------------------------------------------
  // Ordering primitives
  // --------------------------------------------------------------------------

  private observeSeq(seq: number): void {
    if (seq > this.maxSeq) {
      this.maxSeq = seq;
    }
  }

  /**
   * Insert `entry` keeping `entries` sorted by (`order`, `arrival`). A stable
   * insertion (place AFTER all entries that are <= it) guarantees that, for the
   * monotonically increasing seq/arrival the host produces, items render in the
   * host's receive order (R3.4).
   */
  private insert(entry: OrderedEntry): void {
    let index = this.entries.length;
    while (index > 0) {
      const prev = this.entries[index - 1] as OrderedEntry;
      const before =
        prev.order < entry.order ||
        (prev.order === entry.order && prev.arrival <= entry.arrival);
      if (before) {
        break;
      }
      index--;
    }
    this.entries.splice(index, 0, entry);
  }
}
