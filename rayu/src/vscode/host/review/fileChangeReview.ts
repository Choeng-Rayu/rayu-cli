/**
 * The Copilot-Edits review surface.
 *
 * ── KEEP AND UNDO GO THROUGH THE ENGINE'S OWN COMMANDS ─────────────────────────
 *
 * `/keep [file]` and `/undo [file]` are what the CLI's review flow uses, and
 * `utils/pendingFileChanges.ts` is the code behind them — including the stale-change
 * protections that refuse to undo a file the user has since edited by hand.
 * Dispatching those as prompts means both surfaces get identical behaviour, and those
 * protections apply here for free.
 *
 * The obvious-looking alternative is the `rewind_files` control request, and it is the
 * WRONG tool: it takes a `user_message_id` and rewinds every change since that
 * message. It is a turn-scoped time machine, not a per-file undo. Wiring a per-file
 * button to it would revert files the user had chosen to keep.
 *
 * ── THE DIFF USES THE RECORDED PRE-EDIT SNAPSHOT, NOT GIT ──────────────────────
 *
 * This is the correctness point of this module. An earlier version built the left-hand
 * side from the `git:` scheme with ref `~`, i.e. the index/HEAD version. That is not
 * the pre-edit file, and treating it as one MISREPORTS the change in three ordinary
 * situations:
 *
 *   - the user had unsaved or uncommitted edits before the turn, which then appear as
 *     though Rayu made them;
 *   - the file is untracked, so there is no git side at all;
 *   - the workspace is not a git repository.
 *
 * The engine already records exactly what it needs: `PendingFileChange.before` is a
 * real snapshot, and the review message carries the `structuredPatch` hunks per file.
 * Those hunks are the source of truth the CLI itself renders (`ReviewDetailDialog` →
 * `DiffDetailView` → `StructuredDiff`), so using them here is reuse rather than a
 * second opinion.
 *
 * The pre-edit content is reconstructed by REVERSE-APPLYING those hunks to the file on
 * disk. That is exact rather than approximate: the engine has already written the
 * post-edit content, and a hunk records both sides of every line it touched.
 */
import * as vscode from 'vscode'

import { reversePatch, type ReviewHunk } from './reversePatch.js'

// Re-exported so consumers have one import site for the review types.
export type { ReviewHunk }

/** Everything the host needs about one changed file. Kept out of the webview. */
export interface ReviewFileRecord {
  filePath: string
  displayPath: string
  changeIds: string[]
  hunks: ReviewHunk[]
  isCreated: boolean
}

/** The scheme the pre-edit virtual documents are served under. */
const PRE_EDIT_SCHEME = 'rayucode-pre-edit'

/**
 * Holds the current working set so a diff request can find its hunks.
 *
 * The webview only needs paths, stats and status; shipping hunks there would be a
 * large `postMessage` for data the browser never renders — the editor draws the diff.
 */
export class ReviewStore implements vscode.TextDocumentContentProvider {
  private readonly byDisplayPath = new Map<string, ReviewFileRecord>()
  private readonly changed = new vscode.EventEmitter<vscode.Uri>()

  readonly onDidChange = this.changed.event

  /** Replace the working set. The engine re-sends the whole summary on every change. */
  replace(files: readonly ReviewFileRecord[]): void {
    this.byDisplayPath.clear()
    for (const f of files) this.byDisplayPath.set(f.displayPath, f)
    // Any open pre-edit document is now stale — the file on disk changed, so the
    // reconstruction would produce a different result.
    for (const f of files) this.changed.fire(preEditUri(f))
  }

  get(displayPath: string): ReviewFileRecord | undefined {
    return this.byDisplayPath.get(displayPath)
  }

