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
  PermissionRequestConversationItem,
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
  /**
   * Live progress for the tool currently running, or `null`.
   *
   * Deliberately transient rather than a conversation item: progress is replaced
   * in place, so a 60-second tool produces one indicator rather than 60
   * transcript entries.
   */
  readonly toolProgress: ToolProgressState | null;
  /** Provider quota state when warning or rejected, else `null`. */
  readonly rateLimit: RateLimitState | null;
  /** Whether the engine is currently authenticating. */
  readonly authenticating: boolean;
  /**
   * The permission request currently blocking the turn, or `null`.
   *
   * DERIVED from {@link items} on every snapshot rather than stored as its own
   * field: a second copy would have to be kept in step with the resolution that
   * arrives later as an `upsertItem` merge, and the failure mode of that drifting
   * is the worst one available here — a bar that keeps asking for a decision
   * already made, or worse, one that disappears while the agent is still blocked.
   * Deriving makes those states unrepresentable.
   *
   * When several are outstanding this is the LOWEST-`seq` one, so requests are
   * answered in the order the agent asked.
   */
  readonly pendingPermission: PermissionRequestConversationItem | null;
}

/** Live progress for an in-flight tool call. */
export interface ToolProgressState {
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
}

/** Provider quota state worth showing the user. */
export interface RateLimitState {
  status: "allowed_warning" | "rejected";
  rateLimitType?: string;
  utilization?: number;
  /** Unix timestamp in SECONDS (not milliseconds). */
  resetsAt?: number;
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
  private toolProgress: ToolProgressState | null = null;
  private rateLimit: RateLimitState | null = null;
  private authenticating = false;

  /** The ordered render items (host-assigned `seq` order, R3.4). */
  get items(): readonly RenderItem[] {
    return this.entries.map((entry) => entry.item);
  }

  /**
   * The lowest-`seq` permission request still awaiting a decision, or `null`.
   *
   * `entries` is already sorted by `seq`, so the first match is the oldest
   * outstanding request.
   */
  get pendingPermission(): PermissionRequestConversationItem | null {
    for (const entry of this.entries) {
      const item = entry.item;
      if (item.kind === "permission_request" && item.resolution === undefined) {
        return item;
      }
    }
    return null;
  }

