// Extension-host integration tests for VSCodeAdapter's NON-edit operations
// (task 12.3 — Requirements 8.4, 9.6, 13.2).
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ HEADLESS LIMITATION — these tests DO NOT and CANNOT run in this environment.
//
// Unlike the vitest unit tests, this suite imports the real `vscode` runtime and
// must execute inside a live VS Code extension host launched by
// @vscode/test-cli / @vscode/test-electron. That harness downloads and runs a
// full Electron-based VS Code build, which requires a display/sandbox and is not
// available in a headless CI step or this sandbox. Run it on a workstation or a
// CI runner with a (virtual) display via:
//
//     npm run test:integration          # in packages/vscode
//
// (which compiles the suite with esbuild — see esbuild.test.mjs — and invokes
// the `vscode-test` runner configured by .vscode-test.mjs). The vitest run
// explicitly EXCLUDES this directory (see vitest.config.ts), and the production
// `tsc` typecheck excludes it too (see tsconfig.json); use tsconfig.test.json to
// type-check this suite where @types/mocha is installed.
// ─────────────────────────────────────────────────────────────────────────────

import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { VSCodeAdapter } from "../../vscodeAdapter.js";

/**
 * A minimal stand-in ExtensionContext, sufficient for every operation this suite
 * exercises: command registration, workspace context, ignore checks, output
 * channel. Cast through `unknown` because it deliberately implements only that
 * surface.
 *
 * A REAL context used to be resolved here as well, purely so a secret-storage
 * round-trip could run against a genuine `SecretStorage`. `EditorAdapter`'s
 * `getSecret`/`storeSecret` pair had zero production callers and was deleted, so
 * that scaffolding went with it.
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

suite("VSCodeAdapter non-edit operations (integration)", () => {
  let adapter: VSCodeAdapter;
  let context: vscode.ExtensionContext;

  let originalFilesExclude: unknown;

  suiteSetup(async () => {
    context = makeMinimalContext();
    adapter = new VSCodeAdapter(context);

    // Snapshot the workspace `files.exclude` so the ignore test can restore it.
    originalFilesExclude = vscode.workspace
      .getConfiguration()
      .get("files.exclude");
  });

  suiteTeardown(async () => {
    // Restore the original exclude configuration.
    await vscode.workspace
      .getConfiguration()
      .update(
        "files.exclude",
        originalFilesExclude,
        vscode.ConfigurationTarget.Workspace,
      );
    // Dispose anything the adapter registered (output channel, commands).
    for (const disposable of context.subscriptions) {
      try {
        disposable.dispose();
      } catch {
        /* best-effort cleanup */
      }
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  // R14.4 — command registration via the extension host.
  test("registers an invocable command and disposes it", async () => {
    const commandId = "rayucode.itest.ping";
    let received: unknown;
    const subscriptionsBefore = context.subscriptions.length;

    const disposable = adapter.registerCommand(commandId, (...args) => {
      received = args[0];
      return "pong";
    });

    // The adapter also tracks the disposable on the context (R14 lifecycle).
    assert.equal(context.subscriptions.length, subscriptionsBefore + 1);

    const result = await vscode.commands.executeCommand(commandId, 42);
    assert.equal(result, "pong");
    assert.equal(received, 42);

    // After disposal the command is no longer registered.
    disposable.dispose();
    await assert.rejects(
      Promise.resolve(vscode.commands.executeCommand(commandId)),
      /command .*not found|no handler|not found/i,
    );
  });

  // R9.1, R9.3, R9.4 — workspace-context queries.
  test("reports workspace root and opt-in active file / selection", async () => {
    const folder = firstWorkspaceFolder();
    const fileUri = vscode.Uri.joinPath(folder.uri, "sample.ts");
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc);
    // Select from line 0 col 0 to line 1 col 5 (0-based positions).
    editor.selection = new vscode.Selection(0, 0, 1, 5);

    // Root is always present; opt-in fields are omitted unless requested.
    const base = await adapter.getWorkspaceContext({});
    assert.equal(base.workspaceRoot, folder.uri.fsPath);
    assert.equal(base.activeFilePath, undefined);
    assert.equal(base.selection, undefined);

    // R9.3 — active file included only when opted in.
    const withFile = await adapter.getWorkspaceContext({
      includeActiveFile: true,
    });
    assert.equal(withFile.activeFilePath, fileUri.fsPath);

    // R9.4 — selection included only when opted in; lines are surfaced 1-based.
    const withSelection = await adapter.getWorkspaceContext({
      includeSelection: true,
    });
    assert.ok(withSelection.selection, "expected a selection");
    assert.equal(withSelection.selection?.path, fileUri.fsPath);
    assert.equal(withSelection.selection?.startLine, 1);
    assert.equal(withSelection.selection?.endLine, 2);
    assert.equal(
      withSelection.selection?.text,
      doc.getText(editor.selection),
    );
  });

  // R9.6 — ignore-aware path checks via the workspace exclude configuration.
  test("treats files matching the exclude config as ignored", async () => {
    const folder = firstWorkspaceFolder();
    await vscode.workspace
      .getConfiguration()
      .update(
        "files.exclude",
        { ...(originalFilesExclude as object), "**/*.ignoreme": true },
        vscode.ConfigurationTarget.Workspace,
      );

    const ignoredPath = vscode.Uri.joinPath(
      folder.uri,
      "secret.ignoreme",
    ).fsPath;
    const normalPath = vscode.Uri.joinPath(folder.uri, "src", "index.ts").fsPath;

    assert.equal(await adapter.isPathIgnored(ignoredPath), true);
    assert.equal(await adapter.isPathIgnored(normalPath), false);
  });
});
