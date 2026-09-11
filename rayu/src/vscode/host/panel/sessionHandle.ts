/**
 * The chat session — engine lifecycle, turn streaming, and the transcript of record.
 *
 * ── SHAPE MIRRORS `WebBridgeHandle` ON PURPOSE ─────────────────────────────────
 *
 * `webBridge/webBridgeSession.ts` and `telegram/telegramBridge.ts` expose the same
 * surface — pushActivity / startTurn / onTextDelta / onThinkingDelta / endTurn /
 * stop / connectionState / sessionId — and its header explains why that symmetry is
 * load-bearing: the REPL's streaming tap wraps every remote surface the same way, so
 * a change to how turns are observed cannot land on one and miss another. This is
 * the third such surface, and it keeps the shape.
 *
 * It differs in ONE way, and the difference is the whole architecture: the web and
 * Telegram bridges observe a REPL that is already running in their own process. This
 * one OWNS an engine child process and drives it over the control protocol. So it
 * also owns spawn, initialize and disposal.
 *
 * ── THE THREE RULES INHERITED FROM THE WEB BRIDGE ──────────────────────────────
 *
 * 1. ONLY FINISHED MESSAGES BECOME TRANSCRIPT ENTRIES. Streaming assistant text
 *    arrives token by token as `appendPartial`; the engine ALSO emits the assembled
 *    message when the block completes. Forwarding both shows every answer twice.
 *    `formatActivityForVSCode` drops streamed kinds for exactly this reason, and
 *    settled assistant text is suppressed here while a stream for it is open.
 *
 * 2. AN INTERRUPT IS ACKED UNCONDITIONALLY. Even when there was nothing to stop.
 *    A click that lands just as a turn ends must still re-enable the composer, "or a
 *    mistimed click leaves it disabled forever".
 *
 * 3. LOSING THE ENGINE NEVER FABRICATES A DECISION. On exit, pending control
 *    requests are rejected and pending inbound requests are dropped UNANSWERED.
 *    Inventing a permission answer would be inventing consent.
 */
import { randomUUID } from 'node:crypto'

import { EngineProcess, type EngineExitInfo } from '../engine/engineProcess.js'
import { ControlClient, type InboundControlRequest } from '../engine/controlClient.js'
import {
  MAX_WEBVIEW_TEXT_CHARS,
  clamp,
  formatActivityForVSCode,
  formatMessageForVSCode,
  type VSCodeActivityBlock,
} from './formatActivityForVSCode.js'
import type { WrappedMessage } from '../../../telegram/formatActivity.js'
import { loadTaskHistory, saveTaskHistory } from '../../../utils/task/taskHistory.js'
import {
  persistModelChoice,
  readActiveModel,
  readActiveRuntimeModel,
  type EngineModel,
} from '../models/modelConfig.js'
import type {
  ReviewFileRecord,
  ReviewHunk,
} from '../review/fileChangeReview.js'
import { permissionModeById } from '../../shared/permissionModes.js'
import {
  type EffortChoice,
  type InferenceSettingsView,
} from '../../shared/inferenceSettings.js'
import type {
  BackgroundTaskType,
  BackgroundTaskView,
  ContextUsageView,
  DiffHunkView,
  ModelCatalogueView,
  EntryId,
  McpServerView,
  ModelInfoView,
  PermissionModeView,
  ReviewFileView,
  SlashCommandView,
  ThinkingEntryView,
  TranscriptEntry,
  TurnCompletionEntry,
  TurnPhaseView,
  TurnProgressView,
  TurnTokenUsageView,
  ImageInputView,
} from '../../shared/webviewProtocol.js'

/**
 * Commands implemented by the editor host rather than the stream-json engine.
 *
 * `/login` and `/connect` are `local-jsx` commands in the CLI, so `main.tsx`
 * deliberately removes them from a non-interactive engine.  They still have native
 * Rayucode surfaces, and must remain in the catalogue after `initialize` replaces the
 * startup fallback. `/logout` is included here as a startup fallback and is executed by
 * the engine, where the shared CLI cleanup and transcript output already live.
 */
const RAYUCODE_SLASH_COMMANDS: SlashCommandView[] = [
  { name: 'connect', description: 'Connect or configure an AI provider' },
  { name: 'login', description: 'Sign in to your Rayu account' },
  { name: 'logout', description: 'Sign out of your Rayu account' },
  // These two are `local-jsx` in the CLI for the same reason `/connect` is — they render an
  // Ink picker — so the non-interactive engine strips them too, and Rayucode has to provide
  // the surface. The grammar and the persistence are the CLI's; only the picker differs.
  {
    name: 'model_subagent',
    description: 'Set the model used by subagents [AGENT] [show|default]',
  },
  {
    name: 'webfetch_model',
    description: 'Set the model WebFetch uses to summarize pages [show|default]',
  },
]

const DEFAULT_SLASH_COMMANDS: SlashCommandView[] = [
  ...RAYUCODE_SLASH_COMMANDS,
  { name: 'clear', description: 'Clear current conversation' },
  { name: 'compact', description: 'Compact conversation to save context window' },
  { name: 'cost', description: 'Show token usage and estimated cost' },
  { name: 'doctor', description: 'Diagnose setup and environment issues' },
  { name: 'help', description: 'Show available slash commands and usage' },
  { name: 'init', description: 'Initialize project-level configuration' },
  { name: 'keep', description: 'Keep pending file changes' },
  { name: 'model', description: 'Switch active AI model' },
  { name: 'permissions', description: 'View or change tool permissions' },
  { name: 'review', description: 'Review changed files awaiting approval' },
  { name: 'undo', description: 'Revert pending file changes' },
]

function withRayucodeSlashCommands(
  commands: SlashCommandView[],
): SlashCommandView[] {
  const names = new Set(commands.map(command => command.name))
  return [
    ...commands,
    ...RAYUCODE_SLASH_COMMANDS.filter(command => !names.has(command.name)),
  ]
}

/**
 * The engine child's argv, beyond the headless flags `vscodeHost` adds for itself.
 *
 * Pure and exported so the flag contract is exhaustively testable without spawning a
 * process. `buildHostArgv` in `entrypoints/vscodeHost.ts` appends the required headless
 * flags on top of whatever this returns and never removes anything, so these survive.
 *
 * ── `--thinking enabled` IS NOT OPTIONAL ───────────────────────────────────────
 *
 * It is the CLI's own switch, and it is the ONLY mechanism that outranks
 * `shouldEnableThinkingByDefault()` — which returns false when the user's shared settings
 * carry `alwaysThinkingEnabled: false` or `MAX_THINKING_TOKENS=0`. The alternative, a
 * `set_max_thinking_tokens` control request with `null`, merely restores that same
 * settings default, so it cannot guarantee thinking is on.
 *
 * `enabled` is safe on every provider: `claude.ts` treats any non-`disabled` config as
 * "thinking wanted" and then resolves adaptive-vs-budget PER MODEL, so a model that
 * cannot do adaptive thinking gets its own default budget and a model that supports no
 * thinking at all is sent no thinking parameter.
 */
export function engineArgsFor(options: {
  resumeSessionId?: string
}): string[] {
  const args = ['--thinking', 'enabled']
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
  return args
}

export interface SessionCallbacks {
  /** A settled entry was appended. */
  onEntry: (entry: TranscriptEntry) => void
  /** One streamed fragment of the open assistant entry. */
  onPartial: (id: EntryId, kind: 'text' | 'thinking', delta: string) => void
  /** The open streaming entry finished. */
  onComplete: (id: EntryId) => void
  /** Turn started or ended, so the composer can flip send/stop. */
  onTurnState: (running: boolean) => void
  /** Live output for a running tool. Replaces the pill's body; never appended. */
  onToolOutput?: (id: EntryId, text: string) => void
  /** The engine reported its model. */
  onModelInfo: (info: ModelInfoView) => void
  /**
   * Something went wrong in a way the user should see, in a session that may NOT be
   * the one on screen.
   *
   * ── THIS IS THE CROSS-SESSION ALERT, NOT THE PRIMARY ERROR SURFACE ───────────
   *
   * `reportError` also records the failure as a `notice` entry in THIS session's
   * transcript, which is where it belongs: an error has a position in the
   * conversation, and rendering it anywhere else means a failure from turn 2 appears
   * below turn 9 with nothing to relate it to.
   *
   * This callback exists for the case the transcript cannot cover — a BACKGROUND
   * conversation failing while the user is looking at a different one. That session's
   * transcript has the entry, but the user is not reading it, and the session they are
   * waiting on must not fail silently. The extension therefore posts `showError` only
   * when the failing session is not active; see its `onError` handler.
   */
  onError: (message: string) => void
  /**
   * The engine is asking permission to run a tool, and is BLOCKED until answered.
   */
  onPermissionRequest: (request: InboundControlRequest) => void
  /**
   * The engine withdrew a permission request — it resolved the decision another way.
   * The card must be dismissed and must NOT be answered afterwards.
   */
  onPermissionCancelled: (requestId: string) => void
  /**
   * The session ended: the engine exited, was disposed, or was replaced.
   *
   * Pending approvals must be dismissed WITHOUT an answer. Fabricating a denial here
   * would reject a tool the user was mid-way through approving.
   */
  onSessionEnded: () => void
  /**
   * The review card no longer has anything to review — everything was kept or undone.
   * The UI must remove it; leaving an empty card offers actions that would do nothing.
   */
  onReviewCleared: (id: EntryId) => void
  /**
   * The recorded working set, for the host's diff reconstruction.
   *
   * Separate from the transcript entry because it carries the HUNKS, which stay
   * host-side: the editor draws the diff, so the webview never needs them, and they
   * would be a large postMessage for data it cannot use.
   */
  onReviewFiles?: (files: readonly ReviewFileRecord[]) => void
  /** Thinking/effort state, after the engine acknowledged a change. */
  onInferenceSettings?: (settings: InferenceSettingsView) => void
  /**
   * The enforced permission mode changed WITHOUT the user asking for it.
   *
   * Fired only when a replay onto a new engine was refused, so the pill can fall back to
   * what is actually enforced. Ordinary user-driven changes are reported by the caller
   * that requested them.
   */
  onPermissionMode?: (mode: PermissionModeView) => void
  /** Slash commands available in the engine. */
  onCommands?: (commands: SlashCommandView[]) => void
  /** Context window usage after a turn. */
  onContextUsage?: (usage: ContextUsageView) => void
  /** Connected MCP servers. */
  onMcpServers?: (servers: McpServerView[]) => void
  /** Structured live progress, derived from the same engine events as the CLI spinner. */
  onTurnProgress?: (progress: TurnProgressView) => void
  /** Final duration and token totals for the current turn. */
  onTurnCompleted?: (turnId: string, completion: TurnCompletionEntry) => void
  /** Provider-supplied thinking text. Never contains redacted/internal reasoning. */
  onThinking?: (thinking: ThinkingEntryView) => void
  /** A sanitized shared task projection changed. */
  onTaskStateChanged?: (task: BackgroundTaskView) => void
  /** A new/resumed session replaced the complete task set. */
  onTaskStateReplaced?: (tasks: BackgroundTaskView[]) => void
}

export interface SessionOptions {
  enginePath: string
  cwd: string
  resumeSessionId?: string
  nodePath?: string
  env?: Record<string, string | undefined>
  /**
   * Extra environment resolved lazily, at spawn time.
   *
   * Exists for the editor connection: its port is only known once a socket has been bound,
   * and awaiting that during `activate()` would delay the extension's activation for
   * something no turn needs yet. The engine spawn is already asynchronous and happens later,
   * so resolving here is both race-free and free.
   *
   * Must not reject — a failure to resolve optional environment cannot be allowed to stop a
   * session from starting.
   */
  resolveEnv?: () => Promise<Record<string, string | undefined>>
}

/**
 * Floor between mid-turn context refreshes. Context usage moves slowly relative to the
 * event rate of a turn, so a shorter interval buys nothing and costs a round-trip per
 * event.
 */
const MIN_CONTEXT_INTERVAL_MS = 2_000

/**
 * Total untruncated tool output the host will hold for on-demand expansion.
 *
 * Two megabytes is roughly sixty maximum-size clamped results, which covers scrolling
 * back through a long agent run while staying a rounding error against the extension
 * host's own footprint. The cost of being wrong in either direction is small and
 * asymmetric: too low means an occasional "no longer available" message, too high means
 * the panel quietly holds output nobody will read for the rest of the session.
 */
const MAX_RETAINED_OUTPUT_CHARS = 2_000_000

/**
 * Caps on the diff copy that crosses into the webview.
 *
 * Sized for READING, not for completeness: a change you can take in at a glance is a few
 * hunks of a few dozen lines, and past that the diff editor is the better surface anyway.
 * Twelve hunks of 400 lines is a worst case of a few thousand lines per file, which is a
 * postMessage measured in tens of kilobytes rather than megabytes.
 *
 * These bound the WEBVIEW copy only. `reviewRecords` keeps the uncapped hunks, because the
 * VS Code diff editor must show the whole change.
 */
const MAX_REVIEW_HUNKS = 12
const MAX_REVIEW_HUNK_LINES = 400

/**
 * Cap a file's hunks for the webview, reporting whether anything was dropped.
 *
 * Truncation is SIGNALLED rather than silent. A diff quietly missing its tail invites the
 * reader to conclude the change is smaller than it is, which is worse than showing less and
 * saying so — the card offers the diff editor for the rest.
 *
 * Pure and module-level so the boundary conditions are testable without a session.
 */