  /** A snapshot of the full render state. */
  get state(): PanelRenderState {
    return {
      items: this.items,
      generating: this.generating,
      toolProgress: this.toolProgress,
      rateLimit: this.rateLimit,
      authenticating: this.authenticating,
      model: this.model,
      permissionMode: this.permissionMode,
      models: this.models,
      mcpServers: this.mcpServers,
      usage: this.usage,
      pendingInput: this.pendingInput,
      pendingPermission: this.pendingPermission,
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
        // A finished turn cannot still have a tool in flight, so drop the
        // indicator rather than leaving a stale elapsed time on screen.
        if (!message.generating) {
          this.toolProgress = null;
        }
        this.generating = message.generating;
        return;
      case "showPermissionRequest":
        this.upsertItem(message.item);
        return;
      case "showToolAction":
        this.upsertItem(message.item);
        return;
      case "updateToolStatus":
        // Clear the live indicator once THIS tool reaches a terminal status.
        //
        // The two ids are different spaces: a tool item's `id` is `tool-<seq>`
        // (allocated by the coordinator), while progress frames carry the
        // engine's `tool_use_id`. So the item is looked up by `itemId` and its
        // `toolUseId` FIELD is compared — matching them directly would silently
        // never fire.
        if (
          this.toolProgress !== null &&
          message.status !== "running" &&
          message.status !== "pending"
        ) {
          const progress = this.toolProgress;
          const matches = this.items.some(
            (item) =>
              item.id === message.itemId &&
              item.kind === "tool_action" &&
              item.toolUseId === progress.toolUseId,
          );
          if (matches) {
            this.toolProgress = null;
          }
        }
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
        // Validated, not stored verbatim: `dom.ts` renderModelOptions reads
        // `.length` and iterates during the repaint, and that runs BEFORE the
        // conversation is reconciled — so a non-array here would throw and skip
        // the entire paint, freezing the panel on stale content.
        this.models = Array.isArray(message.models)
          ? message.models.filter(isModelOption)
          : [];
        return;
      case "setMcpStatus":
        this.mcpServers = Array.isArray(message.servers)
          ? message.servers.filter(isMcpServer)
          : [];
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
      case "toolProgress":
        // Transient, NOT a conversation item: progress is replaced in place so
        // a 60-second tool does not produce 60 transcript entries.
        this.toolProgress = {
          toolUseId: message.toolUseId,
          toolName: message.toolName,
          elapsedSeconds: message.elapsedSeconds,
        };
        return;
      case "rateLimit": {
        // Only surface a warning or rejection. A steady stream of "allowed"
        // events carries no information the user can act on.
        if (message.status === "allowed") {
          this.rateLimit = null;
          return;
        }
        this.rateLimit = {
          status: message.status,
          ...(message.rateLimitType !== undefined
            ? { rateLimitType: message.rateLimitType }
            : {}),
          ...(message.utilization !== undefined
            ? { utilization: message.utilization }
            : {}),
          ...(message.resetsAt !== undefined ? { resetsAt: message.resetsAt } : {}),
        };
        if (message.status === "rejected") {
          this.appendNotice(
            "warn",
            "The model provider rejected this request: rate limit reached." +
              (message.resetsAt !== undefined
                ? ` Resets at ${new Date(message.resetsAt * 1000).toLocaleTimeString()}.`
                : ""),
          );
        }
        return;
      }
      case "authStatus":
        this.authenticating = message.authenticating;
        if (message.error !== undefined && message.error.length > 0) {
          this.appendNotice("warn", `Authentication: ${message.error}`);
        }
        return;
      case "compactBoundary":
        this.appendNotice(
          "info",
          `Context compacted (${message.trigger}) — earlier turns are now summarised` +
            (Number.isFinite(message.preTokens)
              ? ` (was ${message.preTokens.toLocaleString()} tokens).`
              : "."),
        );
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

  /**
   * Replace the entire flow from a restored, host-ordered history (R12.2).
   *
   * `items` is validated rather than trusted. A throw here would abort the
   * webview's `message` handler BEFORE the repaint, freezing the panel on stale
   * content with no error shown — so a wrong-shaped payload must degrade to
   * "nothing restored" instead.
   */
  private restore(items: readonly ConversationItem[]): void {
    this.entries = [];
    this.arrivalCounter = 0;
    this.maxSeq = 0;
    if (!Array.isArray(items)) {
      return;
    }
    for (const item of items) {
      this.upsertItem(item);
    }
  }

  /**
   * Insert a fresh item or update an existing one in place (matched by `id`).
   * A new item is placed to keep the flow sorted by (`seq`, arrival), which is
   * the host's receive order (R3.4).
   *
   * A payload that is not a usable item is DROPPED rather than dereferenced, for
   * the same reason as {@link restore}: one bad message must not brick the panel.
   */
  private upsertItem(item: ConversationItem): void {
    if (!isRenderableItem(item)) {
      return;
    }
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
    // `dom.ts` renderUsage reads `usage.input_tokens` and calls
    // `totalCostUsd.toFixed(4)`, so a missing object or a non-numeric cost would
    // throw during the repaint. Coerce to a renderable shape instead.
    const safeUsage: Usage =
      typeof usage === "object" && usage !== null
        ? usage
        : ({ input_tokens: 0, output_tokens: 0 } as Usage);
    const safeCost = typeof totalCostUsd === "number" && Number.isFinite(totalCostUsd)
      ? totalCostUsd
      : 0;
    const safeModelUsage =
      typeof modelUsage === "object" && modelUsage !== null ? modelUsage : {};

    this.usage = {
      usage: safeUsage,
      totalCostUsd: safeCost,
      modelUsage: safeModelUsage,
    };
    const arrival = this.arrivalCounter++;
    this.insert({
      order: this.maxSeq,
      arrival,
      item: {
        kind: "usage",
        id: `usage-${arrival}`,
        seq: this.maxSeq,
        usage: safeUsage,
        totalCostUsd: safeCost,
        modelUsage: safeModelUsage,
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
    // Tolerate a wrong-shaped payload: a throw here would abort the repaint and
    // freeze the panel (see `restore`). An unknown path list still produces a
    // usable notice, which matters because this notice carries the ONLY control
    // for confirming a conflicting edit (R6.3).
    const list = Array.isArray(paths) ? paths.join(", ") : "unknown files";
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

/**
 * Whether `value` has the two fields `dom.ts` renderModelOptions dereferences.
 * A malformed entry is filtered out rather than reaching the repaint.
 */
function isModelOption(
  value: unknown,
): value is { value: string; displayName: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { value?: unknown; displayName?: unknown };
  return (
    typeof candidate.value === "string" &&
    typeof candidate.displayName === "string"
  );
}

/** Whether `value` has the two fields `dom.ts` renderMcp dereferences. */
function isMcpServer(value: unknown): value is { name: string; status: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { name?: unknown; status?: unknown };
  return typeof candidate.name === "string" && typeof candidate.status === "string";
}

/**
 * Whether `value` carries the minimum shape the flow needs: a string `id` (used
 * as the reconciliation key) and a numeric `seq` (used for ordering).
 *
 * Deliberately structural rather than exhaustive. The renderer already handles an
 * unknown `kind` via its own `never` default, so the only fields that MUST be
 * present are the two this model dereferences. Validating exactly those keeps a
 * malformed message from throwing without rejecting items whose payload the host
 * legitimately extends.
 */
function isRenderableItem(value: unknown): value is ConversationItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { id?: unknown; seq?: unknown };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.seq === "number" &&
    Number.isFinite(candidate.seq)
  );
}
