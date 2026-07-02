// Extension-host integration tests for activation, command wiring, and
// deactivation (task 14.3* — Requirements 2.7, 14.4, 14.5).
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ HEADLESS LIMITATION — these tests DO NOT and CANNOT run in this environment.
//
// Like the other integration suites (tasks 12.3 / 12.5), this file imports the
// real `vscode` runtime and must execute inside a live VS Code extension host
// launched by @vscode/test-cli / @vscode/test-electron. That harness downloads
// and runs a full Electron-based VS Code build, which needs a display/sandbox
// and is therefore unavailable in a headless CI step or the authoring sandbox.
// Run it on a workstation or a CI runner with a (virtual) display via:
//
//     npm run test:integration          # in packages/vscode
//
// (which compiles the suite with esbuild — see esbuild.test.mjs — and invokes
// the `vscode-test` runner configured by .vscode-test.mjs). The vitest run
// explicitly EXCLUDES this directory (see vitest.config.ts), and the production
// `tsc` typecheck excludes it too (see tsconfig.json); use tsconfig.test.json to
// type-check this suite where @types/mocha is installed.
//
// HOW THESE TESTS EXERCISE ACTIVATION DETERMINISTICALLY
// We call the package's exported `activate(context)` / `deactivate()` DIRECTLY
// with a controlled context, rather than relying on the host to auto-activate
// the published extension. To make command wiring observable without the
// timing ambiguity of `executeCommand` (which would also trigger the host's own
// activation of the published extension), we install two thin doubles for the
// duration of the suite:
//   • `vscode.commands.registerCommand` — captures each (id → handler) and
//     passes through to the real implementation (so the id is genuinely
//     registered and appears in `getCommands`, R14.4), and can be told to throw
//     for a chosen id to drive the registration-failure path (R14.5).
//   • `vscode.window.createOutputChannel` — returns a recording channel so we
//     can assert that a registration failure is logged (R14.5).
// We then invoke the captured handler directly to assert behavior, and read the
// API object `activate` returns (`{ context, sessionManager }`) to stub the core
// SessionManager (so a command invocation never spawns a real `rayu`).
// ─────────────────────────────────────────────────────────────────────────────

import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { activate, deactivate } from "../../extension.js";
import type { RayucodeExtensionApi } from "../../extension.js";

const OPEN_PANEL_COMMAND = "rayucode.openPanel";
const ADD_SELECTION_COMMAND = "rayucode.addSelectionToPrompt";

type CommandHandler = (...args: unknown[]) => unknown;

// ----------------------------------------------------------------------------
// Test doubles + shared state (installed for the whole suite)
// ----------------------------------------------------------------------------

/** Captured (id → handler) for every command our activation registers. */
const capturedHandlers = new Map<string, CommandHandler>();
/** Lines written to the adapter's (recording) output channel. */
const capturedLog: string[] = [];
/** Command ids whose registration should be forced to throw (R14.5). */
const failingCommandIds = new Set<string>();
/** Real command disposables registered this test, disposed on teardown. */
const hostDisposables: vscode.Disposable[] = [];

let originalRegisterCommand: typeof vscode.commands.registerCommand;
let originalCreateOutputChannel: typeof vscode.window.createOutputChannel;

/** A `vscode.OutputChannel` that records `appendLine` into `sink`. */
function makeRecordingOutputChannel(
  name: string,
  sink: string[],
): vscode.OutputChannel {
  return {
    name,
    append: () => {},
    appendLine: (value: string) => {
      sink.push(value);
    },
    replace: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
  } as unknown as vscode.OutputChannel;
}

/**
 * A minimal stand-in ExtensionContext: the adapter only needs `subscriptions`
 * and (for showAgentPanel, which these tests never reach) `extensionUri`. Cast
 * through `unknown` because we implement only that surface.
 */
function makeMinimalContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file(__dirname),
  } as unknown as vscode.ExtensionContext;
}

function firstWorkspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "integration tests require an open workspace folder");
  return folder;
}

/** Activate with a fresh controlled context; returns the public API object. */
function activateExtension(): RayucodeExtensionApi {
  return activate(makeMinimalContext());
}

// Stub shapes for replacing instance methods on the returned SessionManager.
type OpenSessionStub = { openSession: (key: string) => Promise<void> };
type AddSelectionStub = {
  addSelectionToPrompt: (key: string, reference: string) => Promise<void>;
};
type DisposeAllStub = { disposeAll: () => Promise<void> };

