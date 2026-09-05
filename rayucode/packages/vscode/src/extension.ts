// rayucode VS Code extension — host entry point (VSCode_Host).
//
// Activation wiring (task 14.2): on activate we construct the VS Code-specific
// EditorAdapter, inject it into the editor-agnostic core SessionManager, and
// register the contributed commands (declared by the manifest, task 14.1) so
// they are invocable from the command palette (R14.4). On deactivate we tear
// every spawned agent process down (R2.7).
//
// V1 additionally composes the surfaces around that core:
//
//   • RayucodePanelProvider — the Agent_Panel as a persistent Activity Bar view,
//     plugged into the adapter's panel-resolver chain so `showAgentPanel` binds
//     the sidebar instead of a floating editor panel.
//   • RayucodeStatusBar     — always-visible idle/generating state, fed by the
//     adapter's panel-message tap.
//   • @rayucode chat participant — the same agent inside the chat view.
//   • RayucodeActionProvider — Explain / Fix / Review on a selection.
//
// Every registration is INDEPENDENTLY isolated: a failure is logged and
// activation continues with the remaining features (R14.5), so a host missing the
// chat API (or a malformed contribution) can never leave the extension dead.
//
// The `vscode` runtime API is provided by the extension host and kept EXTERNAL
// by the esbuild bundle (esbuild.mjs); @rayucode/core is bundled in. The core
// never imports `vscode` — all editor operations flow through the VSCodeAdapter
// (R13.1, R13.4).

import * as vscode from "vscode";

import { AgentProcess, Redactor, SessionManager } from "@rayucode/core";

import { loadDotEnv } from "./dotEnv.js";

import { registerChatParticipant } from "./chatParticipant.js";
import {
  ADD_SELECTION_COMMAND,
  INTERRUPT_COMMAND,
  NEW_SESSION_COMMAND,
  OPEN_PANEL_COMMAND,
} from "./commands.js";
import {
  EXPLAIN_COMMAND,
  FIX_COMMAND,
  REVIEW_COMMAND,
  RayucodeActionProvider,
  buildIntentReference,
  resolveIntentTarget,
} from "./codeActions.js";
import type { SelectionIntent } from "./codeActions.js";
import { PANEL_VIEW_ID, RayucodePanelProvider } from "./panelViewProvider.js";
import { collectEnvironmentSecrets } from "./redactionSecrets.js";
import { RayucodeStatusBar } from "./statusBar.js";
import { VSCodeAdapter } from "./vscodeAdapter.js";
import { registerWebBridge, type WebBridgeRegistration } from "./webBridge.js";

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
  /** The Activity Bar view provider, or `null` if its registration failed. */
  readonly panelProvider: RayucodePanelProvider | null;
  /** The status bar item, or `null` if its construction failed. */
  readonly statusBar: RayucodeStatusBar | null;
}

/**
 * Module-level handle to the live manager so {@link deactivate} (which receives
 * no arguments) can reach it to terminate every spawned agent process (R2.7).
 */
let activeManager: SessionManager | null = null;

/**
 * Extension activation entry point. VS Code invokes this on `onStartupFinished`
 * (so the Activity Bar view, status bar, and chat participant exist before the
 * user reaches for them) as well as on any contributed command.
 *
 * Constructs the {@link VSCodeAdapter} and the core {@link SessionManager}, then
 * registers every surface. Each registration is isolated: a failure is caught,
 * logged to the adapter's log channel, and activation CONTINUES with the
 * remaining features (R14.5).
 */
