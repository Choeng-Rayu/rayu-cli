// Extension-host integration tests for VSCodeAdapter's FILE-EDIT operations —
// applyFileEdits / readFileSnapshot (task 12.5* — Requirements 6.2, 6.3, 6.4,
// 6.5, 6.6).
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ HEADLESS LIMITATION — these tests DO NOT and CANNOT run in this environment.
//
// Exactly like the non-edit integration suite (task 12.3), this file imports the
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
// What it verifies against a REAL workspace (what unit tests cannot):
//   • modify updates an OPEN editor buffer in place (R6.4),
//   • create writes a new file at the workspace-relative path (R6.5),
//   • a stale base hash is reported as a conflict and the file is untouched,
//     and the override re-send (no base hash) then applies it (R6.3),
//   • a per-file failure is isolated — other files still apply (R6.6),
//   • readFileSnapshot round-trips content + hashContent and returns null for a
//     missing file (R6.3).
// ─────────────────────────────────────────────────────────────────────────────

import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { hashContent } from "@rayucode/core";
import type { FileEditPlan } from "@rayucode/core";

import { VSCodeAdapter } from "../../vscodeAdapter.js";

/**
 * A minimal stand-in ExtensionContext. The edit operations touch neither secret
 * storage nor the extension URI, so the subset the constructor uses (the
 * subscriptions array + an output channel) is all that is required. Cast through
 * `unknown` because we deliberately implement only that surface.
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

/** Absolute Uri for a workspace-relative path (the first workspace folder). */
function uriFor(relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(firstWorkspaceFolder().uri, relativePath);
}

/** Write `content` to a workspace-relative path on disk (test setup). */
async function writeOnDisk(
  relativePath: string,
  content: string,
): Promise<void> {
  await vscode.workspace.fs.writeFile(
    uriFor(relativePath),
    Buffer.from(content, "utf8"),
  );
}

/** Read the on-disk content of a workspace-relative path (test assertion). */
async function readOnDisk(relativePath: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uriFor(relativePath));
  return Buffer.from(bytes).toString("utf8");
}

async function existsOnDisk(relativePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uriFor(relativePath));
    return true;
  } catch {
    return false;
  }
}

