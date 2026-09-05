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

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as process from "node:process";

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
import { panelWebviewOptions, renderPanelHtml } from "./webviewHtml.js";

/** The single output channel used for all diagnostic logging (R15.3). */
const OUTPUT_CHANNEL_NAME = "rayucode";

/** Webview view type identifying the Agent_Panel surface (R3.1). */
const AGENT_PANEL_VIEW_TYPE = "rayucode.agentPanel";

/** Setting: opt in to the high-volume Control Protocol trace (R15.3). */
const SETTING_DIAGNOSTIC_LOGGING = "rayucode.diagnosticLogging";

/** Setting: permit edits/reads outside the workspace folders (default false). */
const SETTING_ALLOW_OUTSIDE_WORKSPACE = "rayucode.allowEditsOutsideWorkspace";

/** Human-readable form of the opt-in, used in the per-file failure message. */
const SETTING_ALLOWOUTSIDE_WORKSPACE_LABEL =
  "Rayucode: Allow Edits Outside Workspace";

/**
 * Supplies an {@link AgentPanelHandle} for a session key, or `null` to decline.
 *
 * Registered by the host (see {@link VSCodeAdapter.registerAgentPanelResolver})
 * so a session can be bound to a surface OTHER than the default floating
 * `WebviewPanel` — the Activity Bar `WebviewView` (task: Activity Bar sidebar)
 * and the headless sink backing the `@rayucode` chat participant both plug in
 * this way. Resolvers are consulted in registration order and the first
 * non-`null` result wins; if every resolver declines, the adapter falls back to
 * creating a floating panel, so existing behavior is unchanged (R3.1).
 */
export type AgentPanelResolver = (
  sessionKey: string,
) => Promise<AgentPanelHandle | null> | AgentPanelHandle | null;

/**
 * Observes every host → panel message on its way out, for ANY surface.
 *
 * This is the seam the status bar uses to track agent state (`setGenerating`)
 * without the editor-agnostic core needing to know a status bar exists.
 */
export type PanelMessageObserver = (
  sessionKey: string,
  message: unknown,
) => void;

/**
 * Implements the {@link EditorAdapter} contract using the `vscode` API. Construct
 * once during extension activation with the host-provided
 * {@link vscode.ExtensionContext} and inject it into the core `SessionManager`
 * (the injection wiring itself is task 14.2).
 */
export class VSCodeAdapter implements EditorAdapter {
  private readonly context: vscode.ExtensionContext;
  private readonly outputChannel: vscode.OutputChannel;

  /** Alternate panel surfaces, consulted in registration order (first wins). */
  private readonly panelResolvers: AgentPanelResolver[] = [];

  /** Observers of every outbound host → panel message, for any surface. */
  private readonly panelObservers = new Set<PanelMessageObserver>();

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

  /**
   * Register an alternate panel surface. Resolvers are consulted (in
   * registration order) by {@link showAgentPanel} BEFORE it falls back to
   * creating a floating `WebviewPanel`; the first resolver returning a non-null
   * handle wins.
   */
  registerAgentPanelResolver(resolver: AgentPanelResolver): Disposable {
    this.panelResolvers.push(resolver);
    return {
      dispose: () => {
        const index = this.panelResolvers.indexOf(resolver);
        if (index >= 0) {
          this.panelResolvers.splice(index, 1);
        }
      },
    };
  }

  /**
   * Observe every host → panel message, whichever surface it targets. Used by
   * the status bar to mirror the agent's generating state.
   */
  onPanelMessage(observer: PanelMessageObserver): Disposable {
    this.panelObservers.add(observer);
    return {
      dispose: () => {
        this.panelObservers.delete(observer);
      },
    };
  }

