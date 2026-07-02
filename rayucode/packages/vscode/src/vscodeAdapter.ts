// VSCodeAdapter — the concrete EditorAdapter for VS Code (R13.2).
//
// This is the VS Code-specific Editor_Host. It implements every member of the
// editor-agnostic `EditorAdapter` interface (declared in @rayucode/core) against
// the real `vscode` runtime API. The Core_Integration drives ALL editor
// operations exclusively through this boundary (R13.1, R13.4); the core itself
// never imports `vscode`. esbuild keeps `vscode` external (it is injected by the
// extension host at runtime) and bundles @rayucode/core into the extension.
//
// Scope of THIS file: the full EditorAdapter surface for VS Code —
//   - showAgentPanel        (R3.1)
//   - applyFileEdits        (R6.2, R6.3, R6.4, R6.5, R6.6)  [task 12.4]
//   - readFileSnapshot      (R6.3)                          [task 12.4]
//   - getWorkspaceContext   (R9.1, R9.3, R9.4)
//   - isPathIgnored         (R9.6)
//   - registerCommand       (R14.1, R14.4)
//   - getSecret/storeSecret (R8.4, R13.3)
//   - log                   (R2.6, R15.3)
//   - showActionableMessage (R1.2, R15.1)
//   - getSetting            (R1.1, R9.3, R9.4)
//
// The non-edit members were implemented by task 12.2; the two file-edit members
// (applyFileEdits / readFileSnapshot) are implemented by task 12.4 below.

import * as vscode from "vscode";

import type {
  AgentPanelHandle,
  ApplyResult,
  ContextOptions,
  Disposable,
  EditorAdapter,
  FileEditPlan,
  FileSnapshot,
  WorkspaceContext,
  WorkspaceSelection,
} from "@rayucode/core";
// Value import: the SAME content hash the EditProposalModel uses to capture a
// change's `baseContentHash`. Reusing it here guarantees the conflict-check hash
// and the captured base hash are computed identically, so they line up (R6.3).
import { hashContent } from "@rayucode/core";

import { collectExcludeGlobs, isIgnoredByGlobs } from "./ignoreGlob.js";

/** The single output channel used for all diagnostic logging (R15.3). */
const OUTPUT_CHANNEL_NAME = "rayucode";

/** Webview view type identifying the Agent_Panel surface (R3.1). */
const AGENT_PANEL_VIEW_TYPE = "rayucode.agentPanel";

/**
 * Implements the {@link EditorAdapter} contract using the `vscode` API. Construct
 * once during extension activation with the host-provided
 * {@link vscode.ExtensionContext} and inject it into the core `SessionManager`
 * (the injection wiring itself is task 14.2).
 */
export class VSCodeAdapter implements EditorAdapter {
  private readonly context: vscode.ExtensionContext;
  private readonly outputChannel: vscode.OutputChannel;

