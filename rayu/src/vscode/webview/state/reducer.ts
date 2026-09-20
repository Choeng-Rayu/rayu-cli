/**
 * Transcript state for the panel.
 *
 * A reducer rather than scattered `useState` calls, because the interesting bugs in
 * a streaming transcript are ORDERING bugs — a delta arriving after its completion,
 * a tool result for a pill that was replaced, a resync landing mid-stream. Those are
 * only reviewable when every transition is in one place.
 *
 * ── THE HOST OWNS THE TRANSCRIPT; THIS IS A VIEW ───────────────────────────────
 *
 * `ChatSession` keeps the authoritative copy. This state is rebuilt wholesale from
 * `init`, which the host may send at any time — VS Code disposes and re-creates the
 * webview freely. So no reducer action may depend on state the host does not also
 * have, and `init` must be a full replacement rather than a merge.
 */
import type {
  BackgroundTaskView,
  ContextUsageView,
  EntryId,
  LiveSessionView,
  McpElicitationView,
  McpServerView,
  ModelCatalogueView,
  ModelInfoView,
  PermissionModeView,
  AttachmentView,
  PermissionRequestView,
  ProviderSetupView,
  SessionListView,
  IdeContextView,
  ModelChooserView,
  SlashCommandView,
  RuntimeCapabilitiesView,
  RuntimeCommandView,
  RuntimeToolView,
  RuntimeAgentView,
  RuntimePluginView,
  RuntimeSkillView,
  RateLimitView,
  EngineAuthStatusView,
  ThinkingEntryView,
  TranscriptEntry,
  TurnCompletionEntry,
  TurnProgressView,
  WebviewState,
} from '../../shared/webviewProtocol.js'
import {
  MAX_TRANSCRIPT_ENTRIES,
  TRANSCRIPT_TRIM_STEP,
} from '../../shared/webviewProtocol.js'
import { DEFAULT_PERMISSION_MODE } from '../../shared/permissionModes.js'
import type { InferenceSettingsView } from '../../shared/inferenceSettings.js'

/**
 * How many background notices (panel-level alerts, NOT transcript entries) the
 * webview keeps. They used to accumulate for the life of the panel; twenty is far
 * more than anyone re-reads and bounds a surface that a flapping error could
 * otherwise grow without limit.
 */
const MAX_NOTICES = 20

/**
 * Entries eviction must never touch, because a live code path still updates or
 * acts on them BY ID — mirroring the protection set in the host's
 * `trimTranscript`, restricted to what the webview can observe from the entry
 * itself:
 *
 *   a streaming answer   — `appendPartial` drops deltas for an unknown id, so
 *                          evicting it would silently lose the rest of the reply.
 *   a running tool/hook  — its result/progress frames replace the row in place.
 *   a question mid-answer — the answer posts back against the entry id.
 *   a review card        — interactive (/keep, /undo) until `removeEntry` says
 *                          it is resolved, so any card still present is actionable.
 *
 * The first prompt is protected by the CALLER (it needs array context), because
 * `deriveSessionTitle` names the conversation from it.
 */
function isLiveEntry(entry: TranscriptEntry): boolean {
  if (entry.kind === 'assistant' && entry.streaming) return true
  if (entry.kind === 'tool' && entry.status === 'running') return true
  if (entry.kind === 'side_question' && entry.status === 'answering') return true
  if (entry.kind === 'hook' && entry.status === 'running') return true
  if (entry.kind === 'review') return true
  return false
}

/**
 * Enforce MAX_TRANSCRIPT_ENTRIES, oldest-first.
 *
 * The webview process holds its own copy of every entry ever pushed — the DOM
 * and the React state both grow with it — and long agentic sessions used to grow
 * it without bound until the renderer was a top machine memory consumer. The
 * host caps its own copy at the same thresholds (see `trimTranscript` in
 * sessionHandle.ts); this is the view-side half of the same bound, and it also
 * runs on `init` so a snapshot that somehow exceeds the cap cannot smuggle the
 * growth back in.
 *
 * Quantized by TRANSCRIPT_TRIM_STEP to match the host exactly — trimming one
 * entry per append would shift every visible row on every token of a stream.
 * Returns the evicted entries so callers can prune sidecar state keyed to them
 * (thinking blocks) in the same step.
 */
