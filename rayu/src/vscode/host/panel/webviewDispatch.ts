/**
 * The webview→host dispatch table, factored out of the sidebar provider.
 *
 * ── WHY IT MOVED HERE ──────────────────────────────────────────────────────────
 *
 * Before per-session tabs there was exactly one webview, so the provider could own the
 * `switch` over `WebviewToHostMessage` directly. Now every surface forwards the same
 * messages, and the handler must act on the session the SENDER is bound to — not on
 * whatever is globally active. So each handler gains a leading `scope` describing the
 * origin, and this module is the single port of that switch.
 *
 * ── PURE: NO `vscode` IMPORT ───────────────────────────────────────────────────
 *
 * Everything here is data in, handler calls out. That keeps it runnable under
 * `bun test` (which cannot load the `vscode` module) and makes the routing exhaustively
 * unit-testable against the message union.
 */
import type { EffortChoice } from '../../shared/inferenceSettings.js'
import type {
  ChatSurfaceKind,
  HostToWebviewMessage,
  ImageInputView,
  PromptDeliveryView,
  WebviewToHostMessage,
} from '../../shared/webviewProtocol.js'

/** Everything a handler needs to act on the surface that sent a message. */
export interface SurfaceScope {
  readonly kind: ChatSurfaceKind
  readonly sessionKey: string
  /** Reply to the originating surface only. */
  reply: (message: HostToWebviewMessage) => void
  /** Rebuild this session's surfaces from its snapshot. */
  resync: () => void
}

/**
 * Actions a surface can ask the host to perform.
 *
 * Injected rather than imported so the dispatch stays about the WEBVIEW message
 * plumbing and does not also own the auth flow, the engine, or the review store.
 *
 * EVERY method takes the originating `scope` first: a handler resolves the session it
 * acts on from that scope, never from a global "current". Replies go to
 * `scope.reply`, and a session-scoped resync goes through `scope.resync` — both of
 * which target the surface that asked rather than the focused one.
 */
export interface ChatViewHandlers {
  /** The surface is mounted and can benefit from background engine initialization. */
  ready: (scope: SurfaceScope) => Promise<void> | void
  submitPrompt: (
    scope: SurfaceScope,
    text: string,
    images?: ImageInputView[],
    delivery?: PromptDeliveryView,
  ) => Promise<void> | void
  interrupt: (scope: SurfaceScope) => Promise<void> | void
  newSession: (scope: SurfaceScope) => Promise<void> | void
  /** Bring an already-open conversation to the front. Nothing is spawned or stopped. */
  switchSession: (scope: SurfaceScope, key: string) => Promise<void> | void
  /** Close an open conversation and stop its engine. */
  closeSession: (scope: SurfaceScope, key: string) => Promise<void> | void
  renameSession: (
    scope: SurfaceScope,
    key: string | undefined,
    id: string | undefined,
    title?: string,
  ) => Promise<void> | void
  /** Open/focus a LIVE session as its own editor tab (no spawn, no teardown). */
  openSessionPanel: (scope: SurfaceScope, key: string) => Promise<void> | void
  /** Resume a STORED session as its own editor tab. */
  resumeSessionPanel: (scope: SurfaceScope, id: string) => Promise<void> | void
  permissionResponse: (
    scope: SurfaceScope,
    requestId: string,
    decision: 'allow-once' | 'allow-always' | 'deny',
  ) => Promise<void> | void
  questionResponse: (
    scope: SurfaceScope,
    requestId: string,
    answers: Record<string, string>,
    notes: Record<string, string>,
  ) => Promise<void> | void
  selectModelValue: (scope: SurfaceScope, value: string) => Promise<void> | void
  refreshModelCatalogue: (scope: SurfaceScope) => Promise<void> | void
  setEffort: (scope: SurfaceScope, level: EffortChoice) => Promise<void> | void
  setThinking: (scope: SurfaceScope, enabled: boolean) => Promise<void> | void

