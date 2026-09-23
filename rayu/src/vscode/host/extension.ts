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

import { ChatViewProvider, CHAT_VIEW_ID } from './panel/chatViewProvider.js'
import { ChatSession, type ConversationStateSnapshot } from './panel/sessionHandle.js'
import { watchMcpConnection } from './panel/mcpConnectionUi.js'
import {
  SessionRegistry,
  type SessionEntry,
} from './panel/sessionRegistry.js'
import { PermissionRouter } from './panel/permissionRouter.js'
import { invalidateRayuConfigCache } from '../../utils/rayuConfig.js'
import { readModelOptions, readActiveModel } from './models/modelConfig.js'
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
import { watchSharedSession } from './auth/authWatcher.js'
import { checkTurnAllowed } from './auth/signInGate.js'
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

  // Declared before the session so its callbacks can post to it, and assigned
  // immediately after. The alternative — passing the provider into the session —
  // would make the session depend on the webview, which is backwards.
  let provider: ChatViewProvider

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
    provider.post({ type: 'setProviderSetup', setup: providerSetup })
    if (!open) return

    // Fetched once. The preset list is static for a given install, so refetching would
    // spawn a child process for data that cannot have changed.
    if (providerSetup.presets !== undefined) return

    providerSetup = { ...providerSetup, busy: true, busyMessage: 'Loading providers…' }
    provider.post({ type: 'setProviderSetup', setup: providerSetup })

    const outcome = await listProviderPresets({ enginePath, cwd: engineCwd })
    providerSetup = {
      ...providerSetup,
      busy: false,
      busyMessage: null,
      presets: outcome.presets ?? [],
      error: outcome.ok ? null : (outcome.error ?? 'Could not load providers.'),
    }
    provider.post({ type: 'setProviderSetup', setup: providerSetup })
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
  let liveAttachment: CliAttachment | null = null
  let standaloneTaskSnapshot: BackgroundTaskView[] = []
  /**
   * What the standalone session's transcript/thinking/tool-correlation/retained-output
   * looked like right before this attach began. `null` while nothing is attached — the
   * only state genuinely worth restoring is what `applyMirroredActivity` can mutate; see
   * `snapshotConversationState`'s header for why this is narrower than a full session
   * snapshot (context usage, inference settings, and review state are never touched by
   * the mirrored path, so they need no capture here at all).
   */
  let standaloneConversationSnapshot: ConversationStateSnapshot | null = null
  let taskInspectionSupported = true
  let taskInspectionMessage: string | undefined
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
    provider.post({ type: 'setAttachment', attachment })
  }

  /** Set and publish the chooser in one step, so the two cannot disagree. */
  function setModelChooser(chooser: ModelChooserView | null): void {
    modelChooser = chooser
    provider.post({ type: 'setModelChooser', chooser })
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
          provider.post({ type: 'setIdeContext', context: context_ })
        }),
      )
      return handle
    })
    .catch(() => null)

  /**
   * The panel's open conversations.
   *
   * ── EVERY HANDLER BELOW RESOLVES THE SESSION AT CALL TIME ──────────────────────
   *
   * The handlers are registered once, at activation, and the conversation they must act on
   * changes whenever the user switches. So there is deliberately no `const session`: capturing
   * one would leave every button operating on whichever conversation happened to be open when
   * the extension started. `current()` is the only way to reach a session from here.
   */
  const registry = new SessionRegistry(
    {
      enginePath,
      cwd: engineCwd,
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
      // Every push is gated on `isActive`. A background conversation keeps accruing state
      // inside its own ChatSession; it simply does not write to the panel. Activation then
      // rebuilds the panel from that state with one `syncState()`.
      sessionCallbacks: (entry, isActive) => ({
        onEntry: message => {
          if (isActive()) provider.post({ type: 'addMessage', entry: message })
          // The live list shows a per-session label and running flag, both of which this
          // changed — so background progress stays visible even though the transcript is not.
          else postLiveSessions()
        },
        onPartial: (id, kind, delta) => {
          if (isActive()) provider.post({ type: 'appendPartial', id, kind, delta })
        },
        onComplete: id => {
          if (isActive()) provider.post({ type: 'completeMessage', id })
        },
        onTurnState: running => {
          if (isActive()) provider.post({ type: 'turnState', running })
          postLiveSessions()
        },
        // Only for the visible conversation: a background session's live tool output has
        // nowhere to render and would be a message per second for nothing. Its transcript
        // still receives the final result, and switching to it shows that.
        onToolOutput: (id, text) => {
          if (isActive()) provider.post({ type: 'appendToolOutput', id, text })
        },
        onModelInfo: info => {          if (!isActive()) return
          provider.post({ type: 'setModelInfo', info })
          // The engine's catalogue is authoritative for what the active provider can
          // actually serve, so re-publish once it has reported.
          provider.post({
            type: 'setModelCatalogue',
            catalogue: buildCatalogue(entry.session),
          })
        },
        onError: message => {
          // ── THE ACTIVE SESSION IS ALREADY COVERED BY ITS TRANSCRIPT ──────────────
          //
          // `reportError` records every failure as a `notice` entry in the failing
          // session's own transcript, in chronological position. Posting `showError`
          // as well would render the same failure twice for the visible conversation —
          // once inline where it happened, once in the trailing notices list.
          //
          // A BACKGROUND conversation is the case the transcript cannot cover: the
          // entry exists, but in a transcript the user is not reading, and the session
          // they are waiting on must not fail silently. So the alert is posted only
          // when the failing session is not the one on screen, prefixed so they know
          // which one it was.
          if (!isActive()) {
            provider.post({ type: 'showError', message: `${labelOf(entry)}: ${message}` })
          }
        },
        // Routed to the OWNING session's router, never the active one: a card belongs to the
        // engine that is blocked on it.
        onPermissionRequest: request => entry.permissions.present(request),
        onPermissionCancelled: requestId => entry.permissions.engineCancelled(requestId),
        onSessionEnded: () => entry.permissions.cancelAll(),
        // The review card is the one entry that can stop existing: once everything is
        // kept or undone there is nothing left to act on.
        onReviewCleared: id => {
          if (isActive()) provider.post({ type: 'removeEntry', id })
        },
        // Hunks stay host-side; the editor draws the diff from them. The store is a
        // singleton, so only the visible conversation may own it — see the registry header.
        onReviewFiles: files => {
          if (isActive()) review.store.replace(files)
        },
        onInferenceSettings: settings => {
          if (isActive()) provider.post({ type: 'setInferenceSettings', settings })
        },
        onPermissionMode: mode => {
          if (isActive()) provider.post({ type: 'setPermissionMode', mode })
        },
        onCommands: commands => {
          if (isActive()) provider.post({ type: 'setCommands', commands })
        },
        onContextUsage: usage => {
          if (!isActive()) return
          provider.post({
            type: 'setContextUsage',
            percentage: usage.percentage,
            totalTokens: usage.totalTokens,
            maxTokens: usage.maxTokens,
            stale: usage.stale,
          })
        },
        onMcpServers: servers => {
          if (isActive()) provider.post({ type: 'setMcpServers', servers })
        },
        onTurnProgress: progress => {
          if (isActive()) provider.post({ type: 'setTurnProgress', progress })
        },
        onTurnCompleted: (turnId, completion) => {
          if (isActive()) provider.post({ type: 'turnCompleted', turnId, completion })
        },
        onThinking: thinking => {
          if (isActive()) provider.post({ type: 'updateThinking', thinking })
        },
        onTaskStateChanged: task => {
          if (isActive()) provider.post({ type: 'upsertTaskState', task })
        },
        onTaskStateReplaced: tasks => {
          if (isActive()) {
            provider.post({ type: 'replaceTaskState', tasks, supported: true })
          }
        },
        onRuntimeCatalogue: (capabilities, commands, tools, resources) => {
          if (isActive()) {
            provider.post({
              type: 'setRuntimeCatalogue',
              capabilities,
              commands,
              tools,
              ...resources,
            })
          }
        },
        onRateLimit: rateLimit => {
          if (isActive()) provider.post({ type: 'setRateLimit', rateLimit })
        },
        onEngineAuthStatus: status => {
          if (isActive()) provider.post({ type: 'setEngineAuthStatus', status })
        },
        onSessionStatus: status => {
          if (isActive()) provider.post({ type: 'setSessionStatus', status })
        },
        onPromptSuggestion: suggestion => {
          if (isActive()) provider.post({ type: 'setPromptSuggestion', suggestion })
        },
        onMcpElicitation: request => {
          if (isActive()) provider.post({ type: 'showMcpElicitation', request })
        },
        onMcpElicitationCancelled: requestId => {
          if (isActive()) provider.post({ type: 'dismissMcpElicitation', requestId })
        },
      }),
      onShowPermission: request =>
        provider.post({ type: 'showPermissionRequest', request }),
      onDismissPermission: requestId =>
        provider.post({ type: 'dismissPermissionRequest', requestId }),
      onChanged: () => postLiveSessions(),
      // Hand the diff store to the conversation that is now on screen, then rebuild the panel
      // from it. One full sync is both simpler and more honest than replaying deltas.
      onActivate: entry => {
        if (mcpUiSessionKey !== entry.key) {
          mcpUi = { load: 'idle', error: null, auth: null }
          mcpUiSessionKey = entry.key
        }
        review.store.replace(entry.session.reviewFiles)
        provider.syncState()
      },
    },
  )

  /** The conversation on screen. Resolved per call — see the registry's construction. */
  function current(): SessionEntry {
    return registry.active
  }

  function showMcpUi(entry: SessionEntry, next: McpConnectionUiView): void {
    if (registry.activeSessionKey !== entry.key) return
    mcpUiSessionKey = entry.key
    mcpUi = next
    provider.post({ type: 'setMcpConnectionUi', connection: next })
  }

  async function refreshMcp(entry = current()): Promise<void> {
    showMcpUi(entry, { ...mcpUi, load: 'loading', error: null })
    try {
      const servers = await entry.session.getMcpStatus()
      if (registry.activeSessionKey !== entry.key) return
      provider.post({ type: 'setMcpServers', servers })
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
    provider.post({
      type: 'setLiveSessions',
      sessions: registry.summaries(),
      activeKey: registry.activeSessionKey,
    })
  }

  /**
   * Put the standalone session's transcript back the way it was before this
   * attachment started, then re-derive the panel from it — the same "one full sync
   * is simpler and more honest than replaying deltas" rule `onActivate` already
   * uses when switching which conversation is on screen. Tasks are restored
   * separately by the caller because `standaloneTaskSnapshot`/`applyMirroredTaskSnapshot`
   * predates this function and already has its own preserve-completed semantics.
   */
  function restoreStandaloneConversation(): void {
    if (standaloneConversationSnapshot) {
      current().session.restoreConversationState(standaloneConversationSnapshot)
      standaloneConversationSnapshot = null
    }
    current().session.applyMirroredTaskSnapshot(standaloneTaskSnapshot)
    review.store.replace(current().session.reviewFiles)
    provider.syncState()
  }

  let catalogueRefresh: Promise<void> | null = null
  let disposed = false
  context.subscriptions.push({ dispose: () => { disposed = true } })

  /** Prewarm only when the panel is usable and standalone Rayucode owns execution. */
  async function prewarmSession(): Promise<void> {
    if (
      disposed ||
      !provider.isOpen ||
      liveAttachment ||
      !checkTurnAllowed().allowed
    ) return

    // The hosted refresh writes model capabilities into Rayucode's provider profile,
    // which the engine reads at startup. Starting first can leave the child with a stale
    // capability cache (for example, hiding effort for a thinking model).
    const refresh = catalogueRefresh
    if (refresh) await refresh.catch(() => {})
    if (
      disposed ||
      !provider.isOpen ||
      liveAttachment ||
      !checkTurnAllowed().allowed
    ) return
    await current().session.warmup()
  }

  function refreshModels(model?: string): Promise<void> {
    if (catalogueRefresh) return catalogueRefresh
    catalogueRefresh = (async () => {
      invalidateRayuConfigCache()
      const previous = buildCatalogue(current().session)
      const pending: ModelCatalogueView = { ...previous, loading: true, error: null }
      current().session.availableModels = pending
      provider.post({ type: 'setModelCatalogue', catalogue: pending })
      const outcome = await refreshProviderCatalogue({ enginePath, cwd: engineCwd }, model)
      if (disposed) return
      invalidateRayuConfigCache()
      const active = readActiveModel()
      if (outcome.inference && ((active.provider === outcome.activeProviderId && active.model === outcome.activeModel) || model === outcome.activeModel)) {
        current().session.applyInitialInference(outcome.inference)
      }
      current().session.availableModels = {
        options: outcome.catalogue ?? previous.options,
        loading: false,
        error: outcome.ok ? null : outcome.error ?? 'Could not refresh models.',
      }
      provider.syncState()
    })().finally(() => { catalogueRefresh = null })
    return catalogueRefresh
  }

  /** Run the editor-native login flow, then refresh the same state as the button. */
  async function signInToRayucode(): Promise<void> {
    await runSignIn(provider, { enginePath, cwd: engineCwd })
    await refreshModels()
    prewarmSession()
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
  async function restartEngineWithResume(): Promise<void> {
    invalidateRayuConfigCache()
    const sessionId = current().session.engineSessionId
    if (!sessionId) {
      // `preserveModel` throughout: this is a RESTART of one conversation, not a new one, so
      // it must not adopt whatever model another conversation has since selected.
      current().session.newSession(undefined, undefined, { preserveModel: true })
      provider.syncState()
      prewarmSession()
      return
    }
    const cwd = workspaceDir ?? engineCwd
    current().session.newSession(sessionId, cwd, { preserveModel: true })
    current().session.restoreTranscript(await loadSessionTranscript(sessionId, cwd))
    await current().session.restoreTaskHistory(sessionId, cwd)
    provider.syncState()
    prewarmSession()
  }

  /** Show a host-owned command result in the transcript, as the CLI shows a system line. */
  function postCommandNotice(message: string): void {
    provider.post({ type: 'addMessage', entry: { id: `cmd-${Date.now()}`, kind: 'notice', text: message, severity: 'info' } })
  }

  async function runModelSettingCommand(command: ModelSettingCommand): Promise<void> {
    switch (command.kind) {
      case 'usage':
        postCommandNotice(command.message)
        return
      case 'show':
        postCommandNotice(describeSelection(command.target, command.agentType))
        return
      case 'reset': {
        const notice = applySelection(command.target, null, command.agentType)
        if (notice) postCommandNotice(notice)
        await restartEngineWithResume()
        return
      }
      case 'choose':
        // The catalogue is what the picker lists, and it may not have been fetched yet.
        void refreshModels()
        setModelChooser(
          buildChooser(
            command.target,
            command.agentType,
            current().session.subagentTypes,
          ),
        )
        return
    }
  }

  provider = new ChatViewProvider(
    context.extensionUri,
    () =>
      buildState(
        version,
        current().session,
        current().permissions,
        providerSetup,
        modelChooser,
        ideContext,
        attachment,
        historySessions,
        registry.summaries(),
        registry.activeSessionKey,
        mcpUi,
        current().customTitle,
        taskInspectionSupported,
        taskInspectionMessage,
      ),
    {
      ready: prewarmSession,
      submitPrompt: async (text, images, delivery = 'normal') => {
        // The CLI implementations of these commands render Ink UI and are therefore
        // absent from the non-interactive engine. Route them to Rayucode's existing
        // native surfaces before the sign-in gate, so `/login` is reachable while the
        // user is signed out.
        const hostCommand = rayucodeHostSlashCommand(text)
        if (hostCommand === 'login') {
          await signInToRayucode()
          return
        }
        if (hostCommand === 'connect') {
          await openProviderSetupSurface(true)
          return
        }
        if (hostCommand === 'logout') {
          await runSignOut(provider)
          return
        }
        if (hostCommand === 'reload-plugins') {
          await current().session.reloadPlugins()
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
          provider.post({ type: 'openTaskCenter' })
          return
        }
        const inferenceCommand = parseRayucodeInferenceCommand(text)
        if (inferenceCommand?.kind === 'open') {
          provider.post({ type: 'openComposerControl', control: inferenceCommand.control })
          return
        }
        if (inferenceCommand?.kind === 'effort') {
          await current().session.setEffort(inferenceCommand.level)
          return
        }
        if (inferenceCommand?.kind === 'model') {
          await current().session.setModel(inferenceCommand.model)
          await refreshModels(inferenceCommand.model)
          provider.post({ type: 'setModelCatalogue', catalogue: buildCatalogue(current().session) })
          return
        }
        if (runtimeSection) {
          provider.post({ type: 'openRuntimeCenter', section: runtimeSection })
          return
        }
        const skillInstall = parseSkillInstallCommand(text)
        if (skillInstall) {
          await current().session.installSkill(skillInstall.source, skillInstall.overwrite)
          return
        }
        // These are `local-jsx` in the CLI and therefore absent from the engine too, but
        // unlike /login they take arguments — so they are parsed rather than matched.
        const settingCommand = parseModelSettingCommand(text, current().session.subagentTypes)
        if (settingCommand) {
          await runModelSettingCommand(settingCommand)
          return
        }
        const sideQuestion = parseSideQuestionCommand(text)
        if (sideQuestion !== null) {
          // An attached CLI owns authentication and execution. Its account may be
          // valid while standalone Rayucode is signed out, so only apply the local
          // sign-in gate when the local engine will answer the side question.
          if (!liveAttachment) {
            const gate = checkTurnAllowed()
            if (!gate.allowed) {
              provider.syncState()
              provider.post({ type: 'showError', message: gate.reason })
              return
            }
          }
          if (liveAttachment) {
            const attachment = liveAttachment
            await current().session.askSideQuestion(
              sideQuestion,
              question => {
                if (attachment.capabilities?.features.sideQuestions === false) {
                  return Promise.reject(
                    new Error(
                      'The attached CLI does not support /btw. Update it and reattach to use this.',
                    ),
                  )
                }
                return attachment.askSideQuestion(question)
              },
            )
          } else {
            await current().session.askSideQuestion(sideQuestion)
          }
          return
        }
        if (liveAttachment && (images?.length ?? 0) > 0) {
          provider.post({
            type: 'showError',
            message: 'Image attachments are unavailable while attached to a CLI session. Detach to send this image with Rayucode.',
          })
          return
        }
        if (liveAttachment) {
          try {
            const operationId = await liveAttachment.submitPrompt(text, delivery)
            current().session.recordMirroredPrompt(text, delivery, operationId)
          } catch (cause) {
            provider.post({
              type: 'showError',
              message: `The attached CLI did not accept the message: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            })
          }
          return
        }
        const acceptedImages = validateImageInputs(images, provider)
        if (acceptedImages === null) return
        await submitPrompt(current().session, provider, text, acceptedImages, delivery)
      },
      interrupt: () => current().session.interrupt(),
      newSession: () => {
        // OPENS a conversation; it does not replace one. The previous implementation called
        // `newSession()` on the single session, which killed a turn that was still running.
        registry.create()
        provider.syncState()
        prewarmSession()
      },
      switchSession: key => {
        if (registry.activate(key)) return
        // A stale key from a list the webview fetched before a session closed. Resync rather
        // than fail: the user pressed a row that no longer exists and needs to see why.
        postLiveSessions()
        provider.post({ type: 'showError', message: 'That conversation is no longer open.' })
      },
      closeSession: key => {
        registry.close(key)
        provider.syncState()
        prewarmSession()
      },
      renameSession: async (key, id, suppliedTitle) => {
        const entry = key
          ? registry.all.find(item => item.key === key)
          : id ? registry.findByEngineSessionId(id) : undefined
        const selected = id ? historySessions.sessions.find(item => item.id === id) : undefined
        const sessionId = entry?.session.engineSessionId ?? id
        if (!sessionId || (!entry && !selected)) {
          provider.post({ type: 'showError', message: 'Send a message before naming this conversation, or refresh session history.' })
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
          if (entry) registry.setTitle(entry.key, trimmed)
          historySessions = {
            ...historySessions,
            sessions: historySessions.sessions.map(item => item.id === sessionId
              ? { ...item, label: trimmed, customTitle: trimmed, lastModified: Date.now() }
              : item),
          }
          provider.post({ type: 'setSessions', list: historySessions })
          provider.syncState()
        } catch (cause) {
          provider.post({ type: 'showError', message: `Could not rename session: ${cause instanceof Error ? cause.message : String(cause)}` })
        }
      },
      permissionResponse: (requestId, decision) =>
        current().permissions.resolve(current().session.controlClient, requestId, { kind: decision }),
      questionResponse: (requestId, answers, notes) => {
        const result = current().permissions.resolveQuestions(
          current().session.controlClient,
          requestId,
          answers,
          notes,
        )
        if (result) current().session.recordQuestionAnswers(result.toolUseId, result.answers)
      },
      // The WEBVIEW owns the dropdown now, so the host only applies the choice. It is
      // configuration only — nothing here touches the composer's text.
      selectModelValue: async value => {
        await current().session.setModel(value)
        // Finish an older in-flight fetch before requesting this selection's effective settings.
        if (catalogueRefresh) await catalogueRefresh
        await refreshModels(value)
        provider.post({
          type: 'setModelCatalogue',
          catalogue: buildCatalogue(current().session),
        })
      },
      refreshModelCatalogue: refreshModels,
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

      attachToSession: async (pid: number) => {
        // Replace any existing attachment: mirroring two sessions into one transcript
        // would interleave unrelated conversations with no way to tell them apart.
        liveAttachment?.detach()
        liveAttachment = null
        current().session.resetMirroredPromptTracking()

        const target = attachTargets.find(t => t.pid === pid)
        if (!target) {
          attachment = {
            ...attachment,
            attached: null,
            error: 'That session is no longer running. Refresh the list.',
          }
          postAttachment()
          return
        }

        standaloneTaskSnapshot = [...current().session.backgroundTasks]
        standaloneConversationSnapshot = current().session.snapshotConversationState()
        await current().session.restoreTaskHistory(target.sessionId, target.cwd)
        const handle = await attachToCliSession(target, {
          onStreamStart: () => current().session.beginMirroredTurn(),
          onStreamDelta: delta => current().session.appendMirroredDelta(delta),
          onStreamThinking: () => current().session.markMirroredThinking(),
          onStreamEnd: () => current().session.endMirroredTurn(),
          onActivity: messages => current().session.applyMirroredActivity(messages),
          onPermissionRequest: request =>
            current().permissions.presentMirrored(request, response =>
              liveAttachment?.respondPermission(request.requestId, response),
            ),
          // Withdrawn or answered elsewhere — either way the card must go.
          onPermissionDismiss: requestId => current().permissions.dismiss(requestId),
          onTaskSnapshot: tasks => {
            taskInspectionSupported = true
            taskInspectionMessage = undefined
            current().session.applyMirroredTaskSnapshot(tasks, true)
          },
          onTaskEvent: event => current().session.applyMirroredTaskEvent(event),
          onTaskUnsupported: message => {
            taskInspectionSupported = false
            taskInspectionMessage = message
            provider.post({ type: 'replaceTaskState', tasks: [], supported: false, message })
          },
          onClosed: () => {
            liveAttachment = null
            taskInspectionSupported = true
            taskInspectionMessage = undefined
            restoreStandaloneConversation()
            attachment = {
              ...attachment,
              attached: null,
              error: 'The attached session exited.',
            }
            postAttachment()
            prewarmSession()
          },
        })

        if (!handle) {
          attachment = {
            ...attachment,
            attached: null,
            error: 'Could not connect to that session. It may have just exited.',
          }
          postAttachment()
          return
        }

        liveAttachment = handle
        attachment = { ...attachment, attached: toAttachableView(target), error: null }
        postAttachment()
      },

      detachFromSession: () => {
        liveAttachment?.detach()
        liveAttachment = null
        current().session.resetMirroredPromptTracking()
        taskInspectionSupported = true
        taskInspectionMessage = undefined
        restoreStandaloneConversation()
        attachment = { ...attachment, attached: null, error: null }
        postAttachment()
        prewarmSession()
      },

      providerSetupOpen: openProviderSetupSurface,

      providerSetupValidate: async (providerId, apiKey, baseURL) => {
        providerSetup = {
          ...providerSetup,
          busy: true,
          busyMessage: 'Checking credentials…',
          error: null,
          discoveredModels: null,
        }
        provider.post({ type: 'setProviderSetup', setup: providerSetup })

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
        provider.post({ type: 'setProviderSetup', setup: providerSetup })
      },

      providerSetupSave: async (providerId, apiKey, baseURL, model) => {
        providerSetup = {
          ...providerSetup,
          busy: true,
          busyMessage: 'Saving provider…',
          error: null,
        }
        provider.post({ type: 'setProviderSetup', setup: providerSetup })

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
          provider.post({ type: 'setProviderSetup', setup: providerSetup })
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
        provider.post({ type: 'setProviderSetup', setup: providerSetup })

        // The running engine resolved its provider at spawn time, so it would keep using
        // the old one. A fresh child reads the new configuration and has no stale cache
        // by construction — a stronger guarantee than invalidating caches in place.
        invalidateRayuConfigCache()
        current().session.newSession()
        provider.post({
          type: 'setModelCatalogue',
          catalogue: buildCatalogue(current().session),
        })
        provider.syncState()
        prewarmSession()
      },

      setEffort: level => current().session.setEffort(level),
      mcpElicitationResponse: (requestId, action, content) => {
        current().session.respondMcpElicitation(requestId, action, content)
      },
      reloadPlugins: () => current().session.reloadPlugins(),
      installSkill: (source, overwrite) => current().session.installSkill(source, overwrite),
      cyclePermissionMode: async () => {
        const next = nextPermissionMode(current().session.currentPermissionMode.id)
        // Post either way. On success the pill moves to the accepted mode; on refusal it
        // is snapped back to what is still enforced, because the webview applies its own
        // optimistic update and would otherwise be left claiming a mode the engine
        // rejected.
        await current().session.setPermissionMode(next)
        provider.post({ type: 'setPermissionMode', mode: current().session.currentPermissionMode })
      },
      setPermissionMode: async (modeId: string) => {
        try {
          await current().session.setPermissionMode(permissionModeById(modeId))
        } catch (error) {
          console.error('[rayucode] failed to set permission mode', error)
        }
        // See above: the authoritative mode is published whatever the outcome.
        provider.post({ type: 'setPermissionMode', mode: current().session.currentPermissionMode })
      },
      // Keep/undo go through the engine's OWN /keep and /undo commands, which is the
      // mechanism `utils/pendingFileChanges.ts` implements for the CLI. The
      // `rewind_files` control request is a different thing — it rewinds everything
      // since a message — and wiring a per-file button to it would revert files the
      // user had chosen to keep.
      reviewKeep: path =>
        submitPrompt(current().session, provider, reviewCommand('keep', path)),
      reviewUndo: path =>
        submitPrompt(current().session, provider, reviewCommand('undo', path)),
      openReviewDiff: path => openReviewDiff(review.store, path),
      openFile: path => openReviewFile(review.store, path),
      openExternal: async rawUrl => {
        try {
          const url = new URL(rawUrl)
          if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new Error('Only http(s) URLs can be opened.')
          }
          await vscode.env.openExternal(vscode.Uri.parse(url.toString()))
        } catch (cause) {
          provider.post({
            type: 'showError',
            message: cause instanceof Error ? cause.message : 'That URL could not be opened.',
          })
        }
      },
      signIn: async () => {
        await signInToRayucode()
      },
      signOut: () => runSignOut(provider),
      // Routed at the in-panel surface. This previously opened a dialog telling the
      // user to run /connect in a terminal, which is the gap this closes.
      openProviderSetup: () => openProviderSetupSurface(true),
      findFiles: async (query: string) => {
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
          provider.post({
            type: 'fileSearchResults',
            query,
            files: buildFileSearchResults(relativePaths, leafFilter),
          })
        } catch {
          provider.post({ type: 'fileSearchResults', query, files: [] })
        }
      },
      resolveContextPaths: async (requestId, uriList) => {
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
          provider.post({ type: 'showError', message: 'Rayucode could not access the dropped file or folder.' })
        }
        provider.post({ type: 'contextPathsResolved', requestId, paths })
      },
      pickContextPaths: async requestId => {        const uris = await vscode.window.showOpenDialog({
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
        provider.post({
          type: 'contextPathsResolved',
          requestId,
          paths: uris ? await contextPathsForUris(uris) : [],
        })
      },
      requestToolOutput: (requestId, entryId) => {
        // ALWAYS replies, like the context-path requests above and for the same reason:
        // the webview awaits this by `requestId`, so a silent path would leave its
        // promise pending and the row stuck on "Loading…". `null` is a real answer —
        // retention is capped, so an old result may genuinely be gone.
        provider.post({
          type: 'toolOutputResolved',
          requestId,
          text: current().session.fullToolOutput(entryId),
        })
      },
      requestTaskOutput: async (requestId, taskKey) => {
        // Same discipline, but the answer comes from the engine over the control channel,
        // so this is the one request of the three that can fail for an external reason. It
        // still always replies — with the reason, which the panel shows in place of the
        // output rather than leaving a button that appears to do nothing.
        try {
          const output = await current().session.taskOutput(taskKey)
          provider.post({
            type: 'taskOutputResolved',
            requestId,
            text: output?.text ?? null,
            truncated: output?.truncated === true,
            ...(output ? {} : { error: 'This conversation has no running engine to ask.' }),
          })
        } catch (cause) {
          provider.post({
            type: 'taskOutputResolved',
            requestId,
            text: null,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      },
      modelChooserChoice: async (target, value, agentType) => {
        setModelChooser(null)
        const notice = applySelection(target, value, agentType)
        if (notice) postCommandNotice(notice)
        // Only restart when something was actually written. A choice that resolved to no
        // model is a no-op, and respawning for it would cost the user a reload for nothing.
        if (notice) await restartEngineWithResume()
      },
      modelChooserTarget: agentType => {
        if (modelChooser?.target !== 'subagent') return
        setModelChooser(
          buildChooser('subagent', agentType, current().session.subagentTypes),
        )
      },
      modelChooserDismiss: () => setModelChooser(null),
      mcpToggle: async (serverName, enabled) => {
        await current().session.toggleMcpServer(serverName, enabled)
        await refreshMcp()
      },
      mcpReconnect: async serverName => {
        await current().session.reconnectMcpServer(serverName)
        await refreshMcp()
      },
      mcpAuthenticate: async serverName => {
        const entry = current()
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
              provider.post({ type: 'setMcpServers', servers: [...servers] })
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
      mcpPasteCallback: async serverName => {
        const entry = current()
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
      mcpClearAuth: async serverName => {
        await current().session.clearMcpAuthentication(serverName)
      },
      getMcpStatus: async () => {
        await refreshMcp()
      },
      listSessions: async () => {
        historySessions = { ...historySessions, status: 'loading' }
        provider.post({ type: 'setSessions', list: historySessions })
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
        provider.post({ type: 'setSessions', list: historySessions })
      },
      resumeSession: async (id: string) => {
        // ── AN OPEN CONVERSATION IS ACTIVATED, NOT RESUMED ──────────────────────
        //
        // If this session is already open in the panel, its engine is alive and may be
        // mid-turn. Respawning it with `--resume` would kill that turn and rebuild the
        // transcript from the session FILE — which is where the raw
        // `<command-name>/model</command-name>` breadcrumbs came from. Activation is both
        // cheaper and lossless.
        if (registry.findByEngineSessionId(id)) {
          registry.activate(registry.findByEngineSessionId(id)!.key)
          prewarmSession()
          return
        }
        const selected = historySessions.sessions.find(item => item.id === id)
        if (!selected) {
          provider.post({
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
        // `create()` starts with an empty transcript, so the restore follows it. The engine
        // child is spawned with `--resume` and is the SOLE writer to the session file;
        // `loadSessionTranscript` only reads.
        const entry = registry.create({ resumeSessionId: id, cwd: resumeCwd, customTitle: selected.customTitle })
        const restored = await loadSessionTranscript(id, resumeCwd)
        entry.session.restoreTranscript(restored)
        await entry.session.restoreTaskHistory(id, resumeCwd)
        provider.syncState()
        prewarmSession()
      },
      stopTask: async (_sourceSessionId, taskId) => {
        try {
          if (liveAttachment) await liveAttachment.stopTask(taskId)
          else await current().session.stopBackgroundTask(taskId)
        } catch (cause) {
          provider.post({
            type: 'showError',
            message: `Could not stop task: ${cause instanceof Error ? cause.message : String(cause)}`,
          })
        }
      },
      sendTaskMessage: async (_sourceSessionId, taskId, text) => {
        try {
          if (!liveAttachment) throw new Error('Follow-up messages are unavailable for this task.')
          await liveAttachment.sendTaskMessage(taskId, text)
        } catch (cause) {
          provider.post({
            type: 'showError',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      },
    },
  )

  // The engine children must die with the window. An orphan keeps its MCP server
  // subprocesses alive, holding ports and file locks after the editor has closed — and with
  // several conversations open there may be several of them.
  context.subscriptions.push({ dispose: () => registry.dispose() })
  // The first conversation is opened HERE, not on first access. `create()` publishes through
  // `provider`, which does not exist until the line above it — and a lazy creation triggered
  // from inside `getState()` would re-enter `syncState()` mid-snapshot. Creating an entry does
  // not spawn an engine; `prewarmSession()` does that once the panel is mounted.
  registry.create()
  // Detach cleanly so the CLI session stops forwarding and drops pending decisions,
  // rather than waiting for the socket to notice the window closed.
  context.subscriptions.push({ dispose: () => liveAttachment?.detach() })

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
      // Without this VS Code tears the DOM down and rebuilds it on every
      // collapse/expand. The state itself lives in the host either way; this
      // only avoids paying for a React remount on a panel toggle.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    provider,
  )

  // Login/provider helpers run in child processes and write Rayucode's profile. Watch
  // that directory so their settled writes are reflected without reloading the window.
  context.subscriptions.push(watchSharedSession(() => {
    invalidateRayuConfigCache()
    provider.syncState()
    void refreshModels()
    prewarmSession()
  }, () => {
    // A Rayucode helper changed its provider catalogue. Refresh the choices while the
    // current conversation keeps its explicit provider-qualified execution selection.
    invalidateRayuConfigCache()
    current().session.availableModels = null
    provider.syncState()
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
            provider.syncState()
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
        await provider.reveal()
        provider.post({ type: 'insertPrompt', text: fenceTerminalSelection(selection) })
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
        await provider.reveal()
        provider.post({ type: 'insertPrompt', text: formatPathMentions(paths) })
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.newSession, async () => {
      await provider.reveal()
      // OPENS a conversation. Whatever was on screen keeps its engine and keeps running —
      // which is the whole difference from the previous behaviour, where this button killed
      // the turn in flight.
      registry.create()
      provider.syncState()
      prewarmSession()
    }),
    vscode.commands.registerCommand(COMMANDS.signIn, async () => {
      await provider.reveal()
      await signInToRayucode()
    }),
    vscode.commands.registerCommand(COMMANDS.signOut, () => runSignOut(provider)),
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
  provider: ChatViewProvider,
  text: string,
  images: ImageInputView[] = [],
  delivery: PromptDeliveryView = 'normal',
): Promise<void> {
  const gate = checkTurnAllowed()
  if (!gate.allowed) {
    // Resync so the panel shows the sign-in surface and limits autocomplete to its
    // recovery commands before reporting why this normal prompt was refused.
    provider.syncState()
    provider.post({ type: 'showError', message: gate.reason })
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
  provider: ChatViewProvider,
): ImageInputView[] | null {
  if (!images?.length) return []
  if (images.length > API_MAX_MEDIA_PER_REQUEST) {
    provider.post({
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
      provider.post({
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

async function runSignIn(
  provider: ChatViewProvider,
  engine: SignInOptions,
): Promise<void> {
  const outcome = await signInFromEditor(engine)
  // Resync either way: on success the panel must unlock, and on failure it must
  // stop showing whatever in-progress state the click implied.
  provider.syncState()

  if (outcome.ok) {
    void vscode.window.showInformationMessage(
      outcome.displayName
        ? `Signed in to Rayu as ${outcome.displayName}.`
        : 'Signed in to Rayu.',
    )
    return
  }
  void vscode.window.showErrorMessage(`Rayu sign-in failed: ${outcome.error}`)
}

async function runSignOut(provider: ChatViewProvider): Promise<void> {
  const CONFIRM = 'Sign out'
  const choice = await vscode.window.showWarningMessage(
    'Sign out of Rayucode?',
    { modal: true },
    CONFIRM,
  )
  if (choice !== CONFIRM) return

  signOutShared()
  provider.syncState()
  void vscode.window.showInformationMessage('Signed out of Rayu.')
}
