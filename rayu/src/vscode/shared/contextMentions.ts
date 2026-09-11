/**
 * Rendering workspace paths as `@`-mentions.
 *
 * In `shared/` because BOTH ends produce them and they must be byte-identical:
 *
 *   the webview  — a drop, or the "Add Context" picker, inserts them at the caret
 *   the host     — the Explorer and editor context-menu commands push them into the composer
 *
 * The host route exists because a drop CANNOT reach this panel from the Explorer: Rayucode
 * contributes its own activity-bar container, so the Explorer and the chat are never visible
 * at the same time. A second, subtly different mention format on that route would be a bug
 * the user experiences as "the menu command doesn't work like dragging".
 *
 * Dependency-free, so it is safe in the browser bundle and in the 1.6 MB host bundle alike.
 */

/**
 * Render resolved workspace paths as `@`-mentions.
 *
 * The engine expands these itself through `processAtMentionedFiles`, including directories,
 * so this deliberately produces PLAIN TEXT rather than a bespoke attachment structure —
 * there is exactly one implementation of "what an @-mention means" and it is the CLI's.
 *
 * A path containing whitespace is left as-is: the shared parser's own token rules decide what
 * terminates a mention, and quoting here would invent a second syntax.
 */
export function formatPathMentions(paths: readonly string[]): string {
  return paths
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => `@${path}`)
    .join(' ')
}

/**
 * Whether a string could be a file reference.
 *
 * Deliberately permissive about SCHEME and strict about SHAPE. Permissive because the resolver
 * on the other side validates and rejects what it cannot stat, so a scheme the workbench
 * introduces later costs one wasted round-trip rather than a silently ignored drop —
 * `vscode-remote://` was exactly that case. Strict because the alternative is worse: a dragged
 * SENTENCE would otherwise be turned into `file:///please refactor this`, an attachment to
 * nothing, which a test caught in the tree-view reader.
 *
 * Bare relative words are therefore excluded. `src/a.ts` cannot be resolved without a base, and
 * a dragged code fragment must keep being inserted as text.
 *
 * Shared because BOTH readers need the identical rule: the webview's `DataTransfer` parser and
 * the drop strip's `TreeDragAndDropController`. Two copies would drift, and the symptom — one
 * drop route accepting what the other rejects — reads as randomness to the user.
 */
export function looksLikeFileReference(value: string): boolean {
  const trimmed = value.trim()
  // `#` starts a comment in the `text/uri-list` format.
  if (!trimmed || trimmed.startsWith('#')) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return true
  // Absolute POSIX path, or a Windows drive path.
  return trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)
}
