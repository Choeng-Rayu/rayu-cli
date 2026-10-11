/**
 * Owns every chat surface: the sidebar view and every editor session tab.
 *
 * ── FAN-OUT IS THE WHOLE JOB ───────────────────────────────────────────────────
 *
 * The host has three distinct things it wants to say to a webview, and they are not the
 * same fan-out (see the method docs):
 *
 *   1. A reply to whoever asked                     → `postToSurface`
 *   2. A per-session push (transcript, approvals)   → `postToSession`
 *   3. A window-global push (sign-out, catalogue)   → `broadcast`
 *
 * ── THE SIDEBAR'S BINDING IS THE ACTIVE KEY ────────────────────────────────────
 *
 * The sidebar's quick chat always renders `activeSidebarKey()`. Panels are bound once,
 * permanently, and never gated. This is what preserves the existing
 * `active == sidebar target` invariant while letting a background tab keep streaming.
 *
 * ── WHY `attachSidebar` BUILDS THE PROVIDER ────────────────────────────────────
 *
 * The sidebar surface is exactly a `ChatViewProvider` (the same HTML, CSP, nonce and
 * coalescer as before). Building it here — with `onMessage` derived from the
 * registry's deps — keeps a single sidebar implementation rather than a second one
 * that only differs by its fan-out wiring. The extension host registers the provider
 * that this returns; it must not construct a second one, or two objects would race for
 * the same view.
 */
import * as vscode from 'vscode'

import type {
  ChatSurfaceKind,
  HostToWebviewMessage,
  SurfaceBindingView,
  WebviewState,
  WebviewToHostMessage,
} from '../../shared/webviewProtocol.js'
import { ChatViewProvider } from './chatViewProvider.js'
import { SessionPanel, type SessionPanelHandlers } from './sessionPanel.js'
import { SESSION_PANEL_VIEW_TYPE, type ChatSurface } from './webviewSurface.js'

export interface SurfaceRegistryDeps {
  extensionUri: vscode.Uri
  /** The sidebar's currently-bound key (registry.activeSessionKey). */
  activeSidebarKey: () => string
  /** Full snapshot for a session key, or null when unknown. */
  stateFor: (sessionKey: string) => WebviewState | null
  /** A webview→host message, tagged with the origin surface. */
  onMessage: (kind: ChatSurfaceKind, sessionKey: string, message: WebviewToHostMessage) => void
  onPanelFocused: (sessionKey: string) => void
  /** The tab was closed; the session is untouched. */
  onPanelClosed: (sessionKey: string) => void
  /** The tab title for a key. */
  titleFor: (sessionKey: string) => string
  /** Resolve a restored panel's revival state to the session key it must bind to. */
  reviveBind: (restored: Partial<SurfaceBindingView>) => string
}

export class SurfaceRegistry {
  private sidebar: ChatSurface | undefined
  private readonly panels = new Map<string, SessionPanel>()

  constructor(private readonly deps: SurfaceRegistryDeps) {}

  /**
   * Wire the sidebar's `WebviewView`.
   *
   * Called from the registered `WebviewViewProvider`'s `resolveWebviewView`. Returns the
   * sidebar surface so the caller can hold it; the returned object is the ONLY sidebar
   * surface — see the file header.
   */
  attachSidebar(view: vscode.WebviewView): ChatSurface {
    // A re-resolved view replaces the previous sidebar surface outright; release the
    // old one's listeners so they cannot both fire for one view.
    this.sidebar?.dispose()
    // No snapshot builder is wired into the provider on purpose: `stateFor` is
    // PANEL-flavoured (see extension.ts's sidebar-init note), so a provider-built
    // sidebar init would hide the sessions list and show a close-tab action. The
    // host posts every sidebar init itself, through `postState`.
    const surface = new ChatViewProvider(this.deps.extensionUri, {
      onMessage: message => this.deps.onMessage('sidebar', this.deps.activeSidebarKey(), message),
    })
    surface.resolveWebviewView(view)
    this.sidebar = surface
    return surface
  }

