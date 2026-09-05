// SessionManager — the single per-session composition the Editor_Host drives
// (R2, R3, R4, R5, R6, R7, R8.3, R9, R11, R12, R13, R15).
//
// This is the Core_Integration's one entry point (design "Process model"): it
// composes the editor-agnostic building blocks into a live session and exposes
// the operations the Editor_Host calls — open a session, submit a prompt,
// interrupt, select a model, approve/deny a permission, approve an edit /
// confirm a conflict, start a new session, and close a session.
//
// Composition (one Session ⇒ one of each):
//   - {@link AgentProcess}          — spawns/​supervises the `rayu` child (R2).
//   - {@link ControlProtocolClient} — typed inbound dispatch + outbound control
//                                     request/response correlation (R3, R7, R15.2).
//   - {@link PermissionCoordinator} — tool-permission decisions + default-deny
//                                     on close (R5).
//   - {@link EditProposalModel}     — Write/Edit tool actions → FileEditPlan (R6).
//   - {@link Redactor}              — credential redaction in front of the panel
//                                     and log sinks (R8.4, R15.5).
//   - {@link SessionStore}          — retained, ordered conversation history (R12).
//
// EVERY editor operation is routed through the injected {@link EditorAdapter}
// (the ONLY editor dependency); there is no `vscode` import here, so the module
// builds with no editor package present (R13.1, R13.4, R13.5). The CLI locator,
// the agent-process factory, and the unresponsiveness timers are all injectable,
// so the whole unit is unit-testable against a fake adapter with NO real
// subprocess (task 10.4).
//
// Data flow once started:
//   child stdout → AgentProcess (NDJSON decode) → handleStdout
//        → SessionStore.accept (reduce/assemble, R3.3/R4.1/R4.2/R12)
//        → ControlProtocolClient.handleMessage (typed events)
//             → systemInit/stream/assistant/result  → push to panel + usage
//             → permissionRequest                   → PermissionCoordinator
//             → controlError                        → panel + log (R15.2)
//   panel/host intents → ControlProtocolClient / PermissionCoordinator
//        → session.send → AgentProcess.writeLine → child stdin
//
// All text routed to the panel and to the log channel passes through the
// {@link Redactor} first (R15.5).

