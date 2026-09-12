/**
 * The host ↔ webview message contract.
 *
 * Imported by BOTH sides — `host/panel/chatViewProvider.ts` and the webview — so
 * the two cannot disagree about a payload. They are compiled into different bundles
 * for different targets (Node CJS and browser ESM), which means a mismatch here
 * would not be a link error; it would be a message that silently does nothing.
 * Sharing the types is what turns that class of bug into a compile error.
 *
 * ── THIS FILE MUST STAY TYPE-ONLY AND DEPENDENCY-FREE ──────────────────────────
 *
 * It is the one module both targets import. A value import here — anything from
 * `node:*`, from `vscode`, or from the wider `src/` tree — would be pulled into the
 * BROWSER bundle, where none of it exists. Interfaces and string-literal unions
 * only.
 *
 * ── WHY THE WIRE TYPES ARE NOT REUSED DIRECTLY ─────────────────────────────────
 *
 * The engine's protocol (`src/protocol/`) describes what crosses the engine's
 * stdin/stdout. This describes what crosses `postMessage`. They are different
 * boundaries with different audiences: the webview never sees a `request_id`, and
 * the engine never hears about a collapsed tool pill. Forwarding raw engine frames
 * to the webview would make the UI a second protocol consumer and put schema
 * validation in the browser.
 */

import type {
  EffortChoice,
  InferenceSettingsView,
} from './inferenceSettings.js'
import type { TodoItem } from '../../utils/todo/types.js'

/** Stable id for a transcript entry, assigned by the host. */
export type EntryId = string

/**
 * The TodoWrite item sent across the host/webview boundary.
 *
 * This is derived from the shared engine type instead of restating the fields, so a
 * TodoWrite schema change cannot silently leave the Rayucode card on an old shape.
 * The import is type-only and is erased from the browser bundle.
 */
export type TodoItemView = Pick<TodoItem, 'content' | 'status' | 'activeForm'>

/**
 * What the engine is doing right now, as one stable label per state.
 *
 * ── STABLE PHASES, NOT ROTATING VERBS ──────────────────────────────────────────
 *
 * An earlier version of the panel picked a random present-tense verb ("Cooking",
 * "Brewing") per turn. That reads as playful once and as noise every time after, and
 * it actively hides information: "Cooking" is the same word whether the engine is
 * waiting on a provider, editing a file, or blocked on an approval. These phases are
 * derived from the engine's own stream events by the host, so the label always says
 * which of those is true.
 *
 * The `waiting` phase is the one that matters most: it means the engine is BLOCKED on
 * the user, and a spinner that keeps claiming "working" while nothing can progress is
 * a bug the user cannot diagnose.
 */
export type TurnPhaseView =
  | 'starting'
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'

/**
 * Token counts for one turn, with their provenance.
 *
 * ── `↑` IS INPUT AND `↓` IS OUTPUT — NOT FILESYSTEM READS AND WRITES ───────────
 *
 * `inputTokens` is everything sent TO the provider and `outputTokens` is everything
 * received FROM it. The arrows in the UI mean exactly that. They must never be
 * relabelled as reads and writes, which is a plausible-looking misreading that would
 * make the numbers meaningless.
 *
 * ── INPUT INCLUDES CACHE TOKENS; OUTPUT DOES NOT ───────────────────────────────
 *
 * `inputTokens` is the SUM of direct input, cache-creation input and cache-read
 * input, because all three were sent as part of the request. The two cache figures
 * are also carried separately so the tooltip can break the total down, but adding
 * them to the output side would double-count.
 *
 * ── THE `Estimated` FLAGS EXIST BECAUSE A CONFIDENT WRONG NUMBER IS WORSE ──────
 *
 * Not every provider reports live output usage mid-stream. When it does not, the host
 * estimates from streamed characters using the CLI's own four-characters-per-token
 * fallback and sets the flag, so the UI can mark the figure with `~`. At completion
 * the authoritative `result` usage replaces the estimate and the flags clear. Showing
 * an unmarked estimate would present a guess as a measurement.
 */
export interface TurnTokenUsageView {
  /** Direct + cache-creation + cache-read input. See the note above. */
  inputTokens: number
  /** Provider-reported output, including reasoning tokens where it bills them as output. */
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** True while `inputTokens` has not been reported by the provider. */
  inputEstimated: boolean
  /** True while `outputTokens` is the chars/4 estimate rather than a reported count. */
  outputEstimated: boolean
}

/**
 * Live progress for the turn in flight.
 *
 * ── THE HOST OWNS `startTimestamp`; THE WEBVIEW OWNS THE TICK ──────────────────
 *
 * Elapsed time is rendered by counting from `startTimestamp` with a local one-second
 * interval. The alternative — the host sending an updated elapsed value every second
 * — would be one `postMessage` per second per panel for information the webview can
 * derive, and it would restart the clock on every webview re-creation. Carrying the
 * start instant instead means a re-created panel resumes the same count.
 */
export interface TurnProgressView {
  /** Correlates with the `turnCompleted` entry that eventually replaces this. */
  turnId: string
  phase: TurnPhaseView
  /** Host-resolved wording for `phase`, e.g. "Waiting for approval". */
  label: string
  /** Epoch ms the turn began. The webview counts from this; see above. */
  startTimestamp: number
  /** Tool being run, when the phase came from a tool call. */
  toolName?: string
  /** That tool's one-line label — the path, the command. */
  toolLabel?: string
  usage: TurnTokenUsageView
}

/**
 * One provider-supplied thinking block.
 *
 * ── ONLY WHAT THE PROVIDER EXPLICITLY STREAMED ─────────────────────────────────
 *
 * `text` contains provider-supplied thinking and nothing else. Opaque
 * `redacted_thinking` payloads, block signatures, internal prompts and hidden system
 * reasoning are never placed here — they are not the model's visible reasoning, and
 * some of them are not the user's to see.
 *
 * ── CORRELATION IS `(sourceMessageId, blockIndex)`, NOT ORDER OF ARRIVAL ───────
 *
 * A turn can contain several thinking blocks, and the same block arrives twice: once
 * as live deltas and again inside the settled message. Keying on the source entry
 * plus the block's position in the message's content array is what lets the second
 * copy be recognised and dropped instead of rendered again. `blockIndex` is
 * Anthropic's own `index` on the stream event, which is that position.
 */
export interface ThinkingEntryView {
  /** Stable id, `thinking-<sourceMessageId>-<blockIndex>`. */
  entryId: string
  /** The assistant entry this reasoning belongs in front of. */
  sourceMessageId: EntryId
  /** Position in the settled message's `content` array. See above. */
  blockIndex: number
  text: string
  /** True while deltas are still arriving. */
  streaming: boolean
  /** Epoch ms of the first delta, for the "Thought for Ns" duration. */
  startTime: number
  /** Set once `streaming` goes false. */
  durationMs?: number
  /** True when `text` hit the host's character bound and was cut. */
  truncated: boolean
}