export function activate(context: vscode.ExtensionContext): RayucodeExtensionApi {
  const adapter = new VSCodeAdapter(context);

  // Load the optional developer .env from the extension directory.
  // Absent on production installs (.vscodeignore excludes **/.env); present
  // when a developer places a .env next to the extension source to point the
  // bundled engine at a local stack (RAYU_API_URL, RAYU_GATEWAY_URL, …).
  const extensionDir = context.extensionUri.fsPath;
  const dotEnv = loadDotEnv(extensionDir);
  const dotEnvKeys = Object.keys(dotEnv);
  if (dotEnvKeys.length > 0) {
    // Log KEY NAMES only — values are never logged, they may be secrets.
    adapter.log(
      "lifecycle",
      `.env loaded from ${extensionDir} — keys: ${dotEnvKeys.join(", ")}`,
    );
  }

  // Build the merged environment for the child process. .env keys win over
  // process.env so a developer can override individual vars without replacing
  // the entire environment.
  const childEnv: NodeJS.ProcessEnv =
    dotEnvKeys.length > 0 ? { ...process.env, ...dotEnv } : process.env;

  // R15.5: seed the redaction filter BEFORE the manager is built so every
  // string routed to the panel or the log channel passes through a redactor
  // that actually has secrets. The filter runs over childEnv so that any
  // credential in .env is also redacted from tool output and logs.
  const secrets = collectEnvironmentSecrets(childEnv);

  /*
   * Forward-declared so the SessionManager can be built with a tap that resolves the
   * bridge LAZILY.
   *
   * The two are mutually dependent — the bridge drives the manager, the manager feeds
   * the bridge — and the manager has to exist first because it owns the sessions. A
   * stable closure over this variable breaks the cycle without rebuilding the manager
   * on connect, which would discard every retained conversation (R12).
   */
  let webBridge: WebBridgeRegistration | null = null;

  const sessionManager = new SessionManager({
    adapter,
    redactor: new Redactor(secrets),
    // The engine and its build-info.json ship inside the VSIX. Derive the
    // directory from the extension URI rather than relying on __dirname, so it
    // does not depend on how the bundle was produced.
    engineDistDir: vscode.Uri.joinPath(context.extensionUri, "dist").fsPath,
    // Pass the merged environment into every spawned engine process so .env
    // overrides (e.g. RAYU_API_URL=http://localhost:4000/api) take effect.
    agentProcessFactory: (o) =>
      new AgentProcess({ enginePath: o.enginePath, cwd: o.cwd, adapter: o.adapter, env: childEnv }),
    // Mirror the panel to the Rayu web studio when the bridge is connected. A no-op
    // while it is not, which is the default.
    onPanelMessage: (sessionKey, message) =>
      webBridge?.observePanelMessage(sessionKey, message),
  });
  // Log the COUNT only; the values are needles, never diagnostics.
  adapter.log(
    "lifecycle",
    `Redaction filter active with ${secrets.length} credential value(s) from the environment.`,
  );
  activeManager = sessionManager;

  // --- Activity Bar sidebar ------------------------------------------------
  // Registered FIRST so the resolver is in place before any command can trigger
  // `showAgentPanel` (which would otherwise fall back to a floating panel).
  const panelProvider = registerPanelView(context, adapter, sessionManager);

  // --- Status bar ----------------------------------------------------------
  const statusBar = registerStatusBar(context, adapter);

  // --- Commands ------------------------------------------------------------

  // R14.4: registering openPanel makes it invocable from the command palette.
  registerCommandSafely(adapter, OPEN_PANEL_COMMAND, () =>
    sessionManager.openSession(sessionKeyForActiveWorkspace()),
  );

  // R9.5: insert a reference to the active selection (when one exists) into the
  // Agent_Panel prompt input.
  registerCommandSafely(adapter, ADD_SELECTION_COMMAND, () =>
    runAddSelectionToPrompt(sessionManager),
  );

  // R3.6: interrupt the in-progress turn (also the status bar's click action).
  registerCommandSafely(adapter, INTERRUPT_COMMAND, () =>
    runInterrupt(sessionManager),
  );

  // R12.4: discard the current conversation and start a fresh session.
  registerCommandSafely(adapter, NEW_SESSION_COMMAND, () =>
    sessionManager.newSession(sessionKeyForActiveWorkspace()),
  );

  // Selection intents backing both the lightbulb and the editor context menu.
  for (const [commandId, intent] of [
    [EXPLAIN_COMMAND, "explain"],
    [FIX_COMMAND, "fix"],
    [REVIEW_COMMAND, "review"],
  ] as [string, SelectionIntent][]) {
    registerCommandSafely(adapter, commandId, (...args) =>
      runSelectionIntent(sessionManager, intent, args),
    );
  }

  // --- Code actions --------------------------------------------------------
  registerCodeActions(context, adapter);

  // --- Chat participant ----------------------------------------------------
  registerChatParticipantSafely(context, adapter, sessionManager);

  // --- Web Bridge ----------------------------------------------------------
  // Remote control from the rayu-web studio. OPT-IN: registering the commands does
  // not connect anything. See webBridge.ts for why that is a security decision.
  try {
    webBridge = registerWebBridge({
      adapter,
      sessionManager,
      env: childEnv,
      activeSessionKey: () => sessionKeyForActiveWorkspace(),
    });
    context.subscriptions.push({ dispose: () => webBridge?.dispose() });
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register the web bridge: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { context, sessionManager, panelProvider, statusBar };
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
// Surface registration
// ---------------------------------------------------------------------------

/**
 * Register the Activity Bar webview view and plug it into the adapter's panel
 * resolver chain, so a session for the active workspace binds the SIDEBAR rather
 * than a floating editor panel. Returns `null` (and logs) on failure, in which
 * case `showAgentPanel` transparently falls back to the floating panel.
 */
function registerPanelView(
  context: vscode.ExtensionContext,
  adapter: VSCodeAdapter,
  sessionManager: SessionManager,
): RayucodePanelProvider | null {
  try {
    const provider = new RayucodePanelProvider({
      extensionUri: context.extensionUri,
      sessionKeyProvider: sessionKeyForActiveWorkspace,
      onReveal: (sessionKey) => sessionManager.openSession(sessionKey),
      log: (channel, message) => adapter.log(channel, message),
    });

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, provider, {
        // History lives in the host (R12.2); retaining context keeps the view's
        // DOM (scroll position, half-typed prompt) across side bar hide/show.
        webviewOptions: { retainContextWhenHidden: true },
      }),
      adapter.registerAgentPanelResolver((sessionKey) =>
        provider.resolveAgentPanel(sessionKey),
      ),
      { dispose: () => provider.dispose() },
    );
    return provider;
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register the rayucode Activity Bar view: ${errorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Create the status bar item and feed it the host → panel message stream, so it
 * mirrors exactly the state the panel shows.
 */
function registerStatusBar(
  context: vscode.ExtensionContext,
  adapter: VSCodeAdapter,
): RayucodeStatusBar | null {
  try {
    const statusBar = new RayucodeStatusBar(context);
    context.subscriptions.push(
      adapter.onPanelMessage((_sessionKey, message) => {
        statusBar.handlePanelMessage(message);
      }),
      { dispose: () => statusBar.dispose() },
    );
    return statusBar;
  } catch (error) {
    adapter.log(
      "error",
      `Failed to create the rayucode status bar item: ${errorMessage(error)}`,
    );
    return null;
  }
}

/** Register the selection code-action provider for all file documents. */
function registerCodeActions(
  context: vscode.ExtensionContext,
  adapter: VSCodeAdapter,
): void {
  try {
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        // The agent is language-agnostic; restricting the selector would only
        // hide the feature for some file types.
        { scheme: "file" },
        new RayucodeActionProvider(),
        {
          providedCodeActionKinds: [
            ...RayucodeActionProvider.providedCodeActionKinds,
          ],
        },
      ),
    );
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register rayucode code actions: ${errorMessage(error)}`,
    );
  }
}

/** Register the `@rayucode` chat participant, tolerating hosts without chat. */
function registerChatParticipantSafely(
  context: vscode.ExtensionContext,
  adapter: VSCodeAdapter,
  sessionManager: SessionManager,
): void {
  try {
    registerChatParticipant({
      context,
      sessionManager,
      adapter,
      workspaceSessionKey: sessionKeyForActiveWorkspace,
    });
  } catch (error) {
    adapter.log(
      "error",
      `Failed to register the @rayucode chat participant: ${errorMessage(error)}`,
    );
  }
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
  run: (...args: unknown[]) => void | Promise<void>,
): void {
  try {
    adapter.registerCommand(id, (...args: unknown[]) =>
      // Return the promise so the host awaits completion on invocation; the
      // catch keeps a failed invocation from becoming an unhandled rejection
      // and routes the reason to the log channel instead.
      Promise.resolve()
        .then(() => run(...args))
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
 * Handle the interrupt command (R3.6). Reachable from the command palette and
 * from a status bar click, so it may fire when no session has been started —
 * `SessionManager.interrupt` throws for an unknown key, which would surface as a
 * spurious error in the log channel. With nothing running there is nothing to
 * interrupt, so that case is a deliberate no-op.
 */
async function runInterrupt(sessionManager: SessionManager): Promise<void> {
  const sessionKey = sessionKeyForActiveWorkspace();
  try {
    await sessionManager.interrupt(sessionKey);
  } catch {
    // No live session for this workspace: nothing to interrupt.
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
 * Handle an Explain / Fix / Review selection intent. Stages the instruction plus
 * the selected code into the panel prompt input (opening the panel if needed)
 * WITHOUT submitting, so the user can refine it first. A no-op when nothing is
 * selected, matching the add-selection command.
 *
 * `args` come from either the code action (`[uri, range]`) or a bare context-menu
 * invocation (`[uri]` or empty), so both are handled.
 */
async function runSelectionIntent(
  sessionManager: SessionManager,
  intent: SelectionIntent,
  args: unknown[],
): Promise<void> {
  const uri = args[0] instanceof vscode.Uri ? args[0] : undefined;
  const range = args[1] instanceof vscode.Range ? args[1] : undefined;

  const target = resolveIntentTarget(uri, range);
  if (!target) {
    return;
  }

  const reference = buildIntentReference(
    intent,
    target.document.uri.fsPath,
    target.range.start.line + 1,
    target.range.end.line + 1,
    target.document.getText(target.range),
    target.document.languageId,
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
 * still has a consistent key). Every command uses the SAME key so a selection
 * lands in the panel the open-panel command shows.
 */
function sessionKeyForActiveWorkspace(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : DEFAULT_SESSION_KEY;
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
