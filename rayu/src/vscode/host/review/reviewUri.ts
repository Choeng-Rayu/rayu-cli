/**
 * URI strings for the per-session pre-edit virtual documents.
 *
 * ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────────
 *
 * `fileChangeReview.ts` serves a diff's LEFT-HAND side from a virtual document under
 * the `rayucode-pre-edit` scheme. Before per-session surfaces, that document was
 * identified by its display path ALONE, so two conversations that edited the SAME
 * file produced the SAME URI. The second session's recorded hunks overwrote the
 * first's in the store, and a diff opened from one tab could reconstruct "before"
 * content from the other conversation's edit. Keying the document by
 * `(sessionKey, displayPath)` removes the collision.
 *
 * ── PURE BY CONSTRUCTION ───────────────────────────────────────────────────────
 *
 * This module must NOT import `vscode`: it is built from string operations so it can
 * be unit-tested under `bun test`, exactly as `sessionRegistry.ts` is. The
 * `vscode.Uri` value is produced only at the edge (`fileChangeReview.ts`), which
 * parses the string this module builds.
 *
 * Format:
 *
 *   rayucode-pre-edit:<sessionKey>/<encodeURIComponent(basename)>?<displayPath>
 *
 * The path segment carries the (encoded) basename purely so a diff tab's title reads
 * naturally. The DISPLAY PATH is carried RAW in the query, matching the previous
 * single-session `preEditUri`: a display path can contain characters that do not
 * survive being a URI path, so it lives in the query where it is recovered verbatim.
 */

/** The scheme the pre-edit virtual documents are served under. */
export const PRE_EDIT_SCHEME = 'rayucode-pre-edit'

/** Build the URI for one session's pre-edit snapshot of one file. */
export function buildPreEditUri(sessionKey: string, displayPath: string): string {
  return `${PRE_EDIT_SCHEME}:${sessionKey}/${encodeURIComponent(basename(displayPath))}?${displayPath}`
}

/**
 * Recover `{ sessionKey, displayPath }` from a URI built by `buildPreEditUri`.
 *
 * Returns null — never throws — for anything that is not a well-formed pre-edit URI,
 * so a stray document request degrades to "no record" rather than an exception in the
 * content provider.
 */
export function parsePreEditUri(
  uri: string,
): { sessionKey: string; displayPath: string } | null {
  const prefix = `${PRE_EDIT_SCHEME}:`
  if (!uri.startsWith(prefix)) return null

  const rest = uri.slice(prefix.length)
  const queryIndex = rest.indexOf('?')
  if (queryIndex === -1) return null

  const pathPart = rest.slice(0, queryIndex)
  const displayPath = rest.slice(queryIndex + 1)
  // The session key is the first path segment; a leading `/` (empty key) is malformed.
  const slashIndex = pathPart.indexOf('/')
  if (slashIndex <= 0) return null
  if (displayPath === '') return null

  return { sessionKey: pathPart.slice(0, slashIndex), displayPath }
}

/**
 * The last path segment, split on either separator.
 *
 * Mirrors `fileChangeReview.ts`'s `basename` so the tab title is unchanged; it is
 * duplicated here only because that module imports `vscode` and this one must not.
 */
function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}