suite("VSCodeAdapter file-edit operations (integration)", () => {
  let adapter: VSCodeAdapter;
  let context: vscode.ExtensionContext;

  // Every workspace-relative path this suite creates, deleted on teardown.
  const createdPaths = new Set<string>();
  const track = (relativePath: string): string => {
    createdPaths.add(relativePath);
    return relativePath;
  };

  suiteSetup(() => {
    context = makeMinimalContext();
    adapter = new VSCodeAdapter(context);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const relativePath of createdPaths) {
      try {
        await vscode.workspace.fs.delete(uriFor(relativePath), {
          useTrash: false,
        });
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

  // R6.4 — applying a `modify` to a file open in an editor updates that buffer.
  test("modify updates an open editor buffer in place (R6.4)", async () => {
    const rel = track("edit-itest-modify.ts");
    const base = "export const value = 1;\n";
    const updated = "export const value = 42;\n";
    await writeOnDisk(rel, base);

    // Open the file in an editor tab so there is a live buffer to update.
    const document = await vscode.workspace.openTextDocument(uriFor(rel));
    await vscode.window.showTextDocument(document);
    assert.equal(document.getText(), base);

    const baseHash = (await adapter.readFileSnapshot(rel))?.contentHash;
    assert.ok(baseHash, "expected a snapshot for the existing file");

    const plan: FileEditPlan = {
      changes: [
        { path: rel, kind: "modify", baseContentHash: baseHash, newContent: updated },
      ],
    };
    const result = await adapter.applyFileEdits(plan);

    assert.deepEqual(result.applied, [rel]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.conflicts, []);

    // R6.4: the OPEN buffer reflects the change (and is now a dirty, unsaved
    // edit — the in-place buffer update, not a silent on-disk overwrite).
    assert.equal(document.getText(), updated);
    assert.equal(document.isDirty, true);
  });

  // R6.5 — applying a `create` writes a new file at the workspace-relative path.
  test("create writes a new file at the workspace-relative path (R6.5)", async () => {
    const rel = track("edit-itest-created.ts");
    const content = "export const created = true;\n";
    assert.equal(await existsOnDisk(rel), false);

    // A `create` carries no baseContentHash (nothing on disk to conflict with).
    const plan: FileEditPlan = {
      changes: [{ path: rel, kind: "create", newContent: content }],
    };
    const result = await adapter.applyFileEdits(plan);

    assert.deepEqual(result.applied, [rel]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.conflicts, []);

    assert.equal(await existsOnDisk(rel), true);
    assert.equal(await readOnDisk(rel), content);
  });

  // R6.3 — a base hash that no longer matches the on-disk content is a conflict;
  // the file is left untouched. The override re-send (no base hash) then applies.
  test("reports a conflict on a stale base, then applies on override (R6.3)", async () => {
    const rel = track("edit-itest-conflict.ts");
    const original = "version: A\n";
    await writeOnDisk(rel, original);

    // Capture the base hash as the proposal model would at proposal time.
    const staleHash = (await adapter.readFileSnapshot(rel))?.contentHash;
    assert.ok(staleHash, "expected a snapshot for the existing file");

    // The file changes on disk AFTER the proposal was generated.
    const changedOnDisk = "version: B (edited elsewhere)\n";
    await writeOnDisk(rel, changedOnDisk);

    const attempted = "version: C (from the agent)\n";
    const conflicting: FileEditPlan = {
      changes: [
        { path: rel, kind: "modify", baseContentHash: staleHash, newContent: attempted },
      ],
    };
    const conflictResult = await adapter.applyFileEdits(conflicting);

    // Reported as a conflict, NOT applied, NOT failed — and the file is intact.
    assert.deepEqual(conflictResult.conflicts, [{ path: rel }]);
    assert.deepEqual(conflictResult.applied, []);
    assert.deepEqual(conflictResult.failed, []);
    assert.equal(await readOnDisk(rel), changedOnDisk);

    // Override-after-confirmation: the core re-sends the SAME change WITHOUT a
    // baseContentHash, which skips the conflict check and forces the apply.
    const override: FileEditPlan = {
      changes: [{ path: rel, kind: "modify", newContent: attempted }],
    };
    const overrideResult = await adapter.applyFileEdits(override);

    assert.deepEqual(overrideResult.applied, [rel]);
    assert.deepEqual(overrideResult.conflicts, []);
    assert.deepEqual(overrideResult.failed, []);
    assert.equal(await readOnDisk(rel), attempted);
  });

  // R6.6 — a per-file failure is isolated: a failing change mid-plan leaves the
  // other files applied. The failing change is reported with its path.
  test("isolates a per-file failure and applies the others (R6.6)", async () => {
    const missingRel = track("edit-itest-missing.ts"); // never created on disk
    const createRel = track("edit-itest-iso-create.ts");
    const modifyRel = track("edit-itest-iso-modify.ts");

    const modifyBase = "keep = 0\n";
    const modifyNew = "keep = 1\n";
    await writeOnDisk(modifyRel, modifyBase);
    assert.equal(await existsOnDisk(missingRel), false);

    // Order matters: the FAILING change is first, proving the loop does not
    // abort and still applies the later files.
    const plan: FileEditPlan = {
      changes: [
        // Fails: cannot modify a file that does not exist (no base hash, so the
        // conflict check is skipped and opening the document throws).
        { path: missingRel, kind: "modify", newContent: "noop\n" },
        // Succeeds: a brand-new file.
        { path: createRel, kind: "create", newContent: "export const ok = 1;\n" },
        // Succeeds: an existing file modified.
        { path: modifyRel, kind: "modify", newContent: modifyNew },
      ],
    };
    const result = await adapter.applyFileEdits(plan);

    // The two good files applied; the bad one is reported with its path.
    assert.deepEqual(result.applied.sort(), [createRel, modifyRel].sort());
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.path, missingRel);
    assert.ok(
      result.failed[0]?.reason && result.failed[0].reason.length > 0,
      "a failure must carry a non-empty reason",
    );

    // Other files are genuinely on disk with their new content; the missing one
    // was never created.
    assert.equal(await readOnDisk(createRel), "export const ok = 1;\n");
    assert.equal(await readOnDisk(modifyRel), modifyNew);
    assert.equal(await existsOnDisk(missingRel), false);
  });

  // R6.3 — readFileSnapshot round-trips content + hashContent, and a missing
  // file yields null (the "no snapshot to compare" case for conflict checks).
  test("readFileSnapshot returns content+hash, or null when absent (R6.3)", async () => {
    const rel = track("edit-itest-snapshot.ts");
    const content = "snapshot me\n";
    await writeOnDisk(rel, content);

    const snapshot = await adapter.readFileSnapshot(rel);
    assert.ok(snapshot, "expected a snapshot for the existing file");
    assert.equal(snapshot?.path, rel);
    assert.equal(snapshot?.content, content);
    // The digest matches the SAME hash the core proposal model uses, so the
    // captured base hash and the conflict-check hash line up.
    assert.equal(snapshot?.contentHash, hashContent(content));

    const absent = await adapter.readFileSnapshot("edit-itest-does-not-exist.ts");
    assert.equal(absent, null);
  });
});
