/**
 * Turning a drop or a paste into something the engine can use.
 *
 * Extracted from the composer so the interesting decisions are testable without a DOM
 * drag event, which is awkward to fake and easy to fake wrongly.
 *
 * ── WHY `File.path` IS NOT USED ────────────────────────────────────────────────
 *
 * The obvious implementation reads `(file as File & {path?: string}).path` on each dropped
 * file. That property does not exist in a VS Code webview — it is an Electron extension to
 * `File` that is unavailable in the webview's sandboxed context — so the earlier version of
 * this code silently inserted bare FILENAMES like `@app.ts`, which the engine then could
 * not resolve. Worse, it appeared to work for a file that happened to be unique in the
 * workspace root.
 *
 * The path that does work is `text/uri-list`, which VS Code populates for Explorer drags.
 * Resolving those URIs needs the extension host (only it can map a `vscode-remote://`
 * resource to a path, or recognise a directory), so the webview forwards the raw payload
 * and lets the host answer.
 */
import type { ImageInputView } from '../../shared/webviewProtocol.js'

/** The media types the Anthropic API accepts, and therefore the only ones offered. */
const SUPPORTED_IMAGE_TYPES = new Set<ImageInputView['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

export function isSupportedImageType(
  type: string,
): type is ImageInputView['mediaType'] {
  return SUPPORTED_IMAGE_TYPES.has(type as ImageInputView['mediaType'])
}

/**
 * Strip a data-URL wrapper, leaving raw base64.
 *
 * `FileReader.readAsDataURL` returns `data:image/png;base64,AAAA…`, but the API's image
 * block wants only the payload. Doing this once, here, is why `ImageInputView.data` can
 * document itself as raw base64 instead of every consumer having to guess which form it
 * holds.
 */
export function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(',')
  return comma === -1 ? value : value.slice(comma + 1)
}

/**
 * Split a `DataTransfer`'s files into images we can attach and everything else.
 *
 * Non-image files are NOT read into memory — they are referenced by path instead, which is
 * both cheaper and what the user means by dragging a source file into a prompt.
 */
export function partitionDroppedFiles(files: readonly File[]): {
  images: File[]
  others: File[]
} {
  const images: File[] = []
  const others: File[] = []
  for (const file of files) {
    if (isSupportedImageType(file.type)) images.push(file)
    else others.push(file)
  }
  return { images, others }
}

/**
 * Read one image file as an attachment.
 *
 * Rejects rather than resolving a partial value: a half-read image would be rejected by the
 * host's validation anyway, and failing here lets the caller say which file was the problem.
 */
export function readImageAttachment(file: File): Promise<ImageInputView> {
  return new Promise((resolve, reject) => {
    // Captured into a local so the narrowing survives into the async callback below —
    // a property access on `file` is re-widened there because the object is mutable.
    const mediaType = file.type
    if (!isSupportedImageType(mediaType)) {
      reject(new Error(`${file.name || 'That file'} is not a supported image type.`))
      return
    }
    const reader = new FileReader()
    reader.onerror = () =>
      reject(new Error(`${file.name || 'That image'} could not be read.`))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const data = stripDataUrlPrefix(result)
      if (!data) {
        reject(new Error(`${file.name || 'That image'} was empty.`))
        return
      }
      resolve({ name: file.name || undefined, mediaType, data })
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Render resolved workspace paths as `@`-mentions.
 *
 * Re-exported rather than defined here: the HOST produces the same mentions for the Explorer
 * and editor context-menu commands, and two implementations of the format would drift. See
 * `shared/contextMentions.ts` for why that route exists at all.
 */
export { formatPathMentions } from '../../shared/contextMentions.js'

/**
 * The text a single edit inserted, and where.
 *
 * Used to catch a file path that ARRIVED as text rather than as a drop payload. That is the
 * normal outcome in two cases:
 *
 *   - Chromium's default action for a drop onto a `<textarea>` is to insert the dragged text at
 *     the caret. When VS Code does not take the drag away, a dropped file therefore appears as
 *     a plain path in the composer.
 *   - A middle-click paste on X11, and any other route that bypasses the `paste` event.
 *
 * This is exactly how the CLI works — a terminal converts a drag into pasted text and
 * `shared/pastedPaths.ts` recovers the file — so recognising it here makes the two surfaces
 * behave the same way for the same gesture.
 *
 * Computed by common prefix and suffix rather than from a selection range, because the range is
 * gone by the time React reports the change. Returns null when nothing was inserted, so an edit
 * that only DELETES cannot be mistaken for a paste.
 */
export function insertedChunk(
  before: string,
  after: string,
): { start: number; text: string } | null {
  if (after.length <= before.length) return null
  let prefix = 0
  while (prefix < before.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const text = after.slice(prefix, after.length - suffix)
  return text ? { start: prefix, text } : null
}

/**
 * Insert text at a cursor position, padding so it cannot run into adjacent words.
 *
 * Returns the new value and where the caret should land. Pure, so the padding rules are
 * testable — they are the kind of thing that looks right and is off by one.
 */
export function insertAtCursor(
  value: string,
  cursor: number,
  text: string,
): { value: string; cursor: number } {
  const at = Math.max(0, Math.min(cursor, value.length))
  const before = value.slice(0, at)
  const after = value.slice(at)
  const needsSpaceBefore = before.length > 0 && !/\s$/.test(before)
  const needsSpaceAfter = after.length > 0 && !/^\s/.test(after)
  const insertion =
    (needsSpaceBefore ? ' ' : '') + text + (needsSpaceAfter ? ' ' : '')
  return {
    value: before + insertion + after,
    // Caret lands after the inserted text but BEFORE any padding space that was added to
    // separate it from what follows, so continuing to type extends the insertion.
    cursor: at + (needsSpaceBefore ? 1 : 0) + text.length,
  }
}
