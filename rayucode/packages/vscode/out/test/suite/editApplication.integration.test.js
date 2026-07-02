"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/test/suite/editApplication.integration.test.ts
var assert = __toESM(require("node:assert/strict"));
var vscode2 = __toESM(require("vscode"));

// ../core/dist/edit/contentHash.js
var import_node_crypto = require("node:crypto");
function hashContent(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content, "utf8").digest("hex");
}

// src/vscodeAdapter.ts
var vscode = __toESM(require("vscode"));

// src/ignoreGlob.ts
var REGEX_SPECIALS = /* @__PURE__ */ new Set([
  ".",
  "+",
  "^",
  "$",
  "(",
  ")",
  "|",
  "[",
  "]",
  "{",
  "}",
  "\\"
]);
function escapeLiteral(char) {
  return REGEX_SPECIALS.has(char) ? `\\${char}` : char;
}
function globToRegExpSource(glob) {
  const chars = [...glob];
  let source = "";
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === "*") {
      if (chars[i + 1] === "*") {
        i++;
        if (chars[i + 1] === "/") {
          i++;
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "{") {
      let j = i + 1;
      let body = "";
      while (j < chars.length && chars[j] !== "}") {
        body += chars[j];
        j++;
      }
      const alternatives = body.split(",").map(globToRegExpSource);
      source += `(?:${alternatives.join("|")})`;
      i = j;
      continue;
    }
    source += escapeLiteral(char);
  }
  return source;
}
var regExpCache = /* @__PURE__ */ new Map();
function matchGlob(relativePath, glob) {
  let regExp = regExpCache.get(glob);
  if (!regExp) {
    regExp = new RegExp(`^${globToRegExpSource(glob)}$`);
    regExpCache.set(glob, regExp);
  }
  return regExp.test(relativePath);
}
function normalizeRelativePath(relativePath) {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
function isIgnoredByGlobs(relativePath, globs) {
  const normalized = normalizeRelativePath(relativePath);
  for (const glob of globs) {
    if (!glob) continue;
    if (matchGlob(normalized, glob)) return true;
    const dirGlob = `${glob.replace(/\/+$/, "")}/**`;
    if (matchGlob(normalized, dirGlob)) return true;
  }
  return false;
}
function collectExcludeGlobs(...sources) {
  const globs = /* @__PURE__ */ new Set();
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [glob, value] of Object.entries(source)) {
      if (!glob) continue;
      if (value === false || value === null || value === void 0) continue;
      globs.add(glob);
    }
  }
  return [...globs];
}