/**
 * How a turn ended, kept per turn rather than as one global "last duration".
 *
 * A single latest-value field could only ever describe the most recent turn, so
 * scrolling back showed nothing for earlier ones. Keyed by `turnId` in the host's
 * snapshot, these survive webview re-creation and history restore.
 *
 * `durationMs` prefers the engine's own `duration_ms` from the `result` message and
 * falls back to host wall-clock only when that is absent or non-finite — the engine
 * measured the turn, the host merely observed it.
 */
export interface TurnCompletionEntry {
  outcome: 'completed' | 'failed' | 'stopped'
  durationMs: number
  /** Authoritative usage from the `result` message where it supplied one. */
  usage: TurnTokenUsageView
}

/**
 * An image the user attached in the composer.
 *
 * `data` is RAW base64 with no `data:` URL prefix — that is the shape Anthropic's
 * `image` content block takes, so stripping the prefix happens in the webview rather
 * than leaving every consumer to wonder which form it has.
 *
 * The media types are the four the API accepts. The host re-validates the type, the
 * count and the decoded size before any of this reaches the engine: this crosses a
 * boundary from a browser context, so it is untrusted input regardless of which of
 * our own code produced it.
 */
export interface ImageInputView {
  /** Original filename, used only for the transcript's `[Image: …]` marker. */
  name?: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  /** Raw base64, no data-URL prefix. */
  data: string
}

/**
 * A model chooser opened by a slash command.
 *
 * ── WHY THIS IS NOT A COMPOSER CONTROL ─────────────────────────────────────────
 *
 * The subagent and WebFetch models are set by `/model_subagent` and `/webfetch_model`, the
 * same commands the CLI uses. They are deliberately NOT given toolbar pills: they are rare,
 * per-project decisions, and a permanent control for each would crowd out the three that
 * are used every turn (permission mode, model, effort).
 *
 * ── HOST-OWNED, LIKE THE PROVIDER SETUP SURFACE ────────────────────────────────
 *
 * Carried in `WebviewState` rather than kept in local component state, so a webview that
 * VS Code re-creates while the chooser is open does not silently lose it — the same reason
 * `providerSetup` lives there.
 */
export interface ModelChooserView {
  /** Which setting a choice writes. Also selects the wording. */
  target: 'subagent' | 'webfetch'
  /** Set when scoping a subagent choice to one agent type, from `/model_subagent <AGENT>`. */
  agentType?: string
  title: string
  /** Cost guidance, carried through from the CLI command rather than reworded. */
  tip: string
  /** What is selected now, for the ✓ marker. Null when the default applies. */
  current: string | null
  /** Human description of what "default" means here, for the reset action. */
  defaultNote: string
}

/**
 * The editor's current file and selection, as the composer reports it.
 *
 * Mirrors what the CLI's own `IdeStatusIndicator` shows, from the same underlying data:
 * `⧉ N lines selected`, or `⧉ In <file>` when a file is open with nothing selected. The
 * wording is deliberately identical so the two surfaces describe the editor the same way.
 */
export interface IdeContextView {
  /** Absolute path of the active file, or null when no editor is active. */
  filePath: string | null
  /** Workspace-relative where possible — what an @-mention would use. */
  relativePath: string | null
  /** 0 when nothing is selected. */
  lineCount: number
  /** 1-based inclusive selection bounds, when there is a selection. */
  lineStart?: number
  lineEnd?: number
}

