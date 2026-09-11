/**
 * The Rayucode chat panel.
 *
 * A `WebviewViewProvider`, so the UI lives in the sidebar next to Explorer and
 * Source Control rather than in an editor tab. That is the placement the Copilot
 * Chat design this UI follows uses, and it is what lets the panel stay open beside
 * the code it is editing.
 *
 * ── THE WEBVIEW IS A BROWSER, AND IS TREATED AS UNTRUSTED ──────────────────────
 *
 * A webview runs real web content in the editor. Two consequences drive the
 * implementation below:
 *
 * 1. STRICT CSP WITH A PER-LOAD NONCE. Content-Security-Policy `default-src
 *    'none'` denies everything, then scripts are allowed only with a nonce
 *    generated fresh for this exact page load. This matters because the transcript
 *    renders MODEL OUTPUT and TOOL OUTPUT — text from a language model and from
 *    arbitrary files. Without a nonce-based policy, a crafted response containing
 *    a `<script>` tag would execute inside the editor with the webview's
 *    privileges. A nonce cannot be guessed by content that was generated before
 *    the nonce existed.
 *
 * 2. NO SECRETS CROSS THE BOUNDARY. The host holds the access token and never
 *    sends it in a message. The webview learns only whether the user is signed in.
 *
 * ── WHY `retainContextWhenHidden` IS NOT SET ───────────────────────────────────
 *
 * It keeps the whole DOM and JS heap alive while the panel is collapsed, for every
 * window, forever. The state that must survive lives in the HOST, which owns the
 * engine process anyway, so the panel can be rebuilt from an `init` message. The
 * `ready` handshake exists precisely so that rebuild is a normal path rather than
 * a special case.
 */
import * as vscode from 'vscode'

import type { EffortChoice } from '../../shared/inferenceSettings.js'
import type {
  HostToWebviewMessage,
  ImageInputView,
  WebviewState,
  WebviewToHostMessage,
} from '../../shared/webviewProtocol.js'

/** Matches the view id contributed in `extension.manifest.json`. */
export const CHAT_VIEW_ID = 'rayucode.chat'

/**
 * Actions the panel can ask the host to perform.
 *
 * Injected rather than imported so this provider stays about the WEBVIEW — its
 * HTML, its CSP, its message plumbing — and does not also own the auth flow.
 */
