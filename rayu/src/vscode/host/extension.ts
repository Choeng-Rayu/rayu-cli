/**
 * Rayucode — extension host entry.
 *
 * Bundled to `extension.js` as CommonJS by `scripts/build-vscode.ts`, with
 * `vscode` left external because the editor injects it at load time.
 *
 * ── WHY THIS BUNDLE MUST BE CommonJS ───────────────────────────────────────────
 *
 * VS Code loads extensions with `require()`; it has no support for ESM extension
 * entrypoints (microsoft/vscode#130367, #209560). An ESM `extension.js` fails at
 * activation with a module-format error, and the failure is reported as the
 * extension not activating rather than as a format problem. `sharedBuildOptions()`
 * emits ESM for the CLI, so this bundle overrides `format` — see the build script.
 *
 * ── WHAT ACTIVATION DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 * It does not start the engine during activation. Activation runs on the extension
 * host's startup path, and spawning a 23 MB Node process there would add that cost
 * to every window whether or not Rayucode is used. The engine is prewarmed once the
 * authenticated chat panel mounts, so initialization happens while the user reads
 * the panel and types instead of after their first message.
 */
import * as vscode from 'vscode'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { API_IMAGE_MAX_BASE64_SIZE, API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'

import { CHAT_VIEW_ID } from './panel/chatViewProvider.js'
import { ChatSession, type ConversationStateSnapshot } from './panel/sessionHandle.js'
import { watchMcpConnection } from './panel/mcpConnectionUi.js'
import {
  SessionRegistry,
  type SessionEntry,
} from './panel/sessionRegistry.js'
import { SurfaceRegistry } from './panel/surfaceRegistry.js'
import {
  dispatchWebviewMessage,
  type ChatViewHandlers,
  type SurfaceScope,
} from './panel/webviewDispatch.js'
import { SESSION_PANEL_VIEW_TYPE, type ChatSurface } from './panel/webviewSurface.js'
import { PermissionRouter } from './panel/permissionRouter.js'
import { invalidateRayuConfigCache } from '../../utils/rayuConfig.js'
import { readModelOptions, readActiveModel } from './models/modelConfig.js'
import { CatalogueRefresher } from './models/catalogueRefresh.js'
import { nextPermissionMode, permissionModeById } from '../shared/permissionModes.js'
import { formatPathMentions } from '../shared/contextMentions.js'
import {
  getAccessTokenForHost,
  getApiBaseUrlForHost,
  getAuthSnapshot,
  hasAccountSession,
  signOutShared,
} from './auth/rayuAuthBridge.js'
import { signInFromEditor, type SignInOptions } from './auth/vscodeLogin.js'
import {
  RAYU_FEEDBACK_MAX_MESSAGE,
  submitRayuFeedback,
} from '../../services/rayuAuth/rayuFeedback.js'
import { watchSharedSession } from './auth/authWatcher.js'
import { checkTurnAllowed } from './auth/signInGate.js'
import { beginGuestPairing, guestPairingStatus, stopGuestPairing } from '../../webBridge/guestPairing.js'
import { resolveHostname } from '../../webBridge/client/index.js'
import { VSCodeWebBridge, vscodeBridgeMachineId } from './webBridge/vscodeWebBridge.js'
import { showBridgePairingPanel } from './webBridge/pairingPanel.js'
import {
  openReviewDiff,
  openReviewFile,
  registerReviewStore,
  reviewCommand,
} from './review/fileChangeReview.js'
import type { AttachTargetFrame } from '../shared/connectProtocol.js'
import {
  listAttachTargets,
  listProviderPresets,
  refreshProviderCatalogue,
  saveProvider,
  validateProvider,
} from './auth/providerSetup.js'
import {
  attachToCliSession,
  toAttachableView,
  type CliAttachment,
  type AttachmentCallbacks,
} from './attach/cliAttachment.js'
import { trackEditorSelection } from './ide/editorSelection.js'
import { startIdeServer } from './ide/ideServer.js'
import { runGitHubSetupFromEditor } from './github/githubSetup.js'
import {
  listWorkspaceSessions,
  loadSessionTranscript,
  renameWorkspaceSession,
} from './sessionHistory.js'
import {
  applySelection,
  buildChooser,
  describeSelection,
  parseModelSettingCommand,
  type ModelSettingCommand,
} from './models/modelSettingCommands.js'
import type {
  BackgroundTaskView,
  ChatSurfaceKind,
  LiveSessionView,
  ModelCatalogueView,
  ModelChooserView,
  IdeContextView,
  SessionListView,
  AttachmentView,
  ProviderSetupView,
  SessionSummaryView,
  ImageInputView,
  PromptDeliveryView,
  SurfaceBindingView,
  WebviewState,
  McpConnectionUiView,
} from '../shared/webviewProtocol.js'

/** Command ids, kept in one place so the manifest and the code cannot drift. */
const COMMANDS = {
  newSession: 'rayucode.newSession',
  signIn: 'rayucode.signIn',
  signOut: 'rayucode.signOut',
  addTerminalSelection: 'rayucode.addTerminalSelection',
  addToContext: 'rayucode.addToContext',
  feedback: 'rayucode.feedback',
} as const

/**
 * Resolve a workspace path the exact same way `getOriginalCwd()` does in
 * `src/bootstrap/state.ts`: realpath (symlinks resolved) then NFC-normalized.
 *
 * This is what `~/.rayu/sessions/<pid>.json` records as `cwd` when the terminal CLI
 * registers itself, and the attach-list handler filters session records with a strict
 * `===` against whatever cwd it is given. Comparing an un-resolved VS Code path
 * against a resolved CLI path is a silent, permanent mismatch — not a transient one a
 * retry or a refresh fixes — because the two strings simply never converge. Falls back
 * to the raw path on any `realpathSync` failure (path doesn't exist yet, or a
 * CloudStorage mount returning EPERM on a per-component `lstat`), matching the same
 * fallback `getOriginalCwd()` uses, so a filter that can't resolve degrades to "match
 * literally" rather than throwing.
 */
function normalizeCwdForAttachLookup(path: string): string {
  try {
    return realpathSync(path).normalize('NFC')
  } catch {
    return path.normalize('NFC')
  }
}

/**
 * The `@`-mention file/folder search's query-to-glob decision, and the local filter, if
 * any, still needed after VS Code's own glob search returns. Pure — no `vscode`
 * dependency — so this is unit-testable directly.
 *
 * ── TWO BUGS, TWO FIXES, IN SEQUENCE ────────────────────────────────────────────
 *
 * Bug 1 (fixed first, then this fix broke a second thing): the original glob spliced
 * the raw query straight into a pattern, `**` + `/*` + `${query}` + `*`. That breaks the
 * instant the query contains a `/` — which happens exactly when a user drills into a
 * folder by typing its name (`@src/vscode`) — because `/` inside a glob is a
 * path-segment BOUNDARY, not a literal character. `**` + `/*src/vscode*` means "a
 * segment ending in src immediately followed by a segment starting with vscode", which
 * almost nothing satisfies. The first fix replaced the glob-based query entirely with an
 * unbounded raw fetch (`**` + `/*`, capped at some N) followed by a plain substring
 * filter in JS — correct for matching, but wrong for SCALE.
 *
 * Bug 2 (what this function actually exists to fix): on a real multi-project monorepo
 * workspace, "everything under the workspace root" can be tens of thousands of files
 * (confirmed: 47,317 in the reported case). `vscode.workspace.findFiles` truncates at
 * whatever cap is passed, in whatever order its own file walker enumerates — which is
 * NOT query-aware, so a query like "AGENTS.md" that matches files in three different
 * sibling subprojects can have two of the three matches fall outside the truncation
 * window entirely, before the query filter is ever applied. Raising the cap only moves
 * the cliff edge further out; it does not remove it, and a workspace can always be
 * bigger than whatever fixed number is chosen.
 *
 * The actual fix is to give VS Code's OWN search engine the query again, so it can do
 * the deep, efficient, non-enumerating search it is built for (backed by ripgrep, not a
 * JS array scan) — but build the glob CORRECTLY this time by splitting on the last `/`:
 *
 *   - No slash in the query (the common case — typing a filename or a fragment of one):
 *     the query becomes the FILENAME portion of a scoped glob, `**` + `/*<query>*`,
 *     glob-escaped. This recurses through every folder in the workspace at once,
 *     efficiently, and needs no further filtering.
 *   - A slash in the query (drilling into a folder): everything up to the LAST slash is
 *     a literal directory path, not a fragment to fuzzy-match — the user typed or
 *     selected that exact folder. The glob anchors to that literal path and recurses
 *     under it (`**` + `/<dirPath>/**`), which VS Code's engine only has to search WITHIN
 *     — a small subtree, not the whole workspace, so this stays fast even on a huge
 *     monorepo. The portion after the last slash (if any) is then matched as a plain
 *     substring against the scoped results, exactly as `buildFileSearchResults` already
 *     does for the no-slash case.
 */
export function buildFileSearchGlob(query: string): {
  glob: string
  /** The leaf fragment still needing a substring match after the glob narrows scope. */
  leafFilter: string
} {
  const lastSlash = query.lastIndexOf('/')
  if (lastSlash === -1) {
    return {
      glob: query ? `**/*${escapeGlob(query)}*` : '**/*',
      leafFilter: '',
    }
  }
  const dirPath = query.slice(0, lastSlash)
  const leafFilter = query.slice(lastSlash + 1)
  return {
    glob: `**/${escapeGlobPath(dirPath)}/**`,
    leafFilter,
  }
}

/** Escapes glob metacharacters in a single path segment (no `/` expected in it). */
function escapeGlob(segment: string): string {
  return segment.replace(/[*?[\]{}()!]/g, char => `\\${char}`)
}

/** Escapes glob metacharacters in each segment of a literal path, preserving its `/`s. */
function escapeGlobPath(path: string): string {
  return path.split('/').map(escapeGlob).join('/')
}

/**
 * The `@`-mention file/folder search's local post-processing — no `vscode` dependency,
 * so this is unit-testable directly.
 *
 * `relativePaths` here are already the OUTPUT of the glob built by
 * `buildFileSearchGlob` — a set VS Code's own search has already narrowed to files
 * relevant to the query, not the whole workspace. `leafFilter` (from the same function)
 * is applied as a plain substring match, which is safe to do in JS now because the input
 * set is already small: VS Code's glob did the expensive, workspace-wide part.
 *
 * ── FOLDERS ARE DERIVED FROM THE FULL SET, NOT THE ALREADY-FILTERED ONE ────────
 *
 * Parent folders are derived from every candidate BEFORE the leaf filter is applied,
 * then filtered the same way — a query like "src" must still offer the folder "src/"
 * itself (which contains "src") even though most of that folder's own children might
 * not.
 */
export function buildFileSearchResults(
  relativePaths: readonly string[],
  leafFilter: string,
  displayLimit = 75,
): string[] {
  const q = leafFilter.toLowerCase()
  const matches = (candidate: string): boolean => !q || candidate.toLowerCase().includes(q)

  const files = relativePaths.filter(matches)

  const folders = new Set<string>()
  for (const file of relativePaths) {
    const parts = file.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const folder = `${parts.slice(0, index).join('/')}/`
      if (matches(folder)) folders.add(folder)
    }
  }

  return [...folders, ...files].slice(0, displayLimit)
}