/** Messages the extension host sends TO the webview. */
export type HostToWebviewMessage =
  /**
   * Full state, sent in reply to `ready` and whenever the host needs to resync.
   *
   * The webview is re-created from scratch whenever VS Code disposes the view, and
   * it keeps no storage of its own, so "here is everything" has to be a message the
   * host can send at any time. It is also what the auth watcher re-sends when the
   * CLI signs in or out underneath us.
   */
  | { type: 'init'; state: WebviewState }
  /**
   * A SETTLED transcript entry — a finished message, not a fragment.
   *
   * Streaming text never arrives this way; see `appendPartial`. Sending a finished
   * assistant message here as well as streaming it is the single most likely bug in
   * a transcript UI, and it renders every answer twice.
   */
  | { type: 'addMessage'; entry: TranscriptEntry }
  /**
   * One streamed fragment of the assistant's current answer.
   *
   * `kind` separates visible prose from reasoning so the UI can style or collapse
   * thinking without the host having to decide.
   */
  | { type: 'appendPartial'; id: EntryId; kind: 'text' | 'thinking'; delta: string }
  /**
   * The streaming entry is finished. Carries no text: everything was already
   * delivered by `appendPartial`, and re-sending the assembled body here would let
   * the two disagree.
   */
  | { type: 'completeMessage'; id: EntryId }
  /** Turn boundary, so the composer can flip between send and stop. */
  | { type: 'turnState'; running: boolean }
  /**
   * Drop an entry from the transcript.
   *
   * The review card is the only entry that can stop existing: once every file is
   * kept or undone there is nothing to review, and an empty card would offer actions
   * that do nothing. Everything else is append- or update-only.
   */
  | { type: 'removeEntry'; id: EntryId }
  /** The active model and provider, for the composer toolbar. */
  | { type: 'setModelInfo'; info: ModelInfoView }
  /**
   * The models the composer dropdown can offer, plus its load state.
   *
   * Sent on `ready` from the shared config — so the control is usable BEFORE the first
   * prompt — and re-sent after `initialize` once the engine has reported its own
   * catalogue, which is authoritative for what the active provider can actually serve.
   */
  | { type: 'setModelCatalogue'; catalogue: ModelCatalogueView }
  /**
   * Thinking and effort, as ACKNOWLEDGED by the engine.
   *
   * Sent after a change has been applied, never on the optimistic path: a pill claiming
   * "High" while the engine is still on the model default would be worse than a pill
   * that updates a moment late.
   */
  | { type: 'setInferenceSettings'; settings: InferenceSettingsView }
  /** Provider setup surface state. Never carries a credential. */
  | { type: 'setProviderSetup'; setup: ProviderSetupView }
  /** Attachable CLI sessions and the current attachment. Never carries an IPC token. */
  | { type: 'setAttachment'; attachment: AttachmentView }
  /** The active permission mode, after the engine accepted a change. */
  | { type: 'setPermissionMode'; mode: PermissionModeView }
  /**
   * The engine is asking permission to run a tool and is BLOCKED until answered.
   *
   * Pinned above the composer rather than shown as a modal: the user needs to read
   * the transcript to decide, and a modal covers exactly that.
   */
  | { type: 'showPermissionRequest'; request: PermissionRequestView }
  /**
   * Remove a card that is no longer answerable — the engine withdrew it, the session
   * ended, or it was answered. NOT a denial: see permissionRouter.ts.
   */
  | { type: 'dismissPermissionRequest'; requestId: string }
  /**
   * A problem that has NO position in the visible transcript.
   *
   * ── ORDINARY ERRORS DO NOT COME THIS WAY ───────────────────────────────────────
   *
   * A failure inside a conversation is recorded by the host as a `notice` TRANSCRIPT
   * ENTRY, so it renders inline where it happened. Errors used to travel only through
   * this message, which the webview accumulated in a separate list rendered after every
   * block — so a failure during turn 2 appeared below turn 9, detached from the request
   * that caused it.
   *
   * What remains here is the residue that genuinely has nowhere else to go:
   *
   *   1. A BACKGROUND conversation failed. The entry is in that session's transcript,
   *      which the user is not looking at. See `SessionCallbacks.onError`.
   *   2. A PANEL-LEVEL failure with no session behind it — a drop the platform would
   *      not resolve, a switch to a conversation that has since closed, an image
   *      attachment refused while attached to a CLI session.
   *
   * Both are alerts about something outside the conversation on screen, which is why
   * rendering them outside it is correct rather than a compromise.
   */
  | { type: 'showError'; message: string }
  /** Available slash commands. */
  | { type: 'setCommands'; commands: SlashCommandView[] }
  /** Matching workspace files for @-mentions. */
  | { type: 'fileSearchResults'; query: string; files: string[] }
  /** Context usage percentage after a turn. */
  | { type: 'setContextUsage'; percentage: number; totalTokens?: number; maxTokens?: number; stale?: boolean }
  /** Connected MCP servers status. */
  | { type: 'setMcpServers'; servers: McpServerView[] }
  /**
   * The editor's current selection, or null when there is none.
   *
   * Sent so the composer can say what will be attached BEFORE the message is sent — the
   * engine attaches it automatically, and an invisible attachment is one the user cannot
   * account for when the answer talks about code they had forgotten was highlighted.
   *
   * A cleared selection is sent as `null` rather than simply not sent: the previous
   * indicator has to go away, and "no message" is indistinguishable from "unchanged".
   */
  | { type: 'setIdeContext'; context: IdeContextView | null }
  /**
   * Put text into the composer without sending it.
   *
   * Used by the terminal-selection command. Deliberately does NOT submit: the captured output
   * is context for a question the user has not written yet, and sending it alone would burn a
   * turn on "here is some output" with no request attached.
   */
  | { type: 'insertPrompt'; text: string }
  /** Previous sessions for project history, with load state. */
  | { type: 'setSessions'; list: SessionListView }
  /**
   * The conversations the panel currently holds open, and which one is on screen.
   *
   * Pushed on every change rather than fetched, because the interesting part is the RUNNING
   * flag: a background session finishing its turn has to update the list the user is looking
   * at, and there is nothing to poll for.
   */
  | { type: 'setLiveSessions'; sessions: LiveSessionView[]; activeKey: string }
  /**
   * Live progress for the turn in flight.
   *
   * Sent on every meaningful transition — phase change, usage update — and NOT on a
   * timer. Elapsed seconds are derived in the webview from `startTimestamp`, so a
   * long turn costs a handful of messages rather than one per second.
   */
  | { type: 'setTurnProgress'; progress: TurnProgressView }
  /**
   * A turn reached a terminal state, with its authoritative duration and usage.
   *
   * Keyed by `turnId` rather than replacing a single global value, so each turn in the
   * transcript keeps its own completion line.
   */
  | { type: 'turnCompleted'; turnId: string; completion: TurnCompletionEntry }
  /**
   * A thinking block was created, extended, or finished.
   *
   * Replace-by-`entryId`, not append: the same block is sent repeatedly as it grows,
   * and once more when it settles with its duration. Treating these as appends would
   * render the reasoning once per delta.
   */
  | { type: 'updateThinking'; thinking: ThinkingEntryView }
  /**
   * Workspace paths resolved from a drop or a file picker.
   *
   * `requestId` correlates the reply with the request that asked for it, because two
   * drops can be in flight and a resolution is asynchronous (a folder has to be
   * stat-ed, a remote URI has to go through VS Code). An empty `paths` means nothing
   * was accessible; the host has already reported that as an error.
   */
  | { type: 'contextPathsResolved'; requestId: string; paths: string[] }
  /** Open or close the command-driven model chooser. Null closes it. */
  | { type: 'setModelChooser'; chooser: ModelChooserView | null }
  /** Replace the task center from the execution owner's authoritative snapshot. */
  | { type: 'replaceTaskState'; tasks: BackgroundTaskView[]; supported: boolean; message?: string }
  /**
   * Live output for a tool that is still running.
   *
   * A thin message rather than a whole re-emitted entry: nothing else about the row has
   * changed, and a full `addMessage` per second per running tool is the cost this avoids.
   *
   * `text` REPLACES the row's body — it is a cumulative snapshot, not a chunk. See
   * `handleToolOutput` on the host and `SDKToolOutputMessageSchema` on the wire.
   */
  | { type: 'appendToolOutput'; id: EntryId; text: string }
  /** Insert or update one task without rebuilding the task center. */
  | { type: 'upsertTaskState'; task: BackgroundTaskView }
  /**
   * The untruncated output for one tool row, answering `requestToolOutput`.
   *
   * `text` is null when the host no longer holds it: retention is capped, so a very old
   * result may have been evicted. That is a real answer and the UI reports it — leaving
   * the request unanswered would be indistinguishable from a hung host, which is the same
   * reason `contextPathsResolved` is always sent.
   */
  | { type: 'toolOutputResolved'; requestId: string; text: string | null }
  /**
   * A background task's recorded output, answering `requestTaskOutput`.
   *
   * `text` is null when it could not be read at all — no engine to ask, or the request
   * failed — and `error` says which. An EMPTY string is a different answer: the task exists
   * and has recorded nothing yet, which the panel states rather than treating as a failure.
   */
  | {
      type: 'taskOutputResolved'
      requestId: string
      text: string | null
      truncated?: boolean
      error?: string
    }

/** An approval the user must grant or refuse before a tool runs. */
export interface PermissionRequestView {
  /** Correlates the answer with the engine's blocked request. */
  requestId: string
  /** Shared subagent identity, when the request originated below a task. */
  agentId?: string
  /** Display name where the engine gave one, else the raw tool name. */
  toolName: string
  /** One-line summary of what it would act on — the command, the path. */
  label: string
  /** Pretty-printed parameters, shown when the card is expanded. */
  parameters: string
  /** The engine's own description of the action, when it supplied one. */
  description: string | null
  /**
   * The path that could not be auto-approved.
   *
   * Usually the actual reason the engine had to ask — a file outside the workspace —
   * so it is surfaced rather than buried in the parameters.
   */
  blockedPath: string | null
  /** Why the engine could not decide by itself. */
  reason: string | null
  /** Whether to offer "Always allow" as well as a one-off approval. */
  canAlwaysAllow: boolean
  /** Present when the tool is AskUserQuestion and needs an answer form. */
  questionInteraction?: {
    questions: Array<{
      question: string
      header?: string
      options: Array<{
        label: string
        description?: string
        preview?: string
      }>
      multiSelect?: boolean
    }>
  }
}