  /** Create or focus an editor tab for an existing live session key. */
  openPanel(sessionKey: string, viewColumn?: vscode.ViewColumn): SessionPanel {
    const existing = this.panels.get(sessionKey)
    if (existing) {
      // Never a second tab for one session: focus the one that is already bound.
      void existing.reveal()
      return existing
    }
    const panel = vscode.window.createWebviewPanel(
      SESSION_PANEL_VIEW_TYPE,
      this.deps.titleFor(sessionKey),
      viewColumn ?? vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'media')],
        // Parity with the sidebar, and required for background streaming: the tab must
        // keep its React heap and DOM while the user is in another tab. Bounded by
        // MAX_LIVE_SESSIONS (see the plan's risk register).
        retainContextWhenHidden: true,
      },
    )
    const surface = this.registerPanel(panel, sessionKey)
    this.syncSession(sessionKey)
    return surface
  }

  /** Adopt a restored panel during deserialize. */
  adoptPanel(panel: vscode.WebviewPanel, sessionKey: string): SessionPanel {
    const existing = this.panels.get(sessionKey)
    if (existing) existing.dispose()
    return this.registerPanel(panel, sessionKey)
  }

  /** Resolve a restored panel's binding and bind a fresh `SessionPanel` to it. */
  async reviveFromState(
    panel: vscode.WebviewPanel,
    restored: Partial<SurfaceBindingView>,
  ): Promise<ChatSurface> {
    const sessionKey = this.deps.reviveBind(restored)
    const surface = this.adoptPanel(panel, sessionKey)
    this.syncSession(sessionKey)
    return surface
  }

  panelFor(sessionKey: string): SessionPanel | undefined {
    return this.panels.get(sessionKey)
  }

  hasPanel(sessionKey: string): boolean {
    return this.panels.has(sessionKey)
  }

  /** Reply to the surface that asked. */
  postToSurface(
    kind: ChatSurfaceKind,
    sessionKey: string,
    message: HostToWebviewMessage,
  ): void {
    if (kind === 'panel') {
      this.panels.get(sessionKey)?.post(message)
      return
    }
    this.sidebar?.post(message)
  }

  /** Engine-originated push to every surface showing this session. */
  postToSession(sessionKey: string, message: HostToWebviewMessage): void {
    this.panels.get(sessionKey)?.post(message)
    if (this.deps.activeSidebarKey() === sessionKey) this.sidebar?.post(message)
  }

  /** Full init to the panel for key + the sidebar iff bound to key. */
  syncSession(sessionKey: string): void {
    const state = this.deps.stateFor(sessionKey)
    if (state) this.panels.get(sessionKey)?.postState(state)
    if (this.deps.activeSidebarKey() === sessionKey) this.syncSidebar()
  }

  /** Full init to the sidebar from its bound key. */
  syncSidebar(): void {
    const state = this.deps.stateFor(this.deps.activeSidebarKey())
    if (state) this.sidebar?.postState(state)
  }

  /** Global push to the sidebar and every panel. */
  broadcast(message: HostToWebviewMessage): void {
    this.sidebar?.post(message)
    for (const panel of this.panels.values()) panel.post(message)
  }

  updateTitle(sessionKey: string): void {
    this.panels.get(sessionKey)?.setTitle(this.deps.titleFor(sessionKey))
  }

  /** Idempotent: closing a key with no panel is a no-op. */
  closePanel(sessionKey: string): void {
    const panel = this.panels.get(sessionKey)
    if (!panel) return
    // Remove first, so the dispose-triggered `onClosed` sees no live entry for the key.
    this.panels.delete(sessionKey)
    panel.dispose()
  }

  get isOpen(): boolean {
    return (this.sidebar?.isOpen ?? false) || this.panels.size > 0
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose()
    this.panels.clear()
    this.sidebar?.dispose()
    this.sidebar = undefined
  }

  /**
   * Build the handlers a panel reports through, and register it.
   *
   * `onClosed` removes THIS surface's entry only: a tab closed by the user must not
   * delete a newer panel that was since opened for the same key.
   */
  private registerPanel(panel: vscode.WebviewPanel, sessionKey: string): SessionPanel {
    let surface: SessionPanel
    const handlers: SessionPanelHandlers = {
      onMessage: (key, message) => this.deps.onMessage('panel', key, message),
      onClosed: key => {
        if (this.panels.get(key) === surface) this.panels.delete(key)
        this.deps.onPanelClosed(key)
      },
      onFocused: key => this.deps.onPanelFocused(key),
    }
    surface = new SessionPanel(panel, sessionKey, this.deps.extensionUri, handlers)
    this.panels.set(sessionKey, surface)
    return surface
  }
}
