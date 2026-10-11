/**
 * The Rayucode chat panel (the SIDEBAR surface).
 *
 * A `WebviewViewProvider`, so the UI lives in the sidebar next to Explorer and Source
 * Control rather than in an editor tab. Per-session EDITOR tabs are `SessionPanel`s;
 * this provider is now one `ChatSurface` among several, deliberately thin:
 *
 *   - It owns the sidebar `WebviewView`, its options, and its one message listener.
 *   - It forwards EVERY message — including `ready` — to the host through `deps.onMessage`;
 *     it no longer owns a dispatch table (see `webviewDispatch.ts`) and never builds an
 *     `init` snapshot itself. The host routes and snapshots, and posts inits through
 *     `postState`.
 *
 * ── THE WEBVIEW IS A BROWSER, AND IS TREATED AS UNTRUSTED ──────────────────────
 *
 * A webview runs real web content in the editor. Two consequences drive this file and
 * the shared `renderWebviewHtml`:
 *
 * 1. STRICT CSP WITH A PER-LOAD NONCE. Content-Security-Policy `default-src 'none'`
 *    denies everything, then scripts are allowed only with a nonce generated fresh for
 *    this exact page load. This matters because the transcript renders MODEL OUTPUT and
 *    TOOL OUTPUT — text from a language model and from arbitrary files. A nonce cannot
 *    be guessed by content that was generated before the nonce existed.
 *
 * 2. NO SECRETS CROSS THE BOUNDARY. The host holds the access token and never sends it
 *    in a message. The webview learns only whether the user is signed in.
 *
 * ── WHY `retainContextWhenHidden` IS SET (see its registration in extension.ts) ──
 *
 * It keeps the webview's DOM and JS heap alive while the panel is collapsed. That costs
 * memory, but the alternative costs more where users feel it: without it VS Code destroys
 * the panel on every sidebar switch, so showing it again re-parses the bundle and
 * re-renders the whole transcript, and whatever only the webview knows — the half-typed
 * prompt, attachments, scroll position, expanded rows — is lost. The `ready` handshake
 * still makes a full rebuild from the host's state (window reload, a webview VS Code chose
 * to discard) an ordinary path.
 */
import * as vscode from 'vscode'

import type {
  HostToWebviewMessage,
  WebviewState,
  WebviewToHostMessage,
} from '../../shared/webviewProtocol.js'
import { MessageCoalescer } from './messageCoalescer.js'
import { renderWebviewHtml, type ChatSurface } from './webviewSurface.js'

/** Matches the view id contributed in `extension.manifest.json`. */
export const CHAT_VIEW_ID = 'rayucode.chat'

export class ChatViewProvider implements vscode.WebviewViewProvider, ChatSurface {
  readonly kind = 'sidebar' as const

  private view: vscode.WebviewView | undefined
  private readonly disposables: vscode.Disposable[] = []
  /** Merges per-token streaming messages into one delivery per frame. */
  private readonly outbox = new MessageCoalescer(envelope => {
    void this.view?.webview.postMessage(envelope)
  })

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: {
      /** Forward every received message (including `ready`) to the host. */
      onMessage: (message: WebviewToHostMessage) => void
    },
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

    view.webview.html = renderWebviewHtml(view.webview, this.extensionUri)

    this.disposables.push(
      view.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
        // Every message, `ready` included, goes to the host. The host owns the
        // dispatch table and, on `ready`, sends this surface its snapshot.
        this.deps.onMessage(message)
      }),
    )

    view.onDidDispose(() => {
      this.view = undefined
      // Anything held was for the view that just went away; a new one starts from `init`.
      this.outbox.clear()
      for (const d of this.disposables.splice(0)) d.dispose()
    })
  }

  /** Push a message to the panel. No-op when the panel is not open. */
  post(message: HostToWebviewMessage): void {
    // Not an error worth surfacing: the user collapsed the panel. State is
    // re-sent on the next `ready`, which is why that handshake exists.
    if (!this.view) return
    this.outbox.post(message)
  }

  /** Send a given snapshot to the panel. Does not build one; the host decides content. */
  postState(state: WebviewState): void {
    this.post({ type: 'init', state })
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
    this.outbox.clear()
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}