/** Messages the webview sends TO the extension host. */
export type WebviewToHostMessage =
  /**
   * The React tree has mounted and is listening.
   *
   * Required because `postMessage` sent before the webview's listener is attached is
   * dropped with no error. The host must not push state until this arrives.
   */
  | { type: 'ready' }
  /**
   * Send a prompt. The host gates it before dispatching.
   *
   * `images` carries composer attachments as raw base64. It is validated host-side
   * before it reaches the engine — see `ImageInputView`.
   */
  | { type: 'submitPrompt'; text: string; images?: ImageInputView[] }
  /**
   * Stop the running turn.
   *
   * The host ACKS THIS UNCONDITIONALLY, even when there was nothing to stop. A
   * mistimed click — pressed just as the turn ended — must still re-enable the
   * composer, or the panel is stuck with a stop button and no way back.
   */
  | { type: 'interrupt' }
  /** Start a fresh session, discarding the transcript. */
  | { type: 'newSession' }
  /**
   * The user's answer to a permission card.
   *
   * `allow-always` records a lasting rule; `allow-once` applies to this call only.
   * The host maps these onto the engine's `decisionClassification`.
   */
  | {
      type: 'permissionResponse'
      requestId: string
      decision: 'allow-once' | 'allow-always' | 'deny'
    }
  /** Answers to an AskUserQuestion request, keyed by its exact question text. */
  | {
      type: 'questionResponse'
      requestId: string
      answers: Record<string, string>
      notes: Record<string, string>
    }
  /**
   * Apply a model choice made in the composer dropdown.
   *
   * Carries the value because the WEBVIEW owns the dropdown now — the host no longer
   * opens a QuickPick. The host persists it to the shared config and tells the engine.
   * This changes configuration only: it must never insert text into the composer.
   */
  | { type: 'selectModelValue'; value: string }
  /** Re-fetch the catalogue, for the dropdown's retry action. */
  | { type: 'refreshModelCatalogue' }
  /**
   * Choose an effort level. `null` is Auto.
   *
   * Applied through the CLI's own `/effort` command, which is what clears the RUNTIME
   * value as well as the persisted key and reports any environment override.
   */
  | { type: 'setEffort'; level: EffortChoice }
  /** Open or close the in-panel provider setup surface. */
  | { type: 'listAttachable' }
  | { type: 'attachToSession'; pid: number }
  | { type: 'detachFromSession' }
  | { type: 'providerSetupOpen'; open: boolean }
  /**
   * Verify a credential without saving it. The key crosses the webview boundary once,
   * here, and is never echoed back or stored in webview state.
   */
  | {
      type: 'providerSetupValidate'
      providerId: string
      apiKey?: string
      baseURL?: string
    }
  /** Persist the provider and switch the session onto it. */
  | {
      type: 'providerSetupSave'
      providerId: string
      apiKey?: string
      baseURL?: string
      model?: string
    }
  /**
   * Keep or undo reviewed file changes.
   *
   * `path` omitted means all files. These are dispatched as the engine's own `/keep`
   * and `/undo` slash commands rather than a bespoke control request: that is the
   * mechanism the CLI's review flow already uses, so both surfaces get identical
   * behaviour and there is one implementation of "what keeping a file means".
   */
  | { type: 'reviewKeep'; path?: string }
  | { type: 'reviewUndo'; path?: string }
  /** Show a changed file's diff against its state before the turn. */
  | { type: 'openReviewDiff'; path: string }
  /** Open a changed file in an editor. */
  | { type: 'openFile'; path: string }
  /**
   * Advance to the next permission mode.
   *
   * A cycle rather than a value, because the control is Shift+Tab: the webview knows
   * the user asked for "the next one", and the host owns the order so the pill and
   * the keyboard shortcut cannot disagree about it.
   */
  | { type: 'cyclePermissionMode' }
  /** Select a specific permission mode directly. */
  | { type: 'setPermissionMode'; modeId: string }
  /** Start the interactive account sign-in. */
  | { type: 'signIn' }
  /** Forget the shared credential. Signs the CLI out too — one credential. */
  | { type: 'signOut' }
  /**
   * Open the provider setup surface, for the bring-your-own-key path.
   *
   * A Rayu API key satisfies the sign-in gate just as an account session does, so
   * the signed-out screen must offer both routes. Presenting only "Sign in" would
   * tell a user with a valid key that they are not authenticated.
   */
  | { type: 'openProviderSetup' }
  /** Search workspace files for @-mentions. */
  | { type: 'findFiles'; query: string }
  /**
   * Turn dropped resources into workspace paths the engine can resolve.
   *
   * `uriList` is the raw `text/uri-list` payload from the drop event. It is sent
   * VERBATIM rather than parsed here, because only the extension host can decide what
   * a URI means: a `vscode-remote://` resource has no local path, a folder must be
   * recognised as one, and `File.path` — the obvious-looking shortcut — does not exist
   * on files dropped into a webview.
   */
  | { type: 'resolveContextPaths'; requestId: string; uriList: string }
  /** Open the editor's own file/folder picker and return the chosen paths. */
  | { type: 'pickContextPaths'; requestId: string }
  /**
   * Apply a choice from the command-driven model chooser.
   *
   * `value` null means "reset to the default", which is the CLI's `default` sub-command.
   * The host persists it through the same `rayuConfig` setters the CLI command uses, so
   * there is one definition of where each setting lives.
   */
  | {
      type: 'modelChooserChoice'
      target: ModelChooserView['target']
      agentType?: string
      value: string | null
    }
  /** Close the chooser without changing anything. */
  | { type: 'modelChooserDismiss' }
  /** Toggle an MCP server connection. */
  | { type: 'mcpToggle'; serverName: string; enabled: boolean }
  /** Reconnect an MCP server. */
  | { type: 'mcpReconnect'; serverName: string }
  /** Refresh MCP server status. */
  | { type: 'getMcpStatus' }
  /** List previous sessions for the workspace. */
  | { type: 'listSessions' }
  /** Resume a previous session by id. Spawns an engine child with `--resume`. */
  | { type: 'resumeSession'; id: string }
  /**
   * Bring an already-open session to the front.
   *
   * Distinct from `resumeSession`: nothing is spawned, nothing is torn down, and a turn that
   * is mid-flight in the target keeps running. Keyed by the panel's own session key because a
   * live session may not have learned its engine id yet.
   */
  | { type: 'switchSession'; key: string }
  /** Close an open session and stop its engine. */
  | { type: 'closeSession'; key: string }
  /** Stop a running task through the process that owns its execution. */
  | { type: 'stopTask'; sourceSessionId: string; taskId: string }
  /** Send a follow-up to an agent/teammate when that task advertises the capability. */
  | { type: 'sendTaskMessage'; sourceSessionId: string; taskId: string; text: string }
  /**
   * Ask for a tool row's untruncated output.
   *
   * Correlated by `requestId` for the same reason `resolveContextPaths` is: two rows can
   * be expanded at once and the answer is asynchronous. The host replies to EVERY request,
   * with null when it no longer holds the text, so the promise on the other side always
   * settles.
   */
  | { type: 'requestToolOutput'; requestId: string; entryId: EntryId }
  /**
   * Read what a background task has recorded — a shell's stdout, an agent's transcript.
   *
   * On demand rather than streamed: see `ChatSession.taskOutput`. Uses the same
   * `requestId` correlation as the two requests above, and is answered by
   * `taskOutputResolved` in every case, including failure.
   */
  | { type: 'requestTaskOutput'; requestId: string; taskKey: string }

