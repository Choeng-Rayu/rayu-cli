/**
 * Open a proposed agent edit in VS Code's NATIVE diff editor.
 * UI_PARITY.md flow 11.
 *
 * WHY NOT BUILD THIS IN THE WEBVIEW
 * The panel already renders an inline diff (`webview/diff.tsx`), which is the
 * right thing for a glance at a small hunk. It is the wrong thing for a large
 * rewrite: no folding, no syntax highlighting for the file's real language, no
 * "go to next change", and a scroll region competing with the transcript.
 * VS Code ships an editor that does all of that. Reimplementing it inside a
 * webview would be worse and permanently behind.
 *
 * WHY A CONTENT PROVIDER AND NOT A TEMP FILE
 * The proposed content only exists in memory — it is the agent's proposal, not
 * something on disk. Writing it to a temp file to diff it would leave debris on
 * every preview, and a stale temp file is indistinguishable from a real one to
 * anything that scans the workspace. A `TextDocumentContentProvider` under a
 * private scheme keeps it in memory and lets VS Code manage the document's life.
 *
 * The right side is read-only by construction: a custom-scheme document has no
 * save target, so the user cannot accidentally "fix" the proposal in the diff and
 * believe it will be applied. Approval applies the plan the engine proposed, and
 * `previewEdit` reuses the same `buildEditPlan` the approval path uses, so the
 * two cannot disagree.
 */
import * as vscode from "vscode";

/** Private scheme for the proposed (right-hand) side of the diff. */
export const PROPOSED_SCHEME = "rayucode-proposed";

/**
 * Serves the proposed content for a diff.
 *
 * Keyed by the URI's `path`, with content registered immediately before the diff
 * is opened. Entries are dropped when the diff closes, so a long session does not
 * accumulate proposals in memory.
 */
export class ProposedEditContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  /** Register content and return the URI that will serve it. */
  register(key: string, content: string, label: string): vscode.Uri {
    this.contents.set(key, content);
    // The fragment carries a human-readable label for the editor tab; the query
    // is the key so two proposals for the same file remain distinct.
    const uri = vscode.Uri.from({
      scheme: PROPOSED_SCHEME,
      path: `/${label}`,
      query: key,
    });
    this.emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.query) ?? "";
  }

  /** Forget a registered proposal once its diff is no longer open. */
  release(key: string): void {
    this.contents.delete(key);
  }

  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

/** A single proposed change, as `SessionManager.previewEdit` reports it. */
export interface ProposedChange {
  path: string;
  kind: "modify" | "create";
  newContent: string;
}

/**
 * Show the diff for one proposed change.
 *
 * A `create` has no left-hand side, so it opens as a plain document rather than a
 * diff against an empty buffer — diffing every line as an addition tells the user
 * nothing they did not already know from "this file is new".
 */
export async function showProposedDiff(
  provider: ProposedEditContentProvider,
  workspaceRoot: vscode.Uri | undefined,
  requestId: string,
  change: ProposedChange,
  index: number,
): Promise<void> {
  const name = change.path.split("/").pop() ?? change.path;
  const key = `${requestId}:${index}`;
  const proposed = provider.register(key, change.newContent, name);

  if (change.kind === "create") {
    const doc = await vscode.workspace.openTextDocument(proposed);
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }

  // A workspace-relative path is resolved against the workspace, matching how the
  // engine reported it. Without a workspace there is nothing to resolve against,
  // so the proposal is shown on its own rather than diffed against a guess.
  if (!workspaceRoot) {
    const doc = await vscode.workspace.openTextDocument(proposed);
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }

  const original = vscode.Uri.joinPath(workspaceRoot, change.path);
  await vscode.commands.executeCommand(
    "vscode.diff",
    original,
    proposed,
    `${name} — proposed by Rayu`,
    { preview: true },
  );
}