// src/vscodeAdapter.ts
var OUTPUT_CHANNEL_NAME = "rayucode";
var AGENT_PANEL_VIEW_TYPE = "rayucode.agentPanel";
var VSCodeAdapter = class {
  constructor(context) {
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    context.subscriptions.push(this.outputChannel);
  }
  // --------------------------------------------------------------------------
  // Panel surface (R3.1)
  // --------------------------------------------------------------------------
  async showAgentPanel(sessionKey) {
    const panel = vscode.window.createWebviewPanel(
      AGENT_PANEL_VIEW_TYPE,
      "rayucode",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // History lives in the host (R12.2); retaining context avoids tearing
        // down the view when the user tabs away.
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri]
      }
    );
    panel.webview.html = renderPanelHtml(panel.webview, this.context.extensionUri);
    return new VSCodeAgentPanelHandle(sessionKey, panel);
  }
  // --------------------------------------------------------------------------
  // File edits — task 12.4 (R6.2, R6.3, R6.4, R6.5, R6.6)
  // --------------------------------------------------------------------------
  /**
   * Apply a {@link FileEditPlan} into the workspace, classifying each change
   * independently into `applied`, `failed`, or `conflicts` (R6.2).
   *
   * Each file is processed on its own — built into a single
   * {@link vscode.WorkspaceEdit} and committed with its own
   * {@link vscode.workspace.applyEdit} — so one file's conflict or failure never
   * affects the others (partial-failure isolation, R6.6).
   *
   * - **Conflict (R6.3)**: when a change carries a `baseContentHash`, the current
   *   on-disk snapshot is read and compared; a missing file or a differing hash
   *   means the file changed since the proposal was generated, so it is recorded
   *   in `conflicts` and left untouched. The core then requires explicit
   *   confirmation and re-sends the change WITHOUT a `baseContentHash`, which
   *   skips this check and forces the apply (override-after-confirmation).
   * - **Modify (R6.4)**: applied as a full-range replace against the document
   *   opened via {@link vscode.workspace.openTextDocument}; because that returns
   *   the live in-memory document when the file is open in a tab, the open
   *   editor buffer updates in place.
   * - **Create (R6.5)**: applied with {@link vscode.WorkspaceEdit.createFile} at
   *   the change's workspace-relative path (resolved against the first workspace
   *   folder); `overwrite`/`ignoreIfExists` are both left false so creating over
   *   an existing file fails rather than clobbering it.
   */
  async applyFileEdits(plan) {
    const applied = [];
    const failed = [];
    const conflicts = [];
    for (const change of plan.changes) {
      try {
        if (change.baseContentHash !== void 0) {
          const current = await this.readFileSnapshot(change.path);
          if (current === null || current.contentHash !== change.baseContentHash) {
            conflicts.push({ path: change.path });
            continue;
          }
        }
        const uri = this.resolveEditUri(change.path);
        const edit = new vscode.WorkspaceEdit();
        if (change.kind === "create") {
          edit.createFile(uri, {
            overwrite: false,
            ignoreIfExists: false,
            contents: Buffer.from(change.newContent, "utf8")
          });
        } else {
          const document = await vscode.workspace.openTextDocument(uri);
          const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            document.positionAt(document.getText().length)
          );
          edit.replace(uri, fullRange, change.newContent);
        }
        const ok2 = await vscode.workspace.applyEdit(edit);
        if (ok2) {
          applied.push(change.path);
        } else {
          failed.push({
            path: change.path,
            reason: change.kind === "create" ? "the editor rejected the edit (the file may already exist)" : "the editor rejected the edit"
          });
        }
      } catch (error) {
        failed.push({ path: change.path, reason: errorMessageOf(error) });
      }
    }
    return { applied, failed, conflicts };
  }
  /**
   * Read the current on-disk snapshot of `path` for conflict detection (R6.3),
   * returning its content and a {@link hashContent} digest, or `null` when the
   * file does not exist. The path is resolved against the first workspace folder
   * when relative. Any I/O error other than "file not found" propagates.
   */
  async readFileSnapshot(path) {
    const uri = this.resolveEditUri(path);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf8");
      return { path, content, contentHash: hashContent(content) };
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
  // --------------------------------------------------------------------------
  // Workspace context (R9.1, R9.3, R9.4)
  // --------------------------------------------------------------------------
  async getWorkspaceContext(options) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const result = {
      workspaceRoot: folder ? folder.uri.fsPath : null
    };
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      if (options.includeActiveFile) {
        result.activeFilePath = editor.document.uri.fsPath;
      }
      if (options.includeSelection && !editor.selection.isEmpty) {
        const sel = editor.selection;
        const selection = {
          path: editor.document.uri.fsPath,
          text: editor.document.getText(sel),
          // vscode positions are 0-based; surface 1-based lines (what the user
          // sees in the gutter) for the prompt preamble.
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1
        };
        result.selection = selection;
      }
    }
    return result;
  }
  // --------------------------------------------------------------------------
  // Ignore-aware path checks (R9.6)
  // --------------------------------------------------------------------------
  async isPathIgnored(path) {
    const relative = vscode.workspace.asRelativePath(path, false);
    const config = vscode.workspace.getConfiguration();
    const globs = collectExcludeGlobs(
      config.get("files.exclude"),
      config.get("search.exclude")
    );
    if (isIgnoredByGlobs(relative, globs)) {
      return true;
    }
    return this.isIgnoredByGit(path);
  }
  // --------------------------------------------------------------------------
  // Command registration (R14.1, R14.4)
  // --------------------------------------------------------------------------
  registerCommand(id, handler) {
    const disposable = vscode.commands.registerCommand(id, handler);
    this.context.subscriptions.push(disposable);
    return disposable;
  }
  // --------------------------------------------------------------------------
  // Secret storage (R8.4, R13.3)
  // --------------------------------------------------------------------------
  getSecret(key) {
    return Promise.resolve(this.context.secrets.get(key));
  }
  storeSecret(key, value) {
    return Promise.resolve(this.context.secrets.store(key, value));
  }
  // --------------------------------------------------------------------------
  // Diagnostics (R2.6, R15.3)
  // --------------------------------------------------------------------------
  log(channel, message) {
    this.outputChannel.appendLine(`[${channel}] ${message}`);
  }
  // --------------------------------------------------------------------------
  // Actionable notifications (R1.2, R15.1)
  // --------------------------------------------------------------------------
  async showActionableMessage(level, text, actions) {
    switch (level) {
      case "info":
        return vscode.window.showInformationMessage(text, ...actions);
      case "warn":
        return vscode.window.showWarningMessage(text, ...actions);
      case "error":
        return vscode.window.showErrorMessage(text, ...actions);
      default: {
        const unexpected = level;
        throw new Error(`Unsupported message level: ${String(unexpected)}`);
      }
    }
  }
  // --------------------------------------------------------------------------
  // Settings access (R1.1, R9.3, R9.4)
  // --------------------------------------------------------------------------
  getSetting(key, fallback) {
    return vscode.workspace.getConfiguration().get(key, fallback);
  }
  // --------------------------------------------------------------------------
  // Internals — best-effort git ignore probe
  // --------------------------------------------------------------------------
  async isIgnoredByGit(path) {
    try {
      const api = await this.getGitApi();
      if (!api) return false;
      const uri = this.toAbsoluteUri(path);
      if (!uri) return false;
      const repo = api.getRepository?.(uri) ?? api.repositories.find((r) => uri.fsPath.startsWith(r.rootUri.fsPath));
      if (!repo || typeof repo.checkIgnore !== "function") return false;
      const ignored = await repo.checkIgnore([uri.fsPath]);
      return ignored instanceof Set && ignored.size > 0;
    } catch {
      return false;
    }
  }
  async getGitApi() {
    if (this.gitApi !== void 0) return this.gitApi;
    this.gitApi = null;
    try {
      const ext = vscode.extensions.getExtension("vscode.git");
      if (ext) {
        const exports2 = ext.isActive ? ext.exports : await ext.activate();
        this.gitApi = typeof exports2?.getAPI === "function" ? exports2.getAPI(1) : null;
      }
    } catch {
      this.gitApi = null;
    }
    return this.gitApi;
  }
  toAbsoluteUri(path) {
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) {
      return vscode.Uri.file(path);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, path) : null;
  }
  /**
   * Resolve an edit target's path to a {@link vscode.Uri}. A relative path is
   * resolved against the FIRST workspace folder (R6.5); an absolute path is used
   * as-is. Throws when a relative path cannot be resolved because no workspace
   * folder is open — surfaced by `applyFileEdits` as a per-file failure (R6.6).
   */
  resolveEditUri(path) {
    const uri = this.toAbsoluteUri(path);
    if (!uri) {
      throw new Error(
        `cannot resolve workspace-relative path "${path}" without an open workspace folder`
      );
    }
    return uri;
  }
};
var VSCodeAgentPanelHandle = class {
  constructor(sessionKey, panel) {
    this.sessionKey = sessionKey;
    this.panel = panel;
  }
  reveal() {
    this.panel.reveal();
  }
  postMessage(message) {
    return Promise.resolve(this.panel.webview.postMessage(message));
  }
  onDidReceiveMessage(listener) {
    return this.panel.webview.onDidReceiveMessage(listener);
  }
  onDidDispose(listener) {
    return this.panel.onDidDispose(listener);
  }
  dispose() {
    this.panel.dispose();
  }
};
function renderPanelHtml(webview, extensionUri) {
  const nonce = makeNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.css")
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri.toString()}" />
    <title>rayucode</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
  </body>