  listAttachable: (scope: SurfaceScope) => Promise<void> | void
  attachToSession: (scope: SurfaceScope, pid: number) => Promise<void> | void
  detachFromSession: (scope: SurfaceScope) => Promise<void> | void
  providerSetupOpen: (scope: SurfaceScope, open: boolean) => Promise<void> | void
  providerSetupValidate: (
    scope: SurfaceScope,
    providerId: string,
    apiKey?: string,
    baseURL?: string,
  ) => Promise<void> | void
  providerSetupSave: (
    scope: SurfaceScope,
    providerId: string,
    apiKey?: string,
    baseURL?: string,
    model?: string,
  ) => Promise<void> | void
  cyclePermissionMode: (scope: SurfaceScope) => Promise<void> | void
  setPermissionMode: (scope: SurfaceScope, modeId: string) => Promise<void> | void
  reviewKeep: (scope: SurfaceScope, path?: string) => Promise<void> | void
  reviewUndo: (scope: SurfaceScope, path?: string) => Promise<void> | void
  openReviewDiff: (scope: SurfaceScope, path: string) => Promise<void> | void
  openFile: (scope: SurfaceScope, path: string) => Promise<void> | void
  openExternal: (scope: SurfaceScope, url: string) => Promise<void> | void
  signIn: (scope: SurfaceScope) => Promise<void> | void
  signOut: (scope: SurfaceScope) => Promise<void> | void
  openProviderSetup: (scope: SurfaceScope) => Promise<void> | void
  findFiles: (scope: SurfaceScope, query: string) => Promise<void> | void
  resolveContextPaths: (
    scope: SurfaceScope,
    requestId: string,
    uriList: string,
  ) => Promise<void> | void
  pickContextPaths: (scope: SurfaceScope, requestId: string) => Promise<void> | void
  /** Serve a tool row's untruncated output. Must always reply — see the message doc. */
  requestToolOutput: (
    scope: SurfaceScope,
    requestId: string,
    entryId: string,
  ) => Promise<void> | void
  requestTaskOutput: (
    scope: SurfaceScope,
    requestId: string,
    taskKey: string,
  ) => Promise<void> | void
  /** Apply a model-chooser choice. `value` null resets to the default. */
  modelChooserChoice: (
    scope: SurfaceScope,
    target: 'subagent' | 'webfetch',
    value: string | null,
    agentType?: string,
  ) => Promise<void> | void
  /** Change only the scope displayed by the open subagent chooser. */
  modelChooserTarget: (scope: SurfaceScope, agentType?: string) => Promise<void> | void
  modelChooserDismiss: (scope: SurfaceScope) => Promise<void> | void
  mcpToggle: (scope: SurfaceScope, serverName: string, enabled: boolean) => Promise<void> | void
  mcpReconnect: (scope: SurfaceScope, serverName: string) => Promise<void> | void
  mcpAuthenticate: (scope: SurfaceScope, serverName: string) => Promise<void> | void
  mcpPasteCallback: (scope: SurfaceScope, serverName: string) => Promise<void> | void
  mcpClearAuth: (scope: SurfaceScope, serverName: string) => Promise<void> | void
  getMcpStatus: (scope: SurfaceScope) => Promise<void> | void
  mcpElicitationResponse: (
    scope: SurfaceScope,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => Promise<void> | void
  reloadPlugins: (scope: SurfaceScope) => Promise<void> | void
  installSkill: (scope: SurfaceScope, source: string, overwrite?: boolean) => Promise<void> | void
  listSessions: (scope: SurfaceScope) => Promise<void> | void
  resumeSession: (scope: SurfaceScope, id: string) => Promise<void> | void
  stopTask: (
    scope: SurfaceScope,
    sourceSessionId: string,
    taskId: string,
  ) => Promise<void> | void
  sendTaskMessage: (
    scope: SurfaceScope,
    sourceSessionId: string,
    taskId: string,
    text: string,
  ) => Promise<void> | void
}

/**
 * Route one webview message to its handler, tagged with the origin surface.
 *
 * The `switch` is exhaustive over `WebviewToHostMessage`: a variant added to the union
 * without a case here fails to compile at the `never` check below, so no message can be
 * silently swallowed.
 */
export function dispatchWebviewMessage(
  message: WebviewToHostMessage,
  scope: SurfaceScope,
  handlers: ChatViewHandlers,
): void {
  switch (message.type) {
    case 'ready':
      // The listener is attached; anything sent before now was dropped. The surface's
      // snapshot is (re)sent by the registry's `ready` handling; this only warms the
      // engine if it is not already running.
      void handlers.ready(scope)
      return
    case 'submitPrompt':
      void handlers.submitPrompt(scope, message.text, message.images, message.delivery)
      return
    case 'interrupt':
      void handlers.interrupt(scope)
      return
    case 'newSession':
      void handlers.newSession(scope)
      return
    case 'switchSession':
      void handlers.switchSession(scope, message.key)
      return
    case 'openSessionPanel':
      void handlers.openSessionPanel(scope, message.key)
      return
    case 'resumeSessionPanel':
      void handlers.resumeSessionPanel(scope, message.id)
      return
    case 'closeSession':
      void handlers.closeSession(scope, message.key)
      return
    case 'renameSession':
      void handlers.renameSession(scope, message.key, message.id, message.title)
      return
    case 'permissionResponse':
      void handlers.permissionResponse(scope, message.requestId, message.decision)
      return
    case 'questionResponse':
      void handlers.questionResponse(scope, message.requestId, message.answers, message.notes)
      return
    case 'selectModelValue':
      void handlers.selectModelValue(scope, message.value)
      return
    case 'refreshModelCatalogue':
      void handlers.refreshModelCatalogue(scope)
      return
    case 'setEffort':
      void handlers.setEffort(scope, message.level)
      return
    case 'setThinking':
      void handlers.setThinking(scope, message.enabled)
      return

    case 'listAttachable':
      void handlers.listAttachable(scope)
      return
    case 'attachToSession':
      void handlers.attachToSession(scope, message.pid)
      return
    case 'detachFromSession':
      void handlers.detachFromSession(scope)
      return
    case 'providerSetupOpen':
      void handlers.providerSetupOpen(scope, message.open)
      return
    case 'providerSetupValidate':
      void handlers.providerSetupValidate(
        scope,
        message.providerId,
        message.apiKey,
        message.baseURL,
      )
      return
    case 'providerSetupSave':
      void handlers.providerSetupSave(
        scope,
        message.providerId,
        message.apiKey,
        message.baseURL,
        message.model,
      )
      return
    case 'cyclePermissionMode':
      void handlers.cyclePermissionMode(scope)
      return
    case 'setPermissionMode':
      void handlers.setPermissionMode(scope, message.modeId)
      return
    case 'reviewKeep':
      void handlers.reviewKeep(scope, message.path)
      return
    case 'reviewUndo':
      void handlers.reviewUndo(scope, message.path)
      return
    case 'openReviewDiff':
      void handlers.openReviewDiff(scope, message.path)
      return
    case 'openFile':
      void handlers.openFile(scope, message.path)
      return
    case 'openExternal':
      void handlers.openExternal(scope, message.url)
      return
    case 'signIn':
      void handlers.signIn(scope)
      return
    case 'signOut':
      void handlers.signOut(scope)
      return
    case 'openProviderSetup':
      void handlers.openProviderSetup(scope)
      return
    case 'findFiles':
      void handlers.findFiles(scope, message.query)
      return
    case 'resolveContextPaths':
      void handlers.resolveContextPaths(scope, message.requestId, message.uriList)
      return
    case 'pickContextPaths':
      void handlers.pickContextPaths(scope, message.requestId)
      return
    case 'requestToolOutput':
      void handlers.requestToolOutput(scope, message.requestId, message.entryId)
      return
    case 'requestTaskOutput':
      void handlers.requestTaskOutput(scope, message.requestId, message.taskKey)
      return
    case 'modelChooserChoice':
      void handlers.modelChooserChoice(scope, message.target, message.value, message.agentType)
      return
    case 'modelChooserTarget':
      void handlers.modelChooserTarget(scope, message.agentType)
      return
    case 'modelChooserDismiss':
      void handlers.modelChooserDismiss(scope)
      return
    case 'mcpToggle':
      void handlers.mcpToggle(scope, message.serverName, message.enabled)
      return
    case 'mcpReconnect':
      void handlers.mcpReconnect(scope, message.serverName)
      return
    case 'mcpAuthenticate':
      void handlers.mcpAuthenticate(scope, message.serverName)
      return
    case 'mcpPasteCallback':
      void handlers.mcpPasteCallback(scope, message.serverName)
      return
    case 'mcpClearAuth':
      void handlers.mcpClearAuth(scope, message.serverName)
      return
    case 'getMcpStatus':
      void handlers.getMcpStatus(scope)
      return
    case 'mcpElicitationResponse':
      void handlers.mcpElicitationResponse(
        scope,
        message.requestId,
        message.action,
        message.content,
      )
      return
    case 'reloadPlugins':
      void handlers.reloadPlugins(scope)
      return
    case 'installSkill':
      void handlers.installSkill(scope, message.source, message.overwrite)
      return
    case 'listSessions':
      void handlers.listSessions(scope)
      return
    case 'resumeSession':
      void handlers.resumeSession(scope, message.id)
      return
    case 'stopTask':
      void handlers.stopTask(scope, message.sourceSessionId, message.taskId)
      return
    case 'sendTaskMessage':
      void handlers.sendTaskMessage(
        scope,
        message.sourceSessionId,
        message.taskId,
        message.text,
      )
      return
    default: {
      // An unknown message means host and webview were built from different sources.
      // Silence would make that undiagnosable. The `never` assignment is the
      // exhaustiveness proof: a new union variant without a case breaks compilation.
      const unexpected: never = message
      console.error(`[rayucode] unrecognised message from webview: ${JSON.stringify(unexpected)}`)
    }
  }
}