export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'

export type BackgroundTaskType =
  | 'local_agent'
  | 'in_process_teammate'
  | 'local_shell'
  | 'remote_agent'
  | 'external_agent'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'
  | 'unknown'

export interface TaskActivityView {
  id: string
  label: string
  toolName?: string
  timestamp: number
  kind?: 'tool' | 'search' | 'read' | 'thinking' | 'status'
}

export interface TaskCapabilitiesView {
  canStop: boolean
  canSendMessage: boolean
  hasTranscript: boolean
  hasOutput: boolean
}

/** Sanitized, serializable projection of the shared TaskState lifecycle. */
export interface BackgroundTaskView {
  /** Collision-safe key: source session plus the task's own id. */
  key: string
  taskId: string
  sourceSessionId: string
  type: BackgroundTaskType
  rawType?: string
  group: 'agents' | 'shells' | 'workflows' | 'remote' | 'monitors' | 'other'
  description: string
  prompt?: string
  agentId?: string
  agentName?: string
  status: BackgroundTaskStatus
  executionMode: 'foreground' | 'background'
  startedAt: number
  updatedAt: number
  currentActivity?: string
  recentActivities: TaskActivityView[]
  model?: string
  provider?: string
  tokenCount: number
  toolCount: number
  result?: string
  error?: string
  unread: boolean
  capabilities: TaskCapabilitiesView
  workflowProgress?: Array<{ label: string; status?: string; detail?: string }>
}

export interface TaskDetailPage {
  taskKey: string
  items: TranscriptEntry[]
  output?: string
  cursor?: string
  hasMore: boolean
}

/**
 * A tool's typed result, for the tools that have a dedicated renderer.
 *
 * ── HOW TO ADD A TOOL ──────────────────────────────────────────────────────────
 *
 * 1. Add a variant here with a new `kind`.
 * 2. Add a Zod schema and a projection in `host/panel/formatActivityForVSCode.ts`. The
 *    typed output is ALREADY on the wire as `tool_use_result` on the settled `user`
 *    message — no engine change is needed for any tool that populates it.
 * 3. Add one `case` to the switch in `ToolActionEntry`.
 *
 * Nothing else. Malformed or absent payloads already fall through to the generic
 * `<pre>`, so a partially-added tool degrades rather than breaks.
 *
 * ── WHY MOST TOOLS ARE STILL ON `<pre>` ────────────────────────────────────────
 *
 * A DECISION, not an omission. Edits were done first because they are what the agent
 * spends most of its time doing and the hardest thing to read as raw text; search was
 * added second to prove the mechanism generalises past one shape. The rest — `Read`,
 * `Bash`, `Agent`, `LSP`, `MCP`, `ImageGen`, `ReadMcpResource`, `ListMcpResources`,
 * `RemoteTrigger`, `Config`, `Brief`, the plan-mode and worktree tools, and
 * `AskUserQuestion`/`TodoWrite` which already have their own cards — each have a
 * `renderToolResultMessage` in `src/tools/<Name>/UI.tsx` worth mirroring, and are left
 * for a later pass rather than done badly in bulk.
 *
 * NotebookEdit is a special case: its output carries no `structuredPatch`, so there is
 * nothing to build a diff from. It needs its own variant, not the `edit` one.
 */
export type ToolResultView =
  /**
   * A file edit or write, as a diff.
   *
   * Covers `Edit` and `Write`, which both produce a `structuredPatch` over the same
   * `filePath`. A `Write` that created the file reports `isCreated`, and its diff is
   * naturally all additions.
   */
  | {
      kind: 'edit'
      /** Workspace-relative where the engine reported one; used for highlighting too. */
      filePath: string
      hunks: DiffHunkView[]
      isCreated: boolean
      /** True when the host dropped hunks to stay within its cap. */
      truncated?: boolean
    }
  /**
   * A file-name search — `Grep` in `files_with_matches` mode, or `Glob`.
   *
   * Paths only. Content matches are a different shape and would need their own variant
   * rather than being flattened into this one.
   */
  | {
      kind: 'search'
      filenames: string[]
      /** Total found, which may exceed `filenames.length` when the host capped it. */
      totalCount: number
    }