function capEntries(entries: TranscriptEntry[]): {
  capped: TranscriptEntry[]
  evicted: TranscriptEntry[]
} {
  if (entries.length <= MAX_TRANSCRIPT_ENTRIES + TRANSCRIPT_TRIM_STEP) {
    return { capped: entries, evicted: [] }
  }
  const firstPromptId = entries.find(e => e.kind === 'prompt')?.id
  const capped: TranscriptEntry[] = []
  const evicted: TranscriptEntry[] = []
  let toDrop = entries.length - MAX_TRANSCRIPT_ENTRIES
  for (const entry of entries) {
    if (toDrop > 0 && entry.id !== firstPromptId && !isLiveEntry(entry)) {
      evicted.push(entry)
      toDrop--
    } else {
      capped.push(entry)
    }
  }
  return { capped, evicted }
}

/**
 * Index of `id`, searching from the END.
 *
 * `appendPartial` (every streamed token) and `appendToolOutput` (every progress
 * frame) both target the newest rows, so a head-first `findIndex` walked the whole
 * transcript on every one of them. `findLastIndex` is the built-in that already
 * does this — it matches the newest row first, which is the common case, and no
 * hand-rolled helper is needed. (Same method the engine uses elsewhere, e.g.
 * `utils/attribution.ts`.)
 */
function findEntryIndexFromEnd(entries: TranscriptEntry[], id: EntryId): number {
  return entries.findLastIndex(e => e.id === id)
}

/** Drop thinking blocks whose source assistant entry was evicted. */
function pruneThinkingBlocks(
  blocks: Record<string, ThinkingEntryView>,
  evicted: TranscriptEntry[],
): Record<string, ThinkingEntryView> {
  if (evicted.length === 0) return blocks
  const evictedIds = new Set(evicted.map(e => e.id))
  const pruned: Record<string, ThinkingEntryView> = {}
  for (const [key, block] of Object.entries(blocks)) {
    if (!evictedIds.has(block.sourceMessageId)) pruned[key] = block
  }
  return pruned
}

export interface ChatState {
  /** Null until the first `init` arrives. Distinguishes "connecting" from "empty". */
  session: WebviewState | null
  entries: TranscriptEntry[]
  turnRunning: boolean
  modelInfo: ModelInfoView
  /** The composer dropdown's contents and load state. */
  modelCatalogue: ModelCatalogueView
  /** Thinking and effort, as acknowledged by the engine. */
  inference: InferenceSettingsView
  providerSetup: ProviderSetupView
  /** Open command-driven model chooser, or null. */
  modelChooser: ModelChooserView | null
  attachment: AttachmentView
  /** Active permission mode, for the composer's shield pill. */
  permissionMode: PermissionModeView
  /**
   * Approvals awaiting an answer, oldest first.
   *
   * A list rather than a single slot: the engine can run tools in parallel, and
   * replacing an outstanding card with a newer one would leave the first request
   * blocked with nothing on screen to unblock it.
   */
  pendingPermissions: PermissionRequestView[]
  /**
   * Alerts with no position in the visible transcript, newest last.
   *
   * NOT the general error channel: a failure inside a conversation arrives as a
   * `notice` entry in `entries` and renders inline where it happened. This holds only
   * background-session alerts and panel-level failures — see `showError` in the
   * protocol for why those two belong outside the transcript.
   */
  notices: string[]
  /** Available slash commands. */
  commands: SlashCommandView[]
  /** Context usage percentage and tokens. */
  contextUsage: ContextUsageView | null
  /** Connected MCP servers. */
  mcpServers: McpServerView[]
  runtimeCapabilities: RuntimeCapabilitiesView | null
  runtimeCommands: RuntimeCommandView[]
  runtimeTools: RuntimeToolView[]
  runtimeAgents: RuntimeAgentView[]
  runtimePlugins: RuntimePluginView[]
  runtimeSkills: RuntimeSkillView[]
  runtimeWorkflows: RuntimeSkillView[]
  rateLimit: RateLimitView | null
  engineAuthStatus: EngineAuthStatusView | null
  sessionStatus: 'idle' | 'running' | 'requires_action'
  promptSuggestion: string | null
  mcpElicitations: McpElicitationView[]
  /** The editor's current file and selection, or null. */
  ideContext: IdeContextView | null
  /**
   * Progress for the turn in flight, from the host.
   *
   * Retained after the turn ends — the host leaves it in place with a terminal phase —
   * because the completion line is rendered from it. Cleared only by `init`, which is
   * also what a new or resumed session sends.
   */
  turnProgress: TurnProgressView | null
  /** Finished turns by `turnId`, carrying the engine's authoritative duration and usage. */
  turnCompletions: Record<string, TurnCompletionEntry>
  /**
   * Thinking blocks by `entryId`.
   *
   * A map rather than a list so a re-sent block (they arrive repeatedly as they grow)
   * replaces its predecessor instead of appending a duplicate.
   */
  thinkingBlocks: Record<string, ThinkingEntryView>
  /** Workspace files matching current @-search. */
  workspaceFiles: string[]
  /** Previous sessions, with their load state. */
  sessions: SessionListView
  /**
   * Conversations the panel is holding open, newest activity first.
   *
   * Separate from `sessions` because these are LIVE: switching to one activates an engine
   * that is already there — possibly mid-turn — where a history row spawns a child. See
   * `LiveSessionView` for why the two lists cannot be merged.
   */
  liveSessions: LiveSessionView[]
  /** Which live session is on screen. */
  activeSessionKey: string
  backgroundTasks: BackgroundTaskView[]
  taskInspectionSupported: boolean
  taskInspectionMessage?: string
}

