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
  ContextUsageView,
  EntryId,
  McpServerView,
  ModelCatalogueView,
  ModelInfoView,
  PermissionModeView,
  AttachmentView,
  PermissionRequestView,
  ProviderSetupView,
  SessionSummaryView,
  SlashCommandView,
  TranscriptEntry,
  WebviewState,
} from '../../shared/webviewProtocol.js'
import { DEFAULT_PERMISSION_MODE } from '../../shared/permissionModes.js'
import type { InferenceSettingsView } from '../../shared/inferenceSettings.js'

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
  /** Non-fatal problems, newest last. Rendered inline, not as toasts. */
  notices: string[]
  /** Available slash commands. */
  commands: SlashCommandView[]
  /** Context usage percentage and tokens. */
  contextUsage: ContextUsageView | null
  /** Connected MCP servers. */
  mcpServers: McpServerView[]
  /** Workspace files matching current @-search. */
  workspaceFiles: string[]
  /** Previous sessions for workspace. */
  /** `undefined` until first fetched; `[]` means fetched and there are none. */
  sessions: SessionSummaryView[] | undefined
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
  workspaceFiles: [],
  sessions: undefined,
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
  | { type: 'setAttachment'; attachment: AttachmentView }
  | { type: 'setPermissionMode'; mode: PermissionModeView }
  | { type: 'showPermissionRequest'; request: PermissionRequestView }
  | { type: 'dismissPermissionRequest'; requestId: string }
  | { type: 'showError'; message: string }
  | { type: 'removeEntry'; id: EntryId }
  | { type: 'setCommands'; commands: SlashCommandView[] }
  | { type: 'fileSearchResults'; query: string; files: string[] }
  | { type: 'setContextUsage'; percentage: number; totalTokens?: number; maxTokens?: number; stale?: boolean }
  | { type: 'setMcpServers'; servers: McpServerView[] }
  | { type: 'setSessions'; sessions: SessionSummaryView[] }

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'init':
      // A FULL replacement. Merging would let a stale local entry survive a resync
      // and diverge from the host's copy with no way to notice.
      return {
        session: action.state,
        entries: action.state.transcript,
        turnRunning: action.state.turnRunning,
        modelInfo: action.state.modelInfo,
        modelCatalogue: action.state.modelCatalogue,
        inference: action.state.inference,
        providerSetup: action.state.providerSetup,
        attachment: action.state.attachment,
        permissionMode: action.state.permissionMode,
        // Restored, because the engine stays blocked across a webview re-creation.
        pendingPermissions: action.state.pendingPermissions,
        notices: [],
        commands: action.state.commands ?? [],
        contextUsage: action.state.contextUsage ?? null,
        mcpServers: action.state.mcpServers ?? [],
        workspaceFiles: state.workspaceFiles,
        sessions: action.state.sessions ?? [],
      }

    case 'addMessage': {
      // Replace-by-id, not append. The host re-emits a tool entry when its result
      // arrives, so this same action serves both "new" and "updated" — appending
      // blindly would duplicate every tool pill the moment it finished.
      const index = state.entries.findIndex(e => e.id === action.entry.id)
      if (index === -1) {
        return { ...state, entries: [...state.entries, action.entry] }
      }
      const entries = [...state.entries]
      entries[index] = action.entry
      return { ...state, entries }
    }

    case 'appendPartial': {
      const index = state.entries.findIndex(e => e.id === action.id)
      // A delta for an entry we do not have means the webview was re-created
      // mid-stream and the host has not resynced yet. Dropping it is right: the
      // host's copy is authoritative and the next `init` carries the full text.
      if (index === -1) return state

      const target = state.entries[index]
      if (target?.kind !== 'assistant') return state

      // Thinking is relayed live but not accumulated into the visible answer.
      // Rendering it inline would interleave reasoning with prose.
      if (action.kind === 'thinking') return state

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
      return { ...state, turnRunning: action.running }

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
      return { ...state, notices: [...state.notices, action.message] }

    case 'removeEntry':
      return {
        ...state,
        entries: state.entries.filter(e => e.id !== action.id),
      }

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

    case 'setSessions':
      return { ...state, sessions: action.sessions }

    default:
      return state
  }
}