  async showAgentPanel(sessionKey: string): Promise<AgentPanelHandle> {
    // Prefer a registered surface (Activity Bar view / chat sink) when one
    // claims this session key.
    for (const resolver of this.panelResolvers) {
      let handle: AgentPanelHandle | null;
      try {
        handle = await resolver(sessionKey);
      } catch (error) {
        // A misbehaving resolver must never break panel opening; fall through
        // to the next resolver (and ultimately the floating panel).
        this.log(
          "error",
          `Agent panel resolver failed for "${sessionKey}": ${errorMessageOf(error)}`,
        );
        continue;
      }
      if (handle) {
        return this.tapPanel(handle);
      }
    }

    const panel = vscode.window.createWebviewPanel(
      AGENT_PANEL_VIEW_TYPE,
      "rayucode",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        ...panelWebviewOptions(this.context.extensionUri),
        // History lives in the host (R12.2); retaining context avoids tearing
        // down the view when the user tabs away.
        retainContextWhenHidden: true,
      },
    );
    panel.webview.html = renderPanelHtml(panel.webview, this.context.extensionUri);
    return this.tapPanel(new VSCodeAgentPanelHandle(sessionKey, panel));
  }

  /**
   * Wrap a handle so every `postMessage` is also reported to the registered
   * {@link PanelMessageObserver}s. Observation is strictly passive: an observer
   * throwing is swallowed and the message still reaches the panel.
   */
  private tapPanel(handle: AgentPanelHandle): AgentPanelHandle {
    if (this.panelObservers.size === 0 && this.panelResolvers.length === 0) {
      return handle;
    }
    const notify = (message: unknown): void => {
      for (const observer of [...this.panelObservers]) {
        try {
          observer(handle.sessionKey, message);
        } catch {
          /* an observer must never break the panel channel */
        }
      }
    };
    return {
      sessionKey: handle.sessionKey,
      reveal: () => handle.reveal(),
      postMessage: (message) => {
        notify(message);
        return handle.postMessage(message);
      },
      onDidReceiveMessage: (listener) => handle.onDidReceiveMessage(listener),
      onDidDispose: (listener) => handle.onDidDispose(listener),
      dispose: () => handle.dispose(),
    };
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
        // Was this document ALREADY open before we touched it? That decides
        // whether the applied edit is persisted or left as a dirty buffer.
        let wasAlreadyOpen = false;

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
          wasAlreadyOpen = isDocumentOpen(uri);
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
          // R6.4/R6.5 — an approved edit must actually LAND. `applyEdit` on a
          // text document only mutates the in-memory buffer, so a file the user
          // did not already have open would otherwise never reach disk. Persist
          // exactly those documents we opened ourselves; a buffer the user
          // already had open stays dirty so the change remains reviewable and
          // undoable in their editor.
          if (change.kind === "modify" && !wasAlreadyOpen) {
            await this.saveDocument(uri);
          }
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
    // R15.3: `protocol` is the high-volume Control Protocol trace, gated behind
    // the opt-in setting the manifest declares. Without this check the setting
    // did nothing, and every session wrote its full protocol traffic to the
    // channel — noise that also widens the window for a credential echoed by the
    // agent to end up in a copied bug report.
    if (
      channel === "protocol" &&
      !this.getSetting<boolean>(SETTING_DIAGNOSTIC_LOGGING, false)
    ) {
      return;
    }

    // One channel, lines prefixed with the logical channel name.
    //
    // The channel's lifetime is tied to `context.subscriptions`, so it is closed
    // on deactivate. A late log — from a timer or an in-flight promise that
    // outlives teardown — would otherwise throw "Channel has been closed" INTO
    // its caller. A diagnostic sink must never do that, so a failed write is
    // dropped.
    try {
      this.outputChannel.appendLine(`[${channel}] ${message}`);
    } catch {
      /* the channel is gone; there is nowhere left to report this */
    }
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
   * Flush an applied `modify` to disk. Called only for documents the adapter
   * opened itself (see {@link applyFileEdits}); a `false`/throwing save is
   * surfaced as a per-file failure by the caller's catch (R6.6).
   */
  private async saveDocument(uri: vscode.Uri): Promise<void> {
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    if (!document || !document.isDirty) {
      // Nothing buffered to flush (the edit already hit disk).
      return;
    }
    const saved = await document.save();
    if (!saved) {
      throw new Error("the editor could not save the applied edit to disk");
    }
  }

  /**
   * Resolve an edit target's path to a {@link vscode.Uri}, enforcing workspace
   * containment.
   *
   * A relative path is resolved against the FIRST workspace folder (R6.5); an
   * absolute path is used as-is. The resolved uri is then required to lie inside
   * one of the open workspace folders.
   *
   * WHY THIS GUARD EXISTS. `file_path` is chosen by the AGENT, and the agent's
   * output is influenced by whatever it reads — file contents, tool output,
   * fetched web pages — so it must be treated as untrusted. `Uri.joinPath`
   * normalizes `..`, so a relative `../../.bashrc` escapes the workspace, and an
   * absolute path escapes trivially. Under `acceptEdits` or `bypassPermissions`
   * edits are auto-approved with no prompt, which would turn that into a silent
   * arbitrary-file-write primitive (shell profiles, SSH authorized_keys, editor
   * configs) reachable by prompt injection. Confining writes to the workspace
   * keeps the blast radius inside the project the user opened.
   *
   * Users who genuinely need to edit outside the workspace can opt in with
   * `rayucode.allowEditsOutsideWorkspace`.
   *
   * @throws when a relative path cannot be resolved (no workspace folder open),
   *   or when the resolved path escapes the workspace and the opt-in is off.
   *   Both are surfaced by `applyFileEdits` as a per-file failure (R6.6).
   */
  private resolveEditUri(path: string): vscode.Uri {
    const uri = this.toAbsoluteUri(path);
    if (!uri) {
      throw new Error(
        `cannot resolve workspace-relative path "${path}" without an open workspace folder`,
      );
    }
    if (!this.isWithinWorkspace(uri)) {
      throw new Error(
        `refusing to touch "${uri.fsPath}" because it is outside the open workspace folders. ` +
          `Enable "${SETTING_ALLOWOUTSIDE_WORKSPACE_LABEL}" to allow this.`,
      );
    }
    return uri;
  }

  /**
   * Whether `uri` is inside one of the open workspace folders — or, when no
   * folder is open, a document the user themselves opened. The containment
   * opt-out short-circuits both.
   *
   * Every workspace folder is considered, not just the first, so a multi-root
   * workspace behaves correctly. Comparison is done on normalized filesystem
   * paths with a separator-aware prefix test, so a sibling directory whose name
   * merely starts with the root's name (`/work` vs `/work-secrets`) is NOT
   * treated as inside.
   */
  private isWithinWorkspace(uri: vscode.Uri): boolean {
    if (this.getSetting<boolean>(SETTING_ALLOW_OUTSIDE_WORKSPACE, false)) {
      return true;
    }
    // A non-file scheme (untitled:, vscode-remote:, …) has no comparable path.
    if (uri.scheme !== "file") {
      return false;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      // No folder ⇒ no containment boundary from the workspace. Rather than
      // refusing every edit (which would break `code somefile.txt`, a real usage
      // mode), fall back to the narrowest defensible boundary: a file the user
      // demonstrably opened themselves. That still denies the agent an arbitrary
      // path of its own choosing.
      return isDocumentOpen(uri);
    }

    return folders.some(
      (folder) =>
        folder.uri.scheme === "file" &&
        isSamePathOrInside(folder.uri.fsPath, uri.fsPath),
    );
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
// Edit-application helpers (task 12.4)
// ----------------------------------------------------------------------------

/**
 * Whether `target` is `root` itself or lies beneath it, comparing REAL paths.
 *
 * Two normalizations matter here, and both are security-relevant:
 *
 *  1. **Symlinks are dereferenced.** `path.resolve` collapses `.`/`..` but does
 *     NOT follow links, so a symlink committed inside the workspace and pointing
 *     at `$HOME` would otherwise satisfy a purely lexical containment check while
 *     writing outside it. Both sides are passed through `realpath` so the check
 *     is made on the actual filesystem location. The workspace root is resolved
 *     too, because the root itself is often a symlink (`/tmp` → `/private/tmp` on
 *     macOS) and resolving only one side would then reject legitimate files.
 *
 *  2. **Case is folded on case-insensitive filesystems** (Windows, macOS), where
 *     a case-sensitive compare would let `/Work/x` bypass a `/work` root.
 *
 * `path.relative` — rather than a string prefix — keeps `/work-secrets` from
 * counting as inside `/work`.
 */
function isSamePathOrInside(root: string, target: string): boolean {
  const caseInsensitive =
    process.platform === "win32" || process.platform === "darwin";
  const fold = (value: string): string =>
    caseInsensitive ? value.toLowerCase() : value;

  const relative = nodePath.relative(
    fold(realPathOf(root)),
    fold(realPathOf(target)),
  );
  if (relative === "") {
    return true; // the root itself
  }
  return !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

/**
 * The real (symlink-resolved) absolute path of `candidate`.
 *
 * A `create` targets a file that does not exist yet, so `realpath` on it would
 * fail. We therefore resolve the deepest EXISTING ancestor and re-append the
 * remaining segments — which is sufficient, because a link can only be traversed
 * through a path component that exists. If nothing resolves (a permission error,
 * a vanished parent), we fall back to the lexically resolved path: that is the
 * pre-existing behavior and still rejects plain `..`/absolute escapes.
 */
function realPathOf(candidate: string): string {
  const absolute = nodePath.resolve(candidate);
  let head = absolute;
  const trailing: string[] = [];

  for (;;) {
    try {
      return nodePath.join(nodeFs.realpathSync(head), ...trailing);
    } catch {
      const parent = nodePath.dirname(head);
      if (parent === head) {
        // Reached the filesystem root without resolving anything.
        return absolute;
      }
      trailing.unshift(nodePath.basename(head));
      head = parent;
    }
  }
}

/** Extract a human-readable message from an unknown thrown value (R6.6). */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether VS Code ALREADY has a text document open for `uri`. Distinguishes a
 * buffer the user is working in (leave the applied edit dirty and reviewable,
 * R6.4) from a file only the adapter touched (persist it, so an approved edit
 * genuinely lands on disk).
 */
function isDocumentOpen(uri: vscode.Uri): boolean {
  const target = uri.toString();
  return vscode.workspace.textDocuments.some(
    (document) => document.uri.toString() === target,
  );
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