export const initialChatState: ChatState = {
  session: null,
  entries: [],
  turnRunning: false,
  modelInfo: { model: null, provider: null },
  // Starts as loading: the host sends the config-derived list on `ready`, so an empty
  // list before that is "not yet known", not "none configured".
  modelCatalogue: { options: [], loading: true, error: null },
  // Capabilities unknown until `initialize`; false keeps the controls hidden rather
  // than showing them and then taking them away.
  inference: {
    supportsEffort: false,
    supportedLevels: [],
    effort: null,
    effortEnvOverride: null,
    supportsThinking: false,
    thinkingEnabled: false,
  },
  thinkingBlocks: {},
  turnProgress: null,
  turnCompletions: {},
  modelChooser: null,
  attachment: { available: undefined, attached: null, error: null },
  providerSetup: {
    open: false,
    // undefined = not fetched yet, so the panel says "loading" rather than "none".
    presets: undefined,
    busy: false,
    busyMessage: null,
    error: null,
    discoveredModels: null,
    connectedProviderId: null,
    connectedModel: null,
  },
  permissionMode: DEFAULT_PERMISSION_MODE,
  pendingPermissions: [],
  notices: [],
  commands: [],
  contextUsage: null,
  mcpServers: [],
  runtimeCapabilities: null,
  runtimeCommands: [],
  runtimeTools: [],
  runtimeAgents: [],
  runtimePlugins: [],
  runtimeSkills: [],
  runtimeWorkflows: [],
  rateLimit: null,
  engineAuthStatus: null,
  sessionStatus: 'idle',
  promptSuggestion: null,
  mcpElicitations: [],
  ideContext: null,
  workspaceFiles: [],
  sessions: { status: 'loading', sessions: [] },
  liveSessions: [],
  activeSessionKey: '',
  backgroundTasks: [],
  taskInspectionSupported: true,
}

