// RayucodeStatusBar — always-visible agent state in the status bar.
//
// Without this, a long-running turn is invisible whenever the Agent_Panel is
// hidden: the user has no way to tell "the agent is thinking" from "nothing
// happened". The status bar item is the one surface that is always on screen.
//
// ── How state is observed ───────────────────────────────────────────────────
// The editor-agnostic core deliberately knows nothing about a status bar. Rather
// than teach it, this class listens on the SAME `PanelOutboundMessage` stream the
// webview receives, tapped at the adapter's panel boundary
// (`VSCodeAdapter.onPanelMessage`). That means:
//
//   • one source of truth — the status bar can never disagree with the panel;
//   • every surface is covered — floating panel, Activity Bar view, and the
//     headless chat-participant sink all flow through the same tap;
//   • zero core changes.
//
// Messages consumed:
//   `setGenerating` → busy / idle          (the primary signal)
//   `showError`     → error, then idle     (transient, so a failure is not silent)
//
// States:
//   idle        `$(sparkle) Rayu`
//   generating  `$(sync~spin) Rayu — Generating`   + Interrupt tooltip
//   error       `$(warning) Rayu`                  (warning background)

import * as vscode from "vscode";

import { INTERRUPT_COMMAND, OPEN_PANEL_COMMAND } from "./commands.js";

/** How long the error state is shown before reverting to idle. */
const ERROR_DISPLAY_MS = 5_000;

/** Status bar priority — high enough to sit left of most third-party items. */
const PRIORITY = 100;

/** The three states the item can be in. */
export type StatusBarState = "idle" | "generating" | "error";

/**
 * Owns the rayucode status bar item. Construct during activation, feed it panel
 * messages via {@link handlePanelMessage} (or drive it directly with
 * {@link setIdle} / {@link setGenerating}), and dispose it on deactivate.
 */
export class RayucodeStatusBar {
  private readonly item: vscode.StatusBarItem;
  private state: StatusBarState = "idle";
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      PRIORITY,
    );
    context.subscriptions.push(this.item);
    this.setIdle();
    this.item.show();
  }

  /** The current state (exposed for tests and diagnostics). */
  get currentState(): StatusBarState {
    return this.state;
  }

  /** The rendered text (exposed for tests). */
  get text(): string {
    return this.item.text;
  }

  /** Idle: the agent is available. Clicking opens the Agent_Panel. */
  setIdle(): void {
    this.clearErrorTimer();
    this.state = "idle";
    this.item.text = "$(sparkle) Rayu";
    this.item.tooltip = "Rayucode — open the agent panel";
    this.item.command = OPEN_PANEL_COMMAND;
    this.item.backgroundColor = undefined;
  }

  /** Generating: a turn is in flight. Clicking interrupts it (R3.6). */
  setGenerating(): void {
    this.clearErrorTimer();
    this.state = "generating";
    this.item.text = "$(sync~spin) Rayu — Generating";
    this.item.tooltip = "Rayucode is generating — click to interrupt";
    this.item.command = INTERRUPT_COMMAND;
    this.item.backgroundColor = undefined;
  }

  /**
   * Error: the last turn surfaced a problem. Transient — reverts to idle after
   * {@link ERROR_DISPLAY_MS} so a stale warning never sticks around.
   */
  setError(): void {
    this.clearErrorTimer();
    this.state = "error";
    this.item.text = "$(warning) Rayu";
    this.item.tooltip = "Rayucode reported an error — open the panel for details";
    this.item.command = OPEN_PANEL_COMMAND;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null;
      this.setIdle();
    }, ERROR_DISPLAY_MS);
    (this.errorTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Fold one host → panel message into the item's state. Unrecognized messages
   * are ignored, so the core is free to add message types without touching this.
   */
  handlePanelMessage(message: unknown): void {
    const type = messageType(message);
    if (type === "setGenerating") {
      const generating = (message as { generating?: unknown }).generating;
      if (generating === true) {
        this.setGenerating();
      } else {
        this.setIdle();
      }
      return;
    }
    if (type === "showError") {
      this.setError();
    }
  }

  dispose(): void {
    this.clearErrorTimer();
    this.item.dispose();
  }

  private clearErrorTimer(): void {
    if (this.errorTimer !== null) {
      clearTimeout(this.errorTimer);
      this.errorTimer = null;
    }
  }
}

/** Read a message's `type` discriminant, or `null` for a non-message value. */
function messageType(message: unknown): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}
