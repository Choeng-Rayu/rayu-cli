/**
 * Reading a drop in a VS Code webview.
 *
 * ── WHY THIS IS NOT JUST `getData('text/uri-list')` ────────────────────────────
 *
 * A drop that originates INSIDE VS Code is not a plain browser file drop. `fillEditorsDragData`
 * in the workbench (`vs/workbench/browser/dnd.ts`) writes SEVERAL formats, and the standard
 * one is deliberately incomplete:
 *
 *   text/uri-list                  the web standard — but VS Code puts only the FIRST uri in
 *                                  it, to work around Chromium bug 239745
 *   application/vnd.code.uri-list  `DataTransfers.INTERNAL_URI_LIST`: the FULL list. This is
 *                                  the one to prefer for a multi-file drag
 *   CodeEditors                    a marshalled JSON array of dragged editor inputs, each
 *                                  with a `resource` URI object rather than a string
 *   CodeFiles                      a JSON array of filesystem paths
 *   text/plain                     the fallback an editor-tab drag leaves behind
 *
 * Format names are compared in lower case because `DataTransfer.setData` lower-cases them per
 * spec, so `CodeEditors` is retrievable only as `codeeditors`.
 *
 * ── WHAT THIS CANNOT FIX, AND WHY IT MATTERS HERE ──────────────────────────────
 *
 * A drag only reaches this code if the user holds SHIFT. That is not a guess; it was measured
 * against a real Extension Host by sampling the iframe's inline style mid-drag:
 *
 *   drag an editor tab onto the panel            → iframe `pointer-events: none`, zero events
 *   the same drag with Shift held                → `pointer-events: auto`
 *
 * The mechanism is VS Code's webview preload: on `dragenter` it posts `drag-start` to the
 * workbench unless `e.shiftKey`, and the workbench answers by blanking the iframe's pointer
 * events for the duration of the drag. Its condition is "every item is a file", which an
 * ordinary Explorer or tab drag satisfies because `fillEditorsDragData` attaches a
 * `DownloadURL` that Chromium reports as a file item. So this applies to INTERNAL drags, not
 * only to drags from the operating system.
 *
 * Nothing in this module can defeat that — the preload's `defaultPrevented` escape hatch is
 * checked in a document we do not control. It is why the panel states the Shift requirement
 * in plain words and offers `@`-mentions, the Add Context picker and an Explorer context-menu
 * command, all of which need no gesture at all.
 *
 * Everything here is pure and takes a minimal shape rather than a real `DataTransfer`, so each
 * format can be tested without synthesising a DOM drag event.
 */
import { looksLikeFileReference as sharedLooksLikeFileReference } from '../../shared/contextMentions.js'
import { cleanPastedPath, splitPastedPaths } from '../../shared/pastedPaths.js'

/** The parts of `DataTransfer` this module reads. */
export interface DropDataLike {
  types?: readonly string[]
  getData: (type: string) => string
}

/**
 * Formats that can carry file references, in preference order.
 *
 * VS Code's own full list comes FIRST: `text/uri-list` is truncated to one entry for internal
 * drags, so preferring the standard format would silently drop every file but the first in a
 * multi-select. The standard format is still read — it is the only one an OS drop provides.
 */
const URI_FORMATS = [
  'application/vnd.code.uri-list',
  'text/uri-list',
  'codeeditors',
  'codefiles',
  'resourceurls',
] as const

/** Formats whose presence means a drag is worth reacting to. */
const DROPPABLE_TYPES = [...URI_FORMATS, 'files', 'text/plain'] as const

