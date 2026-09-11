/**
 * Recovering file paths from text a drag or a paste left behind.
 *
 * ── THIS MIRRORS HOW THE CLI HANDLES DRAG AND DROP ─────────────────────────────
 *
 * Dragging a file onto a terminal produces no drop event; the terminal emulator PASTES the
 * file's path as text. So everything the CLI does for "drag and drop" is text parsing:
 * `hooks/usePasteHandler.ts` splits the paste and `utils/imagePaste.ts` cleans each candidate.
 *
 * The same thing happens in this panel — Chromium's default action for a drop onto a
 * `<textarea>` is to insert the dragged text, and a path can also arrive by paste — so the rules
 * have to be the same. They are REIMPLEMENTED here rather than imported, deliberately:
 * `utils/imagePaste.ts` reaches `node:crypto`, `node:path`, `execa` and the filesystem, and this
 * is a BROWSER bundle. Importing it is impossible, and editing it to extract the pure half would
 * change CLI code for an editor-only feature.
 *
 * The rules are not obvious and each comes from a real terminal's behaviour:
 *
 *   SPACE-SEPARATED PATHS   Finder and most file managers put several dragged files on one line.
 *                           They cannot be split on every space, because a space inside a
 *                           filename is escaped — so the split looks for a space FOLLOWED by the
 *                           start of an absolute path.
 *   QUOTES                  Some terminals wrap a path containing spaces in quotes instead.
 *   BACKSLASH ESCAPES       Others escape the spaces: `my\ file\ (1).png`.
 *
 * If the CLI's rules change, these must be revisited — `test/vscodePastedPaths.test.ts` documents
 * the shapes both sides are expected to accept.
 */

/**
 * Image extensions the API accepts.
 *
 * Kept in sync with `MIME_BY_EXT` in `BriefTool/upload.ts` — `attachments.ts` sets `isImage` on
 * the wire from this, and remote viewers fetch `/preview` only when that is true. An extension
 * listed here but missing there uploads as octet-stream and shows a broken thumbnail.
 */
export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i

/** Remove one layer of matching outer quotes. */
export function removeOuterQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Whether a path should be read as a Windows path, where `\` is a SEPARATOR and not an escape.
 *
 * Decided from the string rather than from the host platform, so the same function serves a
 * browser bundle that has no `process.platform`, and so a Windows path pasted into a session on
 * another platform — a real case over SSH and in remote workspaces — is not mangled.
 */
function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path)
}

/**
 * Remove shell escape backslashes.
 *
 * A single pass is correct and the placeholder dance an earlier version used is unnecessary:
 * `replace(/\\(.)/g, '$1')` consumes `\\` as one match and yields a single `\`, so a literal
 * backslash in a filename survives without being mistaken for an escape of the character after
 * it. Left to right, `a\\\ b` becomes `a\ b` either way.
 *
 * A Windows path is returned unchanged — its backslashes are the separators.
 */
export function stripBackslashEscapes(path: string): string {
  if (isWindowsPath(path)) return path
  return path.replace(/\\(.)/g, '$1')
}

/** Clean one candidate: strip quotes, then shell escapes. */
export function cleanPastedPath(text: string): string {
  return stripBackslashEscapes(removeOuterQuotes(text.trim()))
}

/** Whether cleaned text names an image file. */
export function isImageFilePath(text: string): boolean {
  return IMAGE_EXTENSION_REGEX.test(cleanPastedPath(text))
}

/** The cleaned path when it names an image, else null. */
export function asImageFilePath(text: string): string | null {
  const cleaned = cleanPastedPath(text)
  return IMAGE_EXTENSION_REGEX.test(cleaned) ? cleaned : null
}

/**
 * Split pasted text into individual path candidates.
 *
 * Splits on a space that PRECEDES the start of an absolute path — `/` on POSIX, `C:\` on
 * Windows — and then on newlines. Splitting on every space would break `my file.png`, which is
 * exactly the case the escaping exists to preserve.
 *
 * Order is kept, because a multi-file drag has a meaningful order to the user.
 */
export function splitPastedPaths(text: string): string[] {
  return text
    .split(/ (?=\/|[A-Za-z]:[\\/])/)
    .flatMap(part => part.split('\n'))
    .map(part => part.trim())
    .filter(Boolean)
}

/**
 * Whether a path is absolute, without `node:path`.
 *
 * A relative candidate is deliberately NOT accepted: it cannot be resolved without knowing the
 * base directory, and guessing the workspace root would silently attach the wrong file.
 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || isWindowsPath(path)
}

/**
 * Whether a raw candidate is ONE path rather than a path followed by words.
 *
 * Checked on the raw text, before cleaning, because that is the only place the evidence still
 * exists: a space that belongs to a filename is either escaped or inside quotes, and cleaning
 * removes exactly those markers. Afterwards `/home/u/my file.png` and
 * `/home/u/a.png and also this` are indistinguishable.
 *
 * Without this, `splitPastedPaths` — which only breaks on a space that PRECEDES another absolute
 * path — hands back `"/home/u/a.png and also this"` as a single candidate, and pasting a
 * sentence that happens to start with a path would silently replace it with an attachment. The
 * CLI never hit that because it only ever asked "is this an image?", and its `\.(png|…)$` anchor
 * rejected the trailing words for it.
 */
function isSinglePathCandidate(raw: string): boolean {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    // Quoted: the quotes delimit the path, so its content may contain anything.
    return trimmed.length > 2
  }
  // Unquoted: every space must be escaped to count as part of the name.
  return !/(^|[^\\]) /.test(trimmed)
}

/**
 * Read pasted text as a list of dropped file paths, or return null when it is prose.
 *
 * Null rather than an empty array so the caller can tell "this was not a path paste" from "this
 * was a path paste that yielded nothing" — the first must be inserted as text, and inserting a
 * dragged path as literal text is the failure this whole module prevents.
 *
 * EVERY candidate must be a single absolute path for the paste to count. One stray word is
 * enough to make the whole thing prose, which is the conservative direction: failing to
 * recognise a drop costs the user one extra step, while misreading their sentence as a drop
 * destroys what they typed.
 */
export function readPastedPaths(text: string): string[] | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const raw = splitPastedPaths(trimmed)
  if (raw.length === 0) return null
  if (!raw.every(isSinglePathCandidate)) return null
  const paths = raw.map(cleanPastedPath)
  return paths.every(isAbsolutePath) ? paths : null
}
