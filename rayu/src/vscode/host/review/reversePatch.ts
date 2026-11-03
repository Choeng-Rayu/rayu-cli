import { applyPatch, reversePatch as reverseStructuredPatch } from 'diff'

/**
 * Reconstructing pre-edit content from recorded hunks.
 *
 * Deliberately FREE of `vscode` imports. This is the one piece of real logic in the
 * review path, and getting it wrong produces a diff that looks plausible and is wrong —
 * so it has to be testable without stubbing the editor API. Its consumer,
 * `fileChangeReview.ts`, owns the VS Code plumbing.
 *
 * ── WHY RECONSTRUCT AT ALL ─────────────────────────────────────────────────────
 *
 * By the time the review card appears, the engine has already written the post-edit
 * content to disk. The pre-edit content exists in the engine's recorded
 * `PendingFileChange.before` snapshot, but the extension host does not have that — what
 * it receives on the wire is the `structuredPatch` hunks per file.
 *
 * Those hunks are sufficient, and exactly sufficient: a unified-diff hunk records BOTH
 * sides of every line it touched, so reverse-applying them to the file on disk yields
 * the pre-edit content exactly. That is why this is preferable to reading git — git's
 * index/HEAD is a different thing that merely resembles the pre-edit file, and differs
 * whenever the user had unsaved work, the file was untracked, or there is no repository.
 */

/** Mirrors `StructuredPatchHunk` from the `diff` package, which the engine emits. */
export interface ReviewHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Unified-diff lines, each prefixed with ' ', '-', '+' or '\'. */
  lines: string[]
}

/** Reuse the diff package so EOF markers and zero-length hunks retain their meaning. */
export function reversePatch(newContent: string, hunks: readonly ReviewHunk[]): string {
  if (hunks.length === 0) return newContent
  const patch = reverseStructuredPatch({
    oldFileName: 'file', newFileName: 'file',
    hunks: [...hunks].sort((a, b) => a.newStart - b.newStart),
  })
  const previous = applyPatch(newContent, patch, { autoConvertLineEndings: false })
  if (previous === false) throw new Error('The file no longer matches the recorded Rayu changes.')
  return previous
}