  /** Cached resolution of the optional git ignore probe (see below). */
  private gitApi: GitApiLike | null | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    // One shared output channel for the whole extension (R15.3); its lifetime
    // is tied to the extension's.
    this.outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    context.subscriptions.push(this.outputChannel);
  }

  // --------------------------------------------------------------------------
  // Panel surface (R3.1)
  // --------------------------------------------------------------------------

  async showAgentPanel(sessionKey: string): Promise<AgentPanelHandle> {
    const panel = vscode.window.createWebviewPanel(
      AGENT_PANEL_VIEW_TYPE,
      "rayucode",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // History lives in the host (R12.2); retaining context avoids tearing
        // down the view when the user tabs away.
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      },
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
  async applyFileEdits(plan: FileEditPlan): Promise<ApplyResult> {
    const applied: string[] = [];
    const failed: { path: string; reason: string }[] = [];
    const conflicts: { path: string }[] = [];

    for (const change of plan.changes) {
      try {
        // R6.3 — conflict detection runs ONLY when a base hash was captured.
        // The override re-send omits `baseContentHash`, which intentionally
        // skips this branch so the confirmed change applies.
        if (change.baseContentHash !== undefined) {
          const current = await this.readFileSnapshot(change.path);
          if (
            current === null ||
            current.contentHash !== change.baseContentHash
          ) {
            conflicts.push({ path: change.path });
            continue;
          }
        }

        const uri = this.resolveEditUri(change.path);
        const edit = new vscode.WorkspaceEdit();

        if (change.kind === "create") {
          // R6.5 — create at the workspace-relative path. With both flags false,
          // applyEdit cannot succeed if the file already exists, surfacing that
          // as a per-file failure below rather than silently overwriting.
          edit.createFile(uri, {
            overwrite: false,
            ignoreIfExists: false,
            contents: Buffer.from(change.newContent, "utf8"),
          });
        } else {
          // R6.4 — open-buffer-aware modify: openTextDocument yields the live
          // document for an open tab, so replacing its full range updates that
          // editor buffer in place (and otherwise edits the on-disk file).
          const document = await vscode.workspace.openTextDocument(uri);
          const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            document.positionAt(document.getText().length),
          );
          edit.replace(uri, fullRange, change.newContent);
        }

        // R6.6 — one applyEdit per file: an isolated, atomic commit for this
        // file alone. A `false` return means the editor rejected it.
        const ok = await vscode.workspace.applyEdit(edit);
        if (ok) {
          applied.push(change.path);
        } else {
          failed.push({
            path: change.path,
            reason:
              change.kind === "create"
                ? "the editor rejected the edit (the file may already exist)"
                : "the editor rejected the edit",
          });
        }
      } catch (error) {
        // R6.6 — isolate the failure to this file; every other file (already
        // applied or not yet attempted) is left untouched.
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
  async readFileSnapshot(path: string): Promise<FileSnapshot | null> {
    const uri = this.resolveEditUri(path);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      // Byte-faithful utf8 decode; the same hash function the proposal model
      // used to capture the base means a conflict is detected iff the bytes
      // actually changed (R6.3).
      const content = Buffer.from(bytes).toString("utf8");
      return { path, content, contentHash: hashContent(content) };
    } catch (error) {
      // A missing file has no snapshot to compare against — not an error for
      // conflict detection (R6.3). Other I/O errors are real and propagate.
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Workspace context (R9.1, R9.3, R9.4)
  // --------------------------------------------------------------------------

  async getWorkspaceContext(
    options: ContextOptions,
  ): Promise<WorkspaceContext> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    // R9.2: when the root cannot be determined it is reported as null and the
    // core sends the prompt without one.
    const result: WorkspaceContext = {
      workspaceRoot: folder ? folder.uri.fsPath : null,
    };

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      // R9.3: only attach the active file when the caller opted in.
      if (options.includeActiveFile) {
        result.activeFilePath = editor.document.uri.fsPath;
      }
      // R9.4: only attach the selection when opted in AND text is selected.
      if (options.includeSelection && !editor.selection.isEmpty) {
        const sel = editor.selection;
        const selection: WorkspaceSelection = {
          path: editor.document.uri.fsPath,
          text: editor.document.getText(sel),
          // vscode positions are 0-based; surface 1-based lines (what the user
          // sees in the gutter) for the prompt preamble.
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
        };
        result.selection = selection;
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Ignore-aware path checks (R9.6)
  // --------------------------------------------------------------------------

  async isPathIgnored(path: string): Promise<boolean> {
    // Primary mechanism: the workspace ignore configuration, expressed as the
    // `files.exclude` / `search.exclude` glob settings. `asRelativePath`
    // normalizes an absolute path to the workspace-relative, '/'-separated form
    // those globs are written against.
    const relative = vscode.workspace.asRelativePath(path, false);
    const config = vscode.workspace.getConfiguration();
    const globs = collectExcludeGlobs(
      config.get("files.exclude"),
      config.get("search.exclude"),
    );
    if (isIgnoredByGlobs(relative, globs)) {
      return true;
    }

    // Best-effort: also honor git's ignore rules IF the built-in git extension
    // happens to expose an ignore check at runtime. The public `vscode.git` API
    // (v1) does not guarantee `checkIgnore`, so this is feature-detected and
    // fully guarded — when it is unavailable the exclude globs above suffice
    // (R9.6). See `isIgnoredByGit`.
    return this.isIgnoredByGit(path);
  }

  // --------------------------------------------------------------------------
  // Command registration (R14.1, R14.4)
  // --------------------------------------------------------------------------

  registerCommand(
    id: string,
    handler: (...args: unknown[]) => unknown,
  ): Disposable {
    const disposable = vscode.commands.registerCommand(id, handler);
    // Also tie it to the extension lifetime so a missed manual dispose still
    // gets cleaned up on deactivate.
    this.context.subscriptions.push(disposable);
    return disposable;
  }

  // --------------------------------------------------------------------------
  // Secret storage (R8.4, R13.3)
  // --------------------------------------------------------------------------

  getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.context.secrets.get(key));
  }

  storeSecret(key: string, value: string): Promise<void> {
    return Promise.resolve(this.context.secrets.store(key, value));
  }

  // --------------------------------------------------------------------------
  // Diagnostics (R2.6, R15.3)
  // --------------------------------------------------------------------------

  log(channel: "protocol" | "lifecycle" | "error", message: string): void {
    // One channel, lines prefixed with the logical channel name.
    this.outputChannel.appendLine(`[${channel}] ${message}`);
  }

  // --------------------------------------------------------------------------
  // Actionable notifications (R1.2, R15.1)
  // --------------------------------------------------------------------------

  async showActionableMessage(
    level: "info" | "warn" | "error",
    text: string,
    actions: string[],
  ): Promise<string | undefined> {
    switch (level) {
      case "info":
        return vscode.window.showInformationMessage(text, ...actions);
      case "warn":
        return vscode.window.showWarningMessage(text, ...actions);
      case "error":
        return vscode.window.showErrorMessage(text, ...actions);
      default: {
        // Exhaustiveness guard: a new level must be handled explicitly.
        const unexpected: never = level;
        throw new Error(`Unsupported message level: ${String(unexpected)}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Settings access (R1.1, R9.3, R9.4)
  // --------------------------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration().get<T>(key, fallback);
  }

  // --------------------------------------------------------------------------
  // Internals — best-effort git ignore probe
  // --------------------------------------------------------------------------

  private async isIgnoredByGit(path: string): Promise<boolean> {
    try {
      const api = await this.getGitApi();
      if (!api) return false;
      const uri = this.toAbsoluteUri(path);
      if (!uri) return false;
      const repo =
        api.getRepository?.(uri) ??
        api.repositories.find((r) => uri.fsPath.startsWith(r.rootUri.fsPath));
      if (!repo || typeof repo.checkIgnore !== "function") return false;
      const ignored = await repo.checkIgnore([uri.fsPath]);
      return ignored instanceof Set && ignored.size > 0;
    } catch {
      // An optional probe must never break ignore resolution.
      return false;
    }
  }

  private async getGitApi(): Promise<GitApiLike | null> {
    if (this.gitApi !== undefined) return this.gitApi;
    this.gitApi = null;
    try {
      const ext =
        vscode.extensions.getExtension<GitExtensionExportsLike>("vscode.git");
      if (ext) {
        const exports = ext.isActive ? ext.exports : await ext.activate();
        this.gitApi =
          typeof exports?.getAPI === "function" ? exports.getAPI(1) : null;
      }
    } catch {
      this.gitApi = null;
    }
    return this.gitApi;
  }

  private toAbsoluteUri(path: string): vscode.Uri | null {
    // POSIX-absolute ("/x"), Windows-absolute ("C:\x" / "C:/x"), or UNC.
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
  private resolveEditUri(path: string): vscode.Uri {
    const uri = this.toAbsoluteUri(path);
    if (!uri) {
      throw new Error(
        `cannot resolve workspace-relative path "${path}" without an open workspace folder`,
      );
    }
    return uri;
  }
}

// ----------------------------------------------------------------------------
// AgentPanelHandle wrapping a vscode.WebviewPanel
// ----------------------------------------------------------------------------

/**
 * Wraps a {@link vscode.WebviewPanel} as the editor-agnostic
 * {@link AgentPanelHandle} the core drives purely through message passing.
 */
class VSCodeAgentPanelHandle implements AgentPanelHandle {
  readonly sessionKey: string;
  private readonly panel: vscode.WebviewPanel;

  constructor(sessionKey: string, panel: vscode.WebviewPanel) {
    this.sessionKey = sessionKey;
    this.panel = panel;
  }

  reveal(): void {
    this.panel.reveal();
  }

  postMessage(message: unknown): Promise<boolean> {
    // `Thenable<boolean>` → `Promise<boolean>` for the adapter's contract.
    return Promise.resolve(this.panel.webview.postMessage(message));
  }

  onDidReceiveMessage(listener: (message: unknown) => void): Disposable {
    return this.panel.webview.onDidReceiveMessage(listener);
  }

  onDidDispose(listener: () => void): Disposable {
    return this.panel.onDidDispose(listener);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

// ----------------------------------------------------------------------------
// Agent_Panel webview HTML (task 13.1)
// ----------------------------------------------------------------------------

/**
 * Render the Agent_Panel HTML shell. The actual UI is the bundled webview
 * front-end (`dist/webview.js` + `dist/webview.css`, built by esbuild.mjs);
 * this document only loads them under a strict, no-remote-content CSP:
 *
 *   - `default-src 'none'` — nothing loads unless explicitly allowed below.
 *   - `script-src 'nonce-…'` — ONLY the one bundled script bearing this
 *     request's nonce may execute; no inline handlers, no remote scripts.
 *   - `style-src ${cspSource}` — only the host-served stylesheet (no inline
 *     styles, so no 'unsafe-inline').
 *   - `img-src/font-src` — host-served (+ data: images) only.
 *
 * Both asset URIs are produced with {@link vscode.Webview.asWebviewUri} so they
 * resolve through the webview's locked-down resource origin (the panel's
 * `localResourceRoots` is the extension root), and no remote content is ever
 * referenced (R3.1 panel surface; supports the panel's sanitized rendering).
 */
function renderPanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const nonce = makeNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.css"),
  );

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
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

/** Generate a CSP nonce for the bundled webview script (task 13.1). */
function makeNonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

// ----------------------------------------------------------------------------
// Edit-application helpers (task 12.4)
// ----------------------------------------------------------------------------

/** Extract a human-readable message from an unknown thrown value (R6.6). */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `error` signals that a file does not exist. The `vscode` filesystem
 * raises a {@link vscode.FileSystemError} whose `code` is `"FileNotFound"`; a
 * raw Node error would use `ENOENT`. Both are treated as "no snapshot" (R6.3).
 */
function isFileNotFound(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

// ----------------------------------------------------------------------------
// Minimal structural types for the optional built-in git extension API.
//
// We do NOT depend on the git extension's `.d.ts`; these describe only the
// surface the best-effort ignore probe touches, all optional so absence is
// handled by feature detection.
// ----------------------------------------------------------------------------

interface GitRepositoryLike {
  readonly rootUri: vscode.Uri;
  checkIgnore?(paths: string[]): Promise<Set<string>>;
}

interface GitApiLike {
  readonly repositories: GitRepositoryLike[];
  getRepository?(uri: vscode.Uri): GitRepositoryLike | null;
}

interface GitExtensionExportsLike {
  getAPI?(version: 1): GitApiLike;
}
