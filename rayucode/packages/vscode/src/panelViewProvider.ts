// RayucodePanelProvider — the Agent_Panel as a persistent Activity Bar view (R3.1).
//
// The original surface was a floating `WebviewPanel` in an editor column, which
// competes with the user's code for space and disappears from view when they
// switch tabs. This provider serves the SAME webview as an Activity Bar
// `WebviewView` instead: it lives in the side bar, survives focus changes, and is
// reachable from the Rayucode icon.
//
// It re-uses everything: the identical HTML shell / CSP (`webviewHtml.ts`), the
// identical bundled front-end (`dist/webview.js`), and the identical bidirectional
// message contract (`PanelOutboundMessage` / `WebviewToHostMessage`). The core is
// unaware which surface it is driving — it only ever sees an `AgentPanelHandle`.
//
// ── Two directions of resolution ────────────────────────────────────────────
// The awkward part of `WebviewViewProvider` is that the view's lifetime is owned
// by the WORKBENCH, not by us: it exists only once the user (or a `.focus`
// command) reveals it. So the two entry paths must meet in the middle:
//
//   A. Host-initiated (`rayucode.openPanel`, add-selection, …): the core calls
//      `showAgentPanel` → `resolveAgentPanel()` → we execute the view's `.focus`
//      command and AWAIT `resolveWebviewView` before returning a handle.
//
//   B. User-initiated (clicking the Activity Bar icon): `resolveWebviewView`
//      fires first, with no session bound. We then start the session ourselves
//      (`onReveal`), which loops back through `showAgentPanel` →
//      `resolveAgentPanel()` — and finds the view already resolved.
//
// A single in-flight guard (`pendingReveal`) keeps path B from re-entering while
// path A is still awaiting the view, so exactly ONE handle is ever bound and the
// core never ends up with duplicate message subscriptions.

import * as vscode from "vscode";

import type { AgentPanelHandle, Disposable } from "@rayucode/core";

import { panelWebviewOptions, renderPanelHtml } from "./webviewHtml.js";

/** The view id contributed by the manifest (`contributes.views`). */
export const PANEL_VIEW_ID = "rayucode.panel";

/** The workbench command that reveals the contributed view. */
export const PANEL_FOCUS_COMMAND = `${PANEL_VIEW_ID}.focus`;

/** How long to wait for the workbench to resolve the view before giving up. */
const RESOLVE_TIMEOUT_MS = 10_000;

/** Construction options for a {@link RayucodePanelProvider}. */
export interface RayucodePanelProviderOptions {
  /** Extension root, used for `localResourceRoots` and the bundled assets. */
  extensionUri: vscode.Uri;
  /**
   * Session key to open when the USER reveals the view directly (path B above).
   * Evaluated lazily so it always reflects the current workspace.
   */
  sessionKeyProvider: () => string;
  /**
   * Start/reveal the session for a user-initiated reveal (path B). Wired to
   * `SessionManager.openSession`; the resulting `showAgentPanel` call comes back
   * through {@link RayucodePanelProvider.resolveAgentPanel}.
   */
  onReveal: (sessionKey: string) => Promise<void>;
  /** Diagnostic sink (the adapter's log channel). */
  log: (channel: "protocol" | "lifecycle" | "error", message: string) => void;
}

/**
 * Serves the Agent_Panel webview inside the Activity Bar. Register with
 * `vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, provider, {
 * webviewOptions: { retainContextWhenHidden: true } })` and plug
 * {@link resolveAgentPanel} into the adapter via `registerAgentPanelResolver`.
 */
export class RayucodePanelProvider implements vscode.WebviewViewProvider {
  private readonly options: RayucodePanelProviderOptions;

  /** The live view, or `null` before the first reveal / after disposal. */
  private view: vscode.WebviewView | null = null;

  /** The handle currently handed to the core, or `null` when unbound. */
  private handle: PanelViewHandle | null = null;

  /** Resolvers awaiting the workbench to hand us a view (path A). */
  private viewWaiters: ((view: vscode.WebviewView | null) => void)[] = [];

  /** True while a host-initiated reveal is awaiting the view (guards path B). */
  private pendingReveal = false;

  /**
   * Pending reveal-timeout timers. Tracked so {@link dispose} can cancel them: a
   * timer that survives teardown fires against a disposed log channel (and an
   * extension that is no longer there), which surfaces as an unrelated failure
   * seconds later.
   */
  private readonly revealTimers = new Set<ReturnType<typeof setTimeout>>();

