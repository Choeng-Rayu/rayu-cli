/**
 * One editor tab, permanently bound to one session.
 *
 * ── A PANEL IS NEVER `isActive()`-GATED ────────────────────────────────────────
 *
 * The session this panel renders keeps streaming whether or not its tab is the focused
 * one — that is the whole point of per-session tabs. So a panel accepts every message
 * routed to its key and holds nothing back for "when it is next shown".
 *
 * ── CLOSING A TAB DOES NOT STOP THE SESSION ────────────────────────────────────
 *
 * `onDidDispose` reports that the tab went away; it never tells the registry to retire
 * the session. The session keeps running, stays in the sidebar list, and can be
 * re-opened — its transcript is rebuilt from the host's snapshot on the next `ready`.
 *
 * ── WHY A `MessageCoalescer` PER PANEL ─────────────────────────────────────────
 *
 * Same reason the sidebar has one (see `messageCoalescer.ts`): a streamed turn emits
 * several messages per token. With up to `MAX_LIVE_SESSIONS` panels streaming at once,
 * one coalescer per tab keeps each tab's per-frame merge independent, so a burst in one
 * tab cannot delay or merge with another's.
 */
import * as vscode from 'vscode'

import type {
  HostToWebviewMessage,
  WebviewState,
  WebviewToHostMessage,
} from '../../shared/webviewProtocol.js'
import { MessageCoalescer } from './messageCoalescer.js'
import { renderWebviewHtml, type ChatSurface } from './webviewSurface.js'

export interface SessionPanelHandlers {
  onMessage(sessionKey: string, message: WebviewToHostMessage): void
  /** The user closed the tab. The session KEEPS RUNNING. */
  onClosed(sessionKey: string): void
  /** The panel became the active editor tab. */
  onFocused(sessionKey: string): void
}

export class SessionPanel implements ChatSurface {
  readonly kind = 'panel' as const
  readonly sessionKey: string

  /** Merges per-token streaming messages into one delivery per frame. */
  private readonly outbox: MessageCoalescer
  private readonly disposables: vscode.Disposable[] = []
  /** Set once `dispose()` ran, so a later `onDidDispose` does not double-report. */
  private disposed = false
  /** False once the panel is gone (either by our `dispose()` or the user's close). */
  private open = true

  constructor(
    private readonly panel: vscode.WebviewPanel,
    sessionKey: string,
    extensionUri: vscode.Uri,
    private readonly handlers: SessionPanelHandlers,
  ) {
    this.sessionKey = sessionKey
    this.panel.webview.options = {
      enableScripts: true,
      // Restrict what the webview may load to the bundle directory, exactly as the
      // sidebar does. The CSP already denies everything by default; this is the second
      // half of the same boundary.
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    }
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri)

    this.outbox = new MessageCoalescer(envelope => {
      void this.panel.webview.postMessage(envelope)
    })

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
        this.handlers.onMessage(this.sessionKey, message)
      }),
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) this.handlers.onFocused(this.sessionKey)
      }),
    )

    this.panel.onDidDispose(() => {
      this.open = false
      this.outbox.clear()
      for (const d of this.disposables.splice(0)) d.dispose()
      // A close the USER made is reported; one we initiated in `dispose()` is not, or
      // the registry's `closePanel` and this would both fire `onClosed` for one tab.
      if (!this.disposed) this.handlers.onClosed(this.sessionKey)
    })
  }

  get isOpen(): boolean {
    return this.open
  }

  setTitle(title: string): void {
    this.panel.title = title
  }

  /** Push a message to the tab. No-op once the tab is gone. */
  post(message: HostToWebviewMessage): void {
    if (!this.open) return
    this.outbox.post(message)
  }

  postState(state: WebviewState): void {
    this.post({ type: 'init', state })
  }

  /** Bring the tab to the front, forcing the column it lives in. */
  async reveal(): Promise<void> {
    this.panel.reveal(undefined, true)
  }

  /** Idempotent: disposing an already-disposed panel is a no-op. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.open = false
    this.outbox.clear()
    for (const d of this.disposables.splice(0)) d.dispose()
    this.panel.dispose()
  }
}