export function activate(context: vscode.ExtensionContext): void {
  // Provider selection and credentials belong to Rayucode, independently of the
  // terminal CLI. General Rayu storage remains untouched, so history, sessions,
  // skills, rules, and IDE discovery continue to be shared. The explicit override
  // exists for the extension-host fixture and controlled portable installations.
  process.env.RAYU_AUTH_CONFIG_DIR =
    process.env.RAYUCODE_AUTH_CONFIG_DIR || context.globalStorageUri.fsPath
  invalidateRayuConfigCache()

  const version =
    (context.extension.packageJSON as { version?: string }).version ?? '0.0.0'

  // `engine.mjs` is staged at the extension root by scripts/build-vscode.ts. It is
  // spawned, never required, so it does not enter this bundle's import graph.
  const enginePath = vscode.Uri.joinPath(context.extensionUri, 'engine.mjs').fsPath

  /**
   * Provider setup surface state, owned by the host.
   *
   * Held here rather than in the webview so it survives the webview being destroyed and
   * re-created (which VS Code does freely when the view is hidden). Deliberately holds
   * NO credential: keys pass through the handlers and are never stored.
   */
  let providerSetup: ProviderSetupView = {
    open: false,
    // undefined = not fetched yet, so the panel can say "loading" rather than "none".
    presets: undefined,
    busy: false,
    busyMessage: null,
    error: null,
    discoveredModels: null,
    connectedProviderId: null,
    connectedModel: null,
  }
  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const activeFile = vscode.window.activeTextEditor?.document.uri
  // Never use the installed extension directory as a conversation cwd. In an empty
  // window, prefer the active file's directory and otherwise use the user's home.
  const engineCwd =
    workspaceDir ??
    (activeFile?.scheme === 'file' ? dirname(activeFile.fsPath) : homedir())
  // The terminal CLI registers its session under `getOriginalCwd()`
  // (`src/bootstrap/state.ts`), which resolves symlinks and NFC-normalizes the path
  // before writing `~/.rayu/sessions/<pid>.json`. `engineCwd` above is VS Code's raw
  // `workspaceFolders[0].uri.fsPath` — never realpath'd. On any workspace whose path
  // crosses a symlink (a home-directory symlink, a cloud-synced folder, `/tmp` vs
  // `/private/tmp` on macOS), an exact string match between the two would silently
  // fail: a session that just exited would still look "present" until its stale file
  // is swept by PID, and a brand-new terminal session would never match at all, no
  // matter how many times the attach dropdown is reopened. This is the STRING USED
  // FOR ATTACH-LIST COMPARISON ONLY — the engine still spawns with the unresolved
  // `engineCwd` above, since that is just a working directory, not a lookup key.
  const engineCwdRealpath = normalizeCwdForAttachLookup(engineCwd)

  // ── SURFACES ─────────────────────────────────────────────────────────────────
  // The chat now lives on several surfaces at once: the sidebar view and one editor
  // tab per open conversation. `surfaces` (constructed below, after the registry)
  // owns them all — fan-out, per-session routing, and the serializer's revival.
  // The sidebar is the management hub; conversations live in their tabs, and prompt
  // text is delivered to the active conversation's tab (`insertPromptIntoTab`).
  // `sidebar` is the sidebar surface handle, held only for the few host actions
  // that are genuinely sidebar-shaped (reveal, the sidebar's own snapshot).
  let sidebar: ChatSurface | undefined
  let surfaces: SurfaceRegistry
  let webBridge: { entry: SessionEntry; handle: VSCodeWebBridge } | null = null
  let pairingEntry: SessionEntry | null = null
  let webBridgeCommandGeneration = 0

  // Cards are dismissed, never auto-answered, when they stop being answerable. See
  // permissionRouter.ts: fabricating a denial would reject a tool the user was
  // mid-way through approving.
  // Serves the reconstructed pre-edit content for diffs. Registered here so it is
  // disposed with the extension, and so the session's review callback can feed it.
  const review = registerReviewStore()
  context.subscriptions.push(review.disposable, review.store)

  /**
   * Open or close the provider setup surface.
   *
   * A named function because two entry points reach it: the webview's explicit
   * `providerSetupOpen`, and the "connect a provider" affordance on the welcome screen.
   * Both must show the same surface in the same state.
   */
  async function openProviderSetupSurface(open: boolean): Promise<void> {
    providerSetup = { ...providerSetup, open, error: null }
    surfaces.broadcast({ type: 'setProviderSetup', setup: providerSetup })
    if (!open) return

    // Fetched once. The preset list is static for a given install, so refetching would
    // spawn a child process for data that cannot have changed.
    if (providerSetup.presets !== undefined) return

    providerSetup = { ...providerSetup, busy: true, busyMessage: 'Loading providers…' }
    surfaces.broadcast({ type: 'setProviderSetup', setup: providerSetup })

    const outcome = await listProviderPresets({ enginePath, cwd: engineCwd })
    providerSetup = {
      ...providerSetup,
      busy: false,
      busyMessage: null,
      presets: outcome.presets ?? [],
      error: outcome.ok ? null : (outcome.error ?? 'Could not load providers.'),
    }
    surfaces.broadcast({ type: 'setProviderSetup', setup: providerSetup })
  }

  /**
   * Attachment state, host-owned.
   *
   * `targets` retains the discovered records INCLUDING their IPC tokens; `attachment` is
   * the token-free projection sent to the webview. Keeping them separate is what makes it
   * impossible to leak a token by posting state.
   */
  let attachTargets: AttachTargetFrame[] = []
  /**
   * The sessions list AND its load state.
   *
   * A bare array could only say "not fetched" or "here they are", so a failed read and an
   * empty workspace were rendered identically. The list is retained across a failure so a
   * stale-but-real list beats blanking the surface.
   */
  let historySessions: SessionListView = { status: 'loading', sessions: [] }
  let mcpUi: McpConnectionUiView = { load: 'idle', error: null, auth: null }
  let mcpUiSessionKey = ''
  let mcpFlowId = 0
  let attachment: AttachmentView = { available: undefined, attached: null, error: null }
  // The handle, restoration snapshots, and capability state have the same owner.
  // A pending attachment also owns its session, so it cannot start a local turn.
  let liveAttachment: {
    entry: SessionEntry
    target: AttachTargetFrame
    handle: CliAttachment | null
    conversation: ConversationStateSnapshot
    tasks: BackgroundTaskView[]
    taskInspectionSupported: boolean
    taskInspectionMessage?: string
  } | null = null
  /**
   * The open model chooser, if any.
   *
   * Held here as well as posted so `buildState` carries it: VS Code re-creates the webview
   * freely, and a chooser the user just opened must not vanish when they collapse the panel.
   */
  let modelChooser: ModelChooserView | null = null
  /** The editor's current file/selection, mirrored for `buildState`. */
  let ideContext: IdeContextView | null = null

  function postAttachment(): void {
    for (const entry of registry.all) {
      surfaces.postToSession(entry.key, { type: 'setAttachment', attachment: attachmentForEntry(entry) })
    }
  }

  function attachedFor(sessionKey: string): typeof liveAttachment {
    return liveAttachment?.entry.key === sessionKey ? liveAttachment : null
  }

  function attachmentForEntry(entry: SessionEntry): AttachmentView {
    const owned = attachedFor(entry.key)
    return { ...attachment, attached: owned?.handle ? toAttachableView(owned.target) : null }
  }

  /** Set and publish the chooser in one step, so the two cannot disagree. */
  function setModelChooser(chooser: ModelChooserView | null): void {
    modelChooser = chooser
    surfaces.broadcast({ type: 'setModelChooser', chooser })
  }

  // ── EDITOR CONNECTION ────────────────────────────────────────────────────────  //
  // Publishes the same `~/.rayu/ide/<port>.lock` the CLI already scans for, so a `rayu`
  // running in this window's terminal attaches to this editor and sees its selection.
  //
  // It is started BEFORE the session so the engine child can be pointed at it (see
  // its `env` below): the child discovers the editor through the CLI’s own lockfile
  // scan, and `CLAUDE_CODE_SSE_PORT` tells that scan which port is ours. Failure is still
  // non-fatal — the connection is an enhancement, not a prerequisite — so a null handle
  // simply means no live editor context.
  const idePromise = startIdeServer(version)
    .then(handle => {
      if (!handle) return null
      context.subscriptions.push({ dispose: () => void handle.dispose() })
      context.subscriptions.push(
        trackEditorSelection(handle, context_ => {
          ideContext = context_
          surfaces.broadcast({ type: 'setIdeContext', context: context_ })
        }),
      )
      return handle
    })
    .catch(() => null)

  /**
   * The panel's open conversations.
   *
   * ── EVERY PUSH BELOW IS ROUTED, NOT GATED ─────────────────────────────────────
   *
   * A conversation keeps its own transcript, turn state and cards inside its
   * `ChatSession`; the callbacks here are purely a PUSH channel to the surfaces.
   * Each push is routed by `surfaces.postToSession(entry.key, …)`, which reaches the
   * conversation's editor tab and — while that conversation is the active one — the
   * sidebar, WITHOUT an `isActive()` gate: a background tab must keep streaming.
   * A conversation with no surface showing it still accrues state, and the next
   * full sync reconstructs it.
   */
  // Login writes credentials before it finishes preparing the hosted provider.
  // Keep all new engines behind that complete handoff, including the first prompt.
  let signInPending: Promise<void> | null = null
  const registry = new SessionRegistry(
    {
      enginePath,
      cwd: engineCwd,
      prepareStartup: waitForStartupPreparation,
      // Points the child's own lockfile scan at THIS window's editor connection. This is
      // the mechanism an editor extension is expected to use — `detectIDEs` treats a
      // matching `CLAUDE_CODE_SSE_PORT` as authoritative, which also disambiguates a
      // workspace that has several editor windows open on it.
      //
      // Resolved at SPAWN time rather than here: the port is only known once the socket is
      // bound, and awaiting that during activation would delay the whole extension for
      // something the first turn does not need yet.
      resolveEnv: async () => {
        const handle = await idePromise
        return handle ? { CLAUDE_CODE_SSE_PORT: String(handle.port) } : {}
      },
    },
    {
      // No `isActive` gate: every push is routed to this conversation's surfaces —
      // see the registry construction comment above.
      sessionCallbacks: (entry, _isActive) => ({
        onEntry: message => {
          if (webBridge?.entry === entry) webBridge.handle.onEntry(message)
          surfaces.postToSession(entry.key, { type: 'addMessage', entry: message })
          // The live list shows a per-session label and running flag, both of which an
          // entry can change — so it is refreshed alongside the push.
          postLiveSessions()
        },
        onPartial: (id, kind, delta) => {
          if (webBridge?.entry === entry) webBridge.handle.onPartial(id, kind, delta)
          // Text only: the webview builds reasoning from `updateThinking` and drops thinking
          // deltas on arrival (see the reducer), so posting them is pure IPC overhead.
          if (kind === 'text') surfaces.postToSession(entry.key, { type: 'appendPartial', id, kind, delta })
        },
        onComplete: id => {
          surfaces.postToSession(entry.key, { type: 'completeMessage', id })
        },
        onTurnState: running => {
          if (webBridge?.entry === entry) webBridge.handle.onTurnState(running)
          surfaces.postToSession(entry.key, { type: 'turnState', running })
          postLiveSessions()
        },
        // A running tool's live output goes to the conversation's surfaces — a
        // background tab's tool row is exactly where it renders.
        onToolOutput: (id, text) => {
          surfaces.postToSession(entry.key, { type: 'appendToolOutput', id, text })
        },
        onModelInfo: info => {
          surfaces.postToSession(entry.key, { type: 'setModelInfo', info })
          // The engine's catalogue is authoritative for what the active provider can
          // actually serve, so re-publish once it has reported.
          surfaces.postToSession(entry.key, {
            type: 'setModelCatalogue',
            catalogue: buildCatalogue(entry.session),
          })
        },
        onSessionIdChanged: () => {
          postSurfaceBinding(entry)
          postLiveSessions()
        },
        onError: message => {
          // ── A SESSION WITH A VISIBLE SURFACE IS ALREADY COVERED BY ITS TRANSCRIPT ─
          //
          // `reportError` records every failure as a `notice` entry in the failing
          // session's own transcript, in chronological position. Posting `showError`
          // as well would render the same failure twice — once inline where it
          // happened, once in the trailing notices list — for any surface showing
          // that conversation.
          //
          // A conversation NO surface is showing is the case the transcript cannot
          // cover: the entry exists, but in a transcript the user is not reading, and
          // the session they are waiting on must not fail silently. So the alert is
          // posted to the ACTIVE session's surfaces — where the user is — prefixed
          // so they know which conversation it was about. Routing it to
          // `postToSession(entry.key, …)` would deliver it to nobody: no surface is
          // bound to that key at this point.
          if (!surfaces.panelFor(entry.key) && registry.activeSessionKey !== entry.key) {
            surfaces.postToSession(registry.activeSessionKey, {
              type: 'showError',
              message: `${labelOf(entry)}: ${message}`,
            })
          }
        },
        // Routed to the OWNING session's router, never the active one: a card belongs to the
        // engine that is blocked on it.
        onPermissionRequest: request => {
          entry.permissions.present(request)
          if (webBridge?.entry === entry) webBridge.handle.onPermissionRequest(request)
        },
        onPermissionCancelled: requestId => {
          entry.permissions.engineCancelled(requestId)
          if (webBridge?.entry === entry) webBridge.handle.onPermissionDismiss(requestId)
        },
        onSessionEnded: () => entry.permissions.cancelAll(),
        // The review card is the one entry that can stop existing: once everything is
        // kept or undone there is nothing left to act on.
        onReviewCleared: id => {
          surfaces.postToSession(entry.key, { type: 'removeEntry', id })
        },
        // Hunks stay host-side; the editor draws the diff from them. The store is
        // keyed by (sessionKey, displayPath), so every conversation owns its records.
        onReviewFiles: files => {
          review.store.replace(entry.key, files)
        },
        onInferenceSettings: settings => {
          surfaces.postToSession(entry.key, { type: 'setInferenceSettings', settings })
        },
        onPermissionMode: mode => {
          surfaces.postToSession(entry.key, { type: 'setPermissionMode', mode })
        },
        onCommands: commands => {
          surfaces.postToSession(entry.key, { type: 'setCommands', commands })
        },
        onContextUsage: usage => {
          surfaces.postToSession(entry.key, {
            type: 'setContextUsage',
            percentage: usage.percentage,
            totalTokens: usage.totalTokens,
            maxTokens: usage.maxTokens,
            stale: usage.stale,
          })
        },
        onMcpServers: servers => {
          surfaces.postToSession(entry.key, { type: 'setMcpServers', servers })
        },
        onTurnProgress: progress => {
          surfaces.postToSession(entry.key, { type: 'setTurnProgress', progress })
        },
        onTurnCompleted: (turnId, completion) => {
          surfaces.postToSession(entry.key, { type: 'turnCompleted', turnId, completion })
        },
        onThinking: thinking => {
          surfaces.postToSession(entry.key, { type: 'updateThinking', thinking })
        },
        onTaskStateChanged: task => {
          surfaces.postToSession(entry.key, { type: 'upsertTaskState', task })
        },
        onTaskStateReplaced: tasks => {
          surfaces.postToSession(entry.key, { type: 'replaceTaskState', tasks, supported: true })
        },
        onRuntimeCatalogue: (capabilities, commands, tools, resources) => {
          surfaces.postToSession(entry.key, {
            type: 'setRuntimeCatalogue',
            capabilities,
            commands,
            tools,
            ...resources,
          })
        },
        onRateLimit: rateLimit => {
          surfaces.postToSession(entry.key, { type: 'setRateLimit', rateLimit })
        },
        onEngineAuthStatus: status => {
          surfaces.postToSession(entry.key, { type: 'setEngineAuthStatus', status })
        },
        onSessionStatus: status => {
          surfaces.postToSession(entry.key, { type: 'setSessionStatus', status })
        },
        onPromptSuggestion: suggestion => {
          surfaces.postToSession(entry.key, { type: 'setPromptSuggestion', suggestion })
        },
        onMcpElicitation: request => {
          surfaces.postToSession(entry.key, { type: 'showMcpElicitation', request })
        },
        onMcpElicitationCancelled: requestId => {
          surfaces.postToSession(entry.key, { type: 'dismissMcpElicitation', requestId })
        },
      }),
      onShowPermission: (entry, request) => {
        // Unconditional and entry-carrying: a background tab must render its OWN
        // approval card, and the card belongs to the surfaces showing THAT
        // conversation — never to whatever happens to be on screen.
        surfaces.postToSession(entry.key, { type: 'showPermissionRequest', request })
      },
      onDismissPermission: (entry, requestId) => {
        // Gated like `onPermissionCancelled` above: a card's dismissal reaches the
        // bridge only when THAT conversation is the bridged one, so a card answered
        // in another tab cannot dismiss anything on the remote.
        if (webBridge?.entry === entry) webBridge.handle.onPermissionDismiss(requestId)
        surfaces.postToSession(entry.key, { type: 'dismissPermissionRequest', requestId })
      },
      onChanged: () => {
        postLiveSessions()
        // The changed key is not carried, so every tab title is recomputed from the
        // current labels — cheap, idempotent, and never stale.
        for (const entry of registry.all) {
          surfaces.updateTitle(entry.key)
          postSurfaceBinding(entry)
        }
      },
      // The active (sidebar-bound) session changed. One full sync is both simpler and
      // more honest than replaying deltas. The review store is per-session now and is
      // fed by `onReviewFiles`, so nothing is handed over on activation.
      onActivate: entry => {
        if (mcpUiSessionKey !== entry.key) {
          mcpUi = { load: 'idle', error: null, auth: null }
          mcpUiSessionKey = entry.key
        }
        surfaces.syncSession(entry.key)
      },
      // Retired — evicted for capacity, or explicitly closed. Close its tab before
      // its engine goes away, and drop its review records. Idempotent.
      onRetire: entry => {
        if (webBridge?.entry.key === entry.key || pairingEntry?.key === entry.key) {
          webBridgeCommandGeneration++
          webBridge?.handle.stop()
          webBridge = null
          pairingEntry = null
          stopGuestPairing()
        }
        if (attachedFor(entry.key)) detachAttachment(null, false)
        surfaces.closePanel(entry.key)
        // Text parked for a tab that never reached `ready` — its session is gone, so
        // the flush will never come. Without this, closing a just-created tab would
        // leave its queue entry behind forever.
        pendingTabInserts.delete(entry.key)
        review.store.clear(entry.key)
      },
    },
  )

  // ── THE SURFACE REGISTRY ─────────────────────────────────────────────────────
  // Owns the sidebar view and every editor session tab. Panels are bound to one
  // session for their life and are never gated; the sidebar renders
  // `registry.activeSessionKey`. See `panel/surfaceRegistry.ts`.
  //
  // ── ONE SNAPSHOT BUILDER, PARAMETERISED BY SURFACE ────────────────────────────
  //
  // `stateFor` takes the surface it is building for, so the registry posts each
  // surface its OWN flavour: a panel gets `surface: 'panel'` (with a revival
  // binding), the sidebar gets `surface: 'sidebar'`. The webview decides its whole
  // chrome from that one field, so a sidebar init in the panel flavour would mount
  // the conversation in the sidebar. Message-level pushes (`postToSession`,
  // `broadcast`) are unaffected: only `init` is flavoured.
  let lastRevivedSessionKey = ''
  let revivedNeedsRestore = false
  // Prompt text parked for a tab whose webview has not said `ready` yet — see
  // `insertPromptIntoTab`. Keyed by session key; flushed (and cleared) the moment
  // the panel announces itself, so a just-created tab still receives what was
  // meant for it instead of silently dropping it.
  const pendingTabInserts = new Map<string, string[]>()
  surfaces = new SurfaceRegistry({
    extensionUri: context.extensionUri,
    // The sidebar's binding follows the registry's active key, exactly as before:
    // activation (a tab gaining focus, a conversation being created) rebinds it.
    activeSidebarKey: () => registry.activeSessionKey,
    // Built per surface — see the block comment above.
    stateFor: (sessionKey, surface) => buildStateForKey(sessionKey, surface),
    onMessage: (kind, sessionKey, message) => {
      const scope = scopeFor(kind, sessionKey)
      if (message.type === 'ready') {
        // The listener is attached; anything sent before now was dropped. The
        // surface's snapshot is (re)sent HERE — then `handlers.ready` warms the
        // engine for the conversation the surface is bound to.
        if (kind === 'sidebar') surfaces.syncSidebar()
        else {
          surfaces.syncSession(sessionKey)
          const queued = pendingTabInserts.get(sessionKey)
          if (queued) {
            pendingTabInserts.delete(sessionKey)
            for (const text of queued) {
              surfaces.postToSurface('panel', sessionKey, { type: 'insertPrompt', text })
            }
          }
        }
        dispatchWebviewMessage(message, scope, handlers)
        return
      }
      // A surface whose conversation is gone (its tab is closing, or its key is
      // stale) must act on nothing — except the three requests that exist to work
      // without a live conversation.
      if (
        !registry.has(sessionKey) &&
        message.type !== 'openSessionPanel' &&
        message.type !== 'resumeSessionPanel' &&
        message.type !== 'listSessions'
      ) {
        return
      }
      dispatchWebviewMessage(message, scope, handlers)
    },
    // A tab gaining focus makes its conversation the active one, which rebinds
    // the sidebar (`onActivate` → the full sidebar sync).
    onPanelFocused: sessionKey => {
      registry.activate(sessionKey)
    },
    onPanelClosed: sessionKey => {
      surfaces.updateTitle(sessionKey)
    },
    titleFor: sessionKey => {
      const entry = registry.byKey(sessionKey)
      return entry ? labelOf(entry) : 'Session'
    },
    // Resolve a restored tab's revival state. NEVER THROWS: a missing transcript
    // or an unknown id degrades to a fresh conversation (see the plan's risk
    // register) — a failed deserialize would leave the tab blank with no path back.
    reviveBind: restored => {
      revivedNeedsRestore = false
      try {
        if (restored.sessionId) {
          // Already open: bind to it rather than respawning, which would kill a
          // turn that is still running in the existing conversation.
          const existing = registry.findByEngineSessionId(restored.sessionId)
          if (existing) {
            lastRevivedSessionKey = existing.key
            return existing.key
          }
          const entry = registry.create({
            resumeSessionId: restored.sessionId,
            cwd: restored.cwd ?? engineCwd,
            ...(restored.customTitle ? { customTitle: restored.customTitle } : {}),
          })
          revivedNeedsRestore = true
          lastRevivedSessionKey = entry.key
          return entry.key
        }
        const entry = registry.create({
          ...(restored.customTitle ? { customTitle: restored.customTitle } : {}),
        })
        lastRevivedSessionKey = entry.key
        return entry.key
      } catch {
        const entry = registry.create()
        lastRevivedSessionKey = entry.key
        return entry.key
      }
    },
  })

  /** The conversation the sending surface is bound to; null only for a stale key. */
  function entryFor(sessionKey: string): SessionEntry | null {
    return registry.byKey(sessionKey)
  }

  /**
   * Everything a handler needs to act on the surface that sent a message: replies
   * go to THAT surface only, and a resync rebuilds THAT conversation's surfaces.
   */
  function scopeFor(kind: ChatSurfaceKind, sessionKey: string): SurfaceScope {
    return {
      kind,
      sessionKey,
      reply: message => surfaces.postToSurface(kind, sessionKey, message),
      resync: () => surfaces.syncSession(sessionKey),
    }
  }

  /** The registry key of a conversation, for routing its catalogue refresh. */
  function keyForSession(session: ChatSession): string | undefined {
    return registry.all.find(item => item.session === session)?.key
  }

  /** The snapshot for one conversation, flavoured for the surface rendering it. */
  function stateForEntry(entry: SessionEntry, surface: ChatSurfaceKind): WebviewState {
    const owned = attachedFor(entry.key)
    return buildState(
      version,
      entry.session,
      entry.permissions,
      providerSetup,
      modelChooser,
      ideContext,
      attachmentForEntry(entry),
      historySessions,
      registry.summaries(),
      surface === 'panel' ? entry.key : registry.activeSessionKey,
      mcpUi,
      entry.customTitle,
      owned?.taskInspectionSupported ?? true,
      owned?.taskInspectionMessage,
      surface,
      surface === 'panel' ? surfaceBindingFor(entry) : null,
    )
  }

  function surfaceBindingFor(entry: SessionEntry): SurfaceBindingView {
    return {
      sessionKey: entry.key,
      sessionId: entry.session.engineSessionId ?? undefined,
      cwd: entry.session.workingDirectory,
      customTitle: entry.customTitle ?? undefined,
    }
  }

  function postSurfaceBinding(entry: SessionEntry): void {
    surfaces.postToSurface('panel', entry.key, { type: 'setSurfaceBinding', binding: surfaceBindingFor(entry) })
  }

  /** The snapshot for a key, or null when the registry no longer knows it. */
  function buildStateForKey(sessionKey: string, surface: ChatSurfaceKind): WebviewState | null {
    const entry = registry.byKey(sessionKey)
    return entry ? stateForEntry(entry, surface) : null
  }

  /**
   * Deliver prompt text to a conversation's composer — the one place a prompt is typed,
   * now that the sidebar is a management hub with no composer of its own.
   *
   * ── WHY A JUST-CREATED TAB NEEDS THE QUEUE ──────────────────────────────────
   *
   * `postMessage` to a webview whose React listener has not attached yet is dropped by
   * the platform — the same race `ready` exists to solve. An already-open tab is safe to
   * post to directly; one this call just created is not, so its text is parked in
   * `pendingTabInserts` and flushed when the panel announces itself.
   */
  function insertPromptIntoTab(sessionKey: string, text: string): void {
    const existed = surfaces.hasPanel(sessionKey)
    surfaces.openPanel(sessionKey)
    if (existed) {
      surfaces.postToSurface('panel', sessionKey, { type: 'insertPrompt', text })
      return
    }
    const queue = pendingTabInserts.get(sessionKey) ?? []
    queue.push(text)
    pendingTabInserts.set(sessionKey, queue)
  }

  /**
   * A window-global state change (sign-in, provider save, the auth watcher) must
   * reach every surface with a fresh snapshot — the sidebar once, and every open
   * tab with its own panel-flavoured one.
   */
  function resyncAllSurfaces(): void {
    surfaces.syncSidebar()
    for (const entry of registry.all) {
      surfaces.panelFor(entry.key)?.postState(stateForEntry(entry, 'panel'))
    }
  }

  /** Reveal the sidebar (the sign-in gate), opening its container if never mounted. */
  async function revealSidebar(): Promise<void> {
    if (sidebar) {
      await sidebar.reveal()
      return
    }
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`)
  }

  /** The conversation on screen — the sidebar's binding. Resolved per call. */
  function current(): SessionEntry {
    return registry.active
  }

  async function connectWebBridge(entry: SessionEntry): Promise<void> {
    if (!registry.has(entry.key)) return
    webBridge?.handle.stop()
    const handle = new VSCodeWebBridge(entry.session, entry.permissions, engineCwd, state => {
      if (state === 'connected') {
        void vscode.window.showInformationMessage('Rayucode is connected to Studio Remote.')
      } else if (state === 'error') {
        void vscode.window.showWarningMessage('Studio Remote could not connect. Run /web-bridge status for details.')
      }
    })
    webBridge = { entry, handle }
    const connected = await handle.connect()
    if (webBridge?.handle !== handle) return
    if (!connected) {
      handle.stop()
      webBridge = null
      void vscode.window.showErrorMessage('Studio Remote could not obtain a bridge credential. Retry /web-bridge.')
    }
  }

  /**
   * The `/web-bridge` command surface. `entry` is the conversation the command was
   * sent from — captured by the caller at submit time, so a switch mid-flow cannot
   * rebind the bridge to a different conversation.
   */
  async function runWebBridgeCommand(argument: string, entry: SessionEntry): Promise<void> {
    const command = argument.toLowerCase()
    if (command === 'status') {
      const pending = guestPairingStatus()
      const text = webBridge
        ? `Studio Remote: ${webBridge.handle.state}`
        : pending?.status === 'starting'
          ? 'Creating a Studio pairing QR code…'
          : pending?.status === 'waiting'
            ? `Waiting for Studio approval: ${pending.url}`
            : pending?.status === 'error'
              ? `Studio pairing failed: ${pending.error}`
              : 'Studio Remote is off. Run /web-bridge to connect.'
      void vscode.window.showInformationMessage(text)
      return
    }
    if (command === 'off' || command === 'stop' || command === 'disconnect') {
      webBridgeCommandGeneration++
      webBridge?.handle.stop()
      webBridge = null
      pairingEntry = null
      stopGuestPairing()
      void vscode.window.showInformationMessage('Studio Remote disconnected.')
      return
    }
    if (command !== '' && command !== 'on' && command !== 'connect' && command !== 'pair') {
      void vscode.window.showErrorMessage('Usage: /web-bridge [status|off|pair]')
      return
    }
    if (webBridge && command !== 'pair') {
      void vscode.window.showInformationMessage(`Studio Remote is ${webBridge.handle.state}.`)
      return
    }
    const commandGeneration = ++webBridgeCommandGeneration
    pairingEntry = entry
    const token = command === 'pair' ? null : await getAccessTokenForHost()
    if (commandGeneration !== webBridgeCommandGeneration || !registry.has(entry.key)) return
    if (token) {
      stopGuestPairing()
      pairingEntry = null
      await connectWebBridge(entry)
      return
    }
    webBridge?.handle.stop()
    webBridge = null
    stopGuestPairing()
    pairingEntry = entry
    try {
      const pairing = await beginGuestPairing(
        () => {
          if (!registry.has(entry.key)) { stopGuestPairing(); return }
          pairingEntry = null
          void connectWebBridge(entry)
        },
        message => void vscode.window.showErrorMessage(`Studio pairing failed: ${message}`),
        {
          machineId: vscodeBridgeMachineId(engineCwd),
          hostname: resolveHostname(),
          cwd: engineCwd,
          pid: process.pid,
          sessionLabel: `Rayucode VS Code — ${engineCwd.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'}`,
        },
      )
      await showBridgePairingPanel(enginePath, pairing.url, pairing.expiresAt)
    } catch (error) {
      if (!registry.has(entry.key) || (error instanceof Error && (error.name === 'AbortError' || error.message === 'Studio pairing was cancelled'))) return
      void vscode.window.showErrorMessage(`Could not start Studio pairing: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function showMcpUi(entry: SessionEntry, next: McpConnectionUiView): void {
    // One MCP connection flow at a time, anchored to the active conversation — see
    // the `mcpUiSessionKey`/`mcpFlowId` guards around it.
    if (registry.activeSessionKey !== entry.key) return
    mcpUiSessionKey = entry.key
    mcpUi = next
    surfaces.postToSession(entry.key, { type: 'setMcpConnectionUi', connection: next })
  }

  async function refreshMcp(entry: SessionEntry): Promise<void> {
    showMcpUi(entry, { ...mcpUi, load: 'loading', error: null })
    try {
      const servers = await entry.session.getMcpStatus()
      if (registry.activeSessionKey !== entry.key) return
      surfaces.postToSession(entry.key, { type: 'setMcpServers', servers })
      const auth = mcpUi.auth?.stage === 'connected' &&
        !servers.some(server => server.name === mcpUi.auth?.serverName && server.status === 'connected')
        ? null : mcpUi.auth
      showMcpUi(entry, { ...mcpUi, load: 'ready', error: null, auth })
    } catch (cause) {
      showMcpUi(entry, {
        ...mcpUi,
        load: 'error',
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  function labelOf(entry: SessionEntry): string {
    return registry.summaries().find(item => item.key === entry.key)?.label ?? 'Session'
  }

  function postLiveSessions(): void {
    // The live list is window-global: every surface renders it, so it broadcasts.
    surfaces.broadcast({
      type: 'setLiveSessions',
      sessions: registry.summaries(),
      activeKey: registry.activeSessionKey,
    })
  }

  /** Clear ownership before disconnecting, so late callbacks cannot affect a replacement. */
  function detachAttachment(error: string | null = null, warmup = true): void {
    const owned = liveAttachment
    if (!owned) return
    liveAttachment = null
    owned.handle?.detach()
    attachment = { ...attachment, attached: null, error }
    // Retirement has already removed the entry. Do not ask the sidebar for its
    // active key until the registry finishes selecting the replacement.
    if (!registry.has(owned.entry.key)) return
    owned.entry.permissions.cancelAll(true)
    owned.entry.session.resetMirroredPromptTracking()
    owned.entry.session.restoreConversationState(owned.conversation)
    owned.entry.session.applyMirroredTaskSnapshot(owned.tasks)
    review.store.replace(owned.entry.key, owned.entry.session.reviewFiles)
    surfaces.syncSession(owned.entry.key)
    if (warmup) void prewarmSession(owned.entry)
    postAttachment()
  }

  let disposed = false
  context.subscriptions.push({ dispose: () => { disposed = true } })

  /**
   * Model-catalogue refreshes. The rules for which conversation they answer are in
   * its module. The refresher serialises runs, so the target key stashed by
   * `catalogueFor` — called synchronously at each run's start — is the exact key
   * that run's `post`/`onSettled` must route to.
   */
  let refreshTargetKey = ''
  const catalogueRefresher = new CatalogueRefresher<ChatSession>({
    // ALSO the routing stash: the refresher calls this at the start of each
    // (serialized) run, so it captures the run's target before any await.
    catalogueFor: session => {
      refreshTargetKey = keyForSession(session) ?? ''
      return buildCatalogue(session)
    },
    fetch: model => refreshProviderCatalogue({ enginePath, cwd: engineCwd }, model),
    readPersistedModel: readActiveModel,
    // "On screen" now means any surface is showing the conversation: its tab, or
    // the sidebar while it is the active one.
    isActive: session => {
      const key = keyForSession(session)
      return key !== undefined && (surfaces.hasPanel(key) || registry.activeSessionKey === key)
    },
    post: catalogue => surfaces.postToSession(refreshTargetKey, { type: 'setModelCatalogue', catalogue }),
    invalidate: invalidateRayuConfigCache,
    isDisposed: () => disposed,
    onSettled: () => surfaces.syncSession(refreshTargetKey),
  })

  /** Prompts and warmups use the same prerequisites before reading provider config. */
  async function waitForStartupPreparation(): Promise<void> {
    await signInPending
    const refresh = catalogueRefresher.pending
    if (refresh) await refresh
    invalidateRayuConfigCache()
  }

  /** Prewarm only when a surface is usable and standalone Rayucode owns execution. */
  async function prewarmSession(entry: SessionEntry = current()): Promise<void> {
    if (
      disposed ||
      !surfaces.isOpen ||
      attachedFor(entry.key) ||
      !checkTurnAllowed().allowed
    ) return

    // The hosted refresh writes model capabilities into Rayucode's provider profile,
    // which the engine reads at startup. Starting first can leave the child with a stale
    // capability cache (for example, hiding effort for a thinking model).
    try {
      await waitForStartupPreparation()
    } catch {
      // Login/catalogue callers own their errors. A failed preparation must not
      // become an unhandled rejection from this background warmup.
      return
    }
    if (
      disposed ||
      !surfaces.isOpen ||
      attachedFor(entry.key) ||
      !checkTurnAllowed().allowed
    ) return
    await entry.session.warmup()
  }

  /**
   * Refresh the catalogue for `target`, asking about `model` (or the target's own model).
   *
   * Callers acting on a user's choice pass the conversation they captured when the user
   * acted; the default is right only for refreshes not tied to a choice.
   */
  function refreshModels(model?: string, target: ChatSession = registry.active.session): Promise<void> {
    return catalogueRefresher.refresh(target, model)
  }

  /** Run the editor-native login flow, then refresh the same state as the button. */
  async function signInToRayucode(entry: SessionEntry): Promise<void> {
    if (signInPending) return signInPending
    let succeeded = false
    const pending = (async () => {
      if (!await runSignIn(resyncAllSurfaces, { enginePath, cwd: engineCwd })) return
      invalidateRayuConfigCache()
      await refreshModels(undefined, entry.session)
      succeeded = true
    })()
    signInPending = pending
    try {
      await pending
    } finally {
      if (signInPending === pending) signInPending = null
    }
    if (succeeded) await prewarmSession(entry)
  }

  /**
   * Restart the engine so it re-reads the shared config, WITHOUT losing the conversation.
   *
   * `rayuConfig` is process-cached in the engine child, so a subagent or WebFetch model
   * written here is invisible to the running engine — and there is no control request that
   * invalidates its cache. A respawn is the only way to apply it.
   *
   * The respawn uses `--resume <sessionId>`, which is the same sequence `resumeSession` uses:
   * the child reloads the conversation from the session file, and the transcript is restored
   * from that file rather than being cleared. So the visible effect is nothing except the
   * setting taking hold. With no session id yet there is no conversation to preserve, and
   * the next prompt starts a correctly-configured engine on its own.
   */
  async function restartEngineWithResume(entry: SessionEntry): Promise<void> {
    invalidateRayuConfigCache()
    const sessionId = entry.session.engineSessionId
    if (!sessionId) {
      // `preserveModel` throughout: this is a RESTART of one conversation, not a new one, so
      // it must not adopt whatever model another conversation has since selected.
      entry.session.newSession(undefined, undefined, { preserveModel: true })
      surfaces.syncSession(entry.key)
      prewarmSession(entry)
      return
    }
    const cwd = workspaceDir ?? engineCwd
    entry.session.newSession(sessionId, cwd, { preserveModel: true })
    entry.session.restoreTranscript(await loadSessionTranscript(sessionId, cwd))
    await entry.session.restoreTaskHistory(sessionId, cwd)
    surfaces.syncSession(entry.key)
    prewarmSession(entry)
  }

  /** Show a host-owned command result in the transcript, as the CLI shows a system line. */
  function postCommandNotice(sessionKey: string, message: string): void {
    surfaces.postToSession(sessionKey, {
      type: 'addMessage',
      entry: { id: `cmd-${Date.now()}`, kind: 'notice', text: message, severity: 'info' },
    })
  }

  async function runModelSettingCommand(command: ModelSettingCommand, entry: SessionEntry): Promise<void> {
    switch (command.kind) {
      case 'usage':
        postCommandNotice(entry.key, command.message)
        return
      case 'show':
        postCommandNotice(entry.key, describeSelection(command.target, command.agentType))
        return
      case 'reset': {
        const notice = applySelection(command.target, null, command.agentType)
        if (notice) postCommandNotice(entry.key, notice)
        await restartEngineWithResume(entry)
        return
      }
      case 'choose':
        // The catalogue is what the picker lists, and it may not have been fetched yet.
        void refreshModels(undefined, entry.session)
        setModelChooser(
          buildChooser(
            command.target,
            command.agentType,
            entry.session.subagentTypes,
          ),
        )
        return
    }
  }

  /**
   * The webview→host handlers. Every method takes the originating `scope` first
   * and resolves the conversation from IT — never from the globally-active one —
   * so a background tab's buttons act on the conversation that tab is bound to.
   * Dispatch lives in `webviewDispatch.ts`; this is the host's implementation.
   */
  const handlers: ChatViewHandlers = {
      ready: scope => {
        const entry = entryFor(scope.sessionKey)
        if (entry) prewarmSession(entry)
      },
      submitPrompt: async (scope, text, images, delivery = 'normal') => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        const owned = attachedFor(entry.key)
        if (owned && !owned.handle) {
          scope.reply({ type: 'showError', message: 'The CLI connection is still opening. Try again once it connects.' })
          return
        }
        const cli = owned?.handle
        const bridgeCommand = /^\s*\/web-bridge(?:\s+(\S+))?\s*$/.exec(text)
        if (bridgeCommand) {
          await runWebBridgeCommand(bridgeCommand[1] ?? '', entry)
          return
        }
        // The CLI implementations of these commands render Ink UI and are therefore
        // absent from the non-interactive engine. Route them to Rayucode's existing
        // native surfaces before the sign-in gate, so `/login` is reachable while the
        // user is signed out.
        const hostCommand = rayucodeHostSlashCommand(text)
        if (hostCommand === 'login') {
          await signInToRayucode(entry)
          return
        }
        if (hostCommand === 'connect') {
          await openProviderSetupSurface(true)
          return
        }
        if (hostCommand === 'logout') {
          await runSignOut(resyncAllSurfaces)
          return
        }
        if (hostCommand === 'reload-plugins') {
          await entry.session.reloadPlugins()
          return
        }
        if (hostCommand === 'install-github-app') {
          await runGitHubSetupFromEditor(workspaceDir, {
            signedIn: hasAccountSession(),
            apiBaseUrl: getApiBaseUrlForHost(),
            getAccessToken: getAccessTokenForHost,
          })
          return
        }
        const runtimeSection = rayucodeRuntimeSectionCommand(text)
        if (runtimeSection === 'tasks') {
          scope.reply({ type: 'openTaskCenter' })
          return
        }
        const inferenceCommand = parseRayucodeInferenceCommand(text)
        if (inferenceCommand?.kind === 'open') {
          scope.reply({ type: 'openComposerControl', control: inferenceCommand.control })
          return
        }
        if (inferenceCommand?.kind === 'effort') {
          await entry.session.setEffort(inferenceCommand.level)
          return
        }
        if (inferenceCommand?.kind === 'model') {
          // Captured now: the user may switch conversations before `setModel` settles.
          // The catalogue is posted to THIS conversation's surfaces, so it lands right
          // regardless of any switch.
          const session = entry.session
          await session.setModel(inferenceCommand.model)
          await refreshModels(inferenceCommand.model, session)
          surfaces.postToSession(entry.key, { type: 'setModelCatalogue', catalogue: buildCatalogue(session) })
          return
        }
        if (runtimeSection) {
          scope.reply({ type: 'openRuntimeCenter', section: runtimeSection })
          return
        }
        const skillInstall = parseSkillInstallCommand(text)
        if (skillInstall) {
          await entry.session.installSkill(skillInstall.source, skillInstall.overwrite)
          return
        }
        // These are `local-jsx` in the CLI and therefore absent from the engine too, but
        // unlike /login they take arguments — so they are parsed rather than matched.
        const settingCommand = parseModelSettingCommand(text, entry.session.subagentTypes)
        if (settingCommand) {
          await runModelSettingCommand(settingCommand, entry)
          return
        }
        const sideQuestion = parseSideQuestionCommand(text)
        if (sideQuestion !== null) {
          // An attached CLI owns authentication and execution. Its account may be
          // valid while standalone Rayucode is signed out, so only apply the local
          // sign-in gate when the local engine will answer the side question.
          if (!cli) {
            const gate = checkTurnAllowed()
            if (!gate.allowed) {
              scope.resync()
              scope.reply({ type: 'showError', message: gate.reason })
              return
            }
          }
          if (cli) {
            await entry.session.askSideQuestion(
              sideQuestion,
              question => {
                if (cli.capabilities?.features.sideQuestions === false) {
                  return Promise.reject(
                    new Error(
                      'The attached CLI does not support /btw. Update it and reattach to use this.',
                    ),
                  )
                }
                return cli.askSideQuestion(question)
              },
            )
          } else {
            await entry.session.askSideQuestion(sideQuestion)
          }
          return
        }
        if (cli && (images?.length ?? 0) > 0) {
          scope.reply({
            type: 'showError',
            message: 'Image attachments are unavailable while attached to a CLI session. Detach to send this image with Rayucode.',
          })
          return
        }
        if (cli) {
          try {
            const operationId = await cli.submitPrompt(text, delivery)
            if (liveAttachment === owned) entry.session.recordMirroredPrompt(text, delivery, operationId)
          } catch (cause) {
            scope.reply({
              type: 'showError',
              message: `The attached CLI did not accept the message: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            })
          }
          return
        }
        const acceptedImages = validateImageInputs(images, scope)
        if (acceptedImages === null) return
        await submitPrompt(entry.session, scope, text, acceptedImages, delivery)
      },
      interrupt: scope => {
        const entry = entryFor(scope.sessionKey)
        if (attachedFor(scope.sessionKey)) {
          scope.reply({ type: 'showError', message: 'Stop this turn in the attached CLI terminal. Its connection does not support interruption.' })
          return
        }
        if (entry) entry.session.interrupt()
      },
      newSession: () => {
        // OPENS a conversation as its own editor tab; it does not replace one. The
        // previous implementation called `newSession()` on the single session, which
        // killed a turn that was still running.
        const entry = registry.create()
        surfaces.openPanel(entry.key)
        prewarmSession(entry)
      },
      // Sidebar intent: open (or focus) the conversation's editor tab. The sidebar
      // binding follows through the tab's focus → `registry.activate`.
      switchSession: (scope, key) => {
        if (!registry.has(key)) {
          // A stale key from a list the webview fetched before a session closed. Resync rather
          // than fail: the user pressed a row that no longer exists and needs to see why.
          postLiveSessions()
          scope.reply({ type: 'showError', message: 'That conversation is no longer open.' })
          return
        }
        surfaces.openPanel(key)
      },
      // Same intent as switchSession, for surfaces that ask for the tab explicitly.
      openSessionPanel: (scope, key) => {
        if (!registry.has(key)) {
          postLiveSessions()
          scope.reply({ type: 'showError', message: 'That conversation is no longer open.' })
          return
        }
        surfaces.openPanel(key)
      },
      // The sidebar's Runtime Center has no composer to type into, so "use command"
      // means "put it in the active conversation's tab". The active key is the right
      // target — it is the conversation the user last touched, and the sidebar's own
      // state is bound to it.
      useCommandInTab: (_scope, name) => {
        insertPromptIntoTab(registry.active.key, `/${name} `)
      },
      closeSession: (scope, key) => {
        // Close the MESSAGE key's tab: a sidebar row can close a conversation other
        // than its own binding. `registry.close` fires `onRetire`, which closes the
        // same tab idempotently — the explicit close keeps the tab from rendering a
        // retired conversation for even one frame.
        surfaces.closePanel(key)
        registry.close(key)
        prewarmSession()
      },
      renameSession: async (scope, key, id, suppliedTitle) => {
        const entry = key
          ? registry.all.find(item => item.key === key)
          : id ? registry.findByEngineSessionId(id) : undefined
        const selected = id ? historySessions.sessions.find(item => item.id === id) : undefined
        const sessionId = entry?.session.engineSessionId ?? id
        if (!sessionId || (!entry && !selected)) {
          scope.reply({ type: 'showError', message: 'Send a message before naming this conversation, or refresh session history.' })
          return
        }
        const previous = entry?.customTitle ?? selected?.customTitle ?? (entry ? labelOf(entry) : selected?.label ?? '')
        const title = suppliedTitle ?? await vscode.window.showInputBox({
          title: 'Rename conversation',
          prompt: 'This name is shared with Rayu CLI session history.',
          value: previous,
          ignoreFocusOut: true,
          validateInput: value => {
            const trimmed = value.trim()
            return !trimmed || trimmed.length > 120 || /[\r\n\u0000-\u001f]/.test(trimmed)
              ? 'Use a single-line name of 1–120 characters.' : null
          },
        })
        if (title === undefined) return
        try {
          const trimmed = title.trim()
          await renameWorkspaceSession(sessionId, trimmed, selected?.cwd ?? workspaceDir ?? engineCwd)
          // `setTitle` fires `onChanged`, which refreshes the live list and the
          // renamed conversation's tab title.
          if (entry) registry.setTitle(entry.key, trimmed)
          historySessions = {
            ...historySessions,
            sessions: historySessions.sessions.map(item => item.id === sessionId
              ? { ...item, label: trimmed, customTitle: trimmed, lastModified: Date.now() }
              : item),
          }
          surfaces.broadcast({ type: 'setSessions', list: historySessions })
          if (entry) surfaces.syncSession(entry.key)
        } catch (cause) {
          scope.reply({ type: 'showError', message: `Could not rename session: ${cause instanceof Error ? cause.message : String(cause)}` })
        }
      },
      permissionResponse: (scope, requestId, decision) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        entry.permissions.resolve(entry.session.controlClient, requestId, { kind: decision })
      },
      questionResponse: (scope, requestId, answers, notes) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        const result = entry.permissions.resolveQuestions(
          entry.session.controlClient,
          requestId,
          answers,
          notes,
        )
        if (result) entry.session.recordQuestionAnswers(result.toolUseId, result.answers)
      },
      // The WEBVIEW owns the dropdown now, so the host only applies the choice. It is
      // configuration only — nothing here touches the composer's text.
      selectModelValue: async (scope, value) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        // Captured now: the user may switch conversations before `setModel` settles.
        // The refresher queues this behind any refresh already running for something
        // else, and the catalogue is posted to THIS conversation's surfaces, so it
        // lands right regardless of any switch.
        const session = entry.session
        await session.setModel(value)
        await refreshModels(value, session)
        surfaces.postToSession(entry.key, {
          type: 'setModelCatalogue',
          catalogue: buildCatalogue(session),
        })
      },
      refreshModelCatalogue: async scope => {
        const entry = entryFor(scope.sessionKey)
        if (entry) await refreshModels(undefined, entry.session)
      },
      // Both settings are acknowledged by the owning engine before the controls update.
      // Rayucode persists them in its product profile, separate from the terminal CLI.

      listAttachable: async () => {
        const outcome = await listAttachTargets({ enginePath, cwd: engineCwdRealpath }, engineCwdRealpath)
        attachTargets = outcome.targets ?? []
        attachment = {
          ...attachment,
          available: attachTargets.map(toAttachableView),
          error: outcome.ok ? null : (outcome.error ?? 'Could not list sessions.'),
        }
        postAttachment()
      },

      attachToSession: async (scope, pid: number) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        const target = attachTargets.find(t => t.pid === pid)
        if (!target) {
          attachment = {
            ...attachment,
            error: 'That session is no longer running. Refresh the list.',
          }
          postAttachment()
          return
        }

        detachAttachment(null, false)
        entry.session.resetMirroredPromptTracking()
        const owned = {
          entry, target, handle: null as CliAttachment | null,
          conversation: entry.session.snapshotConversationState(),
          tasks: [...entry.session.backgroundTasks],
          taskInspectionSupported: true,
          taskInspectionMessage: undefined as string | undefined,
        }
        liveAttachment = owned
        const isCurrent = () => liveAttachment === owned
        const ifCurrent = <Args extends unknown[]>(callback: (...args: Args) => void) =>
          (...args: Args): void => { if (isCurrent()) callback(...args) }
        const callbacks: AttachmentCallbacks = {
          onStreamStart: ifCurrent(() => entry.session.beginMirroredTurn()),
          onStreamDelta: ifCurrent(delta => entry.session.appendMirroredDelta(delta)),
          onStreamThinking: ifCurrent(() => entry.session.markMirroredThinking()),
          onStreamEnd: ifCurrent(() => entry.session.endMirroredTurn()),
          onActivity: ifCurrent(messages => entry.session.applyMirroredActivity(messages)),
          onPermissionRequest: ifCurrent(request =>
            entry.permissions.presentMirrored(request, response => {
              if (isCurrent()) owned.handle?.respondPermission(request.requestId, response)
            }),
          ),
          // Withdrawn or answered elsewhere — either way the card must go.
          onPermissionDismiss: ifCurrent(requestId => entry.permissions.dismiss(requestId)),
          onTaskSnapshot: ifCurrent(tasks => {
            owned.taskInspectionSupported = true
            owned.taskInspectionMessage = undefined
            entry.session.applyMirroredTaskSnapshot(tasks, true)
          }),
          onTaskEvent: ifCurrent(event => entry.session.applyMirroredTaskEvent(event)),
          onTaskUnsupported: ifCurrent(message => {
            owned.taskInspectionSupported = false
            owned.taskInspectionMessage = message
            surfaces.postToSession(entry.key, { type: 'replaceTaskState', tasks: [], supported: false, message })
          }),
          onClosed: ifCurrent(() => detachAttachment('The attached session exited.')),
        }
        try {
          await entry.session.restoreTaskHistory(target.sessionId, target.cwd, isCurrent)
          if (!isCurrent()) return
          const handle = await attachToCliSession(target, callbacks)
          if (!isCurrent()) {
            handle?.detach()
            return
          }
          if (!handle) {
            detachAttachment('Could not connect to that session. It may have just exited.')
            return
          }
          owned.handle = handle
          attachment = { ...attachment, error: null }
          postAttachment()
        } catch (cause) {
          if (isCurrent()) detachAttachment(
            `Could not connect to that session: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      },

      detachFromSession: scope => {
        if (attachedFor(scope.sessionKey)) detachAttachment()
      },

      providerSetupOpen: (scope, open) => openProviderSetupSurface(open),

      providerSetupValidate: async (scope, providerId, apiKey, baseURL) => {
        providerSetup = {
          ...providerSetup,
          busy: true,
          busyMessage: 'Checking credentials…',
          error: null,
          discoveredModels: null,
        }
        surfaces.broadcast({ type: 'setProviderSetup', setup: providerSetup })

        const outcome = await validateProvider(
          { enginePath, cwd: engineCwd },
          providerId,
          apiKey,
          baseURL,
        )
        providerSetup = {
          ...providerSetup,
          busy: false,
          busyMessage: null,
          // `[]` is a real, successful answer: the provider exposes no list endpoint.
          // Distinct from null, which means "not validated yet".
          discoveredModels: outcome.ok ? (outcome.models ?? []) : null,
          error: outcome.ok ? null : (outcome.error ?? 'Could not verify credentials.'),
        }
        surfaces.broadcast({ type: 'setProviderSetup', setup: providerSetup })
      },

      providerSetupSave: async (scope, providerId, apiKey, baseURL, model) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        providerSetup = {
          ...providerSetup,
          busy: true,
          busyMessage: 'Saving provider…',
          error: null,
        }
        surfaces.broadcast({ type: 'setProviderSetup', setup: providerSetup })

        const outcome = await saveProvider(
          { enginePath, cwd: engineCwd },
          providerId,
          apiKey,
          baseURL,
          model,
        )

        if (!outcome.ok) {
          providerSetup = {
            ...providerSetup,
            busy: false,
            busyMessage: null,
            error: outcome.error ?? 'Could not save the provider.',
          }
          surfaces.broadcast({ type: 'setProviderSetup', setup: providerSetup })
          return
        }

        providerSetup = {
          ...providerSetup,
          open: false,
          busy: false,
          busyMessage: null,
          error: null,
          connectedProviderId: outcome.activeProviderId ?? providerId,
          connectedModel: outcome.activeModel ?? null,
        }
        surfaces.broadcast({ type: 'setProviderSetup', setup: providerSetup })

        // The running engine resolved its provider at spawn time, so it would keep using
        // the old one. A fresh child reads the new configuration and has no stale cache
        // by construction — a stronger guarantee than invalidating caches in place.
        invalidateRayuConfigCache()
        entry.session.newSession()
        surfaces.postToSession(entry.key, {
          type: 'setModelCatalogue',
          catalogue: buildCatalogue(entry.session),
        })
        surfaces.syncSession(entry.key)
        prewarmSession(entry)
      },

      setEffort: (scope, level) => {
        const entry = entryFor(scope.sessionKey)
        if (entry) entry.session.setEffort(level)
      },
      setThinking: (scope, enabled) => {
        const entry = entryFor(scope.sessionKey)
        if (entry) entry.session.setThinking(enabled)
      },
      mcpElicitationResponse: (scope, requestId, action, content) => {
        const entry = entryFor(scope.sessionKey)
        if (entry) entry.session.respondMcpElicitation(requestId, action, content)
      },
      reloadPlugins: scope => {
        const entry = entryFor(scope.sessionKey)
        if (entry) entry.session.reloadPlugins()
      },
      installSkill: (scope, source, overwrite) => {
        const entry = entryFor(scope.sessionKey)
        if (entry) entry.session.installSkill(source, overwrite)
      },
      cyclePermissionMode: async scope => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        const next = nextPermissionMode(entry.session.currentPermissionMode.id)
        // Post either way. On success the pill moves to the accepted mode; on refusal it
        // is snapped back to what is still enforced, because the webview applies its own
        // optimistic update and would otherwise be left claiming a mode the engine
        // rejected.
        await entry.session.setPermissionMode(next)
        surfaces.postToSession(entry.key, { type: 'setPermissionMode', mode: entry.session.currentPermissionMode })
      },
      setPermissionMode: async (scope, modeId: string) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        try {
          await entry.session.setPermissionMode(permissionModeById(modeId))
        } catch (error) {
          console.error('[rayucode] failed to set permission mode', error)
        }
        // See above: the authoritative mode is published whatever the outcome.
        surfaces.postToSession(entry.key, { type: 'setPermissionMode', mode: entry.session.currentPermissionMode })
      },
      // Keep/undo go through the engine's OWN /keep and /undo commands, which is the
      // mechanism `utils/pendingFileChanges.ts` implements for the CLI. The
      // `rewind_files` control request is a different thing — it rewinds everything
      // since a message — and wiring a per-file button to it would revert files the
      // user had chosen to keep.
      reviewKeep: (scope, path) => {
        const entry = entryFor(scope.sessionKey)
        if (entry) void submitPrompt(entry.session, scope, reviewCommand('keep', path))
      },
      reviewUndo: (scope, path) => {
        const entry = entryFor(scope.sessionKey)
        if (entry) void submitPrompt(entry.session, scope, reviewCommand('undo', path))
      },
      openReviewDiff: (scope, path) => openReviewDiff(review.store, scope.sessionKey, path),
      openFile: (scope, path) => openReviewFile(review.store, scope.sessionKey, path),
      openExternal: async (scope, rawUrl) => {
        try {
          const url = new URL(rawUrl)
          if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new Error('Only http(s) URLs can be opened.')
          }
          await vscode.env.openExternal(vscode.Uri.parse(url.toString()))
        } catch (cause) {
          scope.reply({
            type: 'showError',
            message: cause instanceof Error ? cause.message : 'That URL could not be opened.',
          })
        }
      },
      signIn: async scope => {
        // Global by nature (auth is window state), but the post-sign-in refresh and
        // prewarm target the conversation the sign-in surface is bound to.
        await signInToRayucode(entryFor(scope.sessionKey) ?? registry.active)
      },
      signOut: () => runSignOut(resyncAllSurfaces),
      // Routed at the in-panel surface. This previously opened a dialog telling the
      // user to run /connect in a terminal, which is the gap this closes.
      openProviderSetup: () => openProviderSetupSurface(true),
      findFiles: async (scope, query: string) => {
        try {
          // `buildFileSearchGlob` decides what to ask VS Code's own search for —
          // scoped correctly whether or not the query contains a folder drill-down
          // slash — so the expensive, workspace-wide part runs in VS Code's search
          // engine, not a JS array scan over the whole workspace. See its header for
          // why: an unbounded JS-side scan cannot scale to every monorepo size, and a
          // bounded one silently drops matches outside whatever cap is chosen.
          const { glob, leafFilter } = buildFileSearchGlob(query)
          const uris = await vscode.workspace.findFiles(
            glob,
            '{**/node_modules/**,**/.git/**,**/dist/**,**/.turbo/**}',
            2000,
          )
          const relativePaths = uris.map(uri =>
            vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'),
          )
          scope.reply({
            type: 'fileSearchResults',
            query,
            files: buildFileSearchResults(relativePaths, leafFilter),
          })
        } catch {
          scope.reply({ type: 'fileSearchResults', query, files: [] })
        }
      },
      resolveContextPaths: async (scope, requestId, uriList) => {
        const uris: vscode.Uri[] = []
        for (const line of uriList.split(/\r?\n/)) {
          const value = line.trim()
          if (!value || value.startsWith('#')) continue
          try {
            const uri = value.includes('://') ? vscode.Uri.parse(value, true) : vscode.Uri.file(value)
            if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') continue
            uris.push(uri)
          } catch {
            // A stale Explorer item or inaccessible external path is skipped while
            // other dropped resources remain usable.
          }
        }
        const paths = await contextPathsForUris(uris)
        if (paths.length === 0) {
          scope.reply({ type: 'showError', message: 'Rayucode could not access the dropped file or folder.' })
        }
        scope.reply({ type: 'contextPathsResolved', requestId, paths })
      },
      pickContextPaths: async (scope, requestId) => {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: 'Add to Rayu context',
          title: 'Add files or folders to Rayu context',
        })
        // A REPLY IS ALWAYS SENT, including for a cancelled dialog. The webview correlates
        // this by `requestId` and awaits it; returning early on cancel would leave that
        // promise pending forever, which is indistinguishable from a hung extension host.
        // An empty list is the correct answer to "the user chose nothing", and unlike the
        // drop path it is not an error, so nothing is reported.
        scope.reply({
          type: 'contextPathsResolved',
          requestId,
          paths: uris ? await contextPathsForUris(uris) : [],
        })
      },
      requestToolOutput: (scope, requestId, entryId) => {
        // ALWAYS replies, like the context-path requests above and for the same reason:
        // the webview awaits this by `requestId`, so a silent path would leave its
        // promise pending and the row stuck on "Loading…". `null` is a real answer —
        // retention is capped, so an old result may genuinely be gone.
        const entry = entryFor(scope.sessionKey)
        scope.reply({
          type: 'toolOutputResolved',
          requestId,
          text: entry ? entry.session.fullToolOutput(entryId) : null,
        })
      },
      requestTaskOutput: async (scope, requestId, taskKey) => {
        // Same discipline, but the answer comes from the engine over the control channel,
        // so this is the one request of the three that can fail for an external reason. It
        // still always replies — with the reason, which the panel shows in place of the
        // output rather than leaving a button that appears to do nothing.
        try {
          const entry = entryFor(scope.sessionKey)
          if (!entry) {
            scope.reply({
              type: 'taskOutputResolved',
              requestId,
              text: null,
              error: 'This conversation is no longer open.',
            })
            return
          }
          const output = await entry.session.taskOutput(taskKey)
          scope.reply({
            type: 'taskOutputResolved',
            requestId,
            text: output?.text ?? null,
            truncated: output?.truncated === true,
            ...(output ? {} : { error: 'This conversation has no running engine to ask.' }),
          })
        } catch (cause) {
          scope.reply({
            type: 'taskOutputResolved',
            requestId,
            text: null,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      },
      modelChooserChoice: async (scope, target, value, agentType) => {
        // The chooser is window-global state (broadcast), so a choice applies to the
        // ACTIVE conversation — the same conversation the notice is recorded on.
        setModelChooser(null)
        const notice = applySelection(target, value, agentType)
        // Only restart when something was actually written. A choice that resolved to no
        // model is a no-op, and respawning for it would cost the user a reload for nothing.
        if (!notice) return
        postCommandNotice(registry.activeSessionKey, notice)
        await restartEngineWithResume(registry.active)
      },
      modelChooserTarget: (scope, agentType) => {
        if (modelChooser?.target !== 'subagent') return
        const entry = entryFor(scope.sessionKey) ?? registry.active
        setModelChooser(
          buildChooser('subagent', agentType, entry.session.subagentTypes),
        )
      },
      modelChooserDismiss: () => setModelChooser(null),
      mcpToggle: async (scope, serverName, enabled) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        await entry.session.toggleMcpServer(serverName, enabled)
        await refreshMcp(entry)
      },
      mcpReconnect: async (scope, serverName) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        await entry.session.reconnectMcpServer(serverName)
        await refreshMcp(entry)
      },
      mcpAuthenticate: async (scope, serverName) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        const flowId = ++mcpFlowId
        showMcpUi(entry, {
          load: 'ready', error: null,
          auth: { serverName, stage: 'opening' },
        })
        const auth = await entry.session.authenticateMcpServer(serverName)
        if (flowId !== mcpFlowId) return
        if (!auth) {
          showMcpUi(entry, { load: 'ready', error: null, auth: {
            serverName, stage: 'error', message: 'Could not start authentication. Try again.',
          } })
          return
        }
        if (auth.requiresUserAction) {
          if (!auth.authUrl) {
            showMcpUi(entry, { ...mcpUi, auth: {
              serverName, stage: 'error', message: 'The server did not provide an authentication URL.',
            } })
            return
          }
          let opened = false
          try {
            opened = await vscode.env.openExternal(vscode.Uri.parse(auth.authUrl))
          } catch {
            opened = false
          }
          if (!opened) {
            showMcpUi(entry, { ...mcpUi, auth: {
              serverName, stage: 'error', message: 'Could not open the browser. Retry authentication.',
            } })
            return
          }
        }
        showMcpUi(entry, { ...mcpUi, auth: {
          serverName, stage: auth.requiresUserAction ? 'waiting' : 'finishing',
        } })
        const outcome = await watchMcpConnection({
          serverName,
          read: () => entry.session.getMcpStatus(),
          isCurrent: () => flowId === mcpFlowId && !disposed,
          onStatus: servers => {
            if (registry.activeSessionKey === entry.key) {
              surfaces.postToSession(entry.key, { type: 'setMcpServers', servers: [...servers] })
            }
          },
        })
        if (outcome === 'cancelled') return
        const message = outcome === 'timeout'
          ? 'Still waiting for browser authorization. If the callback did not reach this editor, paste its redirect URL.'
          : outcome === 'failed' ? 'The MCP server did not connect. Check its status and retry.' : undefined
        showMcpUi(entry, { ...mcpUi, auth: {
          serverName, stage: outcome === 'connected' ? 'connected' : 'error',
          ...(message ? { message } : {}),
        } })
      },
      mcpPasteCallback: async (scope, serverName) => {
        const entry = entryFor(scope.sessionKey)
        if (!entry) return
        const callbackUrl = await vscode.window.showInputBox({
          title: `Finish ${serverName} authentication`,
          prompt: 'Paste the full browser redirect URL only if automatic connection did not complete.',
          ignoreFocusOut: true,
          password: true,
        })
        if (callbackUrl?.trim()) {
          showMcpUi(entry, { ...mcpUi, auth: { serverName, stage: 'finishing' } })
          const connected = await entry.session.completeMcpAuthentication(serverName, callbackUrl.trim())
          ++mcpFlowId
          await refreshMcp(entry)
          showMcpUi(entry, { ...mcpUi, auth: {
            serverName, stage: connected ? 'connected' : 'error',
            ...(!connected ? { message: 'Could not complete authentication. Check the redirect URL and retry.' } : {}),
          } })
        }
      },
      mcpClearAuth: async (scope, serverName) => {
        const entry = entryFor(scope.sessionKey)
        if (entry) await entry.session.clearMcpAuthentication(serverName)
      },
      getMcpStatus: async scope => {
        const entry = entryFor(scope.sessionKey)
        if (entry) await refreshMcp(entry)
      },
      listSessions: async () => {
        historySessions = { ...historySessions, status: 'loading' }
        surfaces.broadcast({ type: 'setSessions', list: historySessions })
        try {
          historySessions = {
            status: 'ready',
            sessions: (await listWorkspaceSessions(workspaceDir)) ?? [],
          }
        } catch (cause) {
          // Reported rather than swallowed: an unreadable history directory is something the
          // user can act on, and silently showing "no sessions" hides a real problem.
          historySessions = {
            status: 'failed',
            sessions: historySessions.sessions,
            error: `Could not read session history: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }
        }
        surfaces.broadcast({ type: 'setSessions', list: historySessions })
      },
      // The sidebar's quick-chat fallback path — the sidebar's history rows send
      // `resumeSessionPanel`; both resume the stored conversation as a tab.
      resumeSession: (scope, id) => resumeStoredSession(scope, id),
      resumeSessionPanel: (scope, id) => resumeStoredSession(scope, id),
      stopTask: async (scope, _sourceSessionId, taskId) => {
        try {
          const owned = attachedFor(scope.sessionKey)
          if (owned && !owned.handle) throw new Error('The attached CLI is still connecting.')
          const cli = owned?.handle
          if (cli) await cli.stopTask(taskId)
          else {
            const entry = entryFor(scope.sessionKey)
            if (!entry) return
            await entry.session.stopBackgroundTask(taskId)
          }
        } catch (cause) {
          scope.reply({
            type: 'showError',
            message: `Could not stop task: ${cause instanceof Error ? cause.message : String(cause)}`,
          })
        }
      },
      sendTaskMessage: async (scope, _sourceSessionId, taskId, text) => {
        try {
          const cli = attachedFor(scope.sessionKey)?.handle
          if (!cli) throw new Error('Follow-up messages are unavailable for this task.')
          await cli.sendTaskMessage(taskId, text)
        } catch (cause) {
          scope.reply({
            type: 'showError',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      },
  }

  /**
   * Resume a stored conversation as its own editor tab — the flow both
   * `resumeSession` (the sidebar's fallback) and `resumeSessionPanel` (the
   * sidebar's history rows) run.
   *
   * ── AN OPEN CONVERSATION IS OPENED, NOT RESUMED ─────────────────────────────
   *
   * If this session is already open, its engine is alive and may be mid-turn.
   * Respawning it with `--resume` would kill that turn and rebuild the transcript
   * from the session FILE — which is where the raw
   * `<command-name>/model</command-name>` breadcrumbs came from. Opening the
   * existing tab is both cheaper and lossless.
   */
  async function resumeStoredSession(scope: SurfaceScope, id: string): Promise<void> {
    const existing = registry.findByEngineSessionId(id)
    if (existing) {
      surfaces.openPanel(existing.key)
      prewarmSession(existing)
      return
    }
    const selected = historySessions.sessions.find(item => item.id === id)
    if (!selected) {
      scope.reply({
        type: 'showError',
        message: 'That history session could not be found. Refresh history and try again.',
      })
      return
    }
    // In an empty editor window the history list spans every project. Starting
    // the engine in the selected session's cwd lets the shared UUID resume path
    // find the same transcript the lister displayed.
    const resumeCwd = workspaceDir ?? selected.cwd ?? engineCwd
    // A NEW entry rather than reusing the active one: resuming history is opening another
    // conversation, and the one already on screen may be mid-turn. Order matters —
    // `create()` starts with an empty transcript, so the restore happens BEFORE the
    // tab opens and the tab's first init carries the restored transcript. The engine
    // child is spawned with `--resume` and is the SOLE writer to the session file;
    // `loadSessionTranscript` only reads.
    const entry = registry.create({ resumeSessionId: id, cwd: resumeCwd, customTitle: selected.customTitle })
    entry.session.restoreTranscript(await loadSessionTranscript(id, resumeCwd))
    await entry.session.restoreTaskHistory(id, resumeCwd)
    surfaces.openPanel(entry.key)
    prewarmSession(entry)
  }

  // The engine children must die with the window. An orphan keeps its MCP server
  // subprocesses alive, holding ports and file locks after the editor has closed — and with
  // several conversations open there may be several of them.
  context.subscriptions.push({ dispose: () => registry.dispose() })
  context.subscriptions.push({ dispose: () => { webBridge?.handle.stop(); stopGuestPairing() } })
  // The first conversation is opened HERE, not on first access: a lazy creation triggered
  // from inside a snapshot build (the sidebar's `activeSessionKey`) would re-enter the
  // sync mid-snapshot. Creating an entry does not spawn an engine; `prewarmSession()`
  // does that once a surface mounts.
  registry.create()
  // Detach cleanly so the CLI session stops forwarding and drops pending decisions,
  // rather than waiting for the socket to notice the window closed.
  context.subscriptions.push({ dispose: () => detachAttachment(null, false) })

  // The registry builds and owns the sidebar surface — see `surfaceRegistry.ts`'s
  // header for why a second provider here would race it for the same view.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CHAT_VIEW_ID,
      { resolveWebviewView: view => { sidebar = surfaces.attachSidebar(view) } },
      {
        // Without this VS Code tears the DOM down and rebuilds it on every
        // collapse/expand. The state itself lives in the host either way; this
        // only avoids paying for a React remount on a panel toggle.
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    surfaces,
  )

  // ── SESSION TAB REVIVAL ──────────────────────────────────────────────────────
  // A window reload destroys every `SessionPanel`, but the editor remembers the
  // tabs and each tab's webview state (written by the webview via `setState`,
  // sourced from `surfaceBinding`). The serializer rebinds each restored tab:
  // `reviveBind` resolves the binding, and the transcript is restored HERE —
  // the engine child rebuilds its own state from the session file, but the
  // HOST's transcript only fills from an explicit `restoreTranscript`.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(SESSION_PANEL_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => {
        const restored = (state ?? {}) as Partial<SurfaceBindingView>
        // `reviveBind` runs synchronously inside the call, so the shared revive
        // flags are correct the instant it returns — but a SECOND tab's
        // deserialize can interleave across the await below and overwrite them
        // before this one resumes. Capture per-call, before yielding.
        const revived = surfaces.reviveFromState(panel, restored)
        const sessionKey = lastRevivedSessionKey
        const needsRestore = revivedNeedsRestore
        await revived
        const entry = registry.byKey(sessionKey)
        if (needsRestore && entry && restored.sessionId) {
          try {
            const resumeCwd = restored.cwd ?? workspaceDir ?? engineCwd
            entry.session.restoreTranscript(await loadSessionTranscript(restored.sessionId, resumeCwd))
            await entry.session.restoreTaskHistory(restored.sessionId, resumeCwd)
          } catch {
            // Never throw out of deserialize: an unreadable transcript degrades
            // the tab to a fresh conversation rather than failing activation.
          }
        }
        if (entry) {
          // Re-init with the restored transcript: `syncSession` gives the panel its
          // panel-flavoured snapshot and the sidebar its own, each surface correctly built.
          surfaces.syncSession(sessionKey)
          prewarmSession(entry)
        }
      },
    }),
  )

  // Login/provider helpers run in child processes and write Rayucode's profile. Watch
  // that directory so their settled writes are reflected without reloading the window.
  context.subscriptions.push(watchSharedSession(() => {
    invalidateRayuConfigCache()
    // Sign-in state is window-global: every surface gets a fresh snapshot.
    resyncAllSurfaces()
    // The auth file can arrive while the login child is still preparing providers.
    // signInToRayucode owns the final refresh and prewarm for that transaction.
    if (signInPending) return
    void refreshModels()
    prewarmSession()
  }, () => {
    // A Rayucode helper changed its provider catalogue. Refresh the choices while the
    // current conversation keeps its explicit provider-qualified execution selection.
    invalidateRayuConfigCache()
    registry.active.session.availableModels = null
    resyncAllSurfaces()
    if (signInPending) return
    void refreshModels()
  }))

  if (getAuthSnapshot().signedIn) void refreshModels()

  // Register URI handler for vscode://rayu-dev.rayucode/auth/callback (PKCE login)
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/auth/callback' || uri.path === 'auth/callback') {
          const params = new URLSearchParams(uri.query)
          const error = params.get('error')
          if (error) {
            void vscode.window.showErrorMessage(`Rayu authentication error: ${error}`)
            return
          }
          const code = params.get('code')
          const token = params.get('token')
          if (token || code) {
            void vscode.window.showInformationMessage('Rayu authentication received.')
            resyncAllSurfaces()
          }
        }
      },
    }),
  )

  // ── TERMINAL SELECTION ───────────────────────────────────────────────────────
  //
  // An explicit command rather than passive tracking, because stable VS Code API exposes NO
  // way to read a terminal's selected text — there is no `Terminal.selection` getter at any
  // version, and the extension's engine floor is 1.85. The only route is the editor's own
  // copy command plus the clipboard, which is a user-visible side effect and therefore has to
  // be user-initiated. A proposed API would work but could not ship to the Marketplace.
  //
  // The clipboard is RESTORED afterwards: silently destroying what the user had copied would
  // be a worse bug than the feature is worth.
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.addTerminalSelection, async () => {
      if (!vscode.window.activeTerminal) {
        void vscode.window.showInformationMessage('No active terminal to copy from.')
        return
      }
      const previousClipboard = await vscode.env.clipboard.readText()
      try {
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection')
        const selection = await vscode.env.clipboard.readText()
        // Unchanged clipboard means nothing was selected: `copySelection` is a no-op then,
        // and inserting the previous clipboard contents would be actively wrong.
        if (!selection.trim() || selection === previousClipboard) {
          void vscode.window.showInformationMessage(
            'Select some text in the terminal first.',
          )
          return
        }
        // The sidebar is a management hub with no composer, so the selection goes to the
        // ACTIVE conversation's tab — the one place a prompt is typed.
        insertPromptIntoTab(registry.active.key, fenceTerminalSelection(selection))
      } finally {
        await vscode.env.clipboard.writeText(previousClipboard)
      }
    }),
  )

  // ── ADDING CONTEXT FROM THE TREE AND THE EDITOR ──────────────────────────────
  //
  // Drag and drop cannot serve a webview. VS Code blanks the panel's pointer events for the
  // duration of any drag that looks like it carries a file — which an ordinary Explorer or
  // editor-tab drag does — unless Shift is held, and the event that would have to be cancelled
  // is dispatched in a frame the panel cannot reach. See `panel/dropTargetView.ts` for the
  // measurement and for the drop strip that DOES accept a plain drag.
  //
  // So this menu command is not a workaround: it is the route the platform supports for the
  // tree. It reuses the SAME resolver and the SAME `@`-mention format as every other path, so
  // they all produce identical prompt text.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      COMMANDS.addToContext,
      async (clicked?: vscode.Uri, selection?: vscode.Uri[]) => {
        // `selection` is the Explorer's multi-select and is what the user means when they have
        // several rows highlighted; `clicked` is the single row. Falling back to the active
        // editor makes the command work from the palette, where neither argument is passed.
        const uris =
          selection && selection.length > 0
            ? selection
            : clicked
              ? [clicked]
              : vscode.window.activeTextEditor
                ? [vscode.window.activeTextEditor.document.uri]
                : []
        if (uris.length === 0) {
          void vscode.window.showInformationMessage(
            'Select a file or folder to add to Rayu context.',
          )
          return
        }
        const paths = await contextPathsForUris(uris)
        if (paths.length === 0) {
          void vscode.window.showWarningMessage(
            'Rayucode could not read that file or folder.',
          )
          return
        }
        // Same target as the terminal selection: the active conversation's composer.
        insertPromptIntoTab(registry.active.key, formatPathMentions(paths))
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.newSession, async () => {
      // OPENS a conversation as its own editor tab. Whatever was on screen keeps its
      // engine and keeps running — which is the whole difference from the previous
      // behaviour, where this button killed the turn in flight.
      const entry = registry.create()
      surfaces.openPanel(entry.key)
      prewarmSession(entry)
    }),
    vscode.commands.registerCommand(COMMANDS.signIn, async () => {
      await revealSidebar()
      await signInToRayucode(registry.active)
    }),
    vscode.commands.registerCommand(COMMANDS.signOut, () => runSignOut(resyncAllSurfaces)),
  )

  // ── SEND FEEDBACK ─────────────────────────────────────────────────────────────
  //
  // The editor-native mirror of the CLI's `/feedback`: QuickPick → InputBox →
  // optional rating, then the SAME `submitRayuFeedback` client the CLI uses, so the
  // request contract lives in exactly one place. Feedback is an ACCOUNT action (it
  // needs a Rayu JWT), so a signed-out user is offered the sign-in flow the `signIn`
  // command runs rather than a form that would fail on submit.
  async function runFeedbackCommand(): Promise<void> {
    if (!hasAccountSession()) {
      const action = await vscode.window.showWarningMessage(
        'Sign in to Rayu to send feedback.',
        'Sign In',
      )
      if (action === 'Sign In') await signInToRayucode(registry.active)
      return
    }

    const typePick = await vscode.window.showQuickPick(
      [
        { label: 'Bug', description: 'Something is broken or misbehaves', value: 'bug' as const },
        { label: 'Idea', description: 'A feature request or improvement', value: 'idea' as const },
        { label: 'Other', description: 'Anything else', value: 'other' as const },
      ],
      { title: 'RayuCode: Send Feedback', placeHolder: 'What kind of feedback is this?' },
    )
    if (!typePick) return

    const message = await vscode.window.showInputBox({
      title: 'RayuCode: Send Feedback',
      prompt: `Describe it (up to ${RAYU_FEEDBACK_MAX_MESSAGE.toLocaleString()} characters)`,
      placeHolder: 'Tell us what happened…',
      ignoreFocusOut: true,
      validateInput: value => {
        if (!value.trim()) return 'Enter a message'
        if (value.length > RAYU_FEEDBACK_MAX_MESSAGE) {
          return `Keep it under ${RAYU_FEEDBACK_MAX_MESSAGE.toLocaleString()} characters`
        }
        return undefined
      },
    })
    if (message === undefined) return

    const ratingPick = await vscode.window.showQuickPick(
      [
        { label: '5', description: 'Excellent', value: 5 },
        { label: '4', description: 'Good', value: 4 },
        { label: '3', description: 'Okay', value: 3 },
        { label: '2', description: 'Poor', value: 2 },
        { label: '1', description: 'Terrible', value: 1 },
        { label: 'Skip', description: 'No rating', value: undefined },
      ],
      { title: 'RayuCode: Send Feedback', placeHolder: 'Rate RayuCode overall (optional)' },
    )
    if (!ratingPick) return

    const result = await submitRayuFeedback({
      type: typePick.value,
      message,
      rating: ratingPick.value,
      source: 'vscode',
    })
    if (result.ok) {
      void vscode.window.showInformationMessage(
        'Thanks — your feedback was sent to the Rayu team.',
      )
    } else {
      void vscode.window.showErrorMessage(`Could not send feedback: ${result.error}`)
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.feedback, () => runFeedbackCommand()),
  )
}