suite("rayucode activation & command wiring (integration)", () => {
  suiteSetup(() => {
    originalRegisterCommand = vscode.commands.registerCommand;
    originalCreateOutputChannel = vscode.window.createOutputChannel;

    // Capture handlers + pass through (so ids really register), with an opt-in
    // failure for a chosen id.
    (vscode.commands as unknown as Record<string, unknown>).registerCommand = (
      id: string,
      handler: CommandHandler,
      thisArg?: unknown,
    ): vscode.Disposable => {
      if (failingCommandIds.has(id)) {
        throw new Error(`command '${id}' already exists (simulated)`);
      }
      capturedHandlers.set(id, handler);
      const disposable = originalRegisterCommand(id, handler, thisArg);
      hostDisposables.push(disposable);
      return disposable;
    };

    // Recording output channel so a logged registration failure is observable.
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = (
      name: string,
    ): vscode.OutputChannel => makeRecordingOutputChannel(name, capturedLog);
  });

  suiteTeardown(() => {
    (vscode.commands as unknown as Record<string, unknown>).registerCommand =
      originalRegisterCommand;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel =
      originalCreateOutputChannel;
  });

  setup(() => {
    capturedHandlers.clear();
    capturedLog.length = 0;
    failingCommandIds.clear();
  });

  teardown(async () => {
    // Tear the live manager down and unregister this test's commands so the
    // next test can re-register the same ids.
    await deactivate();
    for (const disposable of hostDisposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        /* best-effort cleanup */
      }
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  // R14.4 — the open-panel command is registered and invocable.
  test("registers rayucode.openPanel (invocable from the palette) and openPanel calls openSession", async () => {
    const api = activateExtension();

    // Registered → invocable from the command palette (R14.4).
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes(OPEN_PANEL_COMMAND),
      "rayucode.openPanel should be registered",
    );
    assert.ok(
      commands.includes(ADD_SELECTION_COMMAND),
      "rayucode.addSelectionToPrompt should be registered",
    );

    // Invoking it drives the core open-panel path. Stub openSession so the test
    // does not spawn a real agent; assert the handler delegates with a stable
    // per-workspace key (the first workspace folder's fsPath).
    let openedKey: string | undefined;
    (api.sessionManager as unknown as OpenSessionStub).openSession = async (
      key,
    ) => {
      openedKey = key;
    };

    const handler = capturedHandlers.get(OPEN_PANEL_COMMAND);
    assert.ok(handler, "expected a captured openPanel handler");
    await handler!();

    assert.equal(openedKey, firstWorkspaceFolder().uri.fsPath);
  });

  // R14.5 — a command-registration failure is caught + logged, and activation
  // continues registering the remaining commands.
  test("logs a registration failure and continues activating (R14.5)", async () => {
    // Force ONLY the first command's registration to throw.
    failingCommandIds.add(OPEN_PANEL_COMMAND);

    let api: RayucodeExtensionApi | undefined;
    assert.doesNotThrow(() => {
      api = activateExtension();
    }, "a registration failure must not abort activation");
    assert.ok(api, "activate should still return its API after a failure");

    // The failure was recorded to the log channel (R14.5)…
    assert.ok(
      capturedLog.some(
        (line) =>
          line.includes("Failed to register command") &&
          line.includes(OPEN_PANEL_COMMAND),
      ),
      "expected the openPanel registration failure to be logged",
    );

    // …and activation CONTINUED: the second command still registered.
    assert.ok(
      capturedHandlers.has(ADD_SELECTION_COMMAND),
      "activation should continue and register addSelectionToPrompt",
    );
    assert.ok(
      !capturedHandlers.has(OPEN_PANEL_COMMAND),
      "the failed openPanel registration should not have been captured",
    );
  });

  // R9.5 — add-selection inserts a reference (file path + selected text) into
  // the panel input via the core SessionManager.
  test("addSelectionToPrompt inserts a reference to the selection (R9.5)", async () => {
    const folder = firstWorkspaceFolder();
    const fileUri = vscode.Uri.joinPath(folder.uri, "sample.ts");
    const document = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(document);
    // A non-empty selection over the first `export` line.
    editor.selection = new vscode.Selection(3, 0, 3, 30);
    const selectedText = document.getText(editor.selection);
    assert.ok(selectedText.length > 0, "precondition: a non-empty selection");

    const api = activateExtension();

    // Capture what the command forwards instead of opening a real panel.
    let captured: { key: string; reference: string } | undefined;
    (api.sessionManager as unknown as AddSelectionStub).addSelectionToPrompt =
      async (key, reference) => {
        captured = { key, reference };
      };

    const handler = capturedHandlers.get(ADD_SELECTION_COMMAND);
    assert.ok(handler, "expected a captured addSelectionToPrompt handler");
    await handler!();

    assert.ok(captured, "expected the command to call addSelectionToPrompt");
    assert.equal(captured?.key, folder.uri.fsPath);
    assert.ok(
      captured?.reference.includes(fileUri.fsPath),
      "the reference should cite the selection's file path",
    );
    assert.ok(
      captured?.reference.includes(selectedText),
      "the reference should include the selected text",
    );
    assert.ok(
      captured?.reference.includes("```"),
      "the reference should wrap the selected text in a fenced block",
    );
  });

  // R9.5 — with no (or an empty) selection, the command is a no-op.
  test("addSelectionToPrompt is a no-op when there is no selection (R9.5)", async () => {
    const folder = firstWorkspaceFolder();
    const fileUri = vscode.Uri.joinPath(folder.uri, "sample.ts");
    const document = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(document);
    // Collapse the selection (start === end ⇒ empty).
    editor.selection = new vscode.Selection(0, 0, 0, 0);

    const api = activateExtension();
    let called = false;
    (api.sessionManager as unknown as AddSelectionStub).addSelectionToPrompt =
      async () => {
        called = true;
      };

    const handler = capturedHandlers.get(ADD_SELECTION_COMMAND);
    assert.ok(handler, "expected a captured addSelectionToPrompt handler");
    await handler!();

    assert.equal(called, false, "no selection ⇒ addSelectionToPrompt not called");
  });

  // R2.7 — deactivate terminates every spawned agent process by driving the
  // core's disposeAll() (which denies pending permissions before terminating
  // each child and resolves only after confirmed exit — unit-tested in core).
  test("deactivate terminates spawned processes via disposeAll (R2.7)", async () => {
    const api = activateExtension();

    let disposeAllCalled = false;
    (api.sessionManager as unknown as DisposeAllStub).disposeAll = async () => {
      disposeAllCalled = true;
    };

    await deactivate();

    assert.equal(
      disposeAllCalled,
      true,
      "deactivate should drive SessionManager.disposeAll to terminate agents",
    );

    // Idempotent: a second deactivate (e.g. teardown) does nothing.
    await deactivate();
  });
});