/** A settled transcript entry. Mirrors the host formatter's block kinds. */
export type TranscriptEntry =
  | { id: EntryId; kind: 'prompt'; text: string }
  | { id: EntryId; kind: 'assistant'; text: string; streaming?: boolean }
  | {
      id: EntryId
      kind: 'tool'
      /** Correlates a result with its call. Null when the engine omitted it. */
      toolUseId: string | null
      name: string
      /** One-line collapsed label — the command, the file path, the pattern. */
      label: string
      /** Pretty-printed parameters, shown when the pill is expanded. */
      parameters: string
      status: 'running' | 'done' | 'error'
      /** Result text, once it arrives. */
      output: string | null
      /**
       * How many characters of output the host withheld, or absent when none.
       *
       * Drives the "Show N more characters" action. The full text stays host-side and is
       * fetched on request — see `requestToolOutput` — so a large result costs a message
       * only when someone chooses to read it, rather than being pushed into a transcript
       * that lives for the whole session.
       */
      outputTruncatedChars?: number
      /**
       * The tool's TYPED result, for tools whose output deserves more than a `<pre>`.
       *
       * ── A DISCRIMINATED UNION, NOT `unknown` ───────────────────────────────────
       *
       * Each variant is a shape the renderer knows how to draw. Typing it means adding a
       * tool's rendering is a compile error until the renderer handles it, rather than a
       * payload that silently arrives and is ignored.
       *
       * ── ALWAYS OPTIONAL; `output` IS ALWAYS THE FALLBACK ───────────────────────
       *
       * Absent for most tools, and absent even for a supported tool when the payload did
       * not validate or the engine did not send one — a SUBAGENT's tool results carry no
       * typed output unless `preserveToolUseResults` is set. The generic `output` text is
       * never removed, so a missing sidecar degrades to exactly the previous rendering
       * instead of an empty row.
       *
       * See `webview/components/DiffView.tsx` for the renderer and the note at the bottom
       * of this file for how to add the remaining tools.
       */
      toolResult?: ToolResultView
      /**
       * Epoch ms the call was recorded, so the UI can show how long it has been running.
       *
       * ── THE HOST SENDS THE INSTANT; THE WEBVIEW COUNTS ─────────────────────────
       *
       * The same division of labour as `TurnProgressView.startTimestamp`, for the same
       * reason: pushing an updated elapsed value would be one message per second per
       * running tool, for a number the webview can derive, and it would restart the count
       * every time VS Code re-created the webview. A panel opened mid-tool resumes the
       * real count because the instant travelled, not the duration.
       *
       * The engine's `tool_progress` frame also carries `elapsed_time_seconds`, and it is
       * deliberately NOT used for the display — it arrives at the engine's cadence, not
       * once a second, so a pill driven by it would advance in jumps. That frame is a
       * liveness signal; this field is the clock.
       *
       * Optional because a transcript restored from a session file has no recorded start
       * instant. Restored calls are settled anyway, so nothing counts.
       */
      startedAt?: number
      /**
       * The subagent this call belongs to, when it did not come from the main thread.
       *
       * Derived host-side from the message's `parent_tool_use_id`: the value is the label
       * of the `Task` call that spawned the subagent, so a row can say WHOSE work it is.
       * Absent for main-thread calls, which are the majority — an "agent: main" badge on
       * every row would be noise.
       *
       * Load-bearing for grouping as well as for the badge: without it a subagent's reads
       * merge into the main thread's reads and the count silently describes two different
       * actors as one.
       */
      agent?: string
      /** AskUserQuestion data, retained for its compact transcript result. */
      questions?: NonNullable<PermissionRequestView['questionInteraction']>['questions']
      questionAnswers?: Record<string, string>
      /** Validated TodoWrite data for the dedicated task-list renderer. */
      todos?: TodoItemView[]
    }
  | { id: EntryId; kind: 'notice'; text: string; severity: 'info' | 'error' }
  /**
   * The point in the conversation where a turn ended.
   *
   * ── A POSITIONAL MARKER, NOT A COPY OF THE COMPLETION ──────────────────────────
   *
   * Carries only `turnId`. The facts — outcome, duration, usage — live in
   * `WebviewState.turnCompletions`, keyed by the same id, and the renderer looks them
   * up. Embedding them here instead would put the same completion in two places and
   * let a restored session disagree with itself about how long a turn took.
   *
   * ── WHY A TRANSCRIPT ENTRY AND NOT A SINGLE TRAILING LINE ──────────────────────
   *
   * `turnCompletions` has always been keyed per turn, but the panel rendered exactly
   * one completion line — for the turn in `turnProgress` — so scrolling back showed
   * nothing for any earlier turn. The keyed store was already right; what was missing
   * was somewhere in the transcript to anchor each line to. This is that anchor.
   *
   * ── RESTORED SESSIONS CARRY NO MARKERS, BECAUSE THE DATA IS NOT ON DISK ────────
   *
   * Only turns observed LIVE get one. Stored session files (`~/.rayu/projects/<dir>/
   * <id>.jsonl`) record `user` and `assistant` messages and nothing else — they contain
   * no `result` records at all, which was verified against every session file present.
   * `duration_ms` and the authoritative usage exist only on the live `result` frame, so a
   * resumed conversation has no completion to show for its earlier turns.
   *
   * Emitting markers on restore anyway would render an invisible entry at best, and
   * tempt a future change into fabricating `✓ Completed in 0s` for every historical
   * turn. Persisting turn results would be an engine-side change to what the session
   * file contains; until then, absent is the honest state. `TurnEndEntry` renders
   * nothing without a completion for the same reason.
   */
  | { id: EntryId; kind: 'turn_end'; turnId: string }
  /**
   * One hook execution, from start to outcome.
   *
   * ── WHY HOOKS ARE IN THE TRANSCRIPT AT ALL ─────────────────────────────────────
   *
   * The engine has always emitted `hook_started` / `hook_progress` / `hook_response`;
   * nothing consumed them, so a hook that rewrote a file, blocked a tool, or failed
   * outright was completely invisible in the panel. A user whose `PreToolUse` hook
   * rejected an edit saw the edit not happen and had no way to learn why.
   *
   * ── MORE THAN THE TUI SHOWS, DELIBERATELY ──────────────────────────────────────
   *
   * `HookProgressMessage` in the CLI renders one dim line — "Running PostToolUse hooks…"
   * — and routes completion detail through async attachments. That is a terminal
   * space budget, not a decision to withhold the output: the frames carry `stdout`,
   * `stderr` and `exit_code`, and an editor panel is somewhere a developer expects to
   * READ a failing hook's stderr rather than go hunting for it. So the summary line
   * matches the CLI and the detail is available behind it.
   *
   * ── ONE ENTRY PER `hookId`, REPLACED IN PLACE ──────────────────────────────────
   *
   * Progress frames repeat for the lifetime of the hook. Appending them would produce a
   * row per second per hook. The host keys on `hookId` and updates.
   *
   * ── `stdout` AND `stderr` ARE CUMULATIVE SNAPSHOTS, NOT DELTAS ─────────────────
   *
   * `startHookProgressInterval` re-reads the hook's whole accumulated output each tick
   * and emits it when it differs from what it last sent. So each frame carries the FULL
   * output so far and the host must REPLACE these fields. Appending would repeat
   * everything already shown on every tick, growing quadratically.
   */
  | {
      id: EntryId
      kind: 'hook'
      /** The engine's own hook id. Correlates every frame for this execution. */
      hookId: string
      /** The configured hook's name, as the engine reports it. */
      name: string
      /** The lifecycle event that triggered it, e.g. `PreToolUse`. */
      event: string
      /**
       * `cancelled` is kept distinct from `error`: a hook the engine stopped did not
       * fail, and reporting it as a failure would send the user looking for a bug.
       */
      status: 'running' | 'done' | 'error' | 'cancelled'
      /** Present once the hook exited. Absent while running. */
      exitCode?: number
      /** Full accumulated stdout, bounded. Replaced per frame — see above. */
      stdout: string
      /** Full accumulated stderr, bounded. Replaced per frame — see above. */
      stderr: string
    }
  /**
   * The engine's OWN post-turn summary.
   *
   * Rendered from `system`/`post_turn_summary`, which the engine already produces —
   * this is not a recap the extension generates. Building a second summariser would
   * mean the panel and the CLI could describe the same turn differently, and would
   * cost an extra analysis pass for information the engine already has.
   */
  | {
      id: EntryId
      kind: 'summary'
      title: string
      description: string
      /** The engine's own classification, used for the badge. */
      statusCategory: 'blocked' | 'waiting' | 'completed' | 'review_ready' | 'failed'
      statusDetail: string
      /** What the engine says still needs doing. Empty when nothing does. */
      needsAction: string
      /** Whether the engine flagged this turn as worth attention. */
      isNoteworthy: boolean
    }
  /**
   * The Copilot-Edits working set: every file still recorded as changed, pending review.
   *
   * Its own entry kind rather than a notice, because it is interactive and it is the
   * one transcript element the user acts on after a turn finishes.
   *
   * RE-ANCHORED under each response rather than left where it first appeared — see
   * `flushPendingReview`. The card the user sees is always the last thing in the finished
   * turn, and `ReviewFileView.changedThisTurn` says which of its files that turn produced.
   */
  | {
      id: EntryId
      kind: 'review'
      totalFiles: number
      totalAdditions: number
      totalRemovals: number
      files: ReviewFileView[]
    }

/**
 * One hunk of a unified diff, as the engine recorded it.
 *
 * Mirrors the `diff` package's `StructuredPatchHunk`, which is what
 * `FileChangeReviewFileSchema.hunks` carries — restated here rather than imported so
 * `shared/` stays dependency-free for the browser bundle.
 *
 * `lines` are prefixed in the usual way: a leading space for context, `+` for an
 * addition, `-` for a removal, `\` for the no-newline marker.
 */