export function deactivate(): void {
  // Everything is registered through `context.subscriptions`, which VS Code
  // disposes for us. The engine child process gets an explicit `dispose()` through
  // that same chain once the session layer owns one — an orphaned engine would
  // keep MCP subprocesses alive after the window closed.
}

/**
 * The snapshot handed to the panel.
 *
 * `status` follows `rayuLoginGateMessage()` — the SAME gate the engine's headless
 * path enforces. Deriving it independently would let the panel offer a composer for a
 * prompt the engine then refuses, which reads to the user as a broken extension
 * rather than as a sign-in requirement.
 */
/**
 * The dropdown's contents.
 *
 * Prefers the ENGINE's catalogue once `initialize` has reported one — it knows what the
 * active provider can actually serve. Falls back to the config-derived list so the
 * control is usable BEFORE the first prompt, which is the only time choosing a model is
 * useful.
 *
 * `loading` is true only when BOTH sources are empty: that is genuinely "not known
 * yet", whereas an empty config list for an anthropic provider is normal and resolves
 * when the engine reports.
 */
function buildCatalogue(session: ChatSession): ModelCatalogueView {
  if (session.availableModels) return session.availableModels
  const fromEngine = session.modelCatalogue
  const configured = readModelOptions()
  const source = configured.length > 0 ? configured : fromEngine
  return {
    options: source.map(m => ({
      value: m.value,
      label: m.displayName || m.value,
      description: m.description,
      customerDescription: m.customerDescription,
      providerId: m.providerId, model: m.model, contextWindow: m.contextWindow,
      supportsThinking: m.supportsThinking, supportsImage: m.supportsImage, supportsTools: m.supportsTools,
    })),
    loading: source.length === 0,
    error: null,
  }
}