export type ChatAction =
  | { type: 'init'; state: WebviewState }
  | { type: 'addMessage'; entry: TranscriptEntry }
  | { type: 'appendPartial'; id: EntryId; kind: 'text' | 'thinking'; delta: string }
  | { type: 'completeMessage'; id: EntryId }
  | { type: 'turnState'; running: boolean }
  | { type: 'removeEntry'; id: EntryId }
  | { type: 'setModelInfo'; info: ModelInfoView }
  | { type: 'setModelCatalogue'; catalogue: ModelCatalogueView }
  | { type: 'setInferenceSettings'; settings: InferenceSettingsView }
  | { type: 'setProviderSetup'; setup: ProviderSetupView }
  | { type: 'setModelChooser'; chooser: ModelChooserView | null }
  | { type: 'setAttachment'; attachment: AttachmentView }
  | { type: 'setPermissionMode'; mode: PermissionModeView }
  | { type: 'showPermissionRequest'; request: PermissionRequestView }
  | { type: 'dismissPermissionRequest'; requestId: string }
  | { type: 'showError'; message: string }
  | { type: 'setCommands'; commands: SlashCommandView[] }
  | { type: 'fileSearchResults'; query: string; files: string[] }
  | { type: 'setContextUsage'; percentage: number; totalTokens?: number; maxTokens?: number; stale?: boolean }
  | { type: 'setMcpServers'; servers: McpServerView[] }
  | {
      type: 'setRuntimeCatalogue'
      capabilities: RuntimeCapabilitiesView | null
      commands: RuntimeCommandView[]
      tools: RuntimeToolView[]
      agents?: RuntimeAgentView[]
      plugins?: RuntimePluginView[]
      skills?: RuntimeSkillView[]
      workflows?: RuntimeSkillView[]
    }
  | { type: 'setRateLimit'; rateLimit: RateLimitView | null }
  | { type: 'setEngineAuthStatus'; status: EngineAuthStatusView | null }
  | { type: 'setSessionStatus'; status: 'idle' | 'running' | 'requires_action' }
  | { type: 'setPromptSuggestion'; suggestion: string | null }
  | { type: 'showMcpElicitation'; request: McpElicitationView }
  | { type: 'dismissMcpElicitation'; requestId: string }
  | { type: 'setIdeContext'; context: IdeContextView | null }
  | { type: 'setSessions'; list: SessionListView }
  | { type: 'setLiveSessions'; sessions: LiveSessionView[]; activeKey: string }
  | { type: 'setTurnProgress'; progress: TurnProgressView }
  | { type: 'turnCompleted'; turnId: string; completion: TurnCompletionEntry }
  | { type: 'updateThinking'; thinking: ThinkingEntryView }
  | { type: 'appendToolOutput'; id: EntryId; text: string }
  | { type: 'replaceTaskState'; tasks: BackgroundTaskView[]; supported: boolean; message?: string }
  | { type: 'upsertTaskState'; task: BackgroundTaskView }

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'init': {
      // A FULL replacement. Merging would let a stale local entry survive a resync
      // and diverge from the host's copy with no way to notice.
      //
      // The entry cap is enforced here too, not only on append: the host bounds its
      // own copy at the same constant, but the view guarantees its own bound rather
      // than trusting the snapshot (a host holding many protected live entries can
      // legitimately exceed the cap, and this process must not inherit that).
      const { capped, evicted } = capEntries(action.state.transcript)
      const evictedIds = new Set(evicted.map(e => e.id))
      return {
        session: action.state,
        entries: capped,
        turnRunning: action.state.turnRunning,
        modelInfo: action.state.modelInfo,
        modelCatalogue: action.state.modelCatalogue,
        inference: action.state.inference,
        providerSetup: action.state.providerSetup,
        modelChooser: action.state.modelChooser,
        attachment: action.state.attachment,
        permissionMode: action.state.permissionMode,
        // Restored, because the engine stays blocked across a webview re-creation.
        pendingPermissions: action.state.pendingPermissions,
        // Host-owned, so a re-created panel resumes the same elapsed count, the same
        // token totals and the same reasoning rather than restarting them at zero.
        turnProgress: action.state.turnProgress,
        turnCompletions: action.state.turnCompletions,
        // Blocks whose source assistant entry did not survive the cap are dropped
        // with it — the host prunes its own copy the same way.
        thinkingBlocks: Object.fromEntries(
          action.state.thinkingBlocks
            .filter(block => !evictedIds.has(block.sourceMessageId))
            .map(block => [block.entryId, block]),
        ),
        notices: [],
        commands: action.state.commands ?? [],
        contextUsage: action.state.contextUsage ?? null,
        mcpServers: action.state.mcpServers ?? [],
        runtimeCapabilities: action.state.runtimeCapabilities ?? null,
        runtimeCommands: action.state.runtimeCommands ?? [],
        runtimeTools: action.state.runtimeTools ?? [],
        runtimeAgents: action.state.runtimeAgents ?? [],
        runtimePlugins: action.state.runtimePlugins ?? [],
        runtimeSkills: action.state.runtimeSkills ?? [],
        runtimeWorkflows: action.state.runtimeWorkflows ?? [],
        rateLimit: action.state.rateLimit ?? null,
        engineAuthStatus: action.state.engineAuthStatus ?? null,
        sessionStatus: action.state.sessionStatus ?? 'idle',
        promptSuggestion: action.state.promptSuggestion ?? null,
        mcpElicitations: action.state.mcpElicitations ?? [],
        ideContext: action.state.ideContext ?? null,
        workspaceFiles: state.workspaceFiles,
        sessions: action.state.sessions,
        liveSessions: action.state.liveSessions ?? [],
        activeSessionKey: action.state.activeSessionKey ?? '',
        backgroundTasks: action.state.backgroundTasks ?? [],
        taskInspectionSupported: action.state.taskInspectionSupported ?? true,
        taskInspectionMessage: action.state.taskInspectionMessage,
      }
    }

    case 'addMessage': {
      // Replace-by-id, not append. The host re-emits a tool entry when its result
      // arrives, so this same action serves both "new" and "updated" — appending
      // blindly would duplicate every tool pill the moment it finished.
      const index = state.entries.findIndex(e => e.id === action.entry.id)
      if (index !== -1) {
        const entries = [...state.entries]
        entries[index] = action.entry
        return { ...state, entries }
      }
      // New entry: append, then enforce the transcript cap. Eviction prunes the
      // thinking blocks anchored to evicted assistant entries in the same step,
      // so no sidecar outlives the row it belongs to.
      const { capped, evicted } = capEntries([...state.entries, action.entry])
      return {
        ...state,
        entries: capped,
        thinkingBlocks: pruneThinkingBlocks(state.thinkingBlocks, evicted),
      }
    }

    case 'appendPartial': {
      // ── THINKING DELTAS ARE IGNORED HERE, DELIBERATELY ──────────────────────
      //
      // Reasoning text arrives as its own correlated `updateThinking` message, which
      // carries the block's identity, its bounded text and its duration. This channel
      // has only an entry id, so accumulating from it would build a SECOND, weaker copy
      // of the same reasoning and the two would disagree about where a block starts and
      // ends. See `ThinkingEntryView`.
      if (action.kind === 'thinking') return state

      const index = findEntryIndexFromEnd(state.entries, action.id)
      // A delta for an entry we do not have means the webview was re-created
      // mid-stream and the host has not resynced yet. Dropping it is right: the
      // host's copy is authoritative and the next `init` carries the full text.
      if (index === -1) return state

      const target = state.entries[index]
      if (target?.kind !== 'assistant') return state

      const entries = [...state.entries]
      entries[index] = {
        ...target,
        text: target.text + action.delta,
        streaming: true,
      }
      return { ...state, entries }
    }

    case 'completeMessage': {
      const index = state.entries.findIndex(e => e.id === action.id)
      if (index === -1) return state
      const target = state.entries[index]
      if (target?.kind !== 'assistant') return state

      const entries = [...state.entries]
      entries[index] = { ...target, streaming: false }
      return { ...state, entries }
    }

    case 'turnState':
      return {
        ...state,
        turnRunning: action.running,
        // `turnProgress` is deliberately NOT cleared here. The host leaves it in place
        // with a terminal phase so the completion line can render after the turn, and on
        // the rising edge it has already sent the next turn's `starting` progress — this
        // message arrives second, so clearing would discard it.
      }

    case 'removeEntry':
      return {
        ...state,
        entries: state.entries.filter(e => e.id !== action.id),
      }

    case 'setModelInfo':
      return { ...state, modelInfo: action.info }

    case 'setModelCatalogue':
      return { ...state, modelCatalogue: action.catalogue }

    case 'setInferenceSettings':
      // Acknowledged state only — see the protocol comment on setInferenceSettings.
      return { ...state, inference: action.settings }

    case 'setProviderSetup':
      // The host owns this surface's state so it survives a webview re-creation.
      return { ...state, providerSetup: action.setup }

    case 'setModelChooser':
      // Host-owned for the same reason: a chooser opened by a command must survive the
      // panel being collapsed and rebuilt.
      return { ...state, modelChooser: action.chooser }

    case 'setAttachment':
      return { ...state, attachment: action.attachment }

    case 'setPermissionMode':
      // Sent only AFTER the engine accepted the change, so the pill always reflects
      // what is enforced rather than what was requested.
      return { ...state, permissionMode: action.mode }

    case 'showPermissionRequest': {
      // Replace-by-id so a resync that re-sends a card cannot show it twice.
      const without = state.pendingPermissions.filter(
        p => p.requestId !== action.request.requestId,
      )
      return { ...state, pendingPermissions: [...without, action.request] }
    }

    case 'dismissPermissionRequest':
      return {
        ...state,
        pendingPermissions: state.pendingPermissions.filter(
          p => p.requestId !== action.requestId,
        ),
      }

    case 'showError':
      // Oldest-first eviction: notices are alerts, not transcript — the newest are
      // the readable ones, and a flapping background error must not grow the array
      // (and its rendered DOM) without bound.
      return { ...state, notices: [...state.notices, action.message].slice(-MAX_NOTICES) }

    case 'setCommands':
      return { ...state, commands: action.commands }

    case 'fileSearchResults':
      return { ...state, workspaceFiles: action.files }

    case 'setContextUsage':
      return {
        ...state,
        contextUsage: {
          percentage: action.percentage,
          totalTokens: action.totalTokens,
          maxTokens: action.maxTokens,
          stale: action.stale,
        },
      }

    case 'setMcpServers':
      return { ...state, mcpServers: action.servers }

    case 'setRuntimeCatalogue':
      return {
        ...state,
        runtimeCapabilities: action.capabilities,
        runtimeCommands: action.commands,
        runtimeTools: action.tools,
        runtimeAgents: action.agents ?? state.runtimeAgents,
        runtimePlugins: action.plugins ?? state.runtimePlugins,
        runtimeSkills: action.skills ?? state.runtimeSkills,
        runtimeWorkflows: action.workflows ?? state.runtimeWorkflows,
      }

    case 'setRateLimit':
      return { ...state, rateLimit: action.rateLimit }

    case 'setEngineAuthStatus':
      return { ...state, engineAuthStatus: action.status }

    case 'setSessionStatus':
      return { ...state, sessionStatus: action.status }

    case 'setPromptSuggestion':
      return { ...state, promptSuggestion: action.suggestion }

    case 'showMcpElicitation': {
      const without = state.mcpElicitations.filter(
        request => request.requestId !== action.request.requestId,
      )
      return { ...state, mcpElicitations: [...without, action.request] }
    }

    case 'dismissMcpElicitation':
      return {
        ...state,
        mcpElicitations: state.mcpElicitations.filter(
          request => request.requestId !== action.requestId,
        ),
      }

    case 'setIdeContext':
      // Replaced outright, including with null: a cleared selection must remove the
      // indicator, and "keep the previous value" is how a stale range gets attached.
      return { ...state, ideContext: action.context }

    case 'setSessions':
      return { ...state, sessions: action.list }

    case 'setLiveSessions':
      return { ...state, liveSessions: action.sessions, activeSessionKey: action.activeKey }

    case 'setTurnProgress':
      // Whole-value replacement: the host sends a complete snapshot each time, so there
      // is nothing to merge and merging would risk keeping a stale tool label.
      return { ...state, turnProgress: action.progress }

    case 'turnCompleted':
      return {
        ...state,
        turnCompletions: {
          ...state.turnCompletions,
          [action.turnId]: action.completion,
        },
      }

    case 'updateThinking':
      // Replace-by-entryId. The same block is re-sent as it grows and once more when it
      // settles with its duration, so appending would render the reasoning per delta.
      return {
        ...state,
        thinkingBlocks: {
          ...state.thinkingBlocks,
          [action.thinking.entryId]: action.thinking,
        },
      }

    case 'appendToolOutput': {
      // Named `append` for symmetry with `appendPartial`, but the payload REPLACES the
      // body: the host sends a cumulative snapshot of a bounded tail, so concatenating
      // would repeat everything already shown on every frame. See the protocol comment.
      const index = findEntryIndexFromEnd(state.entries, action.id)
      if (index === -1) return state
      const target = state.entries[index]
      // Only a running row. A frame that arrives after the result must not overwrite the
      // authoritative output with a stale tail.
      if (target?.kind !== 'tool' || target.status !== 'running') return state
      const entries = [...state.entries]
      entries[index] = { ...target, output: action.text }
      return { ...state, entries }
    }

    case 'replaceTaskState':
      return {
        ...state,
        backgroundTasks: action.tasks,
        taskInspectionSupported: action.supported,
        taskInspectionMessage: action.message,
      }

    case 'upsertTaskState': {
      const index = state.backgroundTasks.findIndex(task => task.key === action.task.key)
      if (index === -1) {
        return { ...state, backgroundTasks: [action.task, ...state.backgroundTasks] }
      }
      const backgroundTasks = [...state.backgroundTasks]
      const current = backgroundTasks[index]
      // Do not let a late progress event revive a terminal task in the browser even
      // if an older host happens to send events out of order.
      const terminal = current && (
        current.status === 'completed' || current.status === 'failed' || current.status === 'stopped'
      )
      const incomingActive = action.task.status === 'running' || action.task.status === 'pending'
      if (terminal && incomingActive) return state
      backgroundTasks[index] = action.task
      return { ...state, backgroundTasks }
    }

    default:
      return state
  }
}