  /**
   * Serve the reconstructed pre-edit content.
   *
   * Returns an empty document for a created file: its `before` snapshot is
   * `{exists:false}`, so an empty left side is the honest representation of "this
   * file did not exist".
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const displayPath = uri.query
    const record = this.byDisplayPath.get(displayPath)
    if (!record) throw new Error('This review is no longer available.')
    if (record.isCreated) return ''

    const target = resolveReviewPath(record.displayPath)
    if (!target) throw new Error('The review file could not be located.')

    try {
      const current = await vscode.workspace.fs.readFile(target)
      return reversePatch(Buffer.from(current).toString('utf8'), record.hunks)
    } catch {
      throw new Error('The file changed since this review was recorded. Its original content cannot be reconstructed safely.')
    }
  }

  dispose(): void {
    this.changed.dispose()
    this.byDisplayPath.clear()
  }
}

/** Register the pre-edit provider. Returns the store plus its disposable. */
export function registerReviewStore(): {
  store: ReviewStore
  disposable: vscode.Disposable
} {
  const store = new ReviewStore()
  const disposable = vscode.workspace.registerTextDocumentContentProvider(
    PRE_EDIT_SCHEME,
    store,
  )
  return { store, disposable }
}

function preEditUri(record: Pick<ReviewFileRecord, 'displayPath'>): vscode.Uri {
  // The path segment carries the basename so the diff tab title reads naturally; the
  // query carries the key, because a display path may contain characters that do not
  // survive being a URI path.
  return vscode.Uri.parse(
    `${PRE_EDIT_SCHEME}:${encodeURIComponent(basename(record.displayPath))}?${record.displayPath}`,
  )
}

/**
 * Resolve a path the engine reported into a workspace URI.
 *
 * The engine reports display paths, which may be workspace-relative or absolute.
 * Trying only one form would silently fail for the other.
 */
export function resolveReviewPath(displayPath: string): vscode.Uri | null {
  if (displayPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(displayPath)) {
    return vscode.Uri.file(displayPath)
  }
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return null
  return vscode.Uri.joinPath(folder.uri, displayPath)
}

/** Open a changed file in an editor. */
export async function openReviewFile(displayPath: string): Promise<void> {
  const uri = resolveReviewPath(displayPath)
  if (!uri) {
    void vscode.window.showWarningMessage(
      `Rayu could not locate ${displayPath} in this workspace.`,
    )
    return
  }
  await vscode.window.showTextDocument(uri, { preview: true })
}

/**
 * Show the change as a diff against the RECORDED pre-edit content.
 *
 * Falls back to opening the file when the working set has no record for it — which
 * means the change was already kept or undone, so there is nothing to compare.
 */
export async function openReviewDiff(
  store: ReviewStore,
  displayPath: string,
): Promise<void> {
  const uri = resolveReviewPath(displayPath)
  if (!uri) {
    void vscode.window.showWarningMessage(
      `Rayu could not locate ${displayPath} in this workspace.`,
    )
    return
  }

  const record = store.get(displayPath)
  if (!record) {
    // No recorded change: nothing to diff against. Opening the file is more useful
    // than an empty diff implying nothing changed.
    await vscode.window.showTextDocument(uri, { preview: true })
    return
  }

  await vscode.commands.executeCommand(
    'vscode.diff',
    preEditUri(record),
    uri,
    `${basename(displayPath)} — Rayu changes`,
    { preview: true },
  )
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * Build the slash command for a keep/undo action.
 *
 * Pure so the argument quoting is reviewable in one place: a path with a space would
 * otherwise be parsed as two arguments and silently act on the wrong file, or on
 * everything.
 */
export function reviewCommand(action: 'keep' | 'undo', path?: string): string {
  // Shared CLI semantics differ here: `/keep` keeps every pending file, while
  // `/undo` reverts only the latest edit and requires `/undo all` for the batch.
  if (!path) return action === 'undo' ? '/undo all' : '/keep'
  const needsQuotes = /\s/.test(path)
  return needsQuotes ? `/${action} "${path}"` : `/${action} ${path}`
}