</html>`;
}
function makeNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
function errorMessageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function isFileNotFound(error) {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}

// src/test/suite/editApplication.integration.test.ts
function makeMinimalContext() {
  return {
    subscriptions: [],
    extensionUri: vscode2.Uri.file(__dirname)
  };
}
function firstWorkspaceFolder() {
  const folder = vscode2.workspace.workspaceFolders?.[0];
  assert.ok(folder, "integration tests require an open workspace folder");
  return folder;
}
function uriFor(relativePath) {
  return vscode2.Uri.joinPath(firstWorkspaceFolder().uri, relativePath);
}
async function writeOnDisk(relativePath, content) {
  await vscode2.workspace.fs.writeFile(
    uriFor(relativePath),
    Buffer.from(content, "utf8")
  );
}
async function readOnDisk(relativePath) {
  const bytes = await vscode2.workspace.fs.readFile(uriFor(relativePath));
  return Buffer.from(bytes).toString("utf8");
}
async function existsOnDisk(relativePath) {
  try {
    await vscode2.workspace.fs.stat(uriFor(relativePath));
    return true;
  } catch {
    return false;
  }
}
suite("VSCodeAdapter file-edit operations (integration)", () => {
  let adapter;
  let context;
  const createdPaths = /* @__PURE__ */ new Set();
  const track = (relativePath) => {
    createdPaths.add(relativePath);
    return relativePath;
  };
  suiteSetup(() => {
    context = makeMinimalContext();
    adapter = new VSCodeAdapter(context);
  });
  suiteTeardown(async () => {
    await vscode2.commands.executeCommand("workbench.action.closeAllEditors");
    for (const relativePath of createdPaths) {
      try {
        await vscode2.workspace.fs.delete(uriFor(relativePath), {
          useTrash: false
        });
      } catch {
      }
    }
    for (const disposable of context.subscriptions) {
      try {
        disposable.dispose();
      } catch {
      }
    }
  });
  test("modify updates an open editor buffer in place (R6.4)", async () => {
    const rel = track("edit-itest-modify.ts");
    const base = "export const value = 1;\n";
    const updated = "export const value = 42;\n";
    await writeOnDisk(rel, base);
    const document = await vscode2.workspace.openTextDocument(uriFor(rel));
    await vscode2.window.showTextDocument(document);
    assert.equal(document.getText(), base);
    const baseHash = (await adapter.readFileSnapshot(rel))?.contentHash;
    assert.ok(baseHash, "expected a snapshot for the existing file");
    const plan = {
      changes: [
        { path: rel, kind: "modify", baseContentHash: baseHash, newContent: updated }
      ]
    };
    const result = await adapter.applyFileEdits(plan);
    assert.deepEqual(result.applied, [rel]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.conflicts, []);
    assert.equal(document.getText(), updated);
    assert.equal(document.isDirty, true);
  });
  test("create writes a new file at the workspace-relative path (R6.5)", async () => {
    const rel = track("edit-itest-created.ts");
    const content = "export const created = true;\n";
    assert.equal(await existsOnDisk(rel), false);
    const plan = {
      changes: [{ path: rel, kind: "create", newContent: content }]
    };
    const result = await adapter.applyFileEdits(plan);
    assert.deepEqual(result.applied, [rel]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.conflicts, []);
    assert.equal(await existsOnDisk(rel), true);
    assert.equal(await readOnDisk(rel), content);
  });
  test("reports a conflict on a stale base, then applies on override (R6.3)", async () => {
    const rel = track("edit-itest-conflict.ts");
    const original = "version: A\n";
    await writeOnDisk(rel, original);
    const staleHash = (await adapter.readFileSnapshot(rel))?.contentHash;
    assert.ok(staleHash, "expected a snapshot for the existing file");
    const changedOnDisk = "version: B (edited elsewhere)\n";
    await writeOnDisk(rel, changedOnDisk);
    const attempted = "version: C (from the agent)\n";
    const conflicting = {
      changes: [
        { path: rel, kind: "modify", baseContentHash: staleHash, newContent: attempted }
      ]
    };
    const conflictResult = await adapter.applyFileEdits(conflicting);
    assert.deepEqual(conflictResult.conflicts, [{ path: rel }]);
    assert.deepEqual(conflictResult.applied, []);
    assert.deepEqual(conflictResult.failed, []);
    assert.equal(await readOnDisk(rel), changedOnDisk);
    const override = {
      changes: [{ path: rel, kind: "modify", newContent: attempted }]
    };
    const overrideResult = await adapter.applyFileEdits(override);
    assert.deepEqual(overrideResult.applied, [rel]);
    assert.deepEqual(overrideResult.conflicts, []);
    assert.deepEqual(overrideResult.failed, []);
    assert.equal(await readOnDisk(rel), attempted);
  });
  test("isolates a per-file failure and applies the others (R6.6)", async () => {
    const missingRel = track("edit-itest-missing.ts");
    const createRel = track("edit-itest-iso-create.ts");
    const modifyRel = track("edit-itest-iso-modify.ts");
    const modifyBase = "keep = 0\n";
    const modifyNew = "keep = 1\n";
    await writeOnDisk(modifyRel, modifyBase);
    assert.equal(await existsOnDisk(missingRel), false);
    const plan = {
      changes: [
        // Fails: cannot modify a file that does not exist (no base hash, so the
        // conflict check is skipped and opening the document throws).
        { path: missingRel, kind: "modify", newContent: "noop\n" },
        // Succeeds: a brand-new file.
        { path: createRel, kind: "create", newContent: "export const ok = 1;\n" },
        // Succeeds: an existing file modified.
        { path: modifyRel, kind: "modify", newContent: modifyNew }
      ]
    };
    const result = await adapter.applyFileEdits(plan);
    assert.deepEqual(result.applied.sort(), [createRel, modifyRel].sort());
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.path, missingRel);
    assert.ok(
      result.failed[0]?.reason && result.failed[0].reason.length > 0,
      "a failure must carry a non-empty reason"
    );
    assert.equal(await readOnDisk(createRel), "export const ok = 1;\n");
    assert.equal(await readOnDisk(modifyRel), modifyNew);
    assert.equal(await existsOnDisk(missingRel), false);
  });
  test("readFileSnapshot returns content+hash, or null when absent (R6.3)", async () => {
    const rel = track("edit-itest-snapshot.ts");
    const content = "snapshot me\n";
    await writeOnDisk(rel, content);
    const snapshot = await adapter.readFileSnapshot(rel);
    assert.ok(snapshot, "expected a snapshot for the existing file");
    assert.equal(snapshot?.path, rel);
    assert.equal(snapshot?.content, content);
    assert.equal(snapshot?.contentHash, hashContent(content));
    const absent = await adapter.readFileSnapshot("edit-itest-does-not-exist.ts");
    assert.equal(absent, null);
  });
});
//# sourceMappingURL=editApplication.integration.test.js.map