import { AgentProcess } from "../cli/agentProcess.js";
import type { AgentExitInfo } from "../cli/agentProcess.js";
import {
  EngineResolver,
  defaultEngineDistDir,
  ensureFirstRunMarkerSuppressed,
} from "../cli/engineResolver.js";
import type { EngineResolution } from "../cli/engineResolver.js";
import { EditProposalModel, isEditToolName } from "../edit/proposalModel.js";
import type {
  AgentPanelHandle,
  ApplyResult,
  Disposable,
  EditorAdapter,
  FileEditPlan,
} from "../editor/adapter.js";
import { PermissionCoordinator } from "../permission/coordinator.js";
import { ControlProtocolClient } from "../protocol/controlClient.js";
import type {
  ApiRetryMessage,
  RateLimitEvent,
} from "../protocol/wire.js";
import type {
  ControlErrorEvent,
  PermissionRequestEvent,
} from "../protocol/controlClient.js";
import type { CanUseToolRequest } from "../protocol/wire.js";
import { isPermissionMode } from "../protocol/wire.js";
import type { DecodeFailure } from "../protocol/ndjson.js";
import { isResultError } from "../protocol/guards.js";
import {
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../protocol/wire.js";
import type {
  AssistantMessage,
  ResultMessage,
  StdinMessage,
  StdinUserMessage,
  StdoutMessage,
  StreamEvent,
  SystemInit,
} from "../protocol/wire.js";
import type { PermissionMode } from "../protocol/wire.js";
import type {
  ModelInfo,
  ModelUsage,
} from "../protocol/wire.js";
import type {
  RawMessageStreamEvent,
  ToolUseBlock,
  Usage,
} from "../protocol/contentBlocks.js";
import { Redactor } from "../redaction/redactor.js";
import { SessionStore } from "./sessionStore.js";
import type { SessionStoreEntry } from "./sessionStore.js";
import type { ConversationItem } from "./state.js";

// ----------------------------------------------------------------------------
// Settings keys / defaults
// ----------------------------------------------------------------------------

/** Setting: include the active file path in the prompt context (R9.3). */
export const SETTING_INCLUDE_ACTIVE_FILE = "rayucode.includeActiveFile";
/** Setting: include the active selection in the prompt context (R9.4). */
export const SETTING_INCLUDE_SELECTION = "rayucode.includeSelection";
/** Setting: ms of no protocol activity before the unresponsive notice (R15.4). */
export const SETTING_UNRESPONSIVE_TIMEOUT_MS = "rayucode.unresponsiveTimeoutMs";
/** Setting: initial permission mode for a session (R5.4). */
export const SETTING_PERMISSION_MODE = "rayucode.permissionMode";

/** Default unresponsiveness timeout when the setting is absent (R15.4). */
export const DEFAULT_UNRESPONSIVE_TIMEOUT_MS = 60_000;

// ----------------------------------------------------------------------------
// Injectable collaborators (for unit-testing with no real subprocess)
// ----------------------------------------------------------------------------

/** The minimal agent-process surface the SessionManager drives (R2). */
export interface AgentProcessLike {
  readonly pid: number | undefined;
  start(): Promise<void>;
  writeLine(message: StdinMessage): void;
  onStdoutMessage(cb: (message: StdoutMessage) => void): void;
  onExit(cb: (info: AgentExitInfo) => void): void;
  /**
   * Register a listener for a session-fatal protocol decode failure.
   *
   * Optional so existing test doubles remain valid. The real
   * {@link AgentProcess} always provides it.
   */
  onProtocolFailure?(cb: (failure: DecodeFailure) => void): void;
  terminate(): Promise<void>;
}

/** Options the SessionManager passes to the {@link AgentProcessFactory}. */
export interface AgentProcessFactoryOptions {
  /** Verified path to the engine bundled inside the extension. */
  enginePath: string;
  /** Session workspace root, or `undefined` to inherit (R2.3). */
  cwd: string | undefined;
  /** Diagnostic sink for the spawned process (R2.6). */
  adapter: Pick<EditorAdapter, "log">;
}

/** Creates an {@link AgentProcessLike}; defaults to a real {@link AgentProcess}. */
export type AgentProcessFactory = (
  options: AgentProcessFactoryOptions,
) => AgentProcessLike;

/**
 * Resolves and verifies the bundled engine; the SessionManager only needs
 * `resolve`. Synchronous because the digest is computed once and cached.
 */
export interface EngineResolverLike {
  resolve(): EngineResolution;
}

/**
 * Injectable timer surface for the unresponsiveness timeout (R15.4). The
 * default uses the global timers (unref'd so a pending notice never keeps the
 * host process alive); tests pass a controllable fake.
 */
export interface TimerProvider {
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: TimerProvider = {
  set: (handler, ms) => {
    const handle = setTimeout(handler, ms);
    // Don't let a pending unresponsive-notice timer keep the process alive.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Construction options for a {@link SessionManager}. */
export interface SessionManagerOptions {
  /** The ONLY editor dependency (R13.1, R13.4). */
  adapter: EditorAdapter;
  /** Retained conversation-history store (R12). Defaults to a fresh one. */
  sessionStore?: SessionStore;
  /**
   * Redaction filter placed in front of the panel and log sinks (R15.5).
   * Defaults to an empty redactor (pass-through); the host injects one seeded
   * with the configured credential set.
   */
  redactor?: Redactor;
  /** Engine resolver. Defaults to an {@link EngineResolver} over {@link engineDistDir}. */
  engineResolver?: EngineResolverLike;
  /**
   * Directory holding the bundled engine and `build-info.json`. Defaults to the
   * directory containing the running extension bundle.
   */
  engineDistDir?: string;
  /** Agent-process factory (R2). Defaults to constructing an {@link AgentProcess}. */
  agentProcessFactory?: AgentProcessFactory;
  /** Edit proposal model (R6). Defaults to a fresh {@link EditProposalModel}. */
  editProposalModel?: EditProposalModel;
  /** Unresponsiveness timers (R15.4). Defaults to the global timers. */
  timers?: TimerProvider;
  /** Outbound control-request id factory; forwarded to each session's client. */
  generateRequestId?: () => string;
  /**
   * Observer for every host → panel message, called with the same value the panel
   * receives — that is, AFTER redaction (R15.5).
   *
   * Exists so a second surface can mirror the panel without the SessionManager
   * knowing what that surface is. The Web Bridge is the first such consumer: it
   * relays these to the rayu-web studio so a session can be watched and driven from
   * a browser. Placed at the single `postToPanel` choke point rather than at each
   * call site, because a mirror that misses one message type shows a conversation
   * with a hole in it, and there are eighteen of them.
   *
   * Redaction order is the security-relevant part and it is not incidental: a
   * browser is a strictly less trusted surface than a local webview, so it must
   * never see a credential the panel would have had masked.
   *
   * Must not throw and must not block — it is invoked synchronously on the session's
   * hot path. The SessionManager isolates a throw, but a slow observer is a slow UI.
   */
  onPanelMessage?: (sessionKey: string, message: PanelOutboundMessage) => void;
}

// ----------------------------------------------------------------------------
// Host → webview message contract (the panel is a thin view; R3.1)
// ----------------------------------------------------------------------------

/**
 * A message pushed from the host to the Agent_Panel webview. The webview holds
 * no protocol logic — it renders these in receive order (R3.4). Every string
 * field has already passed through the {@link Redactor} (R15.5).
 */
export type PanelOutboundMessage =
  | { type: "restoreHistory"; items: ConversationItem[] }
  | { type: "addMessage"; item: ConversationItem }
  | { type: "appendPartial"; itemId: string; delta: string }
  | { type: "completeMessage"; itemId: string }
  | { type: "setGenerating"; generating: boolean }
  | { type: "showPermissionRequest"; item: ConversationItem }
  | { type: "showToolAction"; item: ConversationItem }
  | { type: "updateToolStatus"; itemId: string; status: string; output?: string }
  | {
      type: "showUsage";
      usage: Usage;
      totalCostUsd: number;
      modelUsage: Record<string, ModelUsage>;
    }
  | { type: "setModelInfo"; model: string | null; permissionMode: PermissionMode }
  | { type: "setModelList"; models: ModelInfo[] }
  | { type: "setMcpStatus"; servers: { name: string; status: string }[] }
  | { type: "showError"; message: string }
  | { type: "editApplied"; path: string }
  | { type: "editConflict"; paths: string[]; requestId: string }
  // R9.5: stage a reference (e.g. a fenced block citing a file path + selected
  // text) into the prompt input. The webview appends it to the textarea WITHOUT
  // submitting; it is not a conversation item.
  | { type: "insertPrompt"; text: string }
  // Live progress for an in-flight tool call. Before this existed a slow tool
  // was indistinguishable from a hung one (rayucode/TRIAGE.md D8).
  | {
      type: "toolProgress";
      toolUseId: string;
      toolName: string;
      elapsedSeconds: number;
    }
  // Provider quota status. `resetsAt` is a Unix timestamp in seconds when present.
  | {
      type: "rateLimit";
      status: "allowed" | "allowed_warning" | "rejected";
      rateLimitType?: string;
      utilization?: number;
      resetsAt?: number;
    }
  // Authentication progress. Surfacing this is what turns a silent stall during
  // sign-in into visible feedback.
  | { type: "authStatus"; authenticating: boolean; error?: string }
  // The engine compacted the conversation context, so earlier turns are summarised.
  | {
      type: "compactBoundary";
      trigger: "manual" | "auto";
      preTokens: number;
    };

// ----------------------------------------------------------------------------
// Internal per-session runtime
// ----------------------------------------------------------------------------

/** A monotonic receive-sequence allocator shared by a session's components. */
class SeqCounter {
  private value = 0;
  next(): number {
    return this.value++;
  }
  /** Advance to at least `n` so coordinator items stay after processed messages. */
  syncAtLeast(n: number): void {
    if (n > this.value) {
      this.value = n;
    }
  }
}

/** All live runtime for one session. */
interface ManagedSession {
  readonly key: string;
  panel: AgentPanelHandle | null;
  process: AgentProcessLike | null;
  client: ControlProtocolClient | null;
  coordinator: PermissionCoordinator;
  /** Stable outbound sink: writes one StdinMessage to the current child stdin. */
  send: (message: StdinMessage) => void;
  /** Retained history entry (reducer-backed) for this session (R12). */
  entry: SessionStoreEntry;
  /** Shared seq allocator (reducer messages + coordinator items, R3.4). */
  seq: SeqCounter;
  model: string | null;
  permissionMode: PermissionMode;
  /** A submitted prompt is awaiting protocol activity (drives R15.4). */
  promptPending: boolean;
  /** True while an intentional close/new-session teardown is in progress (R2.5 guard). */
  closing: boolean;
  /** Pending unresponsiveness timer handle, or `null`. */
  unresponsiveTimer: unknown | null;
  /** Id of the assistant item currently being rendered to the panel. */
  renderedAssistantId: string | null;
  /** Edit tool requests captured for later apply (keyed by request id, R6). */
  pendingEdits: Map<string, CanUseToolRequest>;
  /** Conflicted plans awaiting explicit confirmation (R6.3). */
  conflictPlans: Map<string, FileEditPlan>;
  /** Last pushed signature per coordinator item id (diffing for live push). */
  coordSignatures: Map<string, string>;
  /** Panel subscriptions to dispose when the panel/session goes away. */
  disposables: Disposable[];
  /**
   * Machine-readable reason this session was abandoned for a protocol fault, or
   * `null` while healthy. Latched so the fail-safe sequence runs exactly once.
   *
   * `protocol_decode_error`  — a stdout line was not valid JSON
   * `protocol_schema_error`  — a frame did not match the wire schema
   * `protocol_version_mismatch` — engine and extension disagree on the version
   */
  protocolFailureReason:
    | "protocol_decode_error"
    | "protocol_schema_error"
    | "protocol_version_mismatch"
    | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a human-readable reason for a failed turn.
 *
 * The engine's `result` message is a DISCRIMINATED UNION, and the two variants
 * carry their failure information in different places:
 *
 *   success ⇒ `result: string` (required); no `errors` field
 *   error   ⇒ NO `result` field at all; `errors: string[]` (required)
 *
 * The pre-refactor code read `message.result ?? \`Turn ended with: ${subtype}\``
 * against a hand-written single-interface model that declared `result?: string`
 * and had no `errors` field whatsoever. On a real failure `result` is absent, so
 * the reason ALWAYS fell through to the bare subtype and the actual explanation
 * — sitting right there in `errors` — was unreachable (TRIAGE.md D3).
 *
 * Now that the union is modelled correctly, read whichever field the variant
 * actually has.
 */
function describeResultFailure(message: ResultMessage): string {
  if (isResultError(message)) {
    const detail = message.errors.filter((e) => e.trim().length > 0).join("; ");
    if (detail.length > 0) {
      return detail;
    }
  } else if (typeof message.result === "string" && message.result.length > 0) {
    // `is_error` can be true on a success-subtype result; prefer its text.
    return message.result;
  }
  return `Turn ended with: ${message.subtype}`;
}

/**
 * Narrow an untrusted value to a plain object, or `undefined`.
 *
 * Arrays, `null`, and primitives are rejected. Used at the webview → host trust
 * boundary for values the host forwards to the CLI as structured payloads, where
 * a wrong shape would be passed through rather than caught.
 */
function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** The incremental text of a streaming event, or `null` when it carries none. */
function streamTextDelta(event: RawMessageStreamEvent): string | null {
  if (
    event.type === "content_block_delta" &&
    event.delta.type === "text_delta"
  ) {
    return event.delta.text;
  }
  return null;
}

/** Build the workspace-context preamble prepended to a prompt (R9.1, R9.3, R9.4). */
export function buildContextPreamble(context: {
  workspaceRoot: string | null;
  activeFilePath?: string | undefined;
  selection?:
    | { path: string; text: string; startLine?: number; endLine?: number }
    | undefined;
}): string {
  const lines: string[] = [];
  // R9.1: include the workspace root when known. R9.2: when it cannot be
  // determined, simply omit it — the prompt is still sent, without a root.
  if (context.workspaceRoot) {
    lines.push(`Workspace root: ${context.workspaceRoot}`);
  }
  if (context.activeFilePath) {
    lines.push(`Active file: ${context.activeFilePath}`);
  }
  if (context.selection) {
    const { path, text, startLine, endLine } = context.selection;
    const range =
      startLine !== undefined && endLine !== undefined
        ? `:${startLine}-${endLine}`
        : "";
    lines.push(`Selection (${path}${range}):`);
    lines.push("```");
    lines.push(text);
    lines.push("```");
  }
  if (lines.length === 0) {
    return "";
  }
  return `<workspace-context>\n${lines.join("\n")}\n</workspace-context>\n\n`;
}

// ----------------------------------------------------------------------------
// SessionManager
// ----------------------------------------------------------------------------

/**
 * Owns the set of live sessions and is the single entry point the Editor_Host
 * calls. Construct once per extension activation with a concrete
 * {@link EditorAdapter}; drive sessions through the public methods below.
 */
export class SessionManager {
  private readonly adapter: EditorAdapter;
  private readonly sessionStore: SessionStore;
  private readonly redactor: Redactor;
  private readonly engineResolver: EngineResolverLike;
  private readonly agentProcessFactory: AgentProcessFactory;
  private readonly editModel: EditProposalModel;
  private readonly timers: TimerProvider;
  private readonly generateRequestId: (() => string) | undefined;
  private readonly onPanelMessage:
    | ((sessionKey: string, message: PanelOutboundMessage) => void)
    | undefined;

  private readonly sessions = new Map<string, ManagedSession>();

  constructor(options: SessionManagerOptions) {
    this.adapter = options.adapter;
    this.sessionStore = options.sessionStore ?? new SessionStore();
    this.redactor = options.redactor ?? new Redactor([]);
    this.engineResolver =
      options.engineResolver ??
      new EngineResolver({
        distDir: options.engineDistDir ?? defaultEngineDistDir(),
        adapter: options.adapter,
      });
    this.agentProcessFactory =
      options.agentProcessFactory ??
      ((o) =>
        new AgentProcess({
          enginePath: o.enginePath,
          cwd: o.cwd,
          adapter: o.adapter,
        }));
    this.editModel = options.editProposalModel ?? new EditProposalModel();
    this.timers = options.timers ?? defaultTimers;
    this.generateRequestId = options.generateRequestId;
    this.onPanelMessage = options.onPanelMessage;
  }

  // --------------------------------------------------------------------------
  // Public entry points (the Editor_Host surface)
  // --------------------------------------------------------------------------

  /**
   * Open (and, if needed, start) a session: show the Agent_Panel, restore the
   * retained history into it (R12.2), and start the agent process if one is not
   * already running for the session (R2.1). Reopening an existing session
   * reveals its panel and re-renders the retained history.
   */
  async openSession(sessionKey: string): Promise<void> {
    const session = this.ensureSession(sessionKey);

    if (session.panel === null) {
      const panel = await this.adapter.showAgentPanel(sessionKey);
      session.panel = panel;
      session.disposables.push(
        panel.onDidReceiveMessage((message) =>
          this.handlePanelMessage(session, message),
        ),
        panel.onDidDispose(() => this.handlePanelDisposed(session)),
      );
    } else {
      session.panel.reveal();
    }

    // Re-render the retained history (R12.1, R12.2); empty on failure (R12.3).
    this.postToPanel(session, {
      type: "restoreHistory",
      items: this.mergedHistory(session),
    });

    if (session.process === null) {
      await this.startAgent(session);
    }
  }

  /**
   * Submit a user prompt (R3.2). Assembles the Workspace_Context preamble
   * (R9.1–R9.4, R9.6), records the prompt in the retained history, writes it to
   * the agent, and arms the unresponsiveness timer (R15.4).
   */
  async submitPrompt(sessionKey: string, text: string): Promise<void> {
    const session = this.requireSession(sessionKey);

    if (session.process === null) {
      await this.startAgent(session);
      if (session.process === null) {
        // Start failed and was surfaced with a retry (R15.1); nothing to send.
        return;
      }
    }

    const message = await this.assemblePrompt(session, text);

    // Record the user's prompt in the retained, ordered history (R12.1).
    session.entry.submitUserPrompt(text);
    session.seq.syncAtLeast(session.entry.state.nextSeq);
    const history = session.entry.history;
    const userItem = history[history.length - 1];
    if (userItem) {
      this.postToPanel(session, { type: "addMessage", item: userItem });
    }

    session.send(message);

    session.promptPending = true;
    this.postToPanel(session, { type: "setGenerating", generating: true });
    this.armUnresponsiveTimer(session);
  }

  /**
   * Insert a reference into the Agent_Panel's prompt input (R9.5). The host side
   * of the add-selection-to-prompt command: the Editor_Host builds the reference
   * (e.g. a fenced block citing a file path + the selected text) and calls this;
   * the panel is opened first if needed, then the reference is posted as an
   * `insertPrompt` message which the webview appends to the prompt textarea
   * WITHOUT submitting. The text is redacted on its way to the panel (R15.5).
   */
  async addSelectionToPrompt(
    sessionKey: string,
    reference: string,
  ): Promise<void> {
    // "Open the panel first if needed": ensure the session + panel exist so
    // there is an input to insert into. Reusing an open panel is idempotent.
    await this.openSession(sessionKey);
    const session = this.requireSession(sessionKey);
    this.postToPanel(session, { type: "insertPrompt", text: reference });
  }

  /** Interrupt the in-progress turn (R3.6). */
  async interrupt(sessionKey: string): Promise<void> {
    const session = this.requireSession(sessionKey);
    try {
      await session.client?.interrupt();
    } catch (error) {
      this.log("protocol", `Interrupt request failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Select a model for subsequent turns (R7.3). On failure the reported reason
   * is surfaced (via the control-error event) and the previously effective
   * model is retained (R7.4).
   */
  /**
   * Change the permission mode for subsequent tool use (the runtime equivalent of
   * the CLI's `/permission-mode`).
   *
   * `mode` arrives from the webview as `unknown` and is validated here rather
   * than at the call site, so there is exactly one place where an unrecognised
   * mode can be rejected.
   *
   * Order matters. The CLI is told FIRST and the local state is updated only if
   * that succeeds: the engine is what actually decides whether it asks before
   * running a tool, so a local mode that ran ahead of a failed request would show
   * "Bypass all prompts" while the engine still prompted — or, in the dangerous
   * direction, show a restrictive mode while the engine auto-approved.
   */
  async selectPermissionMode(sessionKey: string, mode: unknown): Promise<void> {
    const session = this.requireSession(sessionKey);
    if (!isPermissionMode(mode)) {
      this.log(
        "protocol",
        `Ignoring unrecognised permission mode from the panel: ${String(mode)}`,
      );
      return;
    }
    if (mode === session.permissionMode) {
      return;
    }

    try {
      await session.client?.setPermissionMode(mode);
      session.permissionMode = mode;
      session.coordinator.setMode(mode);
      this.postToPanel(session, {
        type: "setModelInfo",
        model: session.model,
        permissionMode: mode,
      });
      this.log("lifecycle", `Permission mode set to ${mode}`);
    } catch (error) {
      // Keep the prior mode and tell the panel so its picker snaps back, rather
      // than leaving it showing a mode that was never applied.
      this.log(
        "protocol",
        `Permission mode change to ${mode} failed; keeping ${session.permissionMode}: ${errorMessage(error)}`,
      );
      this.postToPanel(session, {
        type: "setModelInfo",
        model: session.model,
        permissionMode: session.permissionMode,
      });
    }
  }

  async selectModel(sessionKey: string, model: string): Promise<void> {
    const session = this.requireSession(sessionKey);
    try {
      await session.client?.setModel(model);
      session.model = model;
      this.postToPanel(session, {
        type: "setModelInfo",
        model,
        permissionMode: session.permissionMode,
      });
    } catch (error) {
      // R7.4: keep the prior model; the error text was already surfaced.
      this.log(
        "protocol",
        `Model selection failed; keeping ${session.model ?? "current model"}: ${errorMessage(error)}`,
      );
    }
  }

  /** Fetch the list of available models for the model picker (R7.2). */
  async requestModels(sessionKey: string): Promise<ModelInfo[]> {
    const session = this.requireSession(sessionKey);
    try {
      const init = await session.client?.initialize();
      const models = init?.models ?? [];
      this.postToPanel(session, { type: "setModelList", models });
      return models;
    } catch (error) {
      this.log("protocol", `Model list request failed: ${errorMessage(error)}`);
      return [];
    }
  }

  /** Approve a surfaced permission request with the approved input (R5.2). */
  approvePermission(
    sessionKey: string,
    requestId: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    this.requireSession(sessionKey).coordinator.approve(requestId, updatedInput);
  }

  /** Deny a surfaced permission request (R5.3). */
  denyPermission(
    sessionKey: string,
    requestId: string,
    message?: string,
  ): void {
    this.requireSession(sessionKey).coordinator.deny(requestId, message);
  }

  /**
   * Approve a File_Edit_Proposal: answer the permission and apply the proposed
   * change into the workspace through the adapter (R6.2). A stale base is
   * reported as a conflict requiring confirmation (R6.3); a per-file failure is
   * isolated and reported (R6.6).
   */
  async approveEdit(sessionKey: string, requestId: string): Promise<void> {
    const session = this.requireSession(sessionKey);
    const request = session.pendingEdits.get(requestId);
    // Let the agent proceed with the (possibly user-edited) input.
    session.coordinator.approve(requestId, request?.input);
    if (!request) {
      return;
    }
    session.pendingEdits.delete(requestId);
    const plan = await this.buildEditPlan(session, request);
    if (plan) {
      await this.applyPlan(session, requestId, plan, false);
    }
  }

  /**
   * Confirm applying an edit that previously conflicted with on-disk content,
   * overriding the stale-base check (R6.3). No-op if nothing is awaiting
   * confirmation for the request.
   */
  async confirmConflict(sessionKey: string, requestId: string): Promise<void> {
    const session = this.requireSession(sessionKey);
    const plan = session.conflictPlans.get(requestId);
    if (!plan) {
      return;
    }
    session.conflictPlans.delete(requestId);
    await this.applyPlan(session, requestId, plan, true);
  }

  /**
   * Start a NEW session: tear down the current agent (default-deny pending
   * permissions before terminating, R5.5), allocate a fresh independent history
   * (R12.4), and start a new agent.
   */
  async newSession(sessionKey: string): Promise<void> {
    const existing = this.sessions.get(sessionKey);
    if (!existing) {
      await this.openSession(sessionKey);
      return;
    }

    await this.teardownAgent(existing);

    // Fresh, independent history + reset per-session runtime (R12.4).
    existing.entry = this.sessionStore.startNewSession(sessionKey);
    existing.seq = new SeqCounter();
    existing.model = null;
    existing.permissionMode = "default";
    existing.promptPending = false;
    existing.renderedAssistantId = null;
    existing.pendingEdits.clear();
    existing.conflictPlans.clear();
    existing.coordSignatures.clear();
    existing.coordinator = this.makeCoordinator(existing);

    this.postToPanel(existing, { type: "restoreHistory", items: [] });
    await this.startAgent(existing);
  }

  /**
   * Close a session (R2.4): default-deny every still-pending permission request
   * BEFORE terminating the agent process (R5.5), then release resources. The
   * `coordinator.close(terminate)` call denies synchronously and only then
   * awaits the process termination, guaranteeing the ordering (Property 6).
   */
  async closeSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }
    await this.teardownAgent(session);

    for (const disposable of session.disposables) {
      disposable.dispose();
    }
    session.disposables = [];
    session.panel?.dispose();
    session.panel = null;

    this.sessions.delete(sessionKey);
  }

  /** Close every live session (e.g. on host shutdown, R2.7). */
  async disposeAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    for (const key of keys) {
      await this.closeSession(key);
    }
  }

  // --------------------------------------------------------------------------
  // Session lifecycle internals
  // --------------------------------------------------------------------------

  private ensureSession(sessionKey: string): ManagedSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }
    const session = this.createSession(sessionKey);
    this.sessions.set(sessionKey, session);
    return session;
  }

  private requireSession(sessionKey: string): ManagedSession {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      throw new Error(`SessionManager: no session for key "${sessionKey}"`);
    }
    return session;
  }

  private createSession(sessionKey: string): ManagedSession {
    const entry = this.sessionStore.getOrCreate(sessionKey);
    const seq = new SeqCounter();
    seq.syncAtLeast(entry.state.nextSeq);

    const session: ManagedSession = {
      key: sessionKey,
      panel: null,
      process: null,
      client: null,
      // Assigned immediately below; the placeholder keeps the type total.
      coordinator: undefined as unknown as PermissionCoordinator,
      send: () => {},
      entry,
      seq,
      model: entry.model,
      permissionMode: entry.permissionMode,
      promptPending: false,
      closing: false,
      unresponsiveTimer: null,
      renderedAssistantId: null,
      pendingEdits: new Map(),
      conflictPlans: new Map(),
      coordSignatures: new Map(),
      disposables: [],
      protocolFailureReason: null,
    };
    // The outbound sink reads the CURRENT child at call time, so it keeps
    // working across an agent restart that swaps `session.process`.
    session.send = (message) => {
      session.process?.writeLine(message);
    };
    session.coordinator = this.makeCoordinator(session);
    return session;
  }

  private makeCoordinator(session: ManagedSession): PermissionCoordinator {
    return new PermissionCoordinator({
      send: session.send,
      initialMode: this.adapter.getSetting<PermissionMode>(
        SETTING_PERMISSION_MODE,
        session.permissionMode,
      ),
      allocateSeq: () => session.seq.next(),
      onItemsChanged: (items) => this.onCoordinatorItems(session, items),
    });
  }

  /**
   * Resolve the CLI, construct a fresh protocol client, spawn the agent, and
   * wire stdout → client + store. Surfaces a "not found" / below-minimum / spawn
   * failure with the appropriate actionable control (R1.2, R1.5, R15.1).
   */
  private async startAgent(session: ManagedSession): Promise<void> {
    // Resolve and integrity-check the engine shipped inside this extension.
    // There is nothing to search for and no version negotiation: a mismatch
    // means the VSIX is broken, not that the user has the wrong CLI, so it is a
    // hard error rather than a prompt (PROTOCOL.md §6.1).
    let resolution: EngineResolution;
    try {
      resolution = this.engineResolver.resolve();
    } catch (error) {
      const reason = errorMessage(error);
      this.log("error", `Bundled Rayu engine unavailable: ${reason}`);
      this.postToPanel(session, { type: "showError", message: reason });
      await this.adapter.showActionableMessage("error", reason, ["OK"]);
      return;
    }

    // Keep the engine's first-run welcome banner off the NDJSON stream. See
    // ensureFirstRunMarkerSuppressed for why this is needed and why the
    // workaround lives on the extension side (TRIAGE.md D4).
    ensureFirstRunMarkerSuppressed({ adapter: this.adapter });

    // cwd = the session workspace root (R2.3); inherit when undeterminable.
    const rootContext = await this.adapter.getWorkspaceContext({});
    const cwd = rootContext.workspaceRoot ?? undefined;

    const client = new ControlProtocolClient(
      this.generateRequestId
        ? { send: session.send, generateRequestId: this.generateRequestId }
        : { send: session.send },
    );
    this.wireClient(session, client);
    session.client = client;

    const process = this.agentProcessFactory({
      enginePath: resolution.enginePath,
      cwd,
      adapter: this.adapter,
    });
    process.onStdoutMessage((message) => this.handleStdout(session, message));
    process.onExit((info) => this.handleExit(session, info));
    process.onProtocolFailure?.((failure) =>
      void this.handleProtocolFailure(session, failure),
    );
    session.process = process;

    try {
      await process.start();
    } catch (error) {
      // R15.1: surface the failure reason with a retry control.
      const reason = errorMessage(error);
      this.log("error", `Failed to start the Rayu agent: ${reason}`);
      session.process = null;
      session.client?.dispose();
      session.client = null;
      const choice = await this.adapter.showActionableMessage(
        "error",
        `Could not start the Rayu agent: ${reason}`,
        ["Retry"],
      );
      if (choice === "Retry") {
        await this.startAgent(session);
      }
    }
  }

  /**
   * Complete the fail-safe sequence for a session-fatal protocol decode failure
   * (PROTOCOL.md §7).
   *
   * {@link AgentProcess} has already performed step 1 (log the frame, redacted
   * and truncated, with the schema issue paths) and stopped decoding. This
   * method performs steps 2–5:
   *
   *   2. mark the session failed with a machine-readable reason
   *   3. terminate the child
   *   4. default-deny every pending permission request
   *   5. surface an actionable error in the panel
   *
   * Steps 3 and 4 are delegated to {@link teardownAgent}, which already denies
   * pending permissions BEFORE terminating — the established
   * default-deny-on-close path, not new policy.
   *
   * Crucially the malformed frame is NOT skipped. The control protocol is
   * request/response correlated, so a dropped frame can be the response the UI
   * is awaiting; skipping would leave the panel spinning forever with no error
   * (rayucode/TRIAGE.md D7).
   */
  private async handleProtocolFailure(
    session: ManagedSession,
    failure: DecodeFailure,
  ): Promise<void> {
    if (session.protocolFailureReason !== null) {
      return;
    }

    // Step 2: mark the session failed.
    session.protocolFailureReason =
      failure.kind === "json"
        ? "protocol_decode_error"
        : "protocol_schema_error";

    this.postToPanel(session, { type: "setGenerating", generating: false });

    // Steps 3 + 4: deny pending permissions, then terminate the child.
    await this.teardownAgent(session);

    // Step 5: a terminal, actionable error — not a transient toast the user can
    // miss while the panel merely looks idle.
    const detail =
      failure.kind === "json"
        ? "The agent produced output that is not valid JSON."
        : "The agent produced a message that does not match the expected protocol.";
    this.postToPanel(session, {
      type: "showError",
      message:
        `${detail} The session has been stopped and any pending approvals were denied. ` +
        `See the Rayucode log for details. Start a new session to continue.`,
    });
  }

  /**
   * Default-deny pending permissions (R5.5) and terminate the process, then
   * dispose the client (rejecting any still-pending control requests, R7.4).
   * Sets `closing` so the resulting exit is treated as intentional (not R2.5).
   */
  private async teardownAgent(session: ManagedSession): Promise<void> {
    session.closing = true;
    this.clearUnresponsiveTimer(session);
    session.promptPending = false;

    const process = session.process;
    // R5.5: deny pending BEFORE terminating — coordinator.close denies
    // synchronously, then awaits the terminate callback.
    await session.coordinator.close(() =>
      process ? process.terminate() : Promise.resolve(),
    );

    session.client?.dispose();
    session.client = null;
    session.process = null;
    session.closing = false;
  }

  // --------------------------------------------------------------------------
  // Inbound stdout → store + protocol client
  // --------------------------------------------------------------------------

  private handleStdout(session: ManagedSession, message: StdoutMessage): void {
    // Any inbound protocol activity advances a pending prompt (R15.4).
    if (session.promptPending) {
      this.armUnresponsiveTimer(session);
    }
    // Reduce/assemble into the retained history (R3.3, R4.1, R4.2, R12).
    session.entry.accept(message);
    session.seq.syncAtLeast(session.entry.state.nextSeq);
    // Drive typed events (and host-initiated request correlation).
    session.client?.handleMessage(message);
  }

  private wireClient(
    session: ManagedSession,
    client: ControlProtocolClient,
  ): void {
    client.on("systemInit", (m) => this.onSystemInit(session, m));
    client.on("apiRetry", (m) => this.onApiRetry(session, m));
    // Newly reachable now that the protocol package models them. Each was
    // previously discarded, which is why the panel felt like it was missing
    // information (rayucode/TRIAGE.md D8).
    client.on("toolProgress", (m) =>
      this.postToPanel(session, {
        type: "toolProgress",
        toolUseId: m.tool_use_id,
        toolName: m.tool_name,
        elapsedSeconds: m.elapsed_time_seconds,
      }),
    );
    client.on("rateLimit", (m) => this.onRateLimit(session, m));
    client.on("authStatus", (m) =>
      this.postToPanel(session, {
        type: "authStatus",
        authenticating: m.isAuthenticating,
        ...(m.error !== undefined ? { error: m.error } : {}),
      }),
    );
    client.on("compactBoundary", (m) =>
      this.postToPanel(session, {
        type: "compactBoundary",
        trigger: m.compact_metadata.trigger,
        preTokens: m.compact_metadata.pre_tokens,
      }),
    );
    client.on("streamEvent", (m) => this.onStreamEvent(session, m));
    client.on("assistantMessage", (m) => this.onAssistantMessage(session, m));
    client.on("result", (m) => this.onResult(session, m));
    client.on("permissionRequest", (e) => this.onPermissionRequest(session, e));
    client.on("controlError", (e) => this.onControlError(session, e));
  }

  private onSystemInit(session: ManagedSession, message: SystemInit): void {
    // PROTOCOL.md §6.2 — the second of the two startup checks. The first
    // (engine SHA-256) already ran before the spawn.
    //
    // The engine ships inside the VSIX, so a version mismatch means the
    // packaging step is broken, not that the user has an old CLI. It is
    // therefore a hard failure: continuing would mean interpreting frames whose
    // meaning we do not actually know, which is the exact failure mode this
    // whole refactor exists to eliminate.
    if (!this.checkProtocolVersion(session, message)) {
      return;
    }

    session.model = message.model;
    session.permissionMode = message.permissionMode;
    session.coordinator.setMode(message.permissionMode);
    this.postToPanel(session, {
      type: "setModelInfo",
      model: message.model,
      permissionMode: message.permissionMode,
    });
    // R11.2 / R11.5: surface MCP server status (including failures).
    this.postToPanel(session, {
      type: "setMcpStatus",
      servers: message.mcp_servers,
    });
  }

  /**
   * Compare the engine's advertised `protocolVersion` against the version this
   * extension was built with.
   *
   * An engine that omits the field entirely predates the contract and is treated
   * as {@link LEGACY_PROTOCOL_VERSION} (0) rather than being given the benefit of
   * the doubt — a pre-contract engine is precisely the case where silent drift
   * produced the original bug class.
   *
   * @returns `true` when compatible; `false` after starting the fail-safe.
   */
  private checkProtocolVersion(
    session: ManagedSession,
    message: SystemInit,
  ): boolean {
    const engineVersion = message.protocolVersion ?? LEGACY_PROTOCOL_VERSION;
    if (engineVersion === PROTOCOL_VERSION) {
      return true;
    }

    const described =
      engineVersion === LEGACY_PROTOCOL_VERSION
        ? "did not report a protocol version at all"
        : `reported protocol version ${engineVersion}`;

    this.log(
      "error",
      `Protocol version mismatch: the bundled engine ${described}, but this ` +
        `extension was built for version ${PROTOCOL_VERSION}. Refusing to continue.`,
    );

    session.protocolFailureReason = "protocol_version_mismatch";
    this.postToPanel(session, { type: "setGenerating", generating: false });
    void this.teardownAgent(session).then(() => {
      this.postToPanel(session, {
        type: "showError",
        message:
          `This build of Rayucode is not compatible with its bundled engine ` +
          `(engine ${described}; extension expects ${PROTOCOL_VERSION}). ` +
          `The session has been stopped. Reinstall the extension.`,
      });
    });
    return false;
  }

  private onStreamEvent(session: ManagedSession, message: StreamEvent): void {
    const inProgressId = session.entry.state.inProgressAssistantId;
    if (inProgressId === null) {
      return;
    }
    if (inProgressId !== session.renderedAssistantId) {
      // First delta of a new turn: send the freshly-created item (R4.1).
      session.renderedAssistantId = inProgressId;
      const item = session.entry.history.find((i) => i.id === inProgressId);
      if (item) {
        this.postToPanel(session, { type: "addMessage", item });
      }
      return;
    }
    const delta = streamTextDelta(message.event);
    if (delta) {
      this.postToPanel(session, {
        type: "appendPartial",
        itemId: inProgressId,
        delta,
      });
    }
  }

  private onAssistantMessage(
    session: ManagedSession,
    message: AssistantMessage,
  ): void {
    const inProgressId = session.entry.state.inProgressAssistantId;
    if (inProgressId) {
      session.renderedAssistantId = inProgressId;
      const item = session.entry.history.find((i) => i.id === inProgressId);
      if (item) {
        // Upsert the authoritative complete-block text (R3.3).
        this.postToPanel(session, { type: "addMessage", item });
      }
    }
    // R8.3: auth failure → display it and direct the user to the Rayu CLI.
    if (message.error === "authentication_failed") {
      const text =
        "Authentication failed. Connect your provider using the Rayu CLI (`rayu`), then try again.";
      this.postToPanel(session, { type: "showError", message: text });
      void this.adapter.showActionableMessage("error", text, ["OK"]);
    } else if (message.error) {
      this.postToPanel(session, {
        type: "showError",
        message: `Agent error: ${message.error}`,
      });
    }
  }

  private onResult(session: ManagedSession, message: ResultMessage): void {
    // The terminal result completes the pending prompt (R4.2, R15.4).
    session.promptPending = false;
    this.clearUnresponsiveTimer(session);

    if (session.renderedAssistantId) {
      this.postToPanel(session, {
        type: "completeMessage",
        itemId: session.renderedAssistantId,
      });
      session.renderedAssistantId = null;
    }
    // R4.4: surface token usage / cost for the completed turn.
    this.postToPanel(session, {
      type: "showUsage",
      usage: message.usage,
      totalCostUsd: message.total_cost_usd,
      modelUsage: message.modelUsage,
    });
    this.postToPanel(session, { type: "setGenerating", generating: false });

    if (message.is_error) {
      this.postToPanel(session, {
        type: "showError",
        message: describeResultFailure(message),
      });
    }
  }

  /**
   * Surface a `system/api_retry` frame.
   *
   * The engine emits this each time it retries an upstream API call, carrying
   * the HTTP status and an error classification. An authentication failure is
   * terminal in practice — retrying a 401 with the same credentials cannot
   * succeed — so it is reported immediately instead of leaving the user watching
   * an idle panel.
   *
   * Before the protocol package existed these frames satisfied
   * `isSystemInit()` (which checked only `type === "system"`), so they were
   * dispatched to the init handler: the model and permission mode were
   * overwritten with `undefined` and the status was discarded. A real run
   * against invalid credentials produced one `system/init` followed by NINE
   * `api_retry` frames, so that happened nine times per session and the user saw
   * nothing (rayucode/TRIAGE.md D1, D2).
   */
  private onApiRetry(
    session: ManagedSession,
    message: ApiRetryMessage,
  ): void {
    const status = message.error_status;
    const attempt = `attempt ${message.attempt}/${message.max_retries}`;

    this.log(
      "protocol",
      `Agent API retry (${attempt}): status=${String(status)} error=${String(message.error)}`,
    );

    // A 401/403 will not resolve by retrying, so tell the user now.
    if (
      message.error === "authentication_failed" ||
      status === 401 ||
      status === 403
    ) {
      this.postToPanel(session, {
        type: "showError",
        message:
          "Authentication failed. The agent could not sign in to the model " +
          "provider, so this turn cannot complete. Check your API key or run " +
          "`rayu` in a terminal to sign in, then start a new session.",
      });
      return;
    }

    if (message.error === "rate_limit" || status === 429) {
      this.postToPanel(session, {
        type: "showError",
        message: `Rate limited by the model provider — retrying (${attempt}).`,
      });
      return;
    }

    if (message.error === "billing_error") {
      this.postToPanel(session, {
        type: "showError",
        message:
          "The model provider rejected the request for billing reasons. " +
          "Check your account balance or plan limits.",
      });
    }
  }

  /**
   * Surface a provider rate-limit change.
   *
   * `rejected` is terminal for the current turn, so it is raised as an error
   * rather than a passive notice; a warning is informational.
   */
  private onRateLimit(session: ManagedSession, message: RateLimitEvent): void {
    const info = message.rate_limit_info;
    this.log(
      "protocol",
      `Rate limit ${String(info.status)}` +
        (info.rateLimitType ? ` (${String(info.rateLimitType)})` : "") +
        (typeof info.utilization === "number"
          ? ` at ${Math.round(info.utilization * 100)}% utilisation`
          : ""),
    );
    this.postToPanel(session, {
      type: "rateLimit",
      status: info.status,
      ...(info.rateLimitType !== undefined
        ? { rateLimitType: String(info.rateLimitType) }
        : {}),
      ...(typeof info.utilization === "number"
        ? { utilization: info.utilization }
        : {}),
      ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
    });
  }

  private onPermissionRequest(
    session: ManagedSession,
    event: PermissionRequestEvent,
  ): void {
    // Capture edit-tool requests so an approval can apply them via the adapter.
    if (isEditToolName(event.request.tool_name)) {
      session.pendingEdits.set(event.requestId, event.request);
    }
    session.coordinator.handlePermissionRequest(event);
  }

  private onControlError(
    session: ManagedSession,
    event: ControlErrorEvent,
  ): void {
    // R15.2: render the control-protocol error text in the panel and log it.
    this.postToPanel(session, { type: "showError", message: event.error });
    this.log(
      "protocol",
      `Control protocol error (${event.requestId}): ${event.error}`,
    );
  }

  /** Diff the coordinator's produced items and push granular panel updates. */
  private onCoordinatorItems(
    session: ManagedSession,
    items: ConversationItem[],
  ): void {
    for (const item of items) {
      const signature = JSON.stringify(item);
      const previous = session.coordSignatures.get(item.id);
      if (previous === signature) {
        continue;
      }
      session.coordSignatures.set(item.id, signature);

      if (item.kind === "permission_request") {
        // New or resolution-updated permission request (R5.1, R5.6).
        this.postToPanel(session, { type: "showPermissionRequest", item });
      } else if (item.kind === "tool_action") {
        if (previous === undefined) {
          this.postToPanel(session, { type: "showToolAction", item });
        } else {
          // R10.2/R10.3: status/output change for a running action.
          this.postToPanel(session, {
            type: "updateToolStatus",
            itemId: item.id,
            status: item.status,
            ...(item.output !== undefined ? { output: item.output } : {}),
          });
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Process-exit handling (R2.5)
  // --------------------------------------------------------------------------

  private handleExit(session: ManagedSession, info: AgentExitInfo): void {
    this.clearUnresponsiveTimer(session);
    session.promptPending = false;
    session.client?.dispose();

    if (session.closing) {
      // Intentional teardown (close / new-session / restart): not an error.
      return;
    }

    // R2.5: an unexpected exit shows the status and offers a restart.
    const status = `The Rayu agent exited unexpectedly (code ${info.code ?? "null"}, signal ${info.signal ?? "null"}).`;
    this.log("lifecycle", status);
    this.postToPanel(session, { type: "showError", message: status });
    this.postToPanel(session, { type: "setGenerating", generating: false });
    void this.promptRestart(session, status);
  }

  private async promptRestart(
    session: ManagedSession,
    status: string,
  ): Promise<void> {
    const choice = await this.adapter.showActionableMessage("warn", status, [
      "Restart",
    ]);
    if (choice === "Restart" && this.sessions.has(session.key)) {
      session.process = null;
      session.client = null;
      await this.startAgent(session);
    }
  }

  // --------------------------------------------------------------------------
  // Unresponsiveness timeout (R15.4)
  // --------------------------------------------------------------------------

  private armUnresponsiveTimer(session: ManagedSession): void {
    this.clearUnresponsiveTimer(session);
    const ms = this.adapter.getSetting<number>(
      SETTING_UNRESPONSIVE_TIMEOUT_MS,
      DEFAULT_UNRESPONSIVE_TIMEOUT_MS,
    );
    if (!(ms > 0)) {
      return;
    }
    session.unresponsiveTimer = this.timers.set(() => {
      session.unresponsiveTimer = null;
      void this.onUnresponsive(session);
    }, ms);
  }

  private clearUnresponsiveTimer(session: ManagedSession): void {
    if (session.unresponsiveTimer !== null) {
      this.timers.clear(session.unresponsiveTimer);
      session.unresponsiveTimer = null;
    }
  }

  private async onUnresponsive(session: ManagedSession): Promise<void> {
    if (!session.promptPending) {
      return;
    }
    const choice = await this.adapter.showActionableMessage(
      "warn",
      "The Rayu agent has not responded. You can interrupt the current turn or restart the session.",
      ["Interrupt", "Restart"],
    );
    if (choice === "Interrupt") {
      await this.interrupt(session.key);
    } else if (choice === "Restart") {
      await this.teardownAgent(session);
      this.postToPanel(session, { type: "setGenerating", generating: false });
      await this.startAgent(session);
    }
  }

  // --------------------------------------------------------------------------
  // Prompt + Workspace_Context assembly (R9)
  // --------------------------------------------------------------------------

  private async assemblePrompt(
    session: ManagedSession,
    text: string,
  ): Promise<StdinUserMessage> {
    const includeActiveFile = this.adapter.getSetting<boolean>(
      SETTING_INCLUDE_ACTIVE_FILE,
      false,
    );
    const includeSelection = this.adapter.getSetting<boolean>(
      SETTING_INCLUDE_SELECTION,
      false,
    );

    const context = await this.adapter.getWorkspaceContext({
      includeActiveFile,
      includeSelection,
    });

    // R9.6: never include an ignored file's path/contents in the context.
    let activeFilePath = context.activeFilePath;
    if (activeFilePath && (await this.adapter.isPathIgnored(activeFilePath))) {
      activeFilePath = undefined;
    }
    let selection = context.selection;
    if (selection && (await this.adapter.isPathIgnored(selection.path))) {
      selection = undefined;
    }

    const preamble = buildContextPreamble({
      workspaceRoot: context.workspaceRoot,
      activeFilePath,
      selection,
    });
    const content = preamble ? `${preamble}${text}` : text;

    const message: StdinUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
    // R12.5: carry the resumable session id when one has been observed.
    const resumable = session.entry.resumableSessionId;
    if (resumable) {
      message.session_id = resumable;
    }
    return message;
  }

  // --------------------------------------------------------------------------
  // Edit application (R6)
  // --------------------------------------------------------------------------

  /** Build a {@link FileEditPlan} for one approved edit request (R6.1, R6.3). */
  private async buildEditPlan(
    session: ManagedSession,
    request: CanUseToolRequest,
  ): Promise<FileEditPlan | null> {
    const filePath =
      typeof request.input["file_path"] === "string"
        ? (request.input["file_path"] as string)
        : undefined;
    if (filePath === undefined) {
      return null;
    }
    const snapshot = await this.adapter.readFileSnapshot(filePath);
    const baseContent = snapshot ? snapshot.content : null;
    const action: ToolUseBlock = {
      type: "tool_use",
      id: request.tool_use_id,
      name: request.tool_name,
      input: request.input,
    };
    try {
      return this.editModel.buildPlan([action], (path) =>
        path === filePath ? baseContent : null,
      );
    } catch (error) {
      this.postToPanel(session, {
        type: "showError",
        message: `Could not prepare the edit for ${filePath}: ${errorMessage(error)}`,
      });
      return null;
    }
  }

  /**
   * Apply a plan via the adapter and report the outcome. A conflict (stale base)
   * is recorded and surfaced for explicit confirmation unless `override` is set
   * (R6.3); per-file failures are reported and leave other files untouched
   * (R6.6).
   */
  private async applyPlan(
    session: ManagedSession,
    requestId: string,
    plan: FileEditPlan,
    override: boolean,
  ): Promise<void> {
    const planToApply: FileEditPlan = override
      ? {
          changes: plan.changes.map((change) => ({
            path: change.path,
            kind: change.kind,
            newContent: change.newContent,
          })),
        }
      : plan;

    let result: ApplyResult;
    try {
      result = await this.adapter.applyFileEdits(planToApply);
    } catch (error) {
      this.postToPanel(session, {
        type: "showError",
        message: `Failed to apply the edit: ${errorMessage(error)}`,
      });
      return;
    }

    for (const path of result.applied) {
      this.postToPanel(session, { type: "editApplied", path });
    }
    // R6.6: report each per-file failure with its path; others are untouched.
    for (const failure of result.failed) {
      this.postToPanel(session, {
        type: "showError",
        message: `Failed to apply ${failure.path}: ${failure.reason}`,
      });
    }

    if (!override && result.conflicts.length > 0) {
      // R6.3: require explicit confirmation before overriding a stale base.
      session.conflictPlans.set(requestId, plan);
      const paths = result.conflicts.map((conflict) => conflict.path);
      this.postToPanel(session, { type: "editConflict", paths, requestId });
      const choice = await this.adapter.showActionableMessage(
        "warn",
        `These files changed on disk since the proposal was generated: ${paths.join(", ")}. Apply anyway?`,
        ["Apply anyway", "Cancel"],
      );
      if (choice === "Apply anyway") {
        await this.confirmConflict(session.key, requestId);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Panel & log sinks — everything routed through the Redactor (R15.5)
  // --------------------------------------------------------------------------

  /** Restore-ready merged history: reducer items + coordinator items by seq. */
  private mergedHistory(session: ManagedSession): ConversationItem[] {
    try {
      const reducerItems = this.sessionStore.restoreHistory(session.key);
      const coordinatorItems = session.coordinator.conversationItems;
      return [...reducerItems, ...coordinatorItems].sort(
        (a, b) => a.seq - b.seq,
      );
    } catch {
      // R12.3: open empty rather than failing.
      return [];
    }
  }

  /** Push a message to the panel, redacting every string field first (R15.5). */
  private postToPanel(
    session: ManagedSession,
    message: PanelOutboundMessage,
  ): void {
    const redacted = this.redactDeep(message);

    /*
     * Mirror BEFORE the panel-null check, and mirror the REDACTED value.
     *
     * Before the check, because a session whose panel the user closed is still
     * running — that is the point of retained sessions — and a remote viewer must
     * keep receiving it. Gating the mirror on a local panel being open would make
     * closing the VS Code panel silently blind the browser.
     *
     * The redacted value, because the browser is a less trusted surface than the
     * local webview and must never see a credential the panel would have masked.
     */
    if (this.onPanelMessage) {
      try {
        this.onPanelMessage(session.key, redacted);
      } catch (error) {
        // An observer's failure is never allowed to break the session it observes.
        this.log("error", `panel observer threw: ${errorMessage(error)}`);
      }
    }

    if (session.panel === null) {
      return;
    }
    void session.panel.postMessage(redacted);
  }

  /** Write a redacted line to the diagnostic log channel (R15.5). */
  private log(
    channel: "protocol" | "lifecycle" | "error",
    message: string,
  ): void {
    this.adapter.log(channel, this.redactor.redact(message));
  }

  /** Deep-redact every string in a structured value (R15.5). */
  private redactDeep<T>(value: T): T {
    if (!this.redactor.hasSecrets) {
      return value;
    }
    return this.redactValue(value) as T;
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === "string") {
      return this.redactor.redact(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.redactValue(entry));
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        // `out[key] = …` would invoke the `__proto__` SETTER for a payload that
        // literally carries that key: the assignment would mutate `out`'s
        // prototype instead of adding a property, and the field would vanish from
        // the message between the agent and the panel. Defining the property
        // explicitly keeps it an own data property, so the message stays faithful
        // and no prototype is touched.
        Object.defineProperty(out, key, {
          value: this.redactValue(entry),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return value;
  }

  // --------------------------------------------------------------------------
  // Panel inbound (webview → host) dispatch
  // --------------------------------------------------------------------------

  private handlePanelDisposed(session: ManagedSession): void {
    // The user closed the panel; the session (and its history) survive in the
    // host so reopening restores them (R12.2). Drop only the panel handle and
    // its subscriptions.
    for (const disposable of session.disposables) {
      disposable.dispose();
    }
    session.disposables = [];
    session.panel = null;
  }

  private handlePanelMessage(session: ManagedSession, raw: unknown): void {
    if (typeof raw !== "object" || raw === null) {
      return;
    }
    const message = raw as Record<string, unknown>;
    const type = typeof message["type"] === "string" ? message["type"] : "";
    const requestId =
      typeof message["requestId"] === "string" ? message["requestId"] : "";

    switch (type) {
      case "submitPrompt":
        void this.submitPrompt(
          session.key,
          typeof message["text"] === "string" ? message["text"] : "",
        );
        return;
      case "interrupt":
        void this.interrupt(session.key);
        return;
      case "approvePermission":
        this.approvePermission(
          session.key,
          requestId,
          // R5.2: `updatedInput` becomes the APPROVED tool input forwarded to the
          // CLI, so it is validated rather than cast. The webview is a separate
          // JS context; a malformed or hostile message must not be able to
          // replace the approved input with a non-object (which the CLI would
          // then receive in place of the parameters the user actually reviewed).
          asPlainObject(message["updatedInput"]),
        );
        return;
      case "denyPermission":
        this.denyPermission(
          session.key,
          requestId,
          typeof message["message"] === "string" ? message["message"] : undefined,
        );
        return;
      case "approveEdit":
        void this.approveEdit(session.key, requestId);
        return;
      case "confirmConflict":
        void this.confirmConflict(session.key, requestId);
        return;
      case "selectModel":
        void this.selectModel(
          session.key,
          typeof message["model"] === "string" ? message["model"] : "",
        );
        return;
      case "selectPermissionMode":
        // The mode decides whether tool actions are auto-approved, so the value
        // is checked against the wire schema instead of being cast. An unknown
        // string is dropped, never forwarded: `setMode` with an unrecognised mode
        // would fall through the policy's checks, and the safe direction is to
        // keep the mode already in force.
        void this.selectPermissionMode(session.key, message["mode"]);
        return;
      case "openModelList":
        void this.requestModels(session.key);
        return;
      case "newSession":
        void this.newSession(session.key);
        return;
      default:
        this.log("protocol", `Ignoring unknown panel message: ${String(type)}`);
    }
  }
}