function buildState(
  version: string,
  session: ChatSession,
  permissions: PermissionRouter,
  providerSetup: ProviderSetupView,
  modelChooser: ModelChooserView | null,
  ideContext: IdeContextView | null,
  attachment: AttachmentView,
  historySessions: SessionListView,
  liveSessions: LiveSessionView[],
  activeSessionKey: string,
  mcpConnectionUi: McpConnectionUiView,
  customTitle: string | null,
  taskInspectionSupported = true,
  taskInspectionMessage?: string,
  /**
   * Which surface this snapshot renders — a panel hides its in-panel session
   * switcher and persists its binding; the sidebar keeps both. The caller knows
   * which surface it is building for; the webview decides its chrome from the
   * snapshot alone and never infers it from the message channel.
   */
  surface: ChatSurfaceKind = 'sidebar',
  /** What a restored panel must re-bind to. Null on the sidebar. */
  surfaceBinding: SurfaceBindingView | null = null,
): WebviewState {
  const auth = getAuthSnapshot()
  return {
    status: auth.signedIn ? 'ready' : 'signed-out',
    signInMessage: auth.gateMessage,
    identity: auth.identity,
    oauthEnabled: auth.oauthEnabled,
    version,
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    // The host owns the transcript, so a webview VS Code re-created mid-conversation
    // is restored rather than blanked.
    transcript: [...session.transcript],
    turnRunning: session.isTurnRunning,
    // Restored too: the engine stays blocked across a webview re-creation, so losing
    // the card would leave the turn stuck with nothing on screen to unblock it.
    pendingPermissions: permissions.snapshot(),
    modelInfo: session.currentModelInfo,
    modelCatalogue: buildCatalogue(session),
    inference: session.currentInference,
    providerSetup,
    modelChooser,
    attachment,
    permissionMode: session.currentPermissionMode,
    commands: [...session.commands],
    contextUsage: session.contextUsage,
    mcpServers: [...session.mcpServers],
    mcpConnectionUi,
    customTitle,
    runtimeCapabilities: session.currentRuntimeCapabilities,
    runtimeCommands: [...session.runtimeCommands],
    runtimeTools: [...session.runtimeTools],
    runtimeAgents: [...session.runtimeAgents],
    runtimePlugins: [...session.runtimePlugins],
    runtimeSkills: [...session.runtimeSkills],
    runtimeWorkflows: [...session.runtimeWorkflows],
    rateLimit: session.currentRateLimit,
    engineAuthStatus: session.currentEngineAuthStatus,
    sessionStatus: session.currentExecutionStatus,
    promptSuggestion: session.currentPromptSuggestion,
    mcpElicitations: [...session.pendingMcpElicitations],
    ideContext,
    // Full `init` snapshots replace webview state. Carry the host-owned history
    // list so unrelated model/auth/context syncs cannot erase an open picker.
    sessions: historySessions,
    liveSessions,
    activeSessionKey,
    surface,
    surfaceBinding,
    backgroundTasks: [...session.backgroundTasks],
    taskInspectionSupported,
    taskInspectionMessage,
    turnProgress: session.currentTurnProgress,
    turnCompletions: { ...session.completedTurns },
    thinkingBlocks: [...session.currentThinkingBlocks],
  }
}

