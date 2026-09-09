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
  /** A non-fatal problem worth showing in the transcript rather than a toast. */
  | { type: 'showError'; message: string }
  /** Remove a transcript entry by id (e.g. when a review card is cleared). */
  | { type: 'removeEntry'; id: EntryId }
  /** Available slash commands. */
  | { type: 'setCommands'; commands: SlashCommandView[] }
  /** Matching workspace files for @-mentions. */
  | { type: 'fileSearchResults'; query: string; files: string[] }
  /** Context usage percentage after a turn. */
  | { type: 'setContextUsage'; percentage: number; totalTokens?: number; maxTokens?: number; stale?: boolean }
  /** Connected MCP servers status. */
  | { type: 'setMcpServers'; servers: McpServerView[] }
  /** Previous sessions for project history. */
  | { type: 'setSessions'; sessions: SessionSummaryView[] }
  /** Turn completed — formatted duration string (e.g. "5m 17s"). */
  | { type: 'turnDuration'; duration: string }

/** An approval the user must grant or refuse before a tool runs. */
export interface PermissionRequestView {
  /** Correlates the answer with the engine's blocked request. */
  requestId: string
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
  /** Send a prompt. The host gates it before dispatching. */
  | { type: 'submitPrompt'; text: string }
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
  /** Turn extended thinking on or off for subsequent requests. */
  | { type: 'setThinking'; enabled: boolean }
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
  /** Toggle an MCP server connection. */
  | { type: 'mcpToggle'; serverName: string; enabled: boolean }
  /** Reconnect an MCP server. */
  | { type: 'mcpReconnect'; serverName: string }
  /** Refresh MCP server status. */
  | { type: 'getMcpStatus' }
  /** List previous sessions for the workspace. */
  | { type: 'listSessions' }
  /** Resume a previous session by id. */
  | { type: 'resumeSession'; id: string }

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
      /** AskUserQuestion data, retained for its compact transcript result. */
      questions?: NonNullable<PermissionRequestView['questionInteraction']>['questions']
      questionAnswers?: Record<string, string>
      /** Validated TodoWrite data for the dedicated task-list renderer. */
      todos?: TodoItemView[]
    }
  | { id: EntryId; kind: 'notice'; text: string; severity: 'info' | 'error' }
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
   * The Copilot-Edits working set: files this turn changed, pending review.
   *
   * Its own entry kind rather than a notice, because it is interactive and it is the
   * one transcript element the user acts on after a turn finishes.
   */
  | {
      id: EntryId
      kind: 'review'
      totalFiles: number
      totalAdditions: number
      totalRemovals: number
      files: ReviewFileView[]
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
  attachment: AttachmentView
  /** Active permission mode, for the composer's shield pill. */
  permissionMode: PermissionModeView
  /** Available slash commands. */
  commands: SlashCommandView[]
  /** Context usage breakdown (polled after turns). */
  contextUsage: ContextUsageView | null
  /** Connected MCP servers. */
  mcpServers: McpServerView[]
  /** Previous sessions for project. */
  sessions?: SessionSummaryView[]
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
