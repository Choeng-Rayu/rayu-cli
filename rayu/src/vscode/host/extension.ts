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
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { API_IMAGE_MAX_BASE64_SIZE, API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'

import { ChatViewProvider, CHAT_VIEW_ID } from './panel/chatViewProvider.js'
import { ChatSession } from './panel/sessionHandle.js'
import {
  SessionRegistry,
  type SessionEntry,
} from './panel/sessionRegistry.js'
import { PermissionRouter } from './panel/permissionRouter.js'
import { invalidateRayuConfigCache } from '../../utils/rayuConfig.js'
import { readModelOptions, readActiveModel } from './models/modelConfig.js'
import { nextPermissionMode, permissionModeById } from '../shared/permissionModes.js'
import { formatPathMentions } from '../shared/contextMentions.js'
import { getAuthSnapshot, signOutShared } from './auth/rayuAuthBridge.js'
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
import {
  listWorkspaceSessions,
  loadSessionTranscript,
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
  WebviewState,
} from '../shared/webviewProtocol.js'

/** Command ids, kept in one place so the manifest and the code cannot drift. */
const COMMANDS = {
  newSession: 'rayucode.newSession',
  signIn: 'rayucode.signIn',
  signOut: 'rayucode.signOut',
  addTerminalSelection: 'rayucode.addTerminalSelection',
  addToContext: 'rayucode.addToContext',
} as const

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
  let attachment: AttachmentView = { available: undefined, attached: null, error: null }
  let liveAttachment: CliAttachment | null = null
  let standaloneTaskSnapshot: BackgroundTaskView[] = []
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
      }),
      onShowPermission: request =>
        provider.post({ type: 'showPermissionRequest', request }),
      onDismissPermission: requestId =>
        provider.post({ type: 'dismissPermissionRequest', requestId }),
      onChanged: () => postLiveSessions(),
      // Hand the diff store to the conversation that is now on screen, then rebuild the panel
      // from it. One full sync is both simpler and more honest than replaying deltas.
      onActivate: entry => {
        review.store.replace(entry.session.reviewFiles)
        provider.syncState()
      },
    },
  )

  /** The conversation on screen. Resolved per call — see the registry's construction. */
  function current(): SessionEntry {
    return registry.active
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
        setModelChooser(buildChooser(command.target, command.agentType))
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
        taskInspectionSupported,
        taskInspectionMessage,
      ),
    {
      ready: prewarmSession,
      submitPrompt: async (text, images) => {
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
        // These are `local-jsx` in the CLI and therefore absent from the engine too, but
        // unlike /login they take arguments — so they are parsed rather than matched.
        const settingCommand = parseModelSettingCommand(text, current().session.subagentTypes)
        if (settingCommand) {
          await runModelSettingCommand(settingCommand)
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
          await liveAttachment.submitPrompt(text)
          return
        }
        const acceptedImages = validateImageInputs(images, provider)
        if (acceptedImages === null) return
        await submitPrompt(current().session, provider, text, acceptedImages)
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
      // Effort goes through the CLI's own `/effort` command — see sessionHandle.setEffort.
      // Thinking has no control request: it is forced on for the whole session by the
      // `--thinking enabled` spawn flag, which is the only mechanism that outranks the
      // user's `alwaysThinkingEnabled` setting.
      listAttachable: async () => {
        const outcome = await listAttachTargets({ enginePath, cwd: engineCwd }, engineCwd)
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
            current().session.applyMirroredTaskSnapshot(standaloneTaskSnapshot)
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
        taskInspectionSupported = true
        taskInspectionMessage = undefined
        current().session.applyMirroredTaskSnapshot(standaloneTaskSnapshot)
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
      openFile: path => openReviewFile(path),
      signIn: async () => {
        await signInToRayucode()
      },
      signOut: () => runSignOut(provider),
      // Routed at the in-panel surface. This previously opened a dialog telling the
      // user to run /connect in a terminal, which is the gap this closes.
      openProviderSetup: () => openProviderSetupSurface(true),
      findFiles: async (query: string) => {
        try {
          const pattern = query ? `**/*${query}*` : '**/*'
          const uris = await vscode.workspace.findFiles(
            pattern,
            '{**/node_modules/**,**/.git/**,**/dist/**,**/.turbo/**}',
            50,
          )
          const files = uris.map(uri => vscode.workspace.asRelativePath(uri, false))
          // VS Code's findFiles API returns files only. Derive their parent folders so
          // the same @ picker can reference directories, which the shared attachment
          // parser already knows how to expand.
          const folders = new Set<string>()
          for (const file of files) {
            const parts = file.replace(/\\/g, '/').split('/')
            for (let index = 1; index < parts.length; index += 1) {
              const folder = `${parts.slice(0, index).join('/')}/`
              if (!query || folder.toLowerCase().includes(query.toLowerCase())) folders.add(folder)
            }
          }
          provider.post({
            type: 'fileSearchResults',
            query,
            files: [...folders, ...files].slice(0, 75),
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
      modelChooserChoice: async (target, value, agentType) => {
        setModelChooser(null)
        const notice = applySelection(target, value, agentType)
        if (notice) postCommandNotice(notice)
        // Only restart when something was actually written. A choice that resolved to no
        // model is a no-op, and respawning for it would cost the user a reload for nothing.
        if (notice) await restartEngineWithResume()
      },
      modelChooserDismiss: () => setModelChooser(null),
      mcpToggle: async (serverName, enabled) => {
        await current().session.toggleMcpServer(serverName, enabled)
      },      mcpReconnect: async serverName => {
        await current().session.reconnectMcpServer(serverName)
      },
      getMcpStatus: async () => {
        const servers = await current().session.getMcpStatus()
        provider.post({ type: 'setMcpServers', servers })
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
        const entry = registry.create({ resumeSessionId: id, cwd: resumeCwd })
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
): Promise<void> {
  const gate = checkTurnAllowed()
  if (!gate.allowed) {
    // Resync so the panel shows the sign-in surface and limits autocomplete to its
    // recovery commands before reporting why this normal prompt was refused.
    provider.syncState()
    provider.post({ type: 'showError', message: gate.reason })
    return
  }
  await session.submitPrompt(text, images)
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
function rayucodeHostSlashCommand(text: string): 'login' | 'connect' | null {
  const command = text.trim()
  if (command === '/login') return 'login'
  if (command === '/connect') return 'connect'
  return null
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