/**
 * Send a prompt, refusing it while signed out.
 *
 * This is the SECOND of two gates. `headlessLoginGateMessage()` in the engine is the
 * authority and would refuse the turn anyway — but it does so after the prompt has
 * been sent, which reads as a failure. Checking here means the user is told what is
 * required before anything is dispatched.
 */
async function submitPrompt(
  session: ChatSession,
  scope: SurfaceScope,
  text: string,
  images: ImageInputView[] = [],
  delivery: PromptDeliveryView = 'normal',
): Promise<void> {
  const gate = checkTurnAllowed()
  if (!gate.allowed) {
    // Resync so the surfaces showing this conversation present the sign-in gate
    // and limit autocomplete to its recovery commands before reporting why this
    // normal prompt was refused.
    scope.resync()
    scope.reply({ type: 'showError', message: gate.reason })
    return
  }
  await session.submitPrompt(text, images, delivery)
}

/** Return the `/btw` argument, including an empty argument for the usage card. */
function parseSideQuestionCommand(text: string): string | null {
  const match = /^\s*\/btw(?:\s+([\s\S]*))?\s*$/.exec(text)
  return match ? (match[1] ?? '').trim() : null
}

/** Map interactive CLI catalog commands onto their native Rayucode management view. */
function rayucodeRuntimeSectionCommand(
  text: string,
): import('../shared/webviewProtocol.js').RuntimeSectionView | 'tasks' | null {
  const command = text.trim().toLowerCase()
  if (command === '/mcp') return 'mcp'
  if (command === '/skills' || command === '/workflows') return 'skills'
  if (command === '/plugin' || command === '/plugins') return 'plugins'
  if (command === '/agents') return 'agents'
  if (command === '/tasks') return 'tasks'
  return null
}

