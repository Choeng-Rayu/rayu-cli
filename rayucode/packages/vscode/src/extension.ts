// rayucode VS Code extension — host entry point (VSCode_Host).
//
// Activation wiring (task 14.2): on activate we construct the VS Code-specific
// EditorAdapter, inject it into the editor-agnostic core SessionManager, and
// register the contributed commands (declared by the manifest, task 14.1) so
// they are invocable from the command palette (R14.4). On deactivate we tear
// every spawned agent process down (R2.7).
//
// The `vscode` runtime API is provided by the extension host and kept EXTERNAL
// by the esbuild bundle (esbuild.mjs); @rayucode/core is bundled in. The core
// never imports `vscode` — all editor operations flow through the VSCodeAdapter
// (R13.1, R13.4).

import * as vscode from "vscode";

import { SessionManager } from "@rayucode/core";

import { VSCodeAdapter } from "./vscodeAdapter.js";

/** Command id: reveal/open the Agent_Panel for the active workspace (R14.1). */
const OPEN_PANEL_COMMAND = "rayucode.openPanel";
/** Command id: stage the active selection into the panel prompt input (R9.5). */
const ADD_SELECTION_COMMAND = "rayucode.addSelectionToPrompt";
/** Session key used when no workspace folder is open (single ad-hoc session). */
const DEFAULT_SESSION_KEY = "rayucode";

/**
 * The extension's public API, returned from {@link activate} and surfaced as the
 * extension's `exports`. It is intentionally small and exists mainly as a TEST
 * SEAM: the extension-host integration suites (tasks 12.3 / 14.3) read
 * `ext.exports.context` to obtain a real {@link vscode.ExtensionContext} (the
 * only way to reach a genuine `SecretStorage`) and `ext.exports.sessionManager`
 * to drive/observe the composed core.
 */
export interface RayucodeExtensionApi {
  readonly context: vscode.ExtensionContext;
  readonly sessionManager: SessionManager;
}

/**
 * Module-level handle to the live manager so {@link deactivate} (which receives
 * no arguments) can reach it to terminate every spawned agent process (R2.7).
 */
let activeManager: SessionManager | null = null;

/**
 * Extension activation entry point. VS Code invokes this the first time one of
 * the declared lazy activation events fires (`onCommand:rayucode.openPanel` /
 * `onCommand:rayucode.addSelectionToPrompt`, task 14.1).
 *
 * Constructs the {@link VSCodeAdapter} and the core {@link SessionManager}, then
 * registers the contributed commands. Each registration is isolated: a failure
 * is caught, logged to the adapter's log channel, and activation CONTINUES with
 * the remaining commands (R14.5).
 */
export function activate(context: vscode.ExtensionContext): RayucodeExtensionApi {
  const adapter = new VSCodeAdapter(context);
  const sessionManager = new SessionManager({ adapter });
  activeManager = sessionManager;

  // R14.4: registering openPanel makes it invocable from the command palette.
  registerCommandSafely(adapter, OPEN_PANEL_COMMAND, () =>
    sessionManager.openSession(sessionKeyForActiveWorkspace()),
  );

  // R9.5: insert a reference to the active selection (when one exists) into the
  // Agent_Panel prompt input.
  registerCommandSafely(adapter, ADD_SELECTION_COMMAND, () =>
    runAddSelectionToPrompt(sessionManager),
  );

  return { context, sessionManager };
}

/**
 * Extension deactivation hook. VS Code invokes this on window/extension
 * shutdown. Terminates every spawned `AgentProcess` and closes all sessions via
 * the core's `disposeAll()` — which denies any pending permission requests
 * before terminating each child and resolves only after the children have
 * exited (R2.7, and R5.5 on the close path). Awaited so VS Code lets the
 * teardown complete during shutdown.
 */
export async function deactivate(): Promise<void> {
  const manager = activeManager;
  activeManager = null;
  await manager?.disposeAll();
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

/**
 * Register a command through the adapter, isolating registration failures
 * (R14.5). The adapter binds the returned disposable to `context.subscriptions`
 * for lifecycle cleanup, so we do not track it again here. The command callback
 * is wrapped so an async failure during INVOCATION is logged rather than
 * surfacing as an unhandled promise rejection.
 */
function registerCommandSafely(
  adapter: VSCodeAdapter,
  id: string,
  run: () => void | Promise<void>,
): void {
  try {
    adapter.registerCommand(id, () =>
      // Return the promise so the host awaits completion on invocation; the
      // catch keeps a failed invocation from becoming an unhandled rejection
      // and routes the reason to the log channel instead.
      Promise.resolve()
        .then(run)
        .catch((error: unknown) => {
          adapter.log("error", `Command ${id} failed: ${errorMessage(error)}`);
        }),
    );
  } catch (error) {
    // R14.5: a registration failure must not abort activation. Log it and let
    // the remaining commands register.
    adapter.log(
      "error",
      `Failed to register command ${id}: ${errorMessage(error)}`,
    );
  }
}

/**
 * Handle the add-selection-to-prompt command (R9.5). Only acts when the active
 * editor has a NON-empty selection; builds a reference citing the file path and
 * the selected text and asks the core to insert it into the panel input (opening
 * the panel first if needed).
 */
async function runAddSelectionToPrompt(
  sessionManager: SessionManager,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    // R9.5 is conditioned on "while a text selection exists"; with none, the
    // command is a no-op.
    return;
  }

  const { document, selection } = editor;
  const reference = buildSelectionReference(
    document.uri.fsPath,
    selection.start.line + 1,
    selection.end.line + 1,
    document.getText(selection),
  );

  await sessionManager.addSelectionToPrompt(
    sessionKeyForActiveWorkspace(),
    reference,
  );
}

/**
 * Build the prompt-input reference for a selection: the file path + line range
 * followed by the selected text in a fenced block (R9.5). The webview appends
 * this to the textarea verbatim without submitting.
 */
function buildSelectionReference(
  filePath: string,
  startLine: number,
  endLine: number,
  selectedText: string,
): string {
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return `${filePath}:${range}\n\`\`\`\n${selectedText}\n\`\`\`\n`;
}

/**
 * Derive a stable per-workspace session key: the first workspace folder's
 * filesystem path, or a constant when no folder is open (so an ad-hoc session
 * still has a consistent key). The open-panel and add-selection commands use the
 * SAME key so a selection lands in the panel the open-panel command shows.
 */
function sessionKeyForActiveWorkspace(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : DEFAULT_SESSION_KEY;
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