  /** Set once the provider is disposed; stops all further work. */
  private disposed = false;

  /** Subscriptions tied to the CURRENT view; replaced on each resolve. */
  private viewSubscriptions: vscode.Disposable[] = [];

  constructor(options: RayucodePanelProviderOptions) {
    this.options = options;
  }

  // --------------------------------------------------------------------------
  // vscode.WebviewViewProvider
  // --------------------------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) {
      // The extension is tearing down; do not adopt a new view.
      return;
    }
    this.disposeViewSubscriptions();
    this.view = view;

    view.webview.options = panelWebviewOptions(this.options.extensionUri);
    view.webview.html = renderPanelHtml(
      view.webview,
      this.options.extensionUri,
    );

    // Fan the view's inbound messages into whichever handle is bound. Wiring it
    // here (once per view) rather than per-handle means a handle rebound to a
    // re-created view keeps receiving messages.
    this.viewSubscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        this.handle?.emitMessage(message);
      }),
      view.onDidDispose(() => this.handleViewDisposed(view)),
    );

    // Release path-A waiters now that a view exists.
    const waiters = this.viewWaiters;
    this.viewWaiters = [];
    for (const resolve of waiters) {
      resolve(view);
    }

    // Path B — the user revealed the view themselves and no session is bound
    // yet, so start one. Skipped while a host-initiated reveal is in flight
    // (it is about to bind a handle) or when a handle is already bound.
    if (this.handle === null && !this.pendingReveal) {
      void this.startSessionForReveal();
    }
  }

  // --------------------------------------------------------------------------
  // AgentPanelResolver (adapter side)
  // --------------------------------------------------------------------------

  /**
   * Supply the Agent_Panel handle for `sessionKey`, revealing the view first if
   * necessary. Returns `null` to DECLINE — the adapter then falls back to a
   * floating `WebviewPanel` — which happens when:
   *
   *   - `sessionKey` is not this view's session (e.g. the chat participant's own
   *     session, which has its own sink), or
   *   - the workbench never resolved the view (no such view contributed, or the
   *     reveal timed out), so there is no surface to bind.
   */
  async resolveAgentPanel(sessionKey: string): Promise<AgentPanelHandle | null> {
    if (this.disposed || sessionKey !== this.options.sessionKeyProvider()) {
      return null;
    }

    // Already bound to this session: hand back the same handle so the core does
    // not accumulate duplicate subscriptions.
    if (this.handle && this.handle.sessionKey === sessionKey) {
      this.handle.reveal();
      return this.handle;
    }

    const view = await this.ensureView();
    if (!view) {
      return null;
    }

    const handle = new PanelViewHandle(
      sessionKey,
      () => this.view,
      () => {
        // The core dropped this handle; allow a later reveal to rebind.
        if (this.handle === handle) {
          this.handle = null;
        }
      },
    );
    this.handle = handle;
    return handle;
  }

  /** Reveal the view without changing session binding (used by the command). */
  async reveal(): Promise<void> {
    await this.ensureView();
    this.view?.show?.(true);
  }

  /** Release every subscription, cancel pending work, and drop the handle. */
  dispose(): void {
    this.disposed = true;
    this.disposeViewSubscriptions();
    // Cancel reveal timeouts BEFORE dropping the waiters: a surviving timer
    // would fire after teardown and log to an already-disposed channel.
    for (const timer of this.revealTimers) {
      clearTimeout(timer);
    }
    this.revealTimers.clear();
    // Release anyone still awaiting a view so their `showAgentPanel` settles.
    const waiters = this.viewWaiters;
    this.viewWaiters = [];
    for (const waiter of waiters) {
      waiter(null);
    }
    this.handle?.notifyDisposed();
    this.handle = null;
    this.view = null;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Return the live view, revealing it (and awaiting `resolveWebviewView`) when
   * it does not exist yet. Resolves to `null` if the workbench never delivers
   * one within {@link RESOLVE_TIMEOUT_MS}.
   */
  private async ensureView(): Promise<vscode.WebviewView | null> {
    if (this.view) {
      return this.view;
    }

    this.pendingReveal = true;
    try {
      const delivered = this.waitForView();
      try {
        // Revealing the contributed view is what causes the workbench to call
        // `resolveWebviewView`.
        await vscode.commands.executeCommand(PANEL_FOCUS_COMMAND);
      } catch (error) {
        this.options.log(
          "error",
          `Could not reveal the rayucode view (${PANEL_FOCUS_COMMAND}): ${errorMessage(error)}`,
        );
        return null;
      }
      return await delivered;
    } finally {
      this.pendingReveal = false;
    }
  }

  /** A promise for the next resolved view, or `null` after a timeout. */
  private waitForView(): Promise<vscode.WebviewView | null> {
    return new Promise<vscode.WebviewView | null>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        this.revealTimers.delete(timer);
        if (settled) {
          return;
        }
        settled = true;
        this.viewWaiters = this.viewWaiters.filter((w) => w !== waiter);
        this.options.log(
          "error",
          "Timed out waiting for the rayucode view to be resolved; falling back to a floating panel.",
        );
        resolve(null);
      }, RESOLVE_TIMEOUT_MS);
      // Never keep the host alive for this timer.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.revealTimers.add(timer);

      const waiter = (view: vscode.WebviewView | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.revealTimers.delete(timer);
        resolve(view);
      };
      this.viewWaiters.push(waiter);
    });
  }

  /** Path B: the user revealed the view, so open the workspace session. */
  private async startSessionForReveal(): Promise<void> {
    const sessionKey = this.options.sessionKeyProvider();
    try {
      await this.options.onReveal(sessionKey);
    } catch (error) {
      this.options.log(
        "error",
        `Failed to open the rayucode session for the revealed view: ${errorMessage(error)}`,
      );
    }
  }

  private handleViewDisposed(view: vscode.WebviewView): void {
    if (this.view !== view) {
      return;
    }
    this.view = null;
    this.disposeViewSubscriptions();
    // Tell the core the panel went away so it releases the handle (history is
    // retained host-side, R12.2, and a later reveal restores it).
    const handle = this.handle;
    this.handle = null;
    handle?.notifyDisposed();
  }

  private disposeViewSubscriptions(): void {
    for (const subscription of this.viewSubscriptions.splice(0)) {
      try {
        subscription.dispose();
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// ----------------------------------------------------------------------------
// AgentPanelHandle over a vscode.WebviewView
// ----------------------------------------------------------------------------

/**
 * The editor-agnostic {@link AgentPanelHandle} backed by the provider's current
 * `WebviewView`. The view reference is read through a getter at call time rather
 * than captured, so the handle keeps working if the workbench re-creates the view
 * underneath it.
 *
 * Messages posted while no view exists are DROPPED rather than queued: the core
 * re-sends a full `restoreHistory` on every `openSession`, so a dropped delta can
 * never leave the panel permanently out of sync — whereas an unbounded queue
 * could replay a stale conversation into a fresh view.
 */
class PanelViewHandle implements AgentPanelHandle {
  readonly sessionKey: string;

  private readonly currentView: () => vscode.WebviewView | null;
  private readonly onRelease: () => void;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disposeListeners = new Set<() => void>();
  private disposed = false;

  constructor(
    sessionKey: string,
    currentView: () => vscode.WebviewView | null,
    onRelease: () => void,
  ) {
    this.sessionKey = sessionKey;
    this.currentView = currentView;
    this.onRelease = onRelease;
  }

  reveal(): void {
    // `show(true)` preserves the user's focus (they may be typing in the editor).
    this.currentView()?.show?.(true);
  }

  postMessage(message: unknown): Promise<boolean> {
    const view = this.currentView();
    if (!view || this.disposed) {
      return Promise.resolve(false);
    }
    return Promise.resolve(view.webview.postMessage(message));
  }

  onDidReceiveMessage(listener: (message: unknown) => void): Disposable {
    this.messageListeners.add(listener);
    return {
      dispose: () => {
        this.messageListeners.delete(listener);
      },
    };
  }

  onDidDispose(listener: () => void): Disposable {
    if (this.disposed) {
      // Late subscriber to an already-disposed handle: fire immediately so the
      // core still releases its reference.
      listener();
      return { dispose: () => {} };
    }
    this.disposeListeners.add(listener);
    return {
      dispose: () => {
        this.disposeListeners.delete(listener);
      },
    };
  }

  dispose(): void {
    // The core disposes the handle on `closeSession`. The VIEW itself is owned
    // by the workbench (the user's side bar), so we do not tear it down — we
    // only detach, leaving an empty panel the user can reuse.
    this.notifyDisposed();
  }

  /** Fan an inbound webview message out to the core's listeners. */
  emitMessage(message: unknown): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  /** Mark disposed and notify the core exactly once. */
  notifyDisposed(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const listeners = [...this.disposeListeners];
    this.disposeListeners.clear();
    this.messageListeners.clear();
    for (const listener of listeners) {
      listener();
    }
    this.onRelease();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