export interface ChatViewHandlers {
  /** The panel is mounted and can benefit from background engine initialization. */
  ready: () => Promise<void> | void
  submitPrompt: (text: string, images?: ImageInputView[]) => Promise<void> | void
  interrupt: () => Promise<void> | void
  newSession: () => Promise<void> | void
  /** Bring an already-open conversation to the front. Nothing is spawned or stopped. */
  switchSession: (key: string) => Promise<void> | void
  /** Close an open conversation and stop its engine. */
  closeSession: (key: string) => Promise<void> | void
  permissionResponse: (
    requestId: string,
    decision: 'allow-once' | 'allow-always' | 'deny',
  ) => Promise<void> | void
  questionResponse: (
    requestId: string,
    answers: Record<string, string>,
    notes: Record<string, string>,
  ) => Promise<void> | void
  selectModelValue: (value: string) => Promise<void> | void
  refreshModelCatalogue: () => Promise<void> | void
  setEffort: (level: EffortChoice) => Promise<void> | void
  listAttachable: () => Promise<void> | void
  attachToSession: (pid: number) => Promise<void> | void
  detachFromSession: () => Promise<void> | void
  providerSetupOpen: (open: boolean) => Promise<void> | void
  providerSetupValidate: (
    providerId: string,
    apiKey?: string,
    baseURL?: string,
  ) => Promise<void> | void
  providerSetupSave: (
    providerId: string,
    apiKey?: string,
    baseURL?: string,
    model?: string,
  ) => Promise<void> | void
  cyclePermissionMode: () => Promise<void> | void
  setPermissionMode?: (modeId: string) => Promise<void> | void
  reviewKeep: (path?: string) => Promise<void> | void
  reviewUndo: (path?: string) => Promise<void> | void
  openReviewDiff: (path: string) => Promise<void> | void
  openFile: (path: string) => Promise<void> | void
  signIn: () => Promise<void> | void
  signOut: () => Promise<void> | void
  openProviderSetup: () => Promise<void> | void
  findFiles: (query: string) => Promise<void> | void
  resolveContextPaths: (requestId: string, uriList: string) => Promise<void> | void
  pickContextPaths: (requestId: string) => Promise<void> | void
  /** Serve a tool row's untruncated output. Must always reply — see the message doc. */
  requestToolOutput: (requestId: string, entryId: string) => Promise<void> | void
  /** Apply a model-chooser choice. `value` null resets to the default. */
  modelChooserChoice: (
    target: 'subagent' | 'webfetch',
    value: string | null,
    agentType?: string,
  ) => Promise<void> | void
  modelChooserDismiss: () => Promise<void> | void
  mcpToggle: (serverName: string, enabled: boolean) => Promise<void> | void
  mcpReconnect: (serverName: string) => Promise<void> | void
  getMcpStatus: () => Promise<void> | void
  listSessions: () => Promise<void> | void
  resumeSession: (id: string) => Promise<void> | void
  stopTask: (sourceSessionId: string, taskId: string) => Promise<void> | void
  sendTaskMessage: (
    sourceSessionId: string,
    taskId: string,
    text: string,
  ) => Promise<void> | void
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** Resolves the current snapshot. Called on every `ready`, so it must be cheap. */
    private readonly getState: () => WebviewState,
    private readonly handlers: ChatViewHandlers,
  ) {}

  /** Whether VS Code has mounted the chat view. */
  get isOpen(): boolean {
    return this.view !== undefined
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view

    view.webview.options = {
      enableScripts: true,
      // Restrict what the webview may load to the bundle directory. Without this
      // it can reach any file in the extension, and with a `localResourceRoots`
      // of the whole install there is no benefit to the CSP path restrictions.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    }

    view.webview.html = this.render(view.webview)

    this.disposables.push(
      view.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
        this.handleMessage(message)
      }),
    )

    view.onDidDispose(() => {
      this.view = undefined
      for (const d of this.disposables.splice(0)) d.dispose()
    })
  }

  /** Push a message to the panel. No-op when the panel is not open. */
  post(message: HostToWebviewMessage): void {
    // Not an error worth surfacing: the user collapsed the panel. State is
    // re-sent on the next `ready`, which is why that handshake exists.
    void this.view?.webview.postMessage(message)
  }

  /** Send the current snapshot, e.g. after a sign-in state change. */
  syncState(): void {
    this.post({ type: 'init', state: this.getState() })
  }

  /** Reveal the panel, opening the container if the user has it collapsed. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true)
      return
    }
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`)
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose()
  }

  private handleMessage(message: WebviewToHostMessage): void {
    switch (message.type) {
      case 'ready':
        // The listener is attached; anything sent before now was dropped.
        this.syncState()
        void this.handlers.ready()
        return
      case 'submitPrompt':
        void this.handlers.submitPrompt(message.text, message.images)
        return
      case 'interrupt':
        void this.handlers.interrupt()
        return
      case 'newSession':
        void this.handlers.newSession()
        return
      case 'switchSession':
        void this.handlers.switchSession(message.key)
        return
      case 'closeSession':
        void this.handlers.closeSession(message.key)
        return
      case 'permissionResponse':
        void this.handlers.permissionResponse(message.requestId, message.decision)
        return
      case 'questionResponse':
        void this.handlers.questionResponse(
          message.requestId,
          message.answers,
          message.notes,
        )
        return
      case 'selectModelValue':
        void this.handlers.selectModelValue(message.value)
        return
      case 'refreshModelCatalogue':
        void this.handlers.refreshModelCatalogue()
        return
      case 'setEffort':
        void this.handlers.setEffort(message.level)
        return

      case 'listAttachable':
        void this.handlers.listAttachable()
        return

      case 'attachToSession':
        void this.handlers.attachToSession(message.pid)
        return

      case 'detachFromSession':
        void this.handlers.detachFromSession()
        return

      case 'providerSetupOpen':
        void this.handlers.providerSetupOpen(message.open)
        return

      case 'providerSetupValidate':
        void this.handlers.providerSetupValidate(
          message.providerId,
          message.apiKey,
          message.baseURL,
        )
        return

      case 'providerSetupSave':
        void this.handlers.providerSetupSave(
          message.providerId,
          message.apiKey,
          message.baseURL,
          message.model,
        )
        return
      case 'cyclePermissionMode':
        void this.handlers.cyclePermissionMode()
        return
      case 'setPermissionMode':
        void this.handlers.setPermissionMode?.(message.modeId)
        return
      case 'reviewKeep':
        void this.handlers.reviewKeep(message.path)
        return
      case 'reviewUndo':
        void this.handlers.reviewUndo(message.path)
        return
      case 'openReviewDiff':
        void this.handlers.openReviewDiff(message.path)
        return
      case 'openFile':
        void this.handlers.openFile(message.path)
        return
      case 'signIn':
        void this.handlers.signIn()
        return
      case 'signOut':
        void this.handlers.signOut()
        return
      case 'openProviderSetup':
        void this.handlers.openProviderSetup()
        return
      case 'findFiles':
        void this.handlers.findFiles(message.query)
        return
      case 'resolveContextPaths':
        void this.handlers.resolveContextPaths(message.requestId, message.uriList)
        return
      case 'pickContextPaths':
        void this.handlers.pickContextPaths(message.requestId)
        return
      case 'requestToolOutput':
        void this.handlers.requestToolOutput(message.requestId, message.entryId)
        return
      case 'modelChooserChoice':
        void this.handlers.modelChooserChoice(
          message.target,
          message.value,
          message.agentType,
        )
        return
      case 'modelChooserDismiss':
        void this.handlers.modelChooserDismiss()
        return
      case 'mcpToggle':
        void this.handlers.mcpToggle(message.serverName, message.enabled)
        return
      case 'mcpReconnect':
        void this.handlers.mcpReconnect(message.serverName)
        return
      case 'getMcpStatus':
        void this.handlers.getMcpStatus()
        return
      case 'listSessions':
        void this.handlers.listSessions()
        return
      case 'resumeSession':
        void this.handlers.resumeSession(message.id)
        return
      case 'stopTask':
        void this.handlers.stopTask(message.sourceSessionId, message.taskId)
        return
      case 'sendTaskMessage':
        void this.handlers.sendTaskMessage(
          message.sourceSessionId,
          message.taskId,
          message.text,
        )
        return
      default:
        // An unknown message means host and webview were built from different
        // sources. Silence would make that undiagnosable.
        console.error(
          `[rayucode] unrecognised message from webview: ${JSON.stringify(message)}`,
        )
    }
  }

  private render(webview: vscode.Webview): string {
    const nonce = createNonce()
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'),
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'),
    )

    // `default-src 'none'` first, then the narrowest possible allowances.
    // `style-src` needs 'unsafe-inline' because VS Code itself injects the theme
    // variable block inline; that is the editor's own style element, not content.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>Rayucode</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`
  }
}

/**
 * A fresh nonce per page load.
 *
 * Regenerated on every `render()` rather than cached: a nonce reused across loads
 * could be embedded in content captured from an earlier one, which defeats the
 * point of having it.
 */
function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let nonce = ''
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return nonce
}