function boundHunks(hunks: readonly ReviewHunk[]): {
  hunks: DiffHunkView[]
  truncated: boolean
} {
  let truncated = hunks.length > MAX_REVIEW_HUNKS
  const bounded: DiffHunkView[] = []

  for (const hunk of hunks.slice(0, MAX_REVIEW_HUNKS)) {
    const raw = hunk as unknown as Partial<DiffHunkView>
    const lines = Array.isArray(raw.lines)
      ? raw.lines.filter((line): line is string => typeof line === 'string')
      : []
    if (lines.length > MAX_REVIEW_HUNK_LINES) truncated = true
    bounded.push({
      oldStart: numberOr(raw.oldStart, 1),
      oldLines: numberOr(raw.oldLines, 0),
      newStart: numberOr(raw.newStart, 1),
      newLines: numberOr(raw.newLines, 0),
      lines: lines.slice(0, MAX_REVIEW_HUNK_LINES),
    })
  }

  return { hunks: bounded, truncated }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export class ChatSession {
  private engine: EngineProcess | null = null
  private control: ControlClient | null = null

  /** The transcript of record. The webview is a view of this, never the owner. */
  private readonly entries: TranscriptEntry[] = []

  /** Id of the assistant entry currently being streamed into, if any. */
  private streamingId: EntryId | null = null

  /**
   * Which content blocks already reached the UI as deltas, per assistant message id.
   *
   * This replaces a turn-wide "did anything stream?" flag, which was a real data-loss
   * bug: a turn legitimately contains several assistant messages — prose, a tool call,
   * then a follow-up answer or summary — and one flag suppressed every settled message
   * after the first, so post-tool-call answers vanished.
   *
   * Keyed by `message.id` from `message_start`, which is the SAME id the settled
   * `assistant` message carries. The value is the set of Anthropic block `index`
   * values that produced text, and that index is the block's position in the settled
   * message's `content` array — which is what makes this correlation exact.
   */
  /** The entry currently receiving deltas from an ATTACHED session, if any. */
  private mirrorId: EntryId | null = null
  private readonly streamedBlocks = new Map<string, Set<number>>()
  /** The message currently streaming, from `message_start`. */
  private currentStreamMessageId: string | null = null
  /** The block currently streaming, from `content_block_start`/`_delta`. */
  private currentStreamBlockIndex: number | null = null
  private turnRunning = false
  /** Epoch ms when the current turn started, for the duration display. */
  private turnStartedAt = 0
  private activeTurnId: string | null = null
  /**
   * The engine child's own session id, learned from its frames.
   *
   * Needed to restart the engine WITHOUT losing the conversation: a change that only the
   * child's startup reads (a subagent or WebFetch model written to the shared config, which
   * the child has already cached) requires a respawn, and respawning with `--resume <id>`
   * is what keeps the transcript and the model's context intact.
   */
  private currentSessionId: string | null = null
  /** Subagent type names from `initialize`, for `/model_subagent <AGENT>`. */
  private agentTypes: string[] = []
  private turnProgress: TurnProgressView | null = null
  private readonly turnCompletions: Record<string, TurnCompletionEntry> = {}
  private readonly thinkingBlocks = new Map<string, ThinkingEntryView>()
  private activeThinkingKey: string | null = null
  private currentStreamBlockType: string | null = null
  private turnStreamedChars = 0
  /**
   * Bumped whenever the engine is replaced (new session / resume). Async replies compare
   * against the generation they were issued under so a late reply from a discarded engine
   * cannot overwrite the current session's state.
   */
  private generation = 0
  private contextInFlight = false
  private contextLastFetch = 0
  private modelInfo: ModelInfoView = { model: null, provider: null }
  /** The engine's catalogue, kept host-side for the QuickPick. Never sent to the UI. */
  private catalogue: EngineModel[] = []
  /**
   * The engine's raw `ModelInfo` entries, retained for capability lookups after a model
   * change. The trimmed `catalogue` drops the capability flags, so it cannot serve this.
   */
  public availableModels: ModelCatalogueView | null = null
  private permissionMode: PermissionModeView = permissionModeById('default')

  /**
   * Thinking and effort as last ACKNOWLEDGED.
   *
   * Capability flags are filled in from the engine's ModelInfo at `initialize`;
   * `supportsEffort: false` until then, so the control stays hidden rather than
   * appearing and then vanishing.
   */
  private inference: InferenceSettingsView = {
    supportsEffort: false,
    supportedLevels: [],
    effort: null,
    effortEnvOverride: null,
    supportsThinking: false,
    thinkingEnabled: false,
  }

  /** Tool entries by their engine-assigned id, so results can find their call. */
  private readonly toolsByUseId = new Map<string, EntryId>()

  /**
   * Hook entries by the engine's `hook_id`, so every frame for one execution updates
   * the same row instead of appending one per progress tick.
   *
   * Never cleared per turn: hooks can outlive the turn that triggered them (an async
   * `PostToolUse` hook reports after the turn has ended), and dropping the mapping would
   * make its response create a second, duplicate row.
   */
  private readonly hooksByHookId = new Map<string, EntryId>()

  /**
   * Untruncated tool output, for rows the user may ask to expand.
   *
   * ── BOUNDED, AND OLDEST-FIRST EVICTION ─────────────────────────────────────────
   *
   * Only results that were actually truncated are stored, and only up to
   * `MAX_RETAINED_OUTPUT_CHARS` in total across the session. Without a cap this would be
   * an unbounded leak in exactly the sessions that need it least — a long agent run that
   * reads dozens of large files would hold every one of them in the extension host for
   * output nobody asked to see.
   *
   * `Map` iteration order is insertion order, which is what makes "evict the oldest"
   * a single pass rather than needing a separate LRU. Oldest rather than least-recently-
   * read because the user scrolls back through recent work, not to the top of a long
   * session — and an evicted entry degrades to a message saying so rather than to a bug.
   */
  private readonly retainedToolOutput = new Map<EntryId, string>()
  private retainedOutputChars = 0

  /**
   * The live review card, if any.
   *
   * Tracked so a re-emitted summary UPDATES it rather than appending a second one: the
   * engine sends the whole working set again each time a file is kept or undone, and a
   * trail of those would leave stale cards offering to act on sets that no longer exist.
   *
   * The card still MOVES — `flushPendingReview` re-anchors it under each finished
   * response — but there is only ever one of it.
   */
  private reviewEntryId: EntryId | null = null
  /**
   * The turn the live card is already anchored under.
   *
   * `flushPendingReview` runs from both the `result` frame and the `idle` state change,
   * whichever the engine sends first, and both belong to the same turn. Without this the
   * second call would tear the card down and rebuild it below the completion line.
   */
  private reviewAnchorTurnId: string | null = null
  /**
   * Change ids that were already on record when the current turn started.
   *
   * The baseline for `ReviewFileView.changedThisTurn`. Captured on the turn's rising edge
   * rather than recomputed per snapshot, so the flags stay put while the user keeps and
   * undoes individual files after the turn — a file does not stop having been changed by
   * this response because it was subsequently kept.
   */
  private reviewBaselineChangeIds: ReadonlySet<string> = new Set()
  /** Every change id in the latest snapshot. Becomes the baseline at the next turn's start. */
  private reviewKnownChangeIds: ReadonlySet<string> = new Set()
  /**
   * Buffered review entry waiting for the turn to end.
   *
   * The engine emits `file_change_review` mid-turn as files are modified.
   * Showing it immediately interrupts the response flow, so we buffer here and
   * flush on the `result` frame — the review card then appears after the
   * assistant's prose and the post-turn summary, which is where the user
   * expects a file-change overview.
   */
  private pendingReview: ReviewEntry | null = null
  /**
   * The recorded working set, retained so it can be re-published.
   *
   * The diff store is a SINGLETON serving the editor's diff view, and only one session can own
   * it at a time. When the panel switches away and back, the newly-active session has to put
   * its own records back — otherwise the review card offers a diff reconstructed from another
   * conversation's hunks, which would show the wrong before-content with no error anywhere.
   */
  private reviewRecords: readonly ReviewFileRecord[] = []
  /** The single retry notice, updated in place instead of appending per attempt. */
  private retryNoticeId: EntryId | null = null

  private slashCommands: SlashCommandView[] = DEFAULT_SLASH_COMMANDS
  private lastContextUsage: ContextUsageView | null = null
  private mcpServersList: McpServerView[] = []
  /** Background work is host-owned so webview disposal cannot lose it. */
  private readonly backgroundTaskMap = new Map<string, BackgroundTaskView>()
  private taskHistoryWrite: Promise<void> = Promise.resolve()

  private starting: Promise<void> | null = null
  /** Invalidates prompts waiting for startup when stopped or replaced. */
  private submissionEpoch = 0
  /** Provider-qualified model explicitly selected for this Rayucode session. */
  private selectedRuntimeModel: string | null = null
  /** Last model the current engine acknowledged. Cleared whenever it is replaced. */
  private appliedRuntimeModel: string | null = null
  /** Serializes rapid picker changes so an older acknowledgement cannot win. */
  private modelChangeQueue: Promise<void> = Promise.resolve()
  private modelSelectionEpoch = 0
  private disposed = false
  /** Epoch ms of the last transcript append. See `lastActivityAt`. */
  private lastEntryAt = Date.now()

  constructor(
    private options: SessionOptions,
    private readonly callbacks: SessionCallbacks,
  ) {
    this.selectedRuntimeModel = readActiveRuntimeModel()
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.entries
  }

  get isTurnRunning(): boolean {
    return this.turnRunning
  }

  get currentModelInfo(): ModelInfoView {
    return this.control ? this.modelInfo : readActiveModel()
  }

  get commands(): readonly SlashCommandView[] {
    return this.slashCommands
  }

  get contextUsage(): ContextUsageView | null {
    return this.lastContextUsage
  }

  get mcpServers(): readonly McpServerView[] {
    return this.mcpServersList
  }

  get backgroundTasks(): readonly BackgroundTaskView[] {
    return [...this.backgroundTaskMap.values()].sort(compareBackgroundTasks)
  }

  get currentTurnProgress(): TurnProgressView | null {
    return this.turnProgress ? { ...this.turnProgress, usage: { ...this.turnProgress.usage } } : null
  }

  get completedTurns(): Readonly<Record<string, TurnCompletionEntry>> {
    return this.turnCompletions
  }

  /**
   * The engine child's session id, or null before it has sent a frame.
   *
   * Null means there is nothing to resume — the engine has not started, so a restart is
   * simply a start and no conversation can be lost.
   */
  get engineSessionId(): string | null {
    return this.currentSessionId
  }

  /** Subagent type names the engine reported, for `/model_subagent <AGENT>`. */
  get subagentTypes(): readonly string[] {
    return this.agentTypes
  }

  get currentThinkingBlocks(): readonly ThinkingEntryView[] {
    return [...this.thinkingBlocks.values()].map(block => ({ ...block }))
  }

  /** Restore terminal task metadata alongside the shared transcript on resume. */
  async restoreTaskHistory(sessionId: string, cwd = this.options.cwd): Promise<void> {
    const restored = await loadTaskHistory(cwd, sessionId)
    this.backgroundTaskMap.clear()
    for (const task of restored) this.backgroundTaskMap.set(task.key, task)
    this.callbacks.onTaskStateReplaced?.([...this.backgroundTasks])
  }

  /**
   * Start the engine while the open panel is idle.
   *
   * This uses the same promise as submitPrompt, so a prompt sent while initialization
   * is still running waits for that work instead of spawning a second child.
   */
  async warmup(): Promise<void> {
    if (this.disposed) return
    try {
      await this.ensureStarted()
    } catch (cause) {
      if (this.disposed) return
      this.reportError(
        `Could not start the Rayu engine: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
      this.teardown('engine warmup failed')
    }
  }

  /**
   * Send a prompt, reusing the prewarmed engine or waiting for its initialization.
   */
  async submitPrompt(text: string, images: ImageInputView[] = []): Promise<void> {
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0) || this.disposed) return
    const epoch = this.submissionEpoch

    // The transcript intentionally records only a descriptive image marker. Keeping
    // base64 in WebviewState or session history would retain a potentially large,
    // private payload long after it has been sent to the engine.
    const imageDescription = images
      .map(image => `[Image: ${image.name || 'attachment'}]`)
      .join(' ')
    this.appendEntry({
      id: newId(),
      kind: 'prompt',
      text: [trimmed, imageDescription].filter(Boolean).join('\n'),
    })

    // Report work immediately, before spawning the child or waiting for its
    // initialize response. The first startup can take noticeably longer than
    // later turns while the packaged engine is loaded and the provider is
    // prepared. Keeping this state transition here gives the panel a truthful
    // progress signal for that whole interval.
    this.setTurnRunning(true)

    try {
      await this.ensureStarted()
    } catch (cause) {
      if (this.disposed || epoch !== this.submissionEpoch) return
      this.reportError(
        `Could not start the Rayu engine: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
      this.completeTurn('failed')
      this.setTurnRunning(false)
      return
    }

    if (this.disposed || epoch !== this.submissionEpoch) return

    // A prompt is an ordinary `user` message on stdin — the same shape the CLI's
    // own stream-json input uses, so it inherits queueing and slash-command parsing
    // rather than needing a second code path.
    // ── IMAGES FIRST, TEXT LAST — THIS ORDER IS LOAD-BEARING ──────────────────
    //
    // `processUserInputBase` reads the prompt from the LAST content block:
    //
    //     const lastBlock = processedBlocks[processedBlocks.length - 1]
    //     if (lastBlock?.type === 'text') { inputString = lastBlock.text; … }
    //     else { precedingInputBlocks = processedBlocks }
    //
    // So `[text, image]` leaves `inputString` null and pushes everything into
    // `precedingInputBlocks` — the user's question is dropped and the turn arrives with no
    // prompt, which is why the model answered "I don't see any image": it never received the
    // question OR the attachment as a prompt.
    //
    // This is the CLI's own convention, not a workaround: `processSlashCommand` assembles
    // `[...imageContentBlocks, ...precedingInputBlocks, ...result]` with the text result last,
    // and `prependPathRefs` in `bridge/inboundAttachments.ts` documents the same rule for the
    // web composer ("Targets the LAST text block … putting refs in block[0] means they're
    // silently ignored for [text, image] content").
    const content = images.length === 0
      ? trimmed
      : [
          ...images.map(image => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: image.mediaType,
              data: image.data,
            },
          })),
          // Always present, even when the user sent only an image: a trailing text block is
          // what makes `inputString` non-null, and an image with no prompt would otherwise
          // reach the model as an attachment nobody asked a question about.
          { type: 'text' as const, text: trimmed || 'Describe this image.' },
        ]
    const delivered = this.engine?.send({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    })

    if (!delivered) {
      this.completeTurn('failed')
      this.setTurnRunning(false)
      this.reportError('The Rayu engine is not running.')
    } else {
      this.updateTurnProgress('requesting', 'Sending request')
    }
  }

  /**
   * Stop the running turn.
   *
   * Acked unconditionally by flipping turn state off regardless of what the engine
   * says, and regardless of whether a turn was even running. See rule 2 in the
   * header: the alternative is a composer that can never be re-enabled.
   */
  async interrupt(): Promise<void> {
    this.submissionEpoch += 1
    const control = this.control
    this.finishStreaming()
    // A stopped turn still changed whatever it changed before it was stopped, and those
    // files are on disk waiting to be kept or undone. Without this the buffered card was
    // silently discarded on the next turn's rising edge and the user was never told.
    this.flushPendingReview()
    this.completeTurn('stopped')
    this.setTurnRunning(false)

    if (!control) return
    try {
      await control.request('interrupt', {}, 10_000)
    } catch {
      // Deliberately swallowed. The user asked to stop; whether the engine
      // acknowledged is not something they can act on, and the composer is already
      // usable again.
    }
  }

  /** Stop through the engine's shared task implementation and stale-state checks. */
  async stopBackgroundTask(taskId: string): Promise<void> {
    const task = [...this.backgroundTaskMap.values()].find(item => item.taskId === taskId)
    if (!task || !task.capabilities.canStop) return
    const control = this.control
    if (!control) {
      this.reportError('The Rayu engine is not running.')
      return
    }
    try {
      await control.request('stop_task', { task_id: taskId }, 15_000)
    } catch (cause) {
      this.reportError(
        `Could not stop ${task.description}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }
  }

  /**
   * Discard the conversation and the engine with it.
   *
   * A fresh child rather than a reset message: the engine holds per-session state —
   * read-file tracking, permission decisions, MCP connections, compaction history — and
   * there is no control request that clears all of it. A new process is the only
   * honest "new session".
   *
   * ── `preserveModel` SEPARATES TWO CALLERS THAT LOOK ALIKE ──────────────────────
   *
   * A genuinely NEW conversation should start on whatever model is currently configured, so
   * the selection is re-read. A RESTART of this same conversation — which is how a subagent or
   * WebFetch model setting is applied, since the engine caches config at spawn — must keep the
   * model this conversation was pinned to. Re-reading there silently moved a session onto
   * whatever another session had selected, which is the cross-contamination this flag prevents.
   */
  newSession(
    resumeSessionId?: string,
    cwd?: string,
    options: { preserveModel?: boolean } = {},
  ): void {
    // Invalidate anything in flight against the outgoing engine.
    this.generation += 1
    this.modelSelectionEpoch += 1
    if (!options.preserveModel) this.selectedRuntimeModel = readActiveRuntimeModel()
    this.appliedRuntimeModel = null
    this.contextLastFetch = 0
    this.lastContextUsage = null
    this.teardown('starting a new session')
    this.options = {
      ...this.options,
      resumeSessionId,
      ...(cwd ? { cwd } : {}),
    }
    this.entries.length = 0
    this.activeTurnId = null
    // The transcript is gone, so nothing can ask to expand a row of it. Retained output
    // and hook correlation would otherwise survive into a conversation that has no
    // entries to attach them to — a leak whose size is the previous session's output.
    this.retainedToolOutput.clear()
    this.retainedOutputChars = 0
    this.hooksByHookId.clear()
    // Cleared so a later configuration restart cannot resume a conversation the user has
    // already left. It is re-learned from the new child's first frame — including when
    // `resumeSessionId` was passed, since a resumed child reports that same id.
    this.currentSessionId = null
    this.turnProgress = null
    for (const key of Object.keys(this.turnCompletions)) delete this.turnCompletions[key]
    this.thinkingBlocks.clear()
    this.activeThinkingKey = null
    this.backgroundTaskMap.clear()
    this.callbacks.onTaskStateReplaced?.([])
    this.toolsByUseId.clear()
    this.streamingId = null
    this.reviewEntryId = null
    this.reviewAnchorTurnId = null
    this.reviewBaselineChangeIds = new Set()
    this.reviewKnownChangeIds = new Set()
    this.pendingReview = null
    this.reviewRecords = []
    this.callbacks.onReviewFiles?.([])
    this.lastContextUsage = null
    this.setTurnRunning(false)
  }

  dispose(): void {
    this.disposed = true
    this.teardown('the panel was closed')
  }

  // ── engine lifecycle ───────────────────────────────────────────────────────

  private ensureStarted(): Promise<void> {
    if (this.starting) return this.starting
    if (this.engine?.isRunning && this.control) return Promise.resolve()
    // Concurrent submits must not spawn two engines.
    const starting = this.start().finally(() => {
      if (this.starting === starting) this.starting = null
    })
    this.starting = starting
    return starting
  }

  private async start(): Promise<void> {
    const control: ControlClient = new ControlClient(
      frame => this.engine?.send(frame) ?? false,
      {
        onMessage: message => this.handleEngineMessage(message),
        onRequest: request => this.handleInboundRequest(request),
        onRequestCancelled: requestId => {
          this.callbacks.onPermissionCancelled(requestId)
        },
        onUnknownFrame: (declaredType, excerpt) => {
          // A newer engine emitting a message this build does not know. Logged for
          // diagnosis, deliberately NOT surfaced in the transcript: the user cannot
          // act on it and it is not an error in their work.
          console.warn(
            `[rayucode] ignoring unrecognised "${declaredType}" frame: ${excerpt}`,
          )
        },
        onProtocolError: (message, excerpt) => {
          // Fatal by contract: the protocol is correlated, so continuing past a
          // frame we could not read risks waiting forever on a response that was
          // in it.
          this.callbacks.onError(`${message} ${excerpt}`)
          this.teardown('the engine sent an unreadable frame')
        },
      },
    )

    // Thinking is forced on for every Rayucode session — see `engineArgsFor`.
    const args = engineArgsFor(this.options)
    // Optional, lazily-resolved environment (currently the editor connection's port). A
    // failure here must not prevent the session from starting, so it degrades to nothing.
    const lazyEnv = this.options.resolveEnv
      ? await this.options.resolveEnv().catch(() => ({}))
      : {}
    const engine = new EngineProcess(
      {
        ...this.options,
        args,
        env: {
          ...this.options.env,
          ...lazyEnv,
          RAYU_CLIENT_PRODUCT: 'rayucode',
        },
      },
      {
        onFrame: frame => control.handleFrame(frame),
        onProtocolError: error => {
          this.callbacks.onError(`Engine stream error: ${error.message}`)
          this.teardown('the engine stream could not be read')
        },
        onExit: info => {
          if (this.engine === engine) this.handleExit(info)
        },
      },
    )

    this.engine = engine
    this.control = control
    engine.start()

    // `initialize` is what returns the command list, the model catalogue and the
    // account info. Failing it is not fatal to sending a prompt, so it is reported
    // and the session continues rather than refusing to start.
    try {
      const response = await control.request(
        'initialize',
        { agentProgressSummaries: true },
        60_000,
      )
      if (control !== this.control || this.disposed) return
      this.applyInitialize(response)
      // ── REPLAY THE CHOSEN PERMISSION MODE ────────────────────────────────────
      //
      // A fresh child always starts in the mode its argv implied, which is `default`. So a
      // mode the user picked before this engine existed — or before the engine it replaced
      // was torn down — has to be re-sent, or the panel shows "Full access" while every
      // Bash call raises an approval card. `--allow-dangerously-skip-permissions` is in
      // `vscodeHost`'s required flags precisely so that this replay can succeed.
      //
      // A refusal is not swallowed: the local mode falls back to what is actually
      // enforced and the pill is resynced, because a control that lies about being on is
      // worse than one that admits it could not be.
      if (this.permissionMode.id !== 'default') {
        const desired = this.permissionMode
        const accepted = await this.applyPermissionModeToEngine(control, desired)
        if (control !== this.control || this.disposed) return
        if (!accepted && this.permissionMode === desired) {
          this.permissionMode = permissionModeById('default')
          this.callbacks.onPermissionMode?.(this.permissionMode)
        }
      }
      // Startup can materialize a provider from environment-based credentials. Read
      // the Rayucode profile again after initialization so even that first session is
      // pinned instead of falling through to a model saved by the terminal CLI.
      if (!this.selectedRuntimeModel) {
        this.selectedRuntimeModel = readActiveRuntimeModel()
      }
      // Reapply an explicit Rayucode selection after a crash/restart. The routed
      // provider prefix is intentionally sent over stdin: operating-system argv
      // cannot carry the NUL separator used by shared cross-provider routing.
      const selectedRuntimeModel = this.selectedRuntimeModel
      const selectionEpoch = this.modelSelectionEpoch
      let inferenceAcknowledged = false
      if (selectedRuntimeModel) {
        const modelResponse = await control.request(
          'set_model',
          { model: selectedRuntimeModel },
          15_000,
        )
        if (control !== this.control || this.disposed) return
        if (
          selectionEpoch === this.modelSelectionEpoch &&
          selectedRuntimeModel === this.selectedRuntimeModel
        ) {
          this.appliedRuntimeModel = selectedRuntimeModel
          inferenceAcknowledged = this.applyInferenceResponse(modelResponse)
        }
      }
      if (control !== this.control || this.disposed) return
      // set_model already returns the effective inference state from the same
      // resolver as get_settings. Asking for it again made first launch depend on a
      // second control round-trip and could report a false initialization failure
      // after the model was already applied successfully.
      if (!inferenceAcknowledged) await this.refreshInferenceSettings()
      if (control !== this.control || this.disposed) return
      void this.pollContextUsage(true)
    } catch (cause) {
      if (control !== this.control || this.disposed) return
      this.callbacks.onError(
        `The engine started but did not initialise: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }
  }

  /** Read effective state from the same resolvers used to build CLI requests. */
  private async refreshInferenceSettings(): Promise<void> {
    const control = this.control, generation = this.generation
    if (!control) return
    const response = await control.request('get_settings', {}, 15_000)
    if (control !== this.control || generation !== this.generation || this.disposed) return
    this.applyInferenceResponse(response)
  }

  private applyInferenceResponse(response: Record<string, unknown>): boolean {
    const value = response.inference as InferenceSettingsView | undefined
    if (
      value &&
      typeof value.supportsEffort === 'boolean' &&
      typeof value.supportsThinking === 'boolean'
    ) {
      this.inference = value
      this.callbacks.onInferenceSettings?.(this.inference)
      return true
    }
    return false
  }

  private applyInitialize(response: Record<string, unknown>): void {
    // The catalogue is retained for the picker but NEVER forwarded to the webview:
    // measured at 712 entries against a real engine, which is a large postMessage
    // for a list the user opens occasionally. `host/models/modelSurface.ts` renders
    // it with a QuickPick instead.
    const models = response.models
    if (Array.isArray(models)) {
      this.catalogue = models
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map(m => ({
          // `value` is the API identifier. It is NOT called `model` — reading the
          // wrong field yields undefined and a picker full of blank rows.
          value: typeof m.value === 'string' ? m.value : '',
          displayName: typeof m.displayName === 'string' ? m.displayName : '',
          description: typeof m.description === 'string' ? m.description : '',
        }))
        .filter(m => m.value.length > 0)
    }

    // Retain commands and notify webview
    const commands = response.commands
    if (Array.isArray(commands)) {
      this.slashCommands = withRayucodeSlashCommands(
        commands
          .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
          .map(c => ({
            name: typeof c.name === 'string' ? c.name : '',
            description: typeof c.description === 'string' ? c.description : '',
          }))
          .filter(c => c.name.length > 0),
      )
      this.callbacks.onCommands?.(this.slashCommands)
    }

    // Subagent type names, for `/model_subagent <AGENT>`. Taken from the engine rather than
    // imported from `tools/AgentTool/built-in/subagents` so the list cannot drift from what
    // the running engine offers — and so the host bundle does not carry nine prompt modules
    // to learn nine names.
    const agents = response.agents
    if (Array.isArray(agents)) {
      this.agentTypes = agents
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .map(a => (typeof a.name === 'string' ? a.name : ''))
        .filter(name => name.length > 0)
    }

    // The SELECTED model comes from the shared config, not from the catalogue's
    // first entry — that would show whatever the provider happened to list first
    // and would silently disagree with what the CLI shows.
    this.modelInfo = readActiveModel()
    this.callbacks.onModelInfo(this.modelInfo)


  }

  /** The engine's model catalogue, for the host-side picker. */
  get modelCatalogue(): readonly EngineModel[] {
    return this.catalogue
  }

  get currentPermissionMode(): PermissionModeView {
    return this.permissionMode
  }

  /** The recorded working set, for re-publishing to the diff store on activation. */
  get reviewFiles(): readonly ReviewFileRecord[] {
    return this.reviewRecords
  }

  /**
   * Epoch ms of the last transcript change.
   *
   * Ordering for the live-session list. Taken from the last append rather than from the engine
   * because a session waiting on an approval is not writing anything, and it should keep its
   * place instead of sinking to the bottom.
   */
  get lastActivityAt(): number {
    return this.lastEntryAt
  }

  /**
   * Change the model for this session and persist the choice.
   *
   * `set_model` applies to the running child, and the Rayucode-profile config write
   * makes the choice survive a new Rayucode session.
   */
  async setModel(model: string): Promise<void> {
    const runtimeModel = persistModelChoice(model)
    const selectionEpoch = ++this.modelSelectionEpoch
    this.selectedRuntimeModel = runtimeModel
    this.modelInfo = readActiveModel()
    this.callbacks.onModelInfo(this.modelInfo)

    // When the catalog already knows the model reasoning support, reflect that immediately.
    const knownOpt = this.availableModels?.options.find(
      o => o.value === runtimeModel || o.model === model || o.value === model
    )
    if (knownOpt) {
      const supportsThinking = knownOpt.supportsThinking ?? false
      this.inference = {
        ...this.inference,
        supportsThinking,
        // Thinking is forced on at spawn (`--thinking enabled`), so for any model that
        // supports it the answer is simply "on". There is no user-facing off switch to
        // reconcile with — see the flag's rationale in `initialize`.
        thinkingEnabled: supportsThinking,
        supportsEffort: supportsThinking,
      }
      this.callbacks.onInferenceSettings?.(this.inference)
    }

    const change = this.modelChangeQueue.then(async () => {
      // A picker action can arrive while panel prewarm is still initializing.
      // Joining it lets start() apply the latest selection exactly once.
      const starting = this.starting
      if (starting) await starting
      if (
        this.disposed ||
        selectionEpoch !== this.modelSelectionEpoch ||
        runtimeModel !== this.selectedRuntimeModel
      ) return

      const control = this.control
      if (!control || this.appliedRuntimeModel === runtimeModel) return
      try {
        const response = await control.request(
          'set_model',
          { model: runtimeModel },
          15_000,
        )
        if (
          control !== this.control ||
          selectionEpoch !== this.modelSelectionEpoch ||
          runtimeModel !== this.selectedRuntimeModel
        ) return
        this.appliedRuntimeModel = runtimeModel
        // set_model returns the effective state derived by the same resolvers
        // that build CLI requests, so the UI never guesses capabilities.
        if (response.inference) {
          this.applyInferenceResponse(response)
        } else {
          await this.refreshInferenceSettings()
        }
        void this.pollContextUsage(true)
      } catch (cause) {
        if (selectionEpoch !== this.modelSelectionEpoch) return
        this.callbacks.onError(
          `The model was saved but the running session did not accept it: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        )
      }
    })
    this.modelChangeQueue = change.catch(() => {})
    await change
  }

  /** Initial settings from engine helper or catalogue refresh. */
  applyInitialInference(value: InferenceSettingsView): void {
    this.inference = {
      ...value,
      // The helper child that resolved these settings was NOT launched with
      // `--thinking enabled`, so its `thinkingEnabled` reflects the user's shared
      // settings rather than what this session will actually do. The session forces
      // thinking on at spawn, so the only correct answer here is the capability.
      thinkingEnabled: value.supportsThinking,
    }
    this.callbacks.onInferenceSettings?.(this.inference)
  }

  get currentInference(): InferenceSettingsView {
    return this.inference
  }

  /** Apply the shared CLI action through the engine, never as a chat prompt. */
  async setEffort(level: EffortChoice): Promise<void> {
    try {
      await this.ensureStarted()
      await this.control!.request('set_effort', { effort: level }, 15_000)
      await this.refreshInferenceSettings()
      void this.pollContextUsage(true)
    } catch (cause) {
      this.callbacks.onError(`Could not set effort: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /**
   * Apply a permission mode.
   *
   * The local value is updated only AFTER the engine accepts it. Flipping the pill
   * first would tell the user they are in "Full access" while the engine is still
   * asking for approval on every tool — the pill has to reflect what is enforced,
   * not what was requested.
   *
   * ── A MODE CHOSEN BEFORE THE ENGINE EXISTS IS STILL A PROMISE TO KEEP ──────────
   *
   * With no child yet there is nothing to ask, so the choice is recorded and reported as
   * accepted. That is only honest because `start()` REPLAYS it after `initialize` — see
   * `applyPermissionModeToEngine`. Without that replay the panel said "Full access" while
   * a freshly spawned child sat in `default` and asked for approval on every Bash call,
   * which is the exact bug this pairing exists to prevent. The same replay covers every
   * engine replacement: a configuration restart, a resume, or a crash recovery.
   */
  async setPermissionMode(mode: PermissionModeView): Promise<boolean> {
    if (!this.control) {
      // No engine yet: record it so the first turn starts in the chosen mode.
      this.permissionMode = mode
      return true
    }
    if (await this.applyPermissionModeToEngine(this.control, mode)) {
      this.permissionMode = mode
      return true
    }
    return false
  }

  /**
   * Send one `set_permission_mode` to a specific control client.
   *
   * Takes the client rather than reading `this.control` so a replay issued during
   * `start()` cannot land on an engine that replaced the one it was issued for.
   *
   * Returns false — rather than throwing — because both callers treat refusal as a state
   * to report, not an error to propagate: the engine legitimately rejects
   * `bypassPermissions` when settings or policy disable it, and that is information the
   * user needs rather than a broken session.
   */
  private async applyPermissionModeToEngine(
    control: ControlClient,
    mode: PermissionModeView,
  ): Promise<boolean> {
    try {
      await control.request('set_permission_mode', { mode: mode.id }, 15_000)
      return true
    } catch (cause) {
      this.callbacks.onError(
        `Could not switch to ${mode.label}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
      return false
    }
  }

  private teardown(reason: string): void {
    this.submissionEpoch += 1
    this.starting = null
    const wasLive = this.control !== null || this.engine !== null
    this.control?.dispose(reason)
    this.engine?.dispose()
    this.control = null
    this.engine = null
    this.appliedRuntimeModel = null
    this.setTurnRunning(false)
    // Dismiss any approval card: the engine that was blocked on it is gone, so the
    // card is a control that would do nothing when pressed.
    if (wasLive) this.callbacks.onSessionEnded()
  }

  private handleExit(info: EngineExitInfo): void {
    this.finishStreaming()
    // Same reason as `interrupt`: a crash does not un-write the files this turn already
    // wrote, so the review card is exactly what the user needs next.
    this.flushPendingReview()
    this.completeTurn('failed')
    this.setTurnRunning(false)
    this.control?.dispose('the engine exited')
    this.control = null
    this.engine = null
    // The engine that was blocked on any approval card is gone. Dismiss without
    // answering — see onSessionEnded.
    this.callbacks.onSessionEnded()

    // An expected exit is a disposal we asked for; saying so would be noise.
    if (info.expected) return

    const detail = info.stderrTail.trim()
    this.callbacks.onError(
      `The Rayu engine stopped unexpectedly (code ${info.code ?? 'null'}${
        info.signal ? `, signal ${info.signal}` : ''
      }).${detail ? ` ${detail.slice(-400)}` : ''}`,
    )
  }

  // ── engine → transcript ────────────────────────────────────────────────────

  private handleEngineMessage(message: Record<string, unknown>): void {
    // Every engine frame carries the session it belongs to. Recorded here — the one place
    // all of them pass through — because restarting the engine to pick up a configuration
    // change has to resume THIS conversation rather than start a new one, and the id is
    // otherwise known only to the child.
    if (typeof message.session_id === 'string' && message.session_id) {
      this.currentSessionId = message.session_id
    }

    switch (message.type) {
      case 'stream_event':
        this.handleStreamEvent(message)
        return

      case 'result':
        // The turn is over. The engine's own summary text is not appended: it
        // repeats the answer the user has already read.
        this.finishStreaming()
        // Flush the buffered file-change review card so it appears after the
        // response prose and summary, not mid-turn.
        this.flushPendingReview()
        this.completeTurn(message.is_error === true ? 'failed' : 'completed', message)
        this.setTurnRunning(false)
        void this.pollContextUsage()
        return

      case 'assistant':
      case 'user':
        this.handleSettledMessage(message)
        return

      case 'tool_progress':
        this.handleToolProgress(message)
        return

      case 'tool_output':
        this.handleToolOutput(message)
        return

      case 'system':
        this.handleSystemMessage(message)
        return

      default:
        // Ignoring the remainder is deliberate, not an omission.
        return
    }
  }

  /**
   * Surface the `system` subtypes the CLI already surfaces.
   *
   * ── THESE ARE THE ENGINE'S OWN OUTPUTS, NOT A SECOND ANALYSIS ──────────────────
   *
   * Every branch below renders something the engine already produced. There is
   * deliberately no extra summarising pass and no recap generator here: the engine
   * emits `post_turn_summary` itself, and a second summariser would let the panel and
   * the terminal describe the same turn differently — while costing another analysis
   * for information that already exists.
   *
   * The subtypes NOT handled — `init`, `status`, task progress — are bookkeeping with no
   * transcript meaning, and ignoring them is a decision rather than an oversight. Hook
   * lifecycle frames used to be in that list and are not any more: they describe work that
   * changes what the agent did, so a hook that blocks a tool or rewrites a file has to be
   * visible. See `handleHookLifecycle`.
   */
  private handleSystemMessage(message: Record<string, unknown>): void {
    switch (message.subtype) {
      case 'task_started':
      case 'task_progress':
      case 'task_notification':
        this.handleTaskLifecycle(message)
        return

      case 'file_change_review':
        this.handleReview(message)
        return

      case 'hook_started':
      case 'hook_progress':
      case 'hook_response':
        this.handleHookLifecycle(message)
        return

      case 'session_state_changed':
        this.handleSessionStateChanged(message)
        return

      case 'local_command_output': {
        // The output of a local slash command — `/cost`, `/status`, and critically
        // `/keep` and `/undo`, which is how the review card reports back. Without
        // this branch those commands appeared to do nothing at all.
        //
        // The schema's own description says it is "displayed as assistant-style text
        // in the transcript", so that is exactly how it is rendered.
        const content = typeof message.content === 'string' ? message.content : ''
        if (!content.trim()) return
        this.finishStreaming()
        this.appendEntry({ id: newId(), kind: 'assistant', text: content })
        return
      }

      case 'post_turn_summary': {
        const title = typeof message.title === 'string' ? message.title : ''
        const description =
          typeof message.description === 'string' ? message.description : ''
        // Nothing to show if the engine produced neither. Rendering an empty card
        // would imply the turn ended without an outcome.
        if (!title && !description) return

        const category = message.status_category
        this.finishStreaming()
        this.appendEntry({
          id: newId(),
          kind: 'summary',
          title,
          description,
          statusCategory:
            category === 'blocked' ||
            category === 'waiting' ||
            category === 'review_ready' ||
            category === 'failed'
              ? category
              : 'completed',
          statusDetail:
            typeof message.status_detail === 'string' ? message.status_detail : '',
          needsAction:
            typeof message.needs_action === 'string' ? message.needs_action : '',
          isNoteworthy: message.is_noteworthy === true,
        })
        return
      }

      case 'compact_boundary': {
        // Compaction silently changes what the model can still see, so it belongs in
        // the transcript. Without it a user who notices the assistant forgetting
        // earlier context has no way to know why.
        const meta = message.compact_metadata as Record<string, unknown> | undefined
        const trigger = meta?.trigger === 'manual' ? 'manually' : 'automatically'
        const pre = typeof meta?.pre_tokens === 'number' ? meta.pre_tokens : null
        this.finishStreaming()
        this.appendEntry({
          id: newId(),
          kind: 'notice',
          severity: 'info',
          text: pre
            ? `Context was compacted ${trigger} (was ~${pre.toLocaleString()} tokens). Earlier detail may no longer be visible to the model.`
            : `Context was compacted ${trigger}. Earlier detail may no longer be visible to the model.`,
        })
        return
      }

      case 'api_retry': {
        // A retry means the turn is still alive but slower. Silence here reads as a
        // hang, which is the single most common reason a user gives up on a request
        // that would have succeeded.
        const attempt = typeof message.attempt === 'number' ? message.attempt : 0
        const max = typeof message.max_retries === 'number' ? message.max_retries : 0
        const status =
          typeof message.error_status === 'number' ? ` (HTTP ${message.error_status})` : ''
        const text = `Provider request failed${status}; retrying (attempt ${attempt} of ${max}).`
        // Update the existing retry notice in place instead of appending one per
        // attempt, which clutters the transcript during flaky connections.
        if (this.retryNoticeId) {
          const index = this.entries.findIndex(e => e.id === this.retryNoticeId)
          if (index !== -1) {
            const updated: TranscriptEntry = { id: this.retryNoticeId, kind: 'notice', severity: 'info', text }
            this.entries[index] = updated
            this.emitEntry(updated)
            return
          }
        }
        const id = newId()
        this.retryNoticeId = id
        this.appendEntry({ id, kind: 'notice', severity: 'info', text })
        return
      }

      default:
        return
    }
  }

  /**
   * Project the engine's existing task lifecycle into a stable editor view.
   *
   * Updates are monotonic: once a task reaches a terminal state, a delayed progress
   * frame cannot revive it. The protocol can repeat frames after reconnect/replay, so
   * every update replaces by the composite session/task key.
   */
  private handleTaskLifecycle(message: Record<string, unknown>): void {
    const taskId = typeof message.task_id === 'string' ? message.task_id : ''
    if (!taskId) return
    const sourceSessionId =
      typeof message.session_id === 'string' && message.session_id
        ? message.session_id
        : this.options.resumeSessionId ?? 'standalone'
    const key = `${sourceSessionId}:${taskId}`
    const now = Date.now()
    const existing = this.backgroundTaskMap.get(key)

    if (message.subtype === 'task_started') {
      // A duplicated/replayed start must not erase progress or revive a finished task.
      if (existing) return
      const rawType = typeof message.task_type === 'string' ? message.task_type : undefined
      const type = normalizeTaskType(rawType)
      const description =
        typeof message.description === 'string' && message.description.trim()
          ? message.description.trim()
          : `Background task ${taskId}`
      this.publishTask({
        key,
        taskId,
        sourceSessionId,
        type,
        rawType: type === 'unknown' ? rawType : undefined,
        group: taskGroup(type),
        description,
        prompt: typeof message.prompt === 'string' ? message.prompt : undefined,
        status: 'running',
        executionMode: 'background',
        startedAt: now,
        updatedAt: now,
        currentActivity: description,
        recentActivities: [],
        tokenCount: 0,
        toolCount: 0,
        unread: false,
        capabilities: taskCapabilities(type, true),
      })
      return
    }

    if (message.subtype === 'task_progress') {
      if (existing && isTerminalBackgroundStatus(existing.status)) return
      const usage = asRecord(message.usage)
      const description =
        typeof message.description === 'string' && message.description.trim()
          ? message.description.trim()
          : existing?.description ?? `Background task ${taskId}`
      const summary =
        typeof message.summary === 'string' && message.summary.trim()
          ? message.summary.trim()
          : undefined
      const toolName =
        typeof message.last_tool_name === 'string' && message.last_tool_name.trim()
          ? message.last_tool_name.trim()
          : undefined
      const activityLabel = summary ?? (toolName ? `Using ${toolName}` : description)
      const activities = appendTaskActivity(existing?.recentActivities ?? [], {
        id: `${key}:${now}:${toolName ?? 'progress'}`,
        label: activityLabel,
        toolName,
        timestamp: now,
        kind: toolName ? 'tool' : 'status',
      })
      const rawType = existing?.rawType
      const type = existing?.type ?? 'unknown'
      this.publishTask({
        key,
        taskId,
        sourceSessionId,
        type,
        rawType,
        group: existing?.group ?? 'other',
        description,
        prompt: existing?.prompt,
        agentId: existing?.agentId,
        agentName: existing?.agentName,
        status: 'running',
        executionMode: existing?.executionMode ?? 'background',
        startedAt:
          existing?.startedAt ??
          (typeof usage?.duration_ms === 'number' ? now - usage.duration_ms : now),
        updatedAt: now,
        currentActivity: activityLabel,
        recentActivities: activities,
        model: existing?.model,
        provider: existing?.provider,
        tokenCount:
          typeof usage?.total_tokens === 'number'
            ? usage.total_tokens
            : existing?.tokenCount ?? 0,
        toolCount:
          typeof usage?.tool_uses === 'number'
            ? usage.tool_uses
            : existing?.toolCount ?? 0,
        result: existing?.result,
        error: existing?.error,
        unread: existing?.unread ?? false,
        capabilities: taskCapabilities(type, true),
        workflowProgress: normalizeWorkflowProgress(message.workflow_progress),
      })
      return
    }

    if (message.subtype === 'task_notification') {
      const status =
        message.status === 'failed'
          ? 'failed'
          : message.status === 'stopped'
            ? 'stopped'
            : 'completed'
      // A duplicate terminal event may enrich the record, but may not change its
      // terminal outcome. The first owner-issued outcome wins.
      if (existing && isTerminalBackgroundStatus(existing.status)) return
      const summary = typeof message.summary === 'string' ? message.summary : ''
      const type = existing?.type ?? 'unknown'
      const usage = asRecord(message.usage)
      this.publishTask({
        key,
        taskId,
        sourceSessionId,
        type,
        rawType: existing?.rawType,
        group: existing?.group ?? 'other',
        description: existing?.description ?? (summary || `Background task ${taskId}`),
        prompt: existing?.prompt,
        agentId: existing?.agentId,
        agentName: existing?.agentName,
        status,
        executionMode: existing?.executionMode ?? 'background',
        startedAt:
          existing?.startedAt ??
          (typeof usage?.duration_ms === 'number' ? now - usage.duration_ms : now),
        updatedAt: now,
        currentActivity:
          status === 'completed' ? 'Completed' : status === 'stopped' ? 'Stopped' : 'Failed',
        recentActivities: existing?.recentActivities ?? [],
        model: existing?.model,
        provider: existing?.provider,
        tokenCount:
          typeof usage?.total_tokens === 'number'
            ? usage.total_tokens
            : existing?.tokenCount ?? 0,
        toolCount:
          typeof usage?.tool_uses === 'number'
            ? usage.tool_uses
            : existing?.toolCount ?? 0,
        result: status === 'completed' ? summary : existing?.result,
        error: status === 'failed' ? summary || 'The task failed.' : existing?.error,
        unread: true,
        capabilities: taskCapabilities(type, false),
        workflowProgress: existing?.workflowProgress,
      })
    }
  }

  private publishTask(task: BackgroundTaskView): void {
    this.backgroundTaskMap.set(task.key, task)
    this.callbacks.onTaskStateChanged?.(task)
    this.persistTaskHistory(task.sourceSessionId)
  }

  private persistTaskHistory(sourceSessionId: string): void {
    const tasks = this.backgroundTasks.filter(item => item.sourceSessionId === sourceSessionId)
    this.taskHistoryWrite = this.taskHistoryWrite
      .catch(() => {})
      .then(() => saveTaskHistory(this.options.cwd, sourceSessionId, tasks))
      .catch(() => {})
  }

  /**
   * The working set: every file still recorded as changed and awaiting keep/undo.
   *
   * Replaces the live card rather than appending a second one. The engine re-emits the
   * whole summary as files are kept or undone, so appending would leave a trail of stale
   * cards each offering to act on a set that no longer exists.
   *
   * The one card is not left where it first appeared, though — `flushPendingReview`
   * re-anchors it under each response so the summary follows the conversation.
   */
  private handleReview(message: Record<string, unknown>): void {
    const review = message.review as Record<string, unknown> | undefined
    if (!review) return

    const rawFiles = Array.isArray(review.files) ? review.files : []

    // ── HUNKS NOW CROSS TO THE WEBVIEW, BOUNDED ────────────────────────────────
    //
    // This used to send only paths, stats and status, because "the editor draws the diff".
    // The panel draws it too now — requiring a diff editor to read a two-line change is
    // the biggest single gap against the terminal. The original reason for withholding
    // them was postMessage SIZE, which was a fair concern and is why both caps exist
    // rather than why the data is withheld.
    //
    // The host still keeps its own copy: `reviewRecords` feeds the VS Code diff editor,
    // which needs the complete, uncapped hunks.
    const records: ReviewFileRecord[] = []
    const files: ReviewFileView[] = []
    const knownChangeIds = new Set<string>()

    for (const raw of rawFiles) {
      if (!raw || typeof raw !== 'object') continue
      const f = raw as Record<string, unknown>
      const displayPath = typeof f.displayPath === 'string' ? f.displayPath : ''
      if (!displayPath) continue

      const status = f.status
      const rawHunks = Array.isArray(f.hunks) ? (f.hunks as ReviewHunk[]) : []
      const { hunks, truncated } = boundHunks(rawHunks)
      const changeIds = Array.isArray(f.changeIds)
        ? f.changeIds.filter((id): id is string => typeof id === 'string')
        : []
      for (const id of changeIds) knownChangeIds.add(id)
      const changedThisTurn = this.isChangedThisTurn(changeIds)
      files.push({
        displayPath,
        additions: typeof f.additions === 'number' ? f.additions : 0,
        removals: typeof f.removals === 'number' ? f.removals : 0,
        isCreated: f.isCreated === true,
        // Straight from the engine's PendingFileChangeStatus. Unknown values fall back
        // to 'pending', which is the only state that offers actions — erring toward
        // "actionable" is better than hiding a change the user still has to resolve.
        status:
          status === 'kept' || status === 'undone' || status === 'mixed'
            ? status
            : 'pending',
        changeIds,
        ...(hunks.length > 0 ? { hunks } : {}),
        ...(truncated ? { hunksTruncated: true } : {}),
        ...(changedThisTurn ? { changedThisTurn: true } : {}),
      })

      records.push({
        filePath: typeof f.filePath === 'string' ? f.filePath : displayPath,
        displayPath,
        changeIds,
        // The RECORDED hunks, UNCAPPED. These are what the diff is reconstructed from, and
        // what the CLI's own ReviewDetailDialog renders — not git. The editor's diff view
        // must show the whole change, so the cap applies only to the webview copy.
        hunks: rawHunks,
        isCreated: f.isCreated === true,
      })
    }

    this.reviewRecords = records
    this.reviewKnownChangeIds = knownChangeIds
    this.callbacks.onReviewFiles?.(records)

    // Nothing left to review means the user kept or undid everything. Drop the card
    // rather than showing an empty one.
    if (files.length === 0) {
      this.pendingReview = null
      if (this.reviewEntryId) {
        const index = this.entries.findIndex(e => e.id === this.reviewEntryId)
        if (index !== -1) this.entries.splice(index, 1)
        this.callbacks.onReviewCleared(this.reviewEntryId)
        this.reviewEntryId = null
        this.reviewAnchorTurnId = null
      }
      return
    }

    const entry: ReviewEntry = {
      id: this.reviewEntryId ?? newId(),
      kind: 'review',
      totalFiles: typeof review.totalFiles === 'number' ? review.totalFiles : files.length,
      totalAdditions:
        typeof review.totalAdditions === 'number' ? review.totalAdditions : 0,
      totalRemovals: typeof review.totalRemovals === 'number' ? review.totalRemovals : 0,
      files,
    }

    // Mid-turn: buffer so the card appears after the response, not during it.
    // Each re-emission replaces the buffer with the latest file set.
    if (this.turnRunning) {
      this.pendingReview = entry
      return
    }

    // Post-turn: emit immediately. This covers both the flush path (called from
    // `result`) and keep/undo re-emissions that arrive after the turn.
    this.emitReviewEntry(entry)
  }

  /**
   * Whether a file's recorded changes include anything the CURRENT turn is responsible for.
   *
   * Any change id the turn did not start with is new work. A file reporting no ids cannot
   * be judged and reads as not-this-turn rather than being guessed at — see
   * `ReviewFileView.changedThisTurn`.
   */
  private isChangedThisTurn(changeIds: readonly string[]): boolean {
    return changeIds.some(id => !this.reviewBaselineChangeIds.has(id))
  }

  /**
   * Re-evaluate `changedThisTurn` against the CURRENT baseline.
   *
   * Needed because a card can outlive the turn that built it: when a turn changes nothing,
   * `flushPendingReview` re-anchors the existing entry, whose flags were computed against
   * an older baseline and would otherwise credit this response with the previous one's
   * work. Returns the same objects when nothing changes, so a re-anchor that only moves
   * the card does not also churn every row.
   */
  private retagReviewFiles(files: readonly ReviewFileView[]): ReviewFileView[] {
    return files.map(file => {
      const changed = this.isChangedThisTurn(file.changeIds)
      if (changed === (file.changedThisTurn === true)) return file
      const { changedThisTurn: _previous, ...rest } = file
      return changed ? { ...rest, changedThisTurn: true } : rest
    })
  }

  /** Put a review entry into the transcript, creating or updating as needed. */
  private emitReviewEntry(entry: ReviewEntry): void {
    if (this.reviewEntryId) {
      const index = this.entries.findIndex(e => e.id === this.reviewEntryId)
      if (index !== -1) this.entries[index] = entry
      else this.entries.push(entry)
      this.emitEntry(entry)
    } else {
      this.reviewEntryId = entry.id
      this.appendEntry(entry)
    }
  }

  /**
   * Anchor the review card under the response that just finished. Called on turn end.
   *
   * ── THE CARD MOVES, IT IS NOT LEFT WHERE IT WAS FIRST SHOWN ────────────────────
   *
   * `addMessage` is an upsert BY ID, so re-emitting the live card under its existing id
   * updates it wherever it already sits. That is right for a keep/undo re-emission and
   * wrong at a turn boundary: the card stayed pinned under the first response of the
   * session and every later turn silently updated a card scrolled far out of view, so the
   * user saw a file-change summary once and never again. It is the single most visible
   * difference from the terminal, where `REPL.tsx` appends a fresh card at every turn's
   * completion.
   *
   * So the old entry is REMOVED and re-appended under a fresh id, which is what actually
   * moves it. One card, always the last thing in the finished turn.
   *
   * ── WHY NOT A CARD PER TURN, AS THE TERMINAL HAS ───────────────────────────────
   *
   * The terminal can afford a trail because each of its cards recomputes itself from the
   * live store and renders NOTHING once its own files are resolved. The webview has no
   * such store — the host is the only thing that knows the current statuses — so a trail
   * here would be a row of cards frozen at whatever they said when they were emitted, all
   * offering Keep all and Undo all over overlapping sets. Moving one live card gives the
   * per-response summary without the staleness; `changedThisTurn` supplies the part a
   * cumulative set would otherwise lose.
   *
   * ── AND WHY A FULLY RESOLVED CARD STOPS FOLLOWING ──────────────────────────────
   *
   * Once every file is kept or undone the card is a record, not a task, and dragging it
   * down the transcript after every unrelated answer would be noise. It stays where it is,
   * still updated in place. This mirrors the terminal, where a card with nothing pending
   * renders null.
   */
  private flushPendingReview(): void {
    const buffered = this.pendingReview
    this.pendingReview = null
    const turnId = this.activeTurnId

    // `result` and the `idle` state change both land here, whichever the engine sends
    // first, and both belong to this turn. Anchoring twice would tear the card down and
    // rebuild it below the completion line, so the second call only carries updates.
    if (turnId && this.reviewAnchorTurnId === turnId) {
      if (buffered) this.emitReviewEntry(buffered)
      return
    }

    const index = this.reviewEntryId
      ? this.entries.findIndex(e => e.id === this.reviewEntryId)
      : -1
    // With no new snapshot this turn, the live card is still the summary to show: the
    // files it lists are unresolved regardless of what this turn was about.
    const source = buffered ?? (index === -1 ? undefined : this.entries[index])
    if (!source || source.kind !== 'review') return

    // The flags on a carried-over card were computed for an EARLIER turn. Re-evaluating
    // them here is what stops a response that changed nothing from claiming the previous
    // response's files as its own.
    const files = this.retagReviewFiles(source.files)
    const actionable = files.some(
      file => file.status === 'pending' || file.status === 'mixed',
    )
    const touchedThisTurn = files.some(file => file.changedThisTurn === true)
    if (!actionable && !touchedThisTurn) {
      if (buffered) this.emitReviewEntry({ ...buffered, files })
      return
    }

    if (index !== -1 && this.reviewEntryId) {
      const stale = this.reviewEntryId
      this.entries.splice(index, 1)
      this.reviewEntryId = null
      this.callbacks.onReviewCleared(stale)
    }

    const anchored: ReviewEntry = { ...source, id: newId(), files }
    this.reviewEntryId = anchored.id
    if (turnId) this.reviewAnchorTurnId = turnId
    this.appendEntry(anchored)
  }

  private updateTurnProgress(
    phase: TurnPhaseView,
    label: string,
    toolName?: string,
    toolLabel?: string,
  ): void {
    if (!this.turnRunning || !this.activeTurnId) return
    const previous = this.turnProgress
    this.turnProgress = {
      turnId: this.activeTurnId,
      phase,
      label,
      startTimestamp: this.turnStartedAt || Date.now(),
      ...(toolName ? { toolName } : {}),
      ...(toolLabel ? { toolLabel } : {}),
      usage: previous?.usage ?? emptyTurnUsage(),
    }
    this.callbacks.onTurnProgress?.({
      ...this.turnProgress,
      usage: { ...this.turnProgress.usage },
    })
  }

  private updateUsage(raw: Record<string, unknown> | undefined, finalOutput: boolean): void {
    if (!raw || !this.turnProgress) return
    const direct = finiteToken(raw.input_tokens)
    const cacheRead = finiteToken(raw.cache_read_input_tokens)
    const cacheCreation = finiteToken(raw.cache_creation_input_tokens)
    const hasInput =
      typeof raw.input_tokens === 'number' ||
      typeof raw.cache_read_input_tokens === 'number' ||
      typeof raw.cache_creation_input_tokens === 'number'
    const hasOutput = typeof raw.output_tokens === 'number'
    const output = finalOutput && hasOutput
      ? finiteToken(raw.output_tokens)
      : this.turnProgress.usage.outputTokens
    const usage: TurnTokenUsageView = {
      inputTokens: hasInput
        ? direct + cacheRead + cacheCreation
        : this.turnProgress.usage.inputTokens,
      outputTokens: output,
      cacheReadTokens: hasInput ? cacheRead : this.turnProgress.usage.cacheReadTokens,
      cacheCreationTokens: hasInput ? cacheCreation : this.turnProgress.usage.cacheCreationTokens,
      inputEstimated: hasInput ? false : this.turnProgress.usage.inputEstimated,
      outputEstimated: finalOutput && hasOutput ? false : this.turnProgress.usage.outputEstimated,
    }
    this.turnProgress = { ...this.turnProgress, usage }
    this.callbacks.onTurnProgress?.({ ...this.turnProgress, usage: { ...usage } })
  }

  private updateEstimatedOutput(chars: number): void {
    if (!this.turnProgress || chars <= 0 || !this.turnProgress.usage.outputEstimated) return
    this.turnStreamedChars += chars
    const usage = {
      ...this.turnProgress.usage,
      outputTokens: Math.round(this.turnStreamedChars / 4),
    }
    this.turnProgress = { ...this.turnProgress, usage }
    this.callbacks.onTurnProgress?.({ ...this.turnProgress, usage: { ...usage } })
  }

  private completeTurn(
    outcome: TurnCompletionEntry['outcome'],
    message?: Record<string, unknown>,
  ): void {
    const turnId = this.activeTurnId
    if (!turnId || this.turnCompletions[turnId]) return
    const rawUsage = asRecord(message?.usage)
    const currentUsage = this.turnProgress?.usage ?? emptyTurnUsage()
    const hasUsage = rawUsage !== undefined
    const direct = finiteToken(rawUsage?.input_tokens)
    const cacheRead = finiteToken(rawUsage?.cache_read_input_tokens)
    const cacheCreation = finiteToken(rawUsage?.cache_creation_input_tokens)
    const completion: TurnCompletionEntry = {
      outcome,
      durationMs:
        typeof message?.duration_ms === 'number' && Number.isFinite(message.duration_ms)
          ? Math.max(0, message.duration_ms)
          : Math.max(0, Date.now() - this.turnStartedAt),
      usage: hasUsage
        ? {
            inputTokens: direct + cacheRead + cacheCreation,
            outputTokens: finiteToken(rawUsage?.output_tokens),
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            inputEstimated: false,
            outputEstimated: false,
          }
        : { ...currentUsage },
    }
    this.turnCompletions[turnId] = completion
    this.callbacks.onTurnCompleted?.(turnId, completion)
    // Anchor the completion line where the turn actually ended. Guarded by the
    // `turnCompletions[turnId]` early return above, so a turn can only ever produce one
    // marker even if several code paths race to finish it.
    this.finishStreaming()
    this.appendEntry({ id: newId(), kind: 'turn_end', turnId })
    this.turnProgress = {
      ...(this.turnProgress ?? {
        turnId,
        label: outcome === 'completed' ? 'Completed' : outcome === 'failed' ? 'Failed' : 'Stopped',
        startTimestamp: this.turnStartedAt,
        usage: completion.usage,
      }),
      phase: outcome,
      usage: completion.usage,
    }
  }

  /**
   * Route one streamed event.
   *
   * The engine forwards the provider's RAW stream events, so these are Anthropic's
   * shapes. Four of them matter, and the first is what makes correlation possible:
   *
   *   message_start        carries `message.id` — the id the SETTLED assistant
   *                        message will also carry, which is how we know which
   *                        settled blocks were already streamed.
   *   content_block_start  carries `index` — the position this block will occupy in
   *                        the settled message's `content` array.
   *   content_block_delta  the actual text/thinking fragments.
   *   content_block_stop   the block is complete.
   *
   * `input_json_delta` for tool arguments is deliberately ignored: a half-parsed
   * argument object is not something to render, and the complete input arrives with
   * the settled `tool_use` block.
   */
  private handleStreamEvent(message: Record<string, unknown>): void {
    const event = message.event as Record<string, unknown> | undefined
    if (!event) return

    switch (event.type) {
      case 'message_start': {
        const inner = event.message as Record<string, unknown> | undefined
        const id = typeof inner?.id === 'string' ? inner.id : null
        // A new assistant message begins. Close any open entry FIRST so a turn that
        // produces prose, then a tool call, then more prose renders as separate
        // answers rather than one run-on block.
        this.finishStreaming()
        this.currentStreamMessageId = id
        this.currentStreamBlockIndex = null
        this.currentStreamBlockType = null
        this.updateUsage(asRecord(inner?.usage), false)
        this.updateTurnProgress('responding', 'Responding')
        if (id !== null && !this.streamedBlocks.has(id)) {
          this.streamedBlocks.set(id, new Set())
        }
        return
      }

      case 'content_block_start': {
        this.currentStreamBlockIndex =
          typeof event.index === 'number' ? event.index : null
        const block = asRecord(event.content_block)
        this.currentStreamBlockType = typeof block?.type === 'string' ? block.type : null
        if (this.currentStreamBlockType === 'thinking') {
          this.updateTurnProgress('thinking', 'Thinking')
        } else if (this.currentStreamBlockType === 'tool_use') {
          const name = typeof block?.name === 'string' ? block.name : 'tool'
          const phase = phaseForTool(name)
          this.updateTurnProgress(phase, labelForPhase(phase), name)
        }
        return
      }

      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown> | undefined
        if (!delta) return
        // Prefer the event's own index; `content_block_start` is not guaranteed to
        // precede every delta on every provider.
        if (typeof event.index === 'number') this.currentStreamBlockIndex = event.index

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.finishActiveThinking()
          this.updateTurnProgress('responding', 'Responding')
          this.recordStreamedBlock()
          this.appendPartial('text', delta.text)
          this.updateEstimatedOutput(delta.text.length)
          return
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          // Thinking is relayed live but NOT recorded as a streamed block: the
          // settled message has no thinking text block to suppress, and recording it
          // would suppress whatever text block happens to share the index.
          this.updateTurnProgress('thinking', 'Thinking')
          this.appendThinking(delta.thinking)
          this.updateEstimatedOutput(delta.thinking.length)
        }
        return
      }

      case 'content_block_stop': {
        if (this.currentStreamBlockType === 'thinking') this.finishActiveThinking()
        this.currentStreamBlockIndex = null
        this.currentStreamBlockType = null
        return
      }

      case 'message_delta': {
        this.updateUsage(asRecord(event.usage), true)
        return
      }

      default:
        // message_stop, ping. The turn's end is driven by the
        // `result` frame, which is authoritative; message_stop is not, because a
        // turn can contain several messages.
        return
    }
  }

  /** Note that (current message, current block) produced streamed text. */
  private recordStreamedBlock(): void {
    const id = this.currentStreamMessageId
    const index = this.currentStreamBlockIndex
    if (id === null || index === null) return
    let set = this.streamedBlocks.get(id)
    if (!set) {
      set = new Set()
      this.streamedBlocks.set(id, set)
    }
    set.add(index)
  }

  private appendPartial(kind: 'text' | 'thinking', delta: string): void {
    if (delta.length === 0) return

    if (this.streamingId === null) {
      const id = newId()
      this.streamingId = id
      // Opened as an empty streaming entry so the UI can show the pulse dot
      // immediately, before any text has arrived.
      this.appendEntry({ id, kind: 'assistant', text: '', streaming: true })
    }
    const id = this.streamingId

    // The host keeps its own copy so a re-created webview can be restored from
    // `init` mid-turn rather than losing the partial answer.
    const entry = this.entries.find(e => e.id === id)
    if (entry?.kind === 'assistant' && kind === 'text') entry.text += delta

    this.callbacks.onPartial(id, kind, delta)
  }

  private ensureStreamingEntry(): EntryId {
    if (this.streamingId === null) {
      const id = newId()
      this.streamingId = id
      this.appendEntry({ id, kind: 'assistant', text: '', streaming: true })
    }
    return this.streamingId
  }

  /** Preserve explicit provider thinking as its own correlated, bounded block. */
  private appendThinking(delta: string): void {
    if (!delta) return
    const sourceMessageId = this.ensureStreamingEntry()
    const blockIndex = this.currentStreamBlockIndex ?? 0
    const key = `${sourceMessageId}:${blockIndex}`
    let block = this.thinkingBlocks.get(key)
    if (!block) {
      block = {
        entryId: `thinking-${sourceMessageId}-${blockIndex}`,
        sourceMessageId,
        blockIndex,
        text: '',
        streaming: true,
        startTime: Date.now(),
        truncated: false,
      }
      this.thinkingBlocks.set(key, block)
    }
    this.activeThinkingKey = key
    const available = Math.max(0, MAX_WEBVIEW_TEXT_CHARS - block.text.length)
    if (available > 0) block.text += delta.slice(0, available)
    if (delta.length > available) block.truncated = true
    this.callbacks.onThinking?.({ ...block })
  }

  private finishActiveThinking(): void {
    const key = this.activeThinkingKey
    if (!key) return
    this.activeThinkingKey = null
    const block = this.thinkingBlocks.get(key)
    if (!block || !block.streaming) return
    block.streaming = false
    block.durationMs = Math.max(0, Date.now() - block.startTime)
    this.callbacks.onThinking?.({ ...block })
  }

  private finishStreaming(): void {
    this.finishActiveThinking()
    const id = this.streamingId
    if (id === null) return
    this.streamingId = null

    const entry = this.entries.find(e => e.id === id)
    if (entry?.kind === 'assistant') entry.streaming = false

    this.callbacks.onComplete(id)
  }

  /**
   * Convert a finished engine message into transcript entries.
   *
   * ── SUPPRESSION IS PER BLOCK, NOT PER TURN ─────────────────────────────────────
   *
   * The engine emits streamed deltas AND the assembled message for the same content,
   * so the settled copy of anything already streamed must be skipped. The obvious
   * implementation — a turn-wide "did anything stream?" flag — is WRONG, and wrong in
   * a way that loses data: a turn legitimately contains several assistant messages
   * (prose, tool call, then a follow-up answer or summary), and a turn-wide flag
   * suppresses every one of them after the first.
   *
   * So the check is `(message.id, block index)`. Anthropic's `index` on a stream event
   * is the block's position in the final `content` array, which is exactly what makes
   * this correlation exact rather than heuristic. A block that was never streamed —
   * a summary the provider emitted whole, or content from a message with no deltas at
   * all — is rendered, because nothing has shown it yet.
   */
  private handleSettledMessage(message: Record<string, unknown>): void {
    // Settled messages and tool results are what actually grow the context window, so
    // this is the meaningful mid-turn trigger. Throttled — a long turn produces many.
    void this.pollContextUsage()

    const inner = message.message as Record<string, unknown> | undefined
    const messageId = typeof inner?.id === 'string' ? inner.id : null
    const streamed = messageId ? this.streamedBlocks.get(messageId) : undefined

    const blocks = formatActivityForVSCode([message as unknown as WrappedMessage])

    // `formatActivityForVSCode` drops blocks with no renderable content, so its
    // output indices do not track the wire array. The wire index is recovered by
    // walking the original content array in parallel.
    const wireBlocks = Array.isArray(inner?.content) ? inner.content : []
    const textIndices: number[] = []
    wireBlocks.forEach((b, i) => {
      const type = (b as Record<string, unknown> | null)?.type
      if (type === 'text') textIndices.push(i)
    })
    let textSeen = 0
    // A provider may persist a thinking block without having delivered partial
    // events (for example after reconnecting). Keep it with the immediately
    // following assistant text rather than rendering an orphaned empty turn.
    let settledThinkingEntryId: EntryId | null = null

    for (const block of blocks) {
      switch (block.kind) {
        case 'thinking': {
          const sourceId = this.streamingId ?? newId()
          if (!this.streamingId) {
            this.appendEntry({ id: sourceId, kind: 'assistant', text: '' })
            settledThinkingEntryId = sourceId
          }
          const key = `${sourceId}:${block.blockIndex}`
          if (!this.thinkingBlocks.has(key)) {
            const thinking: ThinkingEntryView = {
              entryId: `thinking-${sourceId}-${block.blockIndex}`,
              sourceMessageId: sourceId,
              blockIndex: block.blockIndex,
              text: block.text,
              streaming: false,
              startTime: Date.now(),
              durationMs: 0,
              truncated: block.text.includes('…[truncated '),
            }
            this.thinkingBlocks.set(key, thinking)
            this.callbacks.onThinking?.({ ...thinking })
          }
          break
        }
        case 'assistant': {
          const wireIndex = textIndices[textSeen++]
          // Skip ONLY if this exact block already reached the UI as deltas.
          if (
            streamed !== undefined &&
            wireIndex !== undefined &&
            streamed.has(wireIndex)
          ) {
            break
          }
          // Fallback dedup: if the block text matches the currently streaming
          // entry, it is the settled copy of what was already shown. This
          // covers providers that do not carry a stable message id on stream
          // events, where the (id, index) dedup above cannot match.
          if (this.streamingId) {
            const current = this.entries.find(e => e.id === this.streamingId)
            if (current?.kind === 'assistant' && current.text === block.text) {
              break
            }
          }
          if (settledThinkingEntryId) {
            const entry = this.entries.find(item => item.id === settledThinkingEntryId)
            if (entry?.kind === 'assistant') {
              entry.text = block.text
              this.emitEntry(entry)
            }
            settledThinkingEntryId = null
            break
          }
          // Not streamed: close any open stream so ordering reads correctly, then
          // render it. This is the path that preserves a post-tool-call summary.
          this.finishStreaming()
          this.appendEntry({ id: newId(), kind: 'assistant', text: block.text })
          break
        }
        case 'prompt':
          // Already appended locally when the user submitted. The engine replays
          // it, and appending again would show the prompt twice.
          break
        case 'tool_use':
          this.appendToolCall(block)
          break
        case 'tool_result':
          this.applyToolResult(block)
          break
      }
    }
  }

  /**
   * Populate the transcript from a stored session when resuming.
   *
   * ── WHY THIS IS NOT `applyBlocks` ───────────────────────────────────────────────
   *
   * The live path deliberately SKIPS `prompt` blocks, because the user's message was
   * already appended locally at submit time and the engine echoes it back. Restored
   * history was never appended locally, so skipping prompts here would show the
   * assistant's replies with nothing to reply to — a transcript of one side of a
   * conversation.
   *
   * Tool results are matched to their calls by `toolUseId` through the same
   * `applyToolResult`, so a restored tool pill shows its outcome rather than spinning.
   */
  // ── MIRRORING AN ATTACHED CLI SESSION ──────────────────────────────────────
  //
  // These render a DIFFERENT process's turn into this transcript. They deliberately do
  // not touch `turnRunning`: that flag governs whether THIS panel's engine is busy and
  // gates the composer's send button. An attached CLI turn must not disable the
  // composer, because the user can still type here — and conflating the two would leave
  // the composer stuck if the remote session never reports an end.

  /** An attached session began streaming an assistant turn. */
  beginMirroredTurn(): void {
    this.finishStreaming()
    this.mirrorId = newId()
    this.appendEntry({ id: this.mirrorId, kind: 'assistant', text: '' })
  }

  appendMirroredDelta(delta: string): void {
    if (!this.mirrorId) this.beginMirroredTurn()
    if (!this.mirrorId) return
    this.callbacks.onPartial(this.mirrorId, 'text', delta)
  }

  /**
   * The attached session is thinking.
   *
   * Content is never sent over this channel, so this can only be an indication — which is
   * why it is a notice rather than a thinking block with no text in it.
   */
  markMirroredThinking(): void {
    this.appendEntry({
      id: newId(),
      kind: 'notice',
      text: 'The attached session is thinking…',
      severity: 'info',
    })
  }

  endMirroredTurn(): void {
    if (this.mirrorId) this.callbacks.onComplete(this.mirrorId)
    this.mirrorId = null
  }

  /**
   * Render completed messages from an attached session.
   *
   * Goes through the SAME formatter as local output, so a mirrored turn is
   * indistinguishable from one this panel ran — tool pills included.
   */
  applyMirroredActivity(messages: unknown[]): void {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const blocks = formatMessageForVSCode(message as never)
      for (const block of blocks) {
        switch (block.kind) {
          case 'thinking': {
            const sourceId = this.mirrorId ?? newId()
            if (!this.mirrorId) {
              this.mirrorId = sourceId
              this.appendEntry({ id: sourceId, kind: 'assistant', text: '' })
            }
            const thinking: ThinkingEntryView = {
              entryId: `thinking-${sourceId}-${block.blockIndex}`,
              sourceMessageId: sourceId,
              blockIndex: block.blockIndex,
              text: block.text,
              streaming: false,
              startTime: Date.now(),
              durationMs: 0,
              truncated: block.text.includes('…[truncated '),
            }
            this.thinkingBlocks.set(`${sourceId}:${block.blockIndex}`, thinking)
            this.callbacks.onThinking?.({ ...thinking })
            break
          }
          case 'prompt':
            // Included, unlike the live path: a prompt typed in the TERMINAL was never
            // appended here, so skipping it would show replies with nothing to reply to.
            this.appendEntry({ id: newId(), kind: 'prompt', text: block.text })
            break
          case 'assistant':
            this.appendEntry({ id: newId(), kind: 'assistant', text: block.text })
            break
          case 'tool_use':
            this.appendToolCall(block)
            break
          case 'tool_result':
            this.applyToolResult(block)
            break
        }
      }
    }
  }

  /** Replace local task projection with the attached CLI owner's snapshot. */
  applyMirroredTaskSnapshot(tasks: BackgroundTaskView[], preserveCompleted = false): void {
    const preserved = preserveCompleted
      ? this.backgroundTasks.filter(task => isTerminalBackgroundStatus(task.status))
      : []
    this.backgroundTaskMap.clear()
    for (const task of preserved) this.backgroundTaskMap.set(task.key, task)
    for (const task of tasks) {
      if (!task || typeof task.key !== 'string' || typeof task.taskId !== 'string') continue
      this.backgroundTaskMap.set(task.key, task)
    }
    this.callbacks.onTaskStateReplaced?.([...this.backgroundTasks])
    for (const sourceSessionId of new Set(tasks.map(task => task.sourceSessionId))) {
      this.persistTaskHistory(sourceSessionId)
    }
  }

  /** Apply one shared SDK lifecycle event forwarded by an attached CLI. */
  applyMirroredTaskEvent(event: Record<string, unknown>): void {
    this.handleTaskLifecycle(event)
  }

  restoreTranscript(blocks: VSCodeActivityBlock[]): void {
    let thinkingSourceId: EntryId | null = null
    for (const block of blocks) {
      switch (block.kind) {
        case 'thinking': {
          if (!thinkingSourceId) {
            thinkingSourceId = newId()
            this.appendEntry({ id: thinkingSourceId, kind: 'assistant', text: '' })
          }
          const thinking: ThinkingEntryView = {
            entryId: `thinking-${thinkingSourceId}-${block.blockIndex}`,
            sourceMessageId: thinkingSourceId,
            blockIndex: block.blockIndex,
            text: block.text,
            streaming: false,
            startTime: Date.now(),
            durationMs: 0,
            truncated: block.text.includes('…[truncated '),
          }
          this.thinkingBlocks.set(`${thinkingSourceId}:${block.blockIndex}`, thinking)
          this.callbacks.onThinking?.({ ...thinking })
          break
        }
        case 'prompt':
          thinkingSourceId = null
          this.appendEntry({ id: newId(), kind: 'prompt', text: block.text })
          break
        case 'assistant':
          if (thinkingSourceId) {
            const entry = this.entries.find(item => item.id === thinkingSourceId)
            if (entry?.kind === 'assistant') {
              entry.text = block.text
              this.emitEntry(entry)
            }
            thinkingSourceId = null
          } else {
            this.appendEntry({ id: newId(), kind: 'assistant', text: block.text })
          }
          break
        case 'tool_use':
          thinkingSourceId = null
          this.appendToolCall(block)
          break
        case 'tool_result':
          this.applyToolResult(block)
          break
      }
    }

    // A restored pill whose result never made it into the file — the session was killed
    // mid-tool — would otherwise sit on 'running' forever in a session that is not
    // running anything.
    this.settleUnfinishedRestoredTools()
  }

  /**
   * Mark still-'running' restored tool pills as interrupted.
   *
   * Only safe for RESTORED history: nothing from a stored session is still executing.
   * Applying this to a live session would falsely settle a tool that is genuinely working.
   */
  private settleUnfinishedRestoredTools(): void {
    for (const entry of this.entries) {
      if (entry.kind === 'tool' && entry.status === 'running') {
        entry.status = 'error'
        entry.output = 'This tool did not finish before the session ended.'
        // emitEntry is an upsert — the reducer replaces by id.
        this.emitEntry(entry)
      }
    }
  }

  private appendToolCall(
    block: Extract<VSCodeActivityBlock, { kind: 'tool_use' }>,
  ): void {
    // A tool call arriving means the assistant's prose for this step is done, so the
    // stream is closed before the pill so ordering reads correctly.
    this.finishStreaming()

    const phase = phaseForTool(block.name)
    this.updateTurnProgress(phase, labelForPhase(phase), block.name, block.label || undefined)

    const id = newId()
    if (block.toolUseId) this.toolsByUseId.set(block.toolUseId, id)
    const agent = this.agentLabelFor(block.parentToolUseId)

    this.appendEntry({
      id,
      kind: 'tool',
      toolUseId: block.toolUseId,
      name: block.name,
      label: block.label,
      parameters: block.parameters,
      status: 'running',
      output: null,
      startedAt: Date.now(),
      ...(agent && { agent }),
      ...(block.questions && { questions: block.questions }),
      ...(block.todos && { todos: block.todos }),
    })
  }

  /**
   * Name the subagent a call belongs to, from the `Task` call that spawned it.
   *
   * Resolved from the transcript rather than carried on the wire because the engine only
   * reports the parent's ID: the readable name — `Task` plus its own one-line label, e.g.
   * `Task · review the diff` — exists only in the entry this session already recorded.
   *
   * Returns undefined for a main-thread call, and for a parent that is not in the
   * transcript (possible when resuming a session whose head was trimmed). A missing badge
   * is a smaller loss than a badge naming an id the user cannot connect to anything.
   */
  private agentLabelFor(parentToolUseId: string | null): string | undefined {
    if (!parentToolUseId) return undefined
    const parentEntryId = this.toolsByUseId.get(parentToolUseId)
    const parent = parentEntryId
      ? this.entries.find(entry => entry.id === parentEntryId)
      : undefined
    if (!parent || parent.kind !== 'tool') return `Subagent`
    return parent.label ? `${parent.name} · ${parent.label}` : parent.name
  }

  /** Record answers in the tool entry without placing raw question JSON in the UI. */
  recordQuestionAnswers(
    toolUseId: string | undefined,
    answers: Record<string, string>,
  ): void {
    if (!toolUseId) return
    const entryId = this.toolsByUseId.get(toolUseId)
    const entry = entryId ? this.entries.find(item => item.id === entryId) : undefined
    if (!entry || entry.kind !== 'tool' || !entry.questions) return
    entry.questionAnswers = { ...answers }
    this.emitEntry(entry)
  }

  /**
   * A tool is still working.
   *
   * ── A LIVENESS SIGNAL, NOT THE CLOCK ──────────────────────────────────────────
   *
   * The engine emits `tool_progress` on its own cadence, which is neither once a second
   * nor uniform across tools. Driving the pill's timer from it would make the displayed
   * duration advance in jumps and stall whenever the engine was busy. The webview counts
   * from the entry's `startedAt` instead; see that field's comment.
   *
   * What this frame is genuinely good for is the TURN STATUS LINE. A turn whose only
   * activity is one long tool otherwise shows a phase resolved when the call started and
   * then nothing, so a 4-minute `Bash` looks identical to a wedged engine. Refreshing the
   * phase here keeps "Running npm test" accurate for as long as it is true — and, because
   * the frame stops arriving when the tool stops, its absence is meaningful too.
   *
   * The ENTRY IS NOT RE-EMITTED. Nothing the webview renders from it has changed, and a
   * `postMessage` per frame per tool is exactly the cost this design avoids.
   */
  private handleToolProgress(message: Record<string, unknown>): void {
    const toolUseId =
      typeof message.tool_use_id === 'string' ? message.tool_use_id : null
    if (!toolUseId) return

    const entryId = this.toolsByUseId.get(toolUseId)
    // Unknown id: a tool from a turn this session did not record, or one whose call frame
    // has not arrived yet. Nothing to attribute it to, so it is dropped rather than
    // guessed at — attaching it to the newest running pill, as `applyToolResult` may do
    // for a RESULT, would put one tool's progress on another tool's row.
    if (!entryId) return
    const entry = this.entries.find(item => item.id === entryId)
    if (!entry || entry.kind !== 'tool') return
    // Monotonic, as everywhere else: a frame that overtakes its own result must not
    // reopen a settled call. Mirrors the terminal-status guard in `handleTaskLifecycle`.
    if (entry.status !== 'running') return

    const phase = phaseForTool(entry.name)
    this.updateTurnProgress(
      phase,
      labelForPhase(phase),
      entry.name,
      entry.label || undefined,
    )
  }

  /**
   * Project one hook execution into a single, updated-in-place transcript entry.
   *
   * ── KEYED ON `hook_id`, NEVER APPENDED ─────────────────────────────────────────
   *
   * `startHookProgressInterval` emits a frame roughly every second for as long as the
   * hook runs, so appending would produce a row per second. The first frame creates the
   * entry and every later one replaces it.
   *
   * ── stdout/stderr ARE CUMULATIVE, SO THEY ARE REPLACED ─────────────────────────
   *
   * Each progress frame re-reads the hook's ENTIRE accumulated output and sends it whole
   * (see `emitHookProgress`'s caller, which diffs against the last emission). Appending
   * would repeat everything already shown on every tick.
   *
   * ── A RESPONSE WITH NO START STILL RENDERS ─────────────────────────────────────
   *
   * The engine only emits lifecycle frames while stream-json output is enabled, so a hook
   * that began before this session attached reports only its response. Requiring a
   * `hook_started` would silently drop exactly the frame that carries the outcome.
   */
  private handleHookLifecycle(message: Record<string, unknown>): void {
    const hookId = typeof message.hook_id === 'string' ? message.hook_id : ''
    if (!hookId) return

    const subtype = message.subtype
    const existingId = this.hooksByHookId.get(hookId)
    const existing = existingId
      ? this.entries.find(item => item.id === existingId)
      : undefined
    const current = existing?.kind === 'hook' ? existing : undefined

    // Monotonic, as everywhere else: a progress frame that overtakes the response must
    // not reopen a hook that has already reported its outcome.
    if (current && current.status !== 'running' && subtype !== 'hook_response') return

    const status: HookEntryStatus =
      subtype === 'hook_response' ? hookOutcomeStatus(message.outcome) : 'running'

    if (current) {
      current.status = status
      current.stdout = clamp(asString(message.stdout) ?? current.stdout)
      current.stderr = clamp(asString(message.stderr) ?? current.stderr)
      if (typeof message.exit_code === 'number') current.exitCode = message.exit_code
      this.emitEntry(current)
      return
    }

    const id = newId()
    this.hooksByHookId.set(hookId, id)
    this.appendEntry({
      id,
      kind: 'hook',
      hookId,
      name: asString(message.hook_name) || 'hook',
      event: asString(message.hook_event) || 'hook',
      status,
      ...(typeof message.exit_code === 'number' ? { exitCode: message.exit_code } : {}),
      stdout: clamp(asString(message.stdout) ?? ''),
      stderr: clamp(asString(message.stderr) ?? ''),
    })
  }

  /**
   * The engine's own statement of whether it is working.
   *
   * ── THE AUTHORITATIVE TURN-OVER SIGNAL ─────────────────────────────────────────
   *
   * `sdkEventQueue.ts` emits this specifically so SDK consumers — it names VS Code —
   * can tell an idle generator from a producing one, and it was never consumed here.
   * Turn state was inferred from the `result` frame alone, so anything that ended a turn
   * WITHOUT one left the composer showing Stop with no way back except a new session.
   * `idle` is documented as firing after the held-back result flushes and the background
   * agent loop exits, which makes it the last word rather than a hint.
   *
   * ── THE `result` PATH REMAINS, AS A FALLBACK ───────────────────────────────────
   *
   * It is not replaced. An older engine may not emit this frame at all, and the `result`
   * frame carries the authoritative `duration_ms` and usage that this one does not. Both
   * call `completeTurn`, which is idempotent per turn — the first to arrive records the
   * completion and the second is a no-op — so the two cannot disagree or double-count.
   *
   * ── `requires_action` IS NOT IDLE ──────────────────────────────────────────────
   *
   * The turn is still open and will resume once answered, so the composer must stay in
   * Stop mode. It becomes the `waiting` phase, which is what `isWaitingPhase` uses to
   * show a STATIC glyph: an animated spinner would promise progress that cannot happen
   * until the user does something.
   */
  private handleSessionStateChanged(message: Record<string, unknown>): void {
    switch (message.state) {
      case 'running':
        this.setTurnRunning(true)
        return

      case 'requires_action':
        // Deliberately does not touch turn state. Blocked is a kind of running.
        this.updateTurnProgress('waiting', 'Waiting for input')
        return

      case 'idle': {
        if (!this.turnRunning) return
        this.finishStreaming()
        this.flushPendingReview()
        // No `message` argument: this frame carries neither a duration nor usage, so
        // `completeTurn` falls back to its own wall-clock measurement and the usage it
        // accumulated while streaming. When a `result` already arrived, its authoritative
        // figures are already recorded and this call returns immediately.
        this.completeTurn('completed')
        this.setTurnRunning(false)
        void this.pollContextUsage()
        return
      }

      default:
        return
    }
  }

  /**
   * A running tool's output so far.
   *
   * ── THE STREAM IS REPLACED, NEVER APPENDED ─────────────────────────────────────
   *
   * `text` is a cumulative snapshot of the bounded tail the tool computes for its own
   * display, not an incremental chunk — see `SDKToolOutputMessageSchema`. So each frame
   * REPLACES the pill's body. That is what makes a dropped or duplicated frame harmless,
   * and it is why the body cannot grow without bound however chatty the command is.
   *
   * ── AND THE SETTLED RESULT REPLACES THE STREAM ─────────────────────────────────
   *
   * `applyToolResult` assigns `entry.output` outright, so the authoritative result
   * overwrites whatever was streamed rather than being appended to it. Appending is the
   * single most likely bug here and it renders a command's output twice — the same trap
   * `appendPartial` versus `addMessage` exists to avoid for assistant text.
   *
   * Streamed output is deliberately NOT retained for on-demand expansion: it is a tail
   * by construction, so there is no withheld remainder to fetch. `truncatedChars` stays
   * unset until the settled result arrives with the full text.
   */
  private handleToolOutput(message: Record<string, unknown>): void {
    const toolUseId =
      typeof message.tool_use_id === 'string' ? message.tool_use_id : null
    const text = asString(message.text)
    if (!toolUseId || text === undefined) return

    const entryId = this.toolsByUseId.get(toolUseId)
    // Unknown id: dropped rather than attached to the newest running pill. A result may
    // legitimately fall back to that, because exactly one tool can be awaiting one; a
    // stream frame cannot, since several tools can be running and guessing would show one
    // command's output under another's name.
    if (!entryId) return
    const entry = this.entries.find(item => item.id === entryId)
    if (!entry || entry.kind !== 'tool') return
    // Monotonic: a frame that overtakes the result must not overwrite the real output
    // with a stale tail.
    if (entry.status !== 'running') return

    entry.output = clamp(text)
    this.callbacks.onToolOutput?.(entry.id, entry.output)

    // Keep the status line naming this tool for as long as it is actually working. This
    // is the signal `tool_progress` was meant to provide and cannot, being gated to
    // remote sessions — see `handleToolProgress`.
    const phase = phaseForTool(entry.name)
    this.updateTurnProgress(
      phase,
      labelForPhase(phase),
      entry.name,
      entry.label || undefined,
    )
  }

  private applyToolResult(
    block: Extract<VSCodeActivityBlock, { kind: 'tool_result' }>,
  ): void {
    const entryId = block.toolUseId
      ? this.toolsByUseId.get(block.toolUseId)
      : undefined

    const entry = entryId
      ? this.entries.find(e => e.id === entryId)
      : // No correlation id: attach to the most recent still-running pill. Better
        // than dropping the result, which would leave a tool spinning forever.
        [...this.entries].reverse().find(e => e.kind === 'tool' && e.status === 'running')

    if (!entry || entry.kind !== 'tool') return

    entry.status = block.isError ? 'error' : 'done'
    // Structured tools own their result presentation. Their generic result is a
    // sentence generated from the same data and would duplicate the dedicated card.
    const structured = entry.questions || (entry.todos && !block.isError)
    entry.output = structured ? null : block.text
    if (!structured && block.truncatedChars > 0 && block.fullText) {
      entry.outputTruncatedChars = block.truncatedChars
      this.retainToolOutput(entry.id, block.fullText)
    }
    if (block.toolResult) entry.toolResult = block.toolResult
    // Re-emitting the entry is how the webview learns it changed; the reducer
    // replaces by id, so this is an update rather than a duplicate.
    this.emitEntry(entry)
    this.updateTurnProgress('requesting', 'Waiting for response')
  }

  /** Store one untruncated result, evicting oldest entries to stay within the cap. */
  private retainToolOutput(id: EntryId, text: string): void {
    // A result larger than the entire budget is not worth evicting everything else for.
    // The row keeps its truncated body and simply offers no expansion.
    if (text.length > MAX_RETAINED_OUTPUT_CHARS) return

    const existing = this.retainedToolOutput.get(id)
    if (existing !== undefined) this.retainedOutputChars -= existing.length
    this.retainedToolOutput.set(id, text)
    this.retainedOutputChars += text.length

    for (const [oldest, value] of this.retainedToolOutput) {
      if (this.retainedOutputChars <= MAX_RETAINED_OUTPUT_CHARS) break
      // Never evict the entry just added; it is the one most likely to be asked for.
      if (oldest === id) continue
      this.retainedToolOutput.delete(oldest)
      this.retainedOutputChars -= value.length
    }
  }

  /**
   * The untruncated output for one row, or null when it is no longer held.
   *
   * Null is a legitimate answer — see the retention cap — and the caller reports it as
   * such. Returning the truncated text instead would silently answer a different
   * question than the one asked.
   */
  fullToolOutput(id: EntryId): string | null {
    return this.retainedToolOutput.get(id) ?? null
  }

  private handleInboundRequest(request: InboundControlRequest): void {
    if (request.subtype === 'can_use_tool') {
      this.updateTurnProgress('waiting', 'Waiting for approval')
      this.callbacks.onPermissionRequest(request)
      return
    }
    // `hook_callback` and `elicitation` have no UI yet. They are REFUSED rather
    // than ignored: the engine blocks until answered, so silence would hang the
    // turn with no indication why.
    this.control?.respondError(
      request.requestId,
      `Rayucode does not support "${request.subtype}" yet.`,
    )
  }

  /** The control client, for Task 7's permission responses. */
  get controlClient(): ControlClient | null {
    return this.control
  }

  /**
   * Poll current context window usage from the engine.
   *
   * Run once after a turn completes, never token-by-token during streaming.
   */
  async pollContextUsage(force = false): Promise<ContextUsageView | null> {
    if (!this.control || this.disposed) return null
    // One request at a time. Without this a burst of triggers queues requests that
    // resolve out of order, and the last to land wins regardless of which was freshest.
    if (this.contextInFlight) return null

    const now = Date.now()
    // The throttle applies only MID-TURN. Boundary refreshes — init, resume, model
    // change, compaction, completion — are the ones worth having promptly.
    if (
      !force &&
      this.turnRunning &&
      now - this.contextLastFetch < MIN_CONTEXT_INTERVAL_MS
    ) {
      return null
    }

    const generation = this.generation
    this.contextInFlight = true
    this.contextLastFetch = now

    try {
      const resp = await this.control.request('get_context_usage', {}, 10_000)
      // The session was replaced or disposed while this was in flight. Applying it
      // would show the previous conversation's usage against the new one.
      if (generation !== this.generation || this.disposed) return null

      if (typeof resp.percentage === 'number') {
        this.lastContextUsage = {
          percentage: resp.percentage,
          totalTokens:
            typeof resp.totalTokens === 'number' ? resp.totalTokens : undefined,
          maxTokens:
            typeof resp.rawMaxTokens === 'number' ? resp.rawMaxTokens : typeof resp.maxTokens === 'number' ? resp.maxTokens : undefined,
          stale: false,
        }
        this.callbacks.onContextUsage?.(this.lastContextUsage)
        return this.lastContextUsage
      }
    } catch {
      // Unavailable rather than zero. A reading of 0% would be a confident lie; marking
      // the last known value stale says "this was true a moment ago" instead.
      if (generation === this.generation && this.lastContextUsage) {
        this.lastContextUsage = { ...this.lastContextUsage, stale: true }
        this.callbacks.onContextUsage?.(this.lastContextUsage)
      }
    } finally {
      this.contextInFlight = false
    }
    return null
  }

  /**
   * Fetch connected MCP servers status.
   */
  async getMcpStatus(): Promise<McpServerView[]> {
    if (!this.control) return []
    try {
      const resp = await this.control.request('mcp_status', {}, 10_000)
      const raw = Array.isArray(resp.mcpServers) ? resp.mcpServers : []
      this.mcpServersList = raw
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map(s => ({
          name: typeof s.name === 'string' ? s.name : '',
          status: (typeof s.status === 'string'
            ? s.status
            : 'disconnected') as McpServerView['status'],
          error: typeof s.error === 'string' ? s.error : undefined,
        }))
        .filter(s => s.name.length > 0)
      this.callbacks.onMcpServers?.(this.mcpServersList)
      return this.mcpServersList
    } catch {
      return []
    }
  }

  /**
   * Enable or disable an MCP server.
   */
  async toggleMcpServer(serverName: string, enabled: boolean): Promise<boolean> {
    if (!this.control) return false
    try {
      await this.control.request('mcp_toggle', { serverName, enabled }, 10_000)
      await this.getMcpStatus()
      return true
    } catch (cause) {
      this.callbacks.onError(
        `Failed to toggle MCP server ${serverName}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
      return false
    }
  }

  /**
   * Reconnect a failed or disconnected MCP server.
   *
   * A failure surfaces an error notice rather than silently no-oping.
   */
  async reconnectMcpServer(serverName: string): Promise<boolean> {
    if (!this.control) return false
    try {
      await this.control.request('mcp_reconnect', { serverName }, 15_000)
      await this.getMcpStatus()
      return true
    } catch (cause) {
      this.callbacks.onError(
        `Failed to reconnect MCP server ${serverName}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
      return false
    }
  }

  // ── transcript bookkeeping ─────────────────────────────────────────────────

  private appendEntry(entry: TranscriptEntry): void {
    this.entries.push(entry)
    this.lastEntryAt = Date.now()
    this.emitEntry(entry)
  }

  /**
   * Record a failure IN THE TRANSCRIPT, then alert whoever else needs to know.
   *
   * ── AN ERROR HAS A POSITION IN THE CONVERSATION ────────────────────────────────
   *
   * Errors used to travel only as `showError`, which the webview accumulated in a
   * separate `notices` array and rendered AFTER every transcript block. So a provider
   * failure during turn 2 appeared below turn 9, detached from the request that caused
   * it and from the tool calls that surrounded it. The `notice` entry kind already
   * existed and `TranscriptEntryView` already dispatched it — the error path simply did
   * not use it.
   *
   * `onError` is still called, because a transcript entry only helps a user who is
   * READING that transcript. See the callback's own comment for the background case.
   */
  private reportError(message: string): void {
    // Close any open streaming entry first, so the failure reads as having happened
    // after the partial answer rather than interleaved with it.
    this.finishStreaming()
    this.appendEntry({
      id: newId(),
      kind: 'notice',
      severity: 'error',
      text: message,
    })
    this.callbacks.onError(message)
  }

  /**
   * Hand an entry to the UI as a COPY.
   *
   * The host keeps mutable entries — a tool pill gains a status and output, a
   * streaming answer gains text — and it must never hand out a reference it will
   * later mutate. In production `postMessage` structure-clones, so aliasing would be
   * invisible; in-process it silently shares the object, and a consumer that also
   * applies the delta would double it. Copying here makes the boundary behave the
   * same either way, which is also what makes it testable in-process.
   */
  private emitEntry(entry: TranscriptEntry): void {
    this.callbacks.onEntry({ ...entry })
  }

  private setTurnRunning(running: boolean): void {
    // A finished turn is a boundary worth a prompt, unthrottled reading.
    if (this.turnRunning && !running) void this.pollContextUsage(true)
    // Reset per-turn streaming bookkeeping on the RISING edge. Doing it on submit
    // instead would miss a turn the engine starts on its own.
    //
    // The correlation map is cleared here rather than accumulated across the session:
    // message ids are unique per turn, so keeping them would grow without bound for
    // no benefit.
    if (running && !this.turnRunning) {
      this.streamedBlocks.clear()
      this.currentStreamMessageId = null
      this.currentStreamBlockIndex = null
      this.currentStreamBlockType = null
      // `file_change_review` is a cumulative pending-change snapshot. Keep the live
      // card identity across turns so /keep and /undo update that card in place — but
      // `flushPendingReview` re-anchors it under this turn's response when the turn ends,
      // so it is never left behind under an older answer. The empty snapshot clears the
      // identity; a later independent review then gets a fresh card.
      this.pendingReview = null
      // Freeze what was already on record: everything the coming turn reports beyond this
      // is its own work. Captured here rather than per snapshot so the flags survive the
      // keeps and undos that follow the turn.
      this.reviewBaselineChangeIds = new Set(this.reviewKnownChangeIds)
      this.turnStartedAt = Date.now()
      this.turnStreamedChars = 0
      this.activeTurnId = newId()
      this.turnProgress = {
        turnId: this.activeTurnId,
        phase: 'starting',
        label: 'Starting Rayu',
        startTimestamp: this.turnStartedAt,
        usage: emptyTurnUsage(),
      }
      this.callbacks.onTurnProgress?.({
        ...this.turnProgress,
        usage: { ...this.turnProgress.usage },
      })
      this.retryNoticeId = null
    }
    if (this.turnRunning === running) return
    this.turnRunning = running
    this.callbacks.onTurnState(running)
  }
}

function newId(): EntryId {
  return randomUUID()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

/** A string field from an untrusted frame, or undefined when it is any other type. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The status wording a hook entry carries. Kept in step with the protocol's union. */
type HookEntryStatus = Extract<TranscriptEntry, { kind: 'hook' }>['status']

/** The review card entry, narrowed once so the host can carry it without re-narrowing. */
type ReviewEntry = Extract<TranscriptEntry, { kind: 'review' }>
/**
 * Map the engine's hook outcome onto the entry's status.
 *
 * `cancelled` is preserved rather than folded into `error`: the engine stopping a hook is
 * not the hook failing, and badging it as a failure would send the user looking for a bug
 * in their own script. An unrecognised outcome is treated as an error, because the one
 * thing worse than a wrong badge is a hook that silently reports success.
 */
function hookOutcomeStatus(outcome: unknown): HookEntryStatus {
  switch (outcome) {
    case 'success':
      return 'done'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'error'
  }
}

function finiteToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0
}

function emptyTurnUsage(): TurnTokenUsageView {
  return {
    inputTokens: 0,
    outputTokens: 0,
    inputEstimated: true,
    outputEstimated: true,
  }
}

function phaseForTool(name: string): TurnPhaseView {
  const lower = name.toLowerCase()
  if (lower.includes('read') || lower.includes('glob')) return 'reading'
  if (lower.includes('search') || lower.includes('grep') || lower.includes('web')) return 'searching'
  if (lower.includes('write') || lower.includes('edit') || lower.includes('patch')) return 'editing'
  return 'running'
}

function labelForPhase(phase: TurnPhaseView): string {
  switch (phase) {
    case 'reading': return 'Reading'
    case 'searching': return 'Searching'
    case 'editing': return 'Editing'
    case 'running': return 'Running tool'
    default: return 'Working'
  }
}

function normalizeTaskType(value: string | undefined): BackgroundTaskType {
  if (value === 'local_bash') return 'local_shell'
  switch (value) {
    case 'local_agent':
    case 'in_process_teammate':
    case 'local_shell':
    case 'remote_agent':
    case 'external_agent':
    case 'local_workflow':
    case 'monitor_mcp':
    case 'dream':
      return value
    default:
      return 'unknown'
  }
}

function taskGroup(type: BackgroundTaskType): BackgroundTaskView['group'] {
  switch (type) {
    case 'local_agent':
    case 'in_process_teammate':
      return 'agents'
    case 'local_shell':
      return 'shells'
    case 'local_workflow':
      return 'workflows'
    case 'remote_agent':
    case 'external_agent':
      return 'remote'
    case 'monitor_mcp':
      return 'monitors'
    default:
      return 'other'
  }
}

function taskCapabilities(
  type: BackgroundTaskType,
  running: boolean,
): BackgroundTaskView['capabilities'] {
  const agent = type === 'local_agent' || type === 'in_process_teammate'
  return {
    canStop: running,
    // Follow-up routing requires the execution owner's live task store. The standalone
    // engine does not expose that operation yet, so do not render a control that lies.
    canSendMessage: false,
    hasTranscript: agent,
    hasOutput: type === 'local_shell' || type === 'monitor_mcp' || type === 'local_workflow',
  }
}

function isTerminalBackgroundStatus(status: BackgroundTaskView['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped'
}

function appendTaskActivity(
  existing: BackgroundTaskView['recentActivities'],
  next: BackgroundTaskView['recentActivities'][number],
): BackgroundTaskView['recentActivities'] {
  const last = existing[existing.length - 1]
  if (last?.label === next.label && last.toolName === next.toolName) {
    return [...existing.slice(0, -1), next].slice(-8)
  }
  return [...existing, next].slice(-8)
}

function normalizeWorkflowProgress(
  value: unknown,
): BackgroundTaskView['workflowProgress'] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.flatMap(item => {
    const record = asRecord(item)
    if (!record) return []
    const label =
      typeof record.label === 'string'
        ? record.label
        : typeof record.name === 'string'
          ? record.name
          : typeof record.description === 'string'
            ? record.description
            : ''
    if (!label) return []
    return [{
      label,
      status: typeof record.status === 'string' ? record.status : undefined,
      detail: typeof record.detail === 'string' ? record.detail : undefined,
    }]
  })
  return items.length > 0 ? items : undefined
}

function compareBackgroundTasks(a: BackgroundTaskView, b: BackgroundTaskView): number {
  const aActive = isTerminalBackgroundStatus(a.status) ? 1 : 0
  const bActive = isTerminalBackgroundStatus(b.status) ? 1 : 0
  return aActive - bActive || b.updatedAt - a.updatedAt
}