type RayucodeInferenceCommand =
  | { kind: 'open'; control: 'model' | 'effort' }
  | { kind: 'model'; model: string }
  | { kind: 'effort'; level: import('../shared/inferenceSettings.js').EffortChoice }

function parseRayucodeInferenceCommand(text: string): RayucodeInferenceCommand | null {
  const match = /^\s*\/(model|effort)(?:\s+([^\s]+))?\s*$/i.exec(text)
  if (!match) return null
  const command = match[1]!.toLowerCase()
  const value = match[2]
  if (!value) return { kind: 'open', control: command as 'model' | 'effort' }
  if (command === 'model') return { kind: 'model', model: value }
  const effort = value.toLowerCase()
  if (effort === 'auto') return { kind: 'effort', level: null }
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') {
    return { kind: 'effort', level: effort }
  }
  // Recognised command with an invalid argument: opening the authoritative list is
  // more useful than sending the malformed slash command to the model.
  return { kind: 'open', control: 'effort' }
}

/**
 * Convert VS Code URIs to the same workspace-relative attachment references used
 * by the CLI. This deliberately lives in the extension host: browser File objects
 * do not reliably expose a path, and remote-workspace paths must go through VS Code.
 */
async function contextPathsForUris(uris: readonly vscode.Uri[]): Promise<string[]> {
  const paths: string[] = []
  for (const uri of uris) {
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      const workspace = vscode.workspace.getWorkspaceFolder(uri)
      let display = workspace
        ? vscode.workspace.asRelativePath(uri, false)
        : uri.fsPath
      display = display.replace(/\\/g, '/')
      if (stat.type & vscode.FileType.Directory) display = `${display.replace(/\/$/, '')}/`
      if (!paths.includes(display)) paths.push(display)
    } catch {
      // Leave inaccessible members out while preserving the rest of a multi-drop.
    }
  }
  return paths
}

