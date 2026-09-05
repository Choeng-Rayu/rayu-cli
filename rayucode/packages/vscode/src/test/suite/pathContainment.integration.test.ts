// Security integration tests for edit-path resolution (R6.5) against the REAL
// `vscode` API.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ Requires a real VS Code extension host. Run with:
//     npm run test:integration          # in packages/vscode
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS NEEDS THE REAL API
// `applyFileEdits` resolves a change's `path` with `vscode.Uri.joinPath`, whose
// `..` normalization behavior is the entire question here. A stub cannot answer
// it. The agent controls `file_path` in every Write/Edit/MultiEdit tool call, so
// whatever containment exists must hold against a hostile value.

import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { VSCodeAdapter } from "../../vscodeAdapter.js";

/** Must match SETTING_ALLOW_OUTSIDE_WORKSPACE in src/vscodeAdapter.ts. */
const SETTING_ALLOW_OUTSIDE = "rayucode.allowEditsOutsideWorkspace";

function makeContext(): vscode.ExtensionContext {
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

/** Whether `target` lies inside `root` (both absolute, already normalized). */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

suite("edit path containment (integration, security)", () => {
  let adapter: VSCodeAdapter;
  let context: vscode.ExtensionContext;
  const created: vscode.Uri[] = [];
  /** Raw filesystem paths (symlinks, directories) removed on teardown. */
  const createdPaths: string[] = [];

  suiteSetup(() => {
    context = makeContext();
    adapter = new VSCodeAdapter(context);
  });

  suiteTeardown(async () => {
    for (const uri of created) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch {
        /* best-effort cleanup */
      }
    }
    for (const target of createdPaths) {
      try {
        await nodeFs.rm(target, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    for (const disposable of context.subscriptions) {
      try {
        disposable.dispose();
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  test("Uri.joinPath normalizes `..`, so a relative path CAN traverse upward", () => {
    // Documents the primitive the adapter builds on. If this ever stops
    // normalizing, the containment guard below must be revisited.
    const root = firstWorkspaceFolder().uri;
    const escaped = vscode.Uri.joinPath(root, "../../escaped.txt");

    assert.equal(
      isInside(root.fsPath, escaped.fsPath),
      false,
      "joinPath normalized `..` out of the workspace",
    );
  });

  test("a traversing relative path is rejected, not written outside the workspace", async () => {
    const root = firstWorkspaceFolder().uri;
    // A path the agent could put in `file_path` to escape the workspace.
    const target = vscode.Uri.joinPath(root, "..", "rayucode-escape-probe.txt");
    created.push(target);

    const result = await adapter.applyFileEdits({
      changes: [
        {
          path: "../rayucode-escape-probe.txt",
          kind: "create",
          newContent: "escaped\n",
        },
      ],
    });

    // The change must be refused, and nothing may appear outside the workspace.
    assert.deepEqual(
      result.applied,
      [],
      "a workspace-escaping relative path must not be applied",
    );
    assert.equal(result.failed.length, 1);
    assert.match(
      result.failed[0]?.reason ?? "",
      /outside|workspace/i,
      "the failure should explain that the path escapes the workspace",
    );
    await assert.rejects(
      Promise.resolve(vscode.workspace.fs.stat(target)),
      "no file may be created outside the workspace",
    );
  });

  test("an absolute path outside the workspace is rejected", async () => {
    const outside = vscode.Uri.file(
      path.join(os.tmpdir(), "rayucode-abs-escape-probe.txt"),
    );
    created.push(outside);

    const result = await adapter.applyFileEdits({
      changes: [
        { path: outside.fsPath, kind: "create", newContent: "escaped\n" },
      ],
    });

    assert.deepEqual(
      result.applied,
      [],
      "an absolute path outside the workspace must not be applied",
    );
    assert.equal(result.failed.length, 1);
    await assert.rejects(
      Promise.resolve(vscode.workspace.fs.stat(outside)),
      "no file may be created outside the workspace",
    );
  });

  test("a normal in-workspace path still applies (the guard is not over-broad)", async () => {
    const rel = "containment-ok.txt";
    const target = vscode.Uri.joinPath(firstWorkspaceFolder().uri, rel);
    created.push(target);

    const result = await adapter.applyFileEdits({
      changes: [{ path: rel, kind: "create", newContent: "fine\n" }],
    });

    assert.deepEqual(result.applied, [rel]);
    assert.deepEqual(result.failed, []);
  });

  test("an in-workspace path containing `..` that stays inside is allowed", async () => {
    // `sub/../containment-dots.txt` normalizes to `containment-dots.txt`, which is
    // inside the workspace — the guard must judge the RESOLVED path, not reject
    // any string containing "..".
    const rel = "sub/../containment-dots.txt";
    const target = vscode.Uri.joinPath(
      firstWorkspaceFolder().uri,
      "containment-dots.txt",
    );
    created.push(target);

    const result = await adapter.applyFileEdits({
      changes: [{ path: rel, kind: "create", newContent: "fine\n" }],
    });

    assert.equal(
      result.applied.length,
      1,
      `expected the normalized in-workspace path to apply, got ${JSON.stringify(result)}`,
    );
  });

  test("readFileSnapshot does not disclose files outside the workspace", async () => {
    // Snapshot reads feed conflict detection; they must obey the same boundary,
    // otherwise an edit proposal could be used to probe arbitrary files.
    const outside = path.join(os.tmpdir(), "rayucode-read-probe.txt");
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(outside),
      Buffer.from("secret-outside\n", "utf8"),
    );
    created.push(vscode.Uri.file(outside));

    await assert.rejects(
      adapter.readFileSnapshot(outside),
      /outside|workspace/i,
      "reading outside the workspace should be refused",
    );
  });

  test("a sibling directory sharing the root's name prefix is still outside", async () => {
    // The classic containment bug: a raw `startsWith` check would treat
    // `/tmp/rayucode-itest-XYZ-secrets` as inside `/tmp/rayucode-itest-XYZ`.
    const root = firstWorkspaceFolder().uri.fsPath;
    const sibling = vscode.Uri.file(`${root}-secrets/leak.txt`);
    created.push(sibling);

    const result = await adapter.applyFileEdits({
      changes: [{ path: sibling.fsPath, kind: "create", newContent: "leak\n" }],
    });

    assert.deepEqual(
      result.applied,
      [],
      "a path sharing the workspace's name prefix must be treated as outside",
    );
    assert.equal(result.failed.length, 1);
  });

  test("a symlink inside the workspace cannot be used to write outside it", async () => {
    // `path.resolve` collapses `..` but does NOT follow links, so a purely
    // lexical containment check accepts `<workspace>/link/x` while the write
    // actually lands wherever `link` points. A committed symlink makes this
    // reachable just by opening a repository.
    const root = firstWorkspaceFolder().uri.fsPath;
    const outsideDir = await nodeFs.mkdtemp(
      path.join(os.tmpdir(), "rayucode-symlink-target-"),
    );
    const link = path.join(root, "escape-link");
    createdPaths.push(link, outsideDir);

    try {
      await nodeFs.symlink(outsideDir, link, "dir");
    } catch {
      // Symlink creation can be unavailable (e.g. Windows without privilege);
      // there is nothing to assert in that case.
      return;
    }

    const result = await adapter.applyFileEdits({
      changes: [
        {
          path: path.join("escape-link", "leak.txt"),
          kind: "create",
          newContent: "leaked\n",
        },
      ],
    });

    assert.deepEqual(
      result.applied,
      [],
      "a symlinked path escaping the workspace must not be applied",
    );
    assert.equal(result.failed.length, 1);
    await assert.rejects(
      Promise.resolve(
        vscode.workspace.fs.stat(
          vscode.Uri.file(path.join(outsideDir, "leak.txt")),
        ),
      ),
      "nothing may be written through the symlink",
    );
  });

  test("a symlink that stays inside the workspace still works", async () => {
    // The guard resolves real paths, so it must not reject a link whose target is
    // also inside the workspace.
    const root = firstWorkspaceFolder().uri.fsPath;
    const innerDir = path.join(root, "link-target-dir");
    const link = path.join(root, "inner-link");
    createdPaths.push(link, innerDir);

    await nodeFs.mkdir(innerDir, { recursive: true });
    try {
      await nodeFs.symlink(innerDir, link, "dir");
    } catch {
      return;
    }

    const result = await adapter.applyFileEdits({
      changes: [
        {
          path: path.join("inner-link", "ok.txt"),
          kind: "create",
          newContent: "fine\n",
        },
      ],
    });

    assert.deepEqual(
      result.failed,
      [],
      `an in-workspace symlink must still resolve, got ${JSON.stringify(result)}`,
    );
  });

  test("the containment opt-out cannot be set by the workspace", async () => {
    // The setting is machine-scoped precisely so a repository's own
    // `.vscode/settings.json` cannot switch off its containment. VS Code enforces
    // that by refusing the write.
    await assert.rejects(
      Promise.resolve(
        vscode.workspace
          .getConfiguration()
          .update(
            SETTING_ALLOW_OUTSIDE,
            true,
            vscode.ConfigurationTarget.Workspace,
          ),
      ),
      /only into User settings|can be written only/i,
      "a workspace must not be able to disable edit containment",
    );
  });

  test("the opt-in setting, set at User scope, restores editing outside the workspace", async () => {
    // Containment must be overridable by the USER: someone who genuinely edits a
    // sibling repo or a dotfile needs an escape hatch, and it has to work.
    const outside = vscode.Uri.file(
      path.join(os.tmpdir(), "rayucode-optin-probe.txt"),
    );
    created.push(outside);
    const config = vscode.workspace.getConfiguration();
    const previous = config.get(SETTING_ALLOW_OUTSIDE);

    try {
      await config.update(
        SETTING_ALLOW_OUTSIDE,
        true,
        vscode.ConfigurationTarget.Global,
      );

      const result = await adapter.applyFileEdits({
        changes: [
          { path: outside.fsPath, kind: "create", newContent: "opted in\n" },
        ],
      });

      assert.deepEqual(
        result.failed,
        [],
        `expected the opt-in to permit the write, got ${JSON.stringify(result)}`,
      );
      assert.deepEqual(result.applied, [outside.fsPath]);
    } finally {
      await config.update(
        SETTING_ALLOW_OUTSIDE,
        previous,
        vscode.ConfigurationTarget.Global,
      );
    }
  });

  test("containment is restored once the opt-in is turned back off", async () => {
    // Guards against the guard caching its decision: the setting must be read per
    // resolution, not once at construction.
    const outside = vscode.Uri.file(
      path.join(os.tmpdir(), "rayucode-optin-off-probe.txt"),
    );
    created.push(outside);

    const result = await adapter.applyFileEdits({
      changes: [
        { path: outside.fsPath, kind: "create", newContent: "blocked\n" },
      ],
    });

    assert.deepEqual(result.applied, []);
    assert.equal(result.failed.length, 1);
  });
});
