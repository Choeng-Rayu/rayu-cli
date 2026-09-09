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

import { ChatViewProvider, CHAT_VIEW_ID } from './panel/chatViewProvider.js'
import { ChatSession } from './panel/sessionHandle.js'
import { PermissionRouter } from './panel/permissionRouter.js'
import { invalidateRayuConfigCache } from '../../utils/rayuConfig.js'
import { readModelOptions, readActiveModel } from './models/modelConfig.js'
import { nextPermissionMode, permissionModeById } from '../shared/permissionModes.js'
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
import type {
  BackgroundTaskView,
  ModelCatalogueView,
  AttachmentView,
  ProviderSetupView,
  SessionSummaryView,
  WebviewState,
} from '../shared/webviewProtocol.js'

/** Command ids, kept in one place so the manifest and the code cannot drift. */
const COMMANDS = {
  newSession: 'rayucode.newSession',
  signIn: 'rayucode.signIn',
  signOut: 'rayucode.signOut',
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
  let historySessions: SessionSummaryView[] | undefined
  let attachment: AttachmentView = { available: undefined, attached: null, error: null }
  let liveAttachment: CliAttachment | null = null
  let standaloneTaskSnapshot: BackgroundTaskView[] = []
  let taskInspectionSupported = true
  let taskInspectionMessage: string | undefined

  function postAttachment(): void {
    provider.post({ type: 'setAttachment', attachment })
  }

  const permissions = new PermissionRouter({
    onShow: request => provider.post({ type: 'showPermissionRequest', request }),
    onDismiss: requestId =>
      provider.post({ type: 'dismissPermissionRequest', requestId }),
  })

  const session = new ChatSession(
    { enginePath, cwd: engineCwd },
    {
      onEntry: entry => provider.post({ type: 'addMessage', entry }),
      onPartial: (id, kind, delta) =>
        provider.post({ type: 'appendPartial', id, kind, delta }),
      onComplete: id => provider.post({ type: 'completeMessage', id }),
      onTurnState: running => provider.post({ type: 'turnState', running }),
      onModelInfo: info => {
        provider.post({ type: 'setModelInfo', info })
        // The engine's catalogue is authoritative for what the active provider can
        // actually serve, so re-publish once it has reported.
        provider.post({ type: 'setModelCatalogue', catalogue: buildCatalogue(session) })
      },
      onError: message => provider.post({ type: 'showError', message }),
      onPermissionRequest: request => permissions.present(request),
      onPermissionCancelled: requestId => permissions.engineCancelled(requestId),
      onSessionEnded: () => permissions.cancelAll(),
      // The review card is the one entry that can stop existing: once everything is
      // kept or undone there is nothing left to act on.
      onReviewCleared: id => provider.post({ type: 'removeEntry', id }),
      // Hunks stay host-side; the editor draws the diff from them.
      onReviewFiles: files => review.store.replace(files),
      onInferenceSettings: settings =>
        provider.post({ type: 'setInferenceSettings', settings }),
      onCommands: commands => provider.post({ type: 'setCommands', commands }),
      onContextUsage: usage =>
        provider.post({
          type: 'setContextUsage',
          percentage: usage.percentage,
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          stale: usage.stale,
        }),
      onMcpServers: servers => provider.post({ type: 'setMcpServers', servers }),
      onTurnDuration: duration => provider.post({ type: 'turnDuration', duration }),
      onTaskStateChanged: task => provider.post({ type: 'upsertTaskState', task }),
      onTaskStateReplaced: tasks =>
        provider.post({ type: 'replaceTaskState', tasks, supported: true }),
    },
  )

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
    await session.warmup()
  }

  function refreshModels(model?: string): Promise<void> {
    if (catalogueRefresh) return catalogueRefresh
    catalogueRefresh = (async () => {
      invalidateRayuConfigCache()
      const previous = buildCatalogue(session)
      session.availableModels = { ...previous, loading: true, error: null }
      provider.post({ type: 'setModelCatalogue', catalogue: session.availableModels })
      const outcome = await refreshProviderCatalogue({ enginePath, cwd: engineCwd }, model)
      if (disposed) return
      invalidateRayuConfigCache()
      const active = readActiveModel()
      if (outcome.inference && ((active.provider === outcome.activeProviderId && active.model === outcome.activeModel) || model === outcome.activeModel)) {
        session.applyInitialInference(outcome.inference)
      }
      session.availableModels = {
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

  provider = new ChatViewProvider(
    context.extensionUri,
    () =>
      buildState(
        version,
        session,
        permissions,
        providerSetup,
        attachment,
        historySessions,
        taskInspectionSupported,
        taskInspectionMessage,
      ),
    {
      ready: prewarmSession,
      submitPrompt: async text => {
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
        await submitPrompt(session, provider, text)
      },
      interrupt: () => session.interrupt(),
      newSession: () => {
        session.newSession()
        provider.syncState()
        prewarmSession()
      },
      permissionResponse: (requestId, decision) =>
        permissions.resolve(session.controlClient, requestId, { kind: decision }),
      questionResponse: (requestId, answers, notes) => {
        const result = permissions.resolveQuestions(
          session.controlClient,
          requestId,
          answers,
          notes,
        )
        if (result) session.recordQuestionAnswers(result.toolUseId, result.answers)
      },
      // The WEBVIEW owns the dropdown now, so the host only applies the choice. It is
      // configuration only — nothing here touches the composer's text.
      selectModelValue: async value => {
        await session.setModel(value)
        // Finish an older in-flight fetch before requesting this selection's effective settings.
        if (catalogueRefresh) await catalogueRefresh
        await refreshModels(value)
        provider.post({ type: 'setModelCatalogue', catalogue: buildCatalogue(session) })
      },
      refreshModelCatalogue: refreshModels,
      // Effort goes through the CLI's own /effort command; thinking through the engine's
      // set_max_thinking_tokens. Each matches that setting's own semantics — see
      // sessionHandle.setEffort / setThinking.
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

        standaloneTaskSnapshot = [...session.backgroundTasks]
        await session.restoreTaskHistory(target.sessionId, target.cwd)
        const handle = await attachToCliSession(target, {
          onStreamStart: () => session.beginMirroredTurn(),
          onStreamDelta: delta => session.appendMirroredDelta(delta),
          onStreamThinking: () => session.markMirroredThinking(),
          onStreamEnd: () => session.endMirroredTurn(),
          onActivity: messages => session.applyMirroredActivity(messages),
          onPermissionRequest: request =>
            permissions.presentMirrored(request, response =>
              liveAttachment?.respondPermission(request.requestId, response),
            ),
          // Withdrawn or answered elsewhere — either way the card must go.
          onPermissionDismiss: requestId => permissions.dismiss(requestId),
          onTaskSnapshot: tasks => {
            taskInspectionSupported = true
            taskInspectionMessage = undefined
            session.applyMirroredTaskSnapshot(tasks, true)
          },
          onTaskEvent: event => session.applyMirroredTaskEvent(event),
          onTaskUnsupported: message => {
            taskInspectionSupported = false
            taskInspectionMessage = message
            provider.post({ type: 'replaceTaskState', tasks: [], supported: false, message })
          },
          onClosed: () => {
            liveAttachment = null
            taskInspectionSupported = true
            taskInspectionMessage = undefined
            session.applyMirroredTaskSnapshot(standaloneTaskSnapshot)
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
        session.applyMirroredTaskSnapshot(standaloneTaskSnapshot)
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
        session.newSession()
        provider.post({ type: 'setModelCatalogue', catalogue: buildCatalogue(session) })
        provider.syncState()
        prewarmSession()
      },

      setEffort: level => session.setEffort(level),
      setThinking: async enabled => {
        // The boolean result is consumed here rather than propagated: the session already
        // reported the acknowledged state through onInferenceSettings, and surfacing a
        // failure twice would double the notice.
        await session.setThinking(enabled)
      },
      cyclePermissionMode: async () => {
        const next = nextPermissionMode(session.currentPermissionMode.id)
        // Only tell the webview once the engine has accepted it. Flipping the pill
        // optimistically would claim "Full access" while the engine still asks for
        // approval on every tool.
        if (await session.setPermissionMode(next)) {
          provider.post({ type: 'setPermissionMode', mode: next })
        }
      },
      setPermissionMode: async (modeId: string) => {
        try {
          const mode = permissionModeById(modeId)
          if (mode && (await session.setPermissionMode(mode))) {
            provider.post({ type: 'setPermissionMode', mode })
          }
        } catch (error) {
          console.error('[rayucode] failed to set permission mode', error)
        }
      },
      // Keep/undo go through the engine's OWN /keep and /undo commands, which is the
      // mechanism `utils/pendingFileChanges.ts` implements for the CLI. The
      // `rewind_files` control request is a different thing — it rewinds everything
      // since a message — and wiring a per-file button to it would revert files the
      // user had chosen to keep.
      reviewKeep: path => submitPrompt(session, provider, reviewCommand('keep', path)),
      reviewUndo: path => submitPrompt(session, provider, reviewCommand('undo', path)),
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
          const files = uris.map(uri => vscode.workspace.asRelativePath(uri))
          provider.post({ type: 'fileSearchResults', query, files })
        } catch {
          provider.post({ type: 'fileSearchResults', query, files: [] })
        }
      },
      mcpToggle: async (serverName, enabled) => {
        await session.toggleMcpServer(serverName, enabled)
      },
      mcpReconnect: async serverName => {
        await session.reconnectMcpServer(serverName)
      },
      getMcpStatus: async () => {
        const servers = await session.getMcpStatus()
        provider.post({ type: 'setMcpServers', servers })
      },
      listSessions: async () => {
        historySessions = await listWorkspaceSessions(workspaceDir)
        provider.post({ type: 'setSessions', sessions: historySessions })
      },
      resumeSession: async (id: string) => {
        // Order matters: newSession() clears the transcript, so the restore must follow
        // it. The engine child is spawned with --resume and is the SOLE writer to the
        // session file; loadSessionTranscript only reads.
        const selected = historySessions?.find(item => item.id === id)
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
        session.newSession(id, resumeCwd)
        const restored = await loadSessionTranscript(id, resumeCwd)
        session.restoreTranscript(restored)
        await session.restoreTaskHistory(id, resumeCwd)
        provider.syncState()
        prewarmSession()
      },
      stopTask: async (_sourceSessionId, taskId) => {
        try {
          if (liveAttachment) await liveAttachment.stopTask(taskId)
          else await session.stopBackgroundTask(taskId)
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

  // The engine child must die with the window. An orphan keeps its MCP server
  // subprocesses alive, holding ports and file locks after the editor has closed.
  context.subscriptions.push({ dispose: () => session.dispose() })
  // Detach cleanly so the CLI session stops forwarding and drops pending decisions,
  // rather than waiting for the socket to notice the window closed.
  context.subscriptions.push({ dispose: () => liveAttachment?.detach() })

  // ── EDITOR CONNECTION ────────────────────────────────────────────────────────
  //
  // Publishes the same `~/.rayu/ide/<port>.lock` the CLI already scans for, so a `rayu`
  // running in this window's terminal attaches to this editor and sees its selection.
  // Started AFTER the session so a failure here cannot prevent the panel from working —
  // the connection is an enhancement, not a prerequisite.
  void (async () => {
    const ide = await startIdeServer(version)
    if (!ide) return
    context.subscriptions.push({ dispose: () => void ide.dispose() })
    context.subscriptions.push(trackEditorSelection(ide))
  })()

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
    session.availableModels = null
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

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.newSession, async () => {
      await provider.reveal()
      // A real reset: the engine child is replaced, because per-session state
      // (read-file tracking, granted permissions, MCP connections, compaction
      // history) has no control request that clears all of it.
      session.newSession()
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
  attachment: AttachmentView,
  historySessions: SessionSummaryView[] | undefined,
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
    attachment,
    permissionMode: session.currentPermissionMode,
    commands: [...session.commands],
    contextUsage: session.contextUsage,
    mcpServers: [...session.mcpServers],
    // Full `init` snapshots replace webview state. Carry the host-owned history
    // list so unrelated model/auth/context syncs cannot erase an open picker.
    sessions: historySessions,
    backgroundTasks: [...session.backgroundTasks],
    taskInspectionSupported,
    taskInspectionMessage,
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
): Promise<void> {
  const gate = checkTurnAllowed()
  if (!gate.allowed) {
    // Resync so the panel shows the sign-in surface and limits autocomplete to its
    // recovery commands before reporting why this normal prompt was refused.
    provider.syncState()
    provider.post({ type: 'showError', message: gate.reason })
    return
  }
  await session.submitPrompt(text)
}

/**
 * Parse only the commands owned by the extension host.
 *
 * Exact matching is intentional. Arguments belong to the CLI command parser, and a
 * normal prompt beginning with similar text must continue to reach the model unchanged.
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