/** A JSON array, or null when the payload is not one. */
function parseJsonArray(raw: string): unknown[] | null {
  if (!raw.trim().startsWith('[')) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Pull a path or uri out of one entry of a VS Code JSON payload.
 *
 * Entries are not uniformly strings. `CodeFiles` holds plain paths, `ResourceURLs` holds uri
 * strings, and `CodeEditors` holds objects whose `resource` is a MARSHALLED `URI` — an object
 * with `scheme`, `path`, `authority` and a `$mid` tag, not a string. Reconstructing the uri
 * from those fields is what makes an editor-tab drag work in a remote workspace, where
 * `fsPath` is meaningless on the other side.
 */
function referenceFromEntry(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const resource = record.resource ?? record
  if (typeof resource === 'string') return resource
  if (!resource || typeof resource !== 'object') return null
  const uri = resource as Record<string, unknown>
  if (typeof uri.external === 'string') return uri.external
  if (typeof uri.scheme === 'string' && typeof uri.path === 'string') {
    const authority = typeof uri.authority === 'string' ? uri.authority : ''
    return `${uri.scheme}://${authority}${uri.path}`
  }
  // `fsPath` last: it is the local rendering of the path and is wrong for a remote workspace,
  // but it is better than discarding the entry when nothing else is present.
  return typeof uri.fsPath === 'string' ? uri.fsPath : null
}

/**
 * Whether a line could be a file reference.
 *
 * Shared with the drop strip's own reader — see `shared/contextMentions.ts` for the rule and
 * for why both sides must apply the identical one.
 */
const looksLikeFileReference = sharedLooksLikeFileReference

/**
 * Whether a drag carries anything this panel can accept.
 *
 * Used on `dragenter`, where `getData` is unavailable by design — the spec exposes only
 * `types` until the drop, so a website cannot read what is being dragged over it. That means
 * this is the ONLY signal available for deciding whether to show the drop target, and it is
 * why a drag of a text selection inside our own transcript does not light the panel up.
 */
export function hasDroppableTypes(data: DropDataLike | null | undefined): boolean {
  const types = (data?.types ?? []).map(type => type.toLowerCase())
  return types.some(type => (DROPPABLE_TYPES as readonly string[]).includes(type))
}

/**
 * Collect every file reference a drop carries, de-duplicated, order preserved.
 *
 * Returns a newline-separated list in `text/uri-list` form because that is what the host's
 * `resolveContextPaths` already parses — this normalises the several inbound formats onto the
 * one the host understands, rather than teaching the host about each of them.
 */
export function extractUriList(data: DropDataLike | null | undefined): string {
  if (!data) return ''

  const available = new Set((data.types ?? []).map(type => type.toLowerCase()))
  const seen = new Set<string>()
  const found: string[] = []

  function add(candidate: string | null): void {
    const value = candidate?.trim()
    if (!value || !looksLikeFileReference(value) || seen.has(value)) return
    seen.add(value)
    found.push(value)
  }

  for (const format of URI_FORMATS) {
    // `types` is consulted when present so a format that is genuinely absent is not read;
    // some hosts throw or warn on an unknown type. When `types` is missing we simply try.
    if (available.size > 0 && !available.has(format)) continue
    let raw = ''
    try {
      raw = data.getData(format)
    } catch {
      continue
    }
    if (!raw) continue
    const asArray = parseJsonArray(raw)
    if (asArray) {
      for (const entry of asArray) add(referenceFromEntry(entry))
    } else {
      for (const line of raw.split(/\r?\n/)) add(line)
    }
    // ── ONE FORMAT WINS; THE REST ARE NOT MERGED ────────────────────────────────
    //
    // Every format describes the SAME resources, in different notations: `file:///w/a.ts` in
    // the uri lists, `/w/a.ts` in `CodeFiles`, `vscode-remote://…/w/a.ts` reconstructed from
    // `CodeEditors`. Accumulating across them produced three references for one dropped file —
    // reported as "I dropped one file and got three" — because de-duplication compares strings
    // and those three strings differ while naming one path.
    //
    // The list is ordered by preference, so the first format that yields anything is the most
    // complete one available. Stopping there is what makes the count match what was dragged.
    if (found.length > 0) break
  }

  // Last resort. An editor-tab drag can leave only `text/plain`, and it holds the path.
  //
  // Parsed with the same rules the CLI applies (`shared/pastedPaths.ts`): several dragged files arrive on
  // one line separated by spaces, spaces inside a filename are backslash-escaped, and some
  // sources quote the whole path instead. Splitting on newlines alone — which this used to do —
  // turns `/home/u/my\ file.png` into a reference that cannot be resolved, and loses every file
  // but the first of a multi-file drag.
  if (found.length === 0) {
    let plain = ''
    try {
      plain = data.getData('text/plain') || data.getData('text')
    } catch {
      plain = ''
    }
    for (const candidate of splitPastedPaths(plain)) add(cleanPastedPath(candidate))
  }

  return found.join('\n')
}

/**
 * The plain text a drop carries, when it is NOT a file reference.
 *
 * Used for a selection dragged out of an editor, which should be inserted verbatim. Returns
 * empty when the payload looked like paths, so a file drop cannot also paste its own URI into
 * the prompt.
 */
export function extractPlainText(data: DropDataLike | null | undefined): string {
  if (!data) return ''
  if (extractUriList(data)) return ''
  let text = ''
  try {
    text = data.getData('text/plain') || data.getData('text')
  } catch {
    return ''
  }
  return text
}