/** Validate untrusted webview image payloads before they enter the engine process. */
function validateImageInputs(
  images: ImageInputView[] | undefined,
  scope: SurfaceScope,
): ImageInputView[] | null {
  if (!images?.length) return []
  if (images.length > API_MAX_MEDIA_PER_REQUEST) {
    scope.reply({
      type: 'showError',
      message: `A message can include at most ${API_MAX_MEDIA_PER_REQUEST} images.`,
    })
    return null
  }

  const supported = new Set<ImageInputView['mediaType']>([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ])
  for (const image of images) {
    if (
      !image ||
      !supported.has(image.mediaType) ||
      typeof image.data !== 'string' ||
      image.data.length === 0 ||
      image.data.length > API_IMAGE_MAX_BASE64_SIZE ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
      image.data.length % 4 !== 0
    ) {
      scope.reply({
        type: 'showError',
        message: `One image is invalid or exceeds the ${Math.floor(API_IMAGE_MAX_BASE64_SIZE / 1024 / 1024)} MB upload limit.`,
      })
      return null
    }
  }
  return images
}

/**
 * Wrap captured terminal output in a fence so the model reads it as output, not instructions.
 *
 * The fence length adapts to the content: terminal output legitimately contains triple
 * backticks (a shell printing a Markdown file, for instance), and a fixed fence would be
 * closed early by its own payload.
 */