export interface DiffHunkView {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** One changed file in the review card. */
export interface ReviewFileView {
  /** Workspace-relative where possible — what the engine reported. */
  displayPath: string
  additions: number
  removals: number
  /** New files have no previous version; the diff's left side is empty. */
  isCreated: boolean
  /**
   * Resolution state, straight from the engine's `PendingFileChangeStatus`.
   *
   * `mixed` means the file has several recorded changes that were not all resolved the
   * same way. Carried through rather than flattened because a file that is already
   * kept or undone must not offer the same action again — the engine would refuse it,
   * and a button that reliably fails is worse than no button.
   */
  status: 'pending' | 'kept' | 'undone' | 'mixed'
  /**
   * The engine's change ids for this file.
   *
   * Preserved from `FileChangeReviewFile.changeIds` rather than discarded: they are how
   * the engine identifies a specific recorded change, and dropping them would leave the
   * UI unable to say anything precise about what it is acting on.
   */
  changeIds: string[]
  /**
   * The recorded diff, bounded, for the in-panel diff view.
   *
   * ── THIS REVERSES AN EARLIER DECISION, DELIBERATELY ────────────────────────────
   *
   * `handleReview` used to keep hunks host-side, on the stated grounds that "the editor
   * draws the diff, so shipping hunks to the browser would be a large postMessage for data
   * it never renders". The size concern was correct and is why this is capped; the premise
   * no longer is. Requiring a diff editor to read a two-line change is the single biggest
   * gap against the terminal, where the diff is simply THERE the moment the edit lands.
   *
   * Bounded by `MAX_REVIEW_HUNKS` and `MAX_REVIEW_HUNK_LINES` host-side. `truncated` says
   * so, because a diff silently missing its tail is worse than one that admits it. The
   * "Open diff" action remains for the complete, authoritative view.
   *
   * `fileContent` is still NOT sent: it is the whole file, it is unbounded, and the diff
   * does not need it.
   */
  hunks?: DiffHunkView[]
  /** True when hunks were dropped by either cap. The card says so and offers the editor. */
  hunksTruncated?: boolean
  /**
   * Whether this file was changed by the response the card is anchored under.
   *
   * ── WHY A CUMULATIVE CARD NEEDS THIS ───────────────────────────────────────────
   *
   * `file_change_review` is a snapshot of EVERYTHING still recorded, not of the turn that
   * produced it, so by turn five the card lists all twenty files touched since the session
   * began. Anchoring that card under each response — which is what makes it a per-response
   * summary — would otherwise say the same thing every time and tell the user nothing about
   * what just happened.
   *
   * The set cannot simply be narrowed to this turn instead: `Keep all` and `Undo all` act on
   * what the card displays, and hiding an unresolved file from an earlier turn would leave it
   * with no way to be resolved from the transcript.
   *
   * Computed host-side by comparing change ids against the set known before the turn started,
   * so it stays stable while the user keeps and undoes individual files afterwards. Absent on
   * entries from a host that predates it, which reads as "unknown" and simply renders nothing.
   */
  changedThisTurn?: boolean
}

/** The active model, for the composer toolbar. */
export interface ModelInfoView {
  /** Human label, e.g. "Sonnet 4". Null before the engine has reported one. */
  model: string | null
  /** Provider id, e.g. "anthropic". */
  provider: string | null
}

/** One selectable model in the composer dropdown. */
export interface ModelOptionView {
  /** The identifier sent to the engine and written to config. */
  value: string
  /** What a human reads. Falls back to `value` when the source gave no label. */
  label: string
  /** Provider-qualified detail, e.g. "openai · gpt-4o". */
  description: string
  /**
   * The provider's OWN description of the model, when it published one.
   *
   * Separate from `description`, which this panel composes as "provider · model".
   * Keeping them apart lets the dropdown search both and show the human sentence
   * above the machine-readable line, instead of picking one and losing the other.
   */
  customerDescription?: string
  providerId?: string
  model?: string
  contextWindow?: number
  supportsThinking?: boolean
  supportsImage?: boolean
  supportsTools?: boolean

}

/**
 * The dropdown's contents and load state.
 *
 * `loading` and `error` are separate from an empty list on purpose: "still fetching",
 * "nothing configured" and "the fetch failed" need different UI, and collapsing them
 * into an empty array makes a broken provider look like an empty one.
 */
export interface ModelCatalogueView {
  options: ModelOptionView[]
  loading: boolean
  /** User-facing failure, or null. Retry is offered when this is set. */
  error: string | null
}

/**
 * A permission mode as the composer presents it.
 *
 * `id` is the wire value for `set_permission_mode`; `label` and `description` are
 * editor phrasing. The engine's enum also has internal modes (`auto`, `bubble`,
 * `fullManage`) that are deliberately not offered — see `shared/permissionModes.ts`.
 */
export interface PermissionModeView {
  id: 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions'
  label: string
  description: string
}

/**
 * Everything the UI needs to render, as one serialisable object.
 *
 * Deliberately a snapshot rather than a set of independent fields: a webview that
 * has just been re-created needs all of it at once, and one message that carries
 * the whole picture cannot arrive half-applied.
 */
export interface WebviewState {
  /** Which surface to show. `signed-out` limits the composer to authentication commands. */
  status: 'signed-out' | 'ready'
  /**
   * Why the user is blocked, when `status` is `signed-out`. Phrased for an editor —
   * the shared gate's own wording tells the user to run slash commands.
   */
  signInMessage: string | null
  /**
   * Who is signed in, for the header.
   *
   * NO TOKENS. The host holds the access and refresh tokens and never sends them:
   * the webview renders model and tool output, so anything reaching it should be
   * assumed reachable by that content. Null when signed out, and also when signed
   * in with an API key rather than an account.
   */
  identity: { email: string | null; displayName: string | null } | null
  /**
   * Whether Rayu account login is enabled at all. When false, the sign-in button is
   * pointless and the API-key route is the only one that makes sense.
   */
  oauthEnabled: boolean
  /** Extension version, shown in the panel header. */
  version: string
  /** Absolute path of the folder the engine runs in, or null with no workspace. */
  workspaceFolder: string | null
  /** Restored transcript, so a re-created webview does not lose the conversation. */
  transcript: TranscriptEntry[]
  /** Whether a turn is in flight, so the composer starts in the right mode. */
  turnRunning: boolean
  /**
   * Approvals still awaiting an answer.
   *
   * Carried in the snapshot because the engine stays blocked across a webview
   * re-creation. Without this, collapsing the panel while a card was up would lose
   * the card and leave the turn stuck with nothing on screen to unblock it.
   */
  pendingPermissions: PermissionRequestView[]
  /** Active model, for the composer toolbar. */
  modelInfo: ModelInfoView
  /** The dropdown's contents, so a re-created webview does not lose them. */
  modelCatalogue: ModelCatalogueView
  /** Thinking and effort, so the controls survive a webview re-creation. */
  inference: InferenceSettingsView
  providerSetup: ProviderSetupView
  /** Open command-driven model chooser, or null. Host-owned so it survives re-creation. */
  modelChooser: ModelChooserView | null
  attachment: AttachmentView
  /** Active permission mode, for the composer's shield pill. */
  permissionMode: PermissionModeView
  /** Available slash commands. */
  commands: SlashCommandView[]
  /** Context usage breakdown (polled after turns). */
  contextUsage: ContextUsageView | null
  /** Connected MCP servers. */
  mcpServers: McpServerView[]
  /** The editor's current file and selection, or null. */
  ideContext: IdeContextView | null
  /** Previous sessions, with load state. */
  sessions: SessionListView
  /** Conversations the panel is holding open, including the one on screen. */
  liveSessions?: LiveSessionView[]
  /** Which live session is on screen. */
  activeSessionKey?: string
  /** Host-owned task state survives webview collapse and recreation. */
  backgroundTasks?: BackgroundTaskView[]
  /** False when an attached older CLI does not expose task inspection. */
  taskInspectionSupported?: boolean
  taskInspectionMessage?: string
  /**
   * Progress for the turn in flight, or null when nothing is running.
   *
   * In the snapshot rather than left to the next `setTurnProgress`, because VS Code
   * re-creates the webview freely: without this, collapsing the panel mid-turn and
   * reopening it would show an idle composer while the engine was still working.
   */
  turnProgress: TurnProgressView | null
  /** Completed turns by `turnId`, so scrolling back still shows each turn's result. */
  turnCompletions: Record<string, TurnCompletionEntry>
  /** Thinking blocks for the whole session, restored on re-creation and on resume. */
  thinkingBlocks: ThinkingEntryView[]
}

/** A slash command description for the autocomplete popover. */
export interface SlashCommandView {
  name: string
  description: string
}

/** An MCP server's connection status. */
export interface McpServerView {
  name: string
  status: 'connected' | 'connecting' | 'disconnected' | 'disabled'
  error?: string
}

/**
 * A conversation the panel is holding OPEN, with its own engine child.
 *
 * ── WHY LIVE SESSIONS ARE A SEPARATE LIST FROM HISTORY ─────────────────────────
 *
 * `SessionSummaryView` describes a session file on disk, keyed by the engine's UUID and
 * ordered by mtime. A live session may not have an engine id yet — the child reports it on its
 * first frame — and its interesting facts are ones no file has: whether a turn is running,
 * whether it is blocked on an approval, and which model it is pinned to. Folding the two
 * together would mean either inventing an id for a session that has none, or losing the
 * running state, and it would put "the thing you were just doing" in a bucket labelled by
 * modification date.
 *
 * Switching to one of these ACTIVATES it — the engine is already there, the turn is still
 * running — where switching to a history row RESUMES it, which spawns a child. The two are
 * different operations with different costs, and the UI has to be able to say which is which.
 */
export interface LiveSessionView {
  /** The panel's own key. Stable for the life of the session, unlike the engine's id. */
  key: string
  /** Derived from the first prompt, or a placeholder for a session with no prompt yet. */
  label: string
  /** True while this session's engine is mid-turn — including while the panel shows another. */
  running: boolean
  /** Approvals this session is blocked on. Nonzero means it cannot advance unattended. */
  pendingApprovals: number
  /** The model this session is pinned to, which is NOT necessarily the global selection. */
  model: string | null
  /** Epoch ms of the last transcript change, for ordering. */
  updatedAt: number
}

/** Stored session metadata for the history palette. */
export interface SessionSummaryView {
  id: string
  /** Custom /title, else generated summary, else first prompt, else a short id. */
  label: string
  /** Epoch ms. Drives the ordering and the relative time on the row. */
  lastModified: number
  /** Epoch ms, when the transcript's first timestamp was parseable. */
  createdAt?: number
  gitBranch?: string
  /**
   * The session's own working directory. Shown only when it differs from the workspace,
   * which means it came from another git worktree.
   */
  cwd?: string
}

/**
 * The sessions list, with its load state.
 *
 * ── FIVE STATES, NOT AN ARRAY ──────────────────────────────────────────────────
 *
 * The list used to be a bare `SessionSummaryView[] | undefined`, which could express only
 * "not fetched" and "here they are". Five outcomes actually matter and the user needs to tell
 * them apart: still loading, none exist, none MATCH THE SEARCH, the stored history could not
 * be parsed, and the read failed outright. An empty array cannot distinguish a fresh
 * workspace from a broken one, and both were previously rendered as "no previous sessions".
 *
 * `sessions` is still carried on a failure so a stale-but-real list beats an empty one.
 */
export interface SessionListView {
  status: 'loading' | 'ready' | 'failed'
  sessions: SessionSummaryView[]
  /** Set when `status` is `failed`. Phrased for the user, not the log. */
  error?: string
}

/** Context window usage percentage and token counts. */
/**
 * The in-panel provider setup surface.
 *
 * ── NO FIELD HERE HOLDS A CREDENTIAL ───────────────────────────────────────────
 *
 * Keys are write-only from the webview's point of view: they are typed into a local
 * input, sent once, and never returned. Nothing on this type could place one in
 * persisted webview state, a diagnostic, or the transcript.
 */
/**
 * Live attachment to a CLI session.
 *
 * ── NO IPC TOKEN CROSSES THIS BOUNDARY ─────────────────────────────────────────
 *
 * Holding a session's `ipcToken` is enough to drive it, so it stays in the extension host.
 * Nothing here has a field that could hold one.
 */
export interface AttachmentView {
  /** `undefined` until first listed; `[]` means none are running. */
  available: AttachableSessionView[] | undefined
  /** The session currently mirrored here, if any. */
  attached: AttachableSessionView | null
  error: string | null
}

export interface AttachableSessionView {
  pid: number
  sessionId: string
  /** Label from the CLI's /name, when set. */
  name?: string
  cwd: string
  status?: 'busy' | 'idle' | 'waiting'
  /** What the session is blocked on, when it is waiting. */
  waitingFor?: string
  startedAt: number
}

export interface ProviderSetupView {
  open: boolean
  /** `undefined` until first fetched; `[]` means fetched and none are available. */
  presets: ProviderPresetView[] | undefined
  /** True while a validate or save is in flight. */
  busy: boolean
  /** Progress wording for the step in flight. */
  busyMessage: string | null
  error: string | null
  /**
   * Models the last validation discovered. Empty after a successful validation means
   * the provider exposes no list endpoint, which is not a failure.
   */
  discoveredModels: string[] | null
  /** Set after a successful save, so the panel can confirm what is now active. */
  connectedProviderId: string | null
  connectedModel: string | null
}

export interface ProviderPresetView {
  id: string
  label: string
  kind: string
  baseURL?: string
  requiresBaseURL: boolean
  requiresApiKey: boolean
  /** OAuth/ADC presets cannot be completed with a typed key; the panel says so. */
  requiresOAuth: boolean
  /** True when the CLI would already find a key in the environment. */
  envKeyPresent: boolean
  defaultModel?: string
}

export interface ContextUsageView {
  percentage: number
  totalTokens?: number
  maxTokens?: number
  /**
   * True when the last refresh failed and this is the previous reading. Rendered with a
   * marker rather than replaced by 0% — a confident zero is a lie, whereas "this was
   * true a moment ago" is accurate.
   */
  stale?: boolean
}