function fenceTerminalSelection(selection: string): string {
  const trimmed = selection.replace(/\s+$/, '')
  const longestRun = Math.max(
    2,
    ...[...trimmed.matchAll(/`+/g)].map(match => match[0].length),
  )
  const fence = '`'.repeat(longestRun + 1)
  return `Terminal output:\n${fence}\n${trimmed}\n${fence}\n`
}

/**
 * Parse only the commands owned by the extension host.
 *
 * Exact matching for the argument-free ones is intentional: arguments belong to the CLI
 * command parser, and a normal prompt beginning with similar text must continue to reach
 * the model unchanged. The model-setting commands DO take arguments, so they are parsed by
 * `parseModelSettingCommand`, which applies the same first-token rule.
 */
function rayucodeHostSlashCommand(
  text: string,
):
  | 'login'
  | 'connect'
  | 'logout'
  | 'reload-plugins'
  | 'install-github-app'
  | null {
  const command = text.trim()
  if (command === '/login') return 'login'
  if (command === '/connect') return 'connect'
  if (command === '/logout') return 'logout'
  if (command === '/reload-plugins') return 'reload-plugins'
  if (command === '/install-github-app') return 'install-github-app'
  return null
}

function parseSkillInstallCommand(
  text: string,
): { source: string; overwrite: boolean } | null {
  const match = /^\/install-skill(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const tokens = (match[1] ?? '').split(/\s+/).filter(Boolean)
  return {
    source: tokens.filter(token => token !== '--overwrite').join(' '),
    overwrite: tokens.includes('--overwrite'),
  }
}

/**
 * Run the sign-in and re-derive every surface. `resync` is injected so this stays
 * host-agnostic: sign-in state is window-global, so EVERY surface — the sidebar
 * and every open tab — gets a fresh snapshot, not just the one that was clicked.
 */
async function runSignIn(
  resync: () => void,
  engine: SignInOptions,
): Promise<boolean> {
  const outcome = await signInFromEditor(engine)
  // Resync either way: on success every surface must unlock, and on failure they
  // must stop showing whatever in-progress state the click implied.
  resync()

  if (outcome.ok) {
    void vscode.window.showInformationMessage(
      outcome.displayName
        ? `Signed in to Rayu as ${outcome.displayName}.`
        : 'Signed in to Rayu.',
    )
    return true
  }
  void vscode.window.showErrorMessage(`Rayu sign-in failed: ${outcome.error}`)
  return false
}

/** Sign out and re-derive every surface — sign-out state is window-global. */
async function runSignOut(resync: () => void): Promise<void> {
  const CONFIRM = 'Sign out'
  const choice = await vscode.window.showWarningMessage(
    'Sign out of Rayucode?',
    { modal: true },
    CONFIRM,
  )
  if (choice !== CONFIRM) return

  signOutShared()
  resync()
  void vscode.window.showInformationMessage('Signed out of Rayu.')
}
