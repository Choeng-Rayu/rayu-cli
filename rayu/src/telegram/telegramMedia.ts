/**
 * Telegram → terminal media relay.
 *
 * Photos, image documents and static stickers arriving in the linked chat become
 * a normal user turn carrying pasted images, so the terminal transcript shows a
 * clickable `[Image #N]` (UserImageMessage) and the model receives the image
 * blocks. Three things were wrong before and are fixed here:
 *
 *  - Paste id was hard-coded to `0`. `UserImageMessage` renders `[Image #id]`
 *    only when the id is truthy, so `0` printed a bare `[Image]` with no link —
 *    and `imageStore` keys files by id, so every photo overwrote the same file.
 *  - `dimensions` used `{ width, height }`, which is not `ImageDimensions`
 *    (`{ originalWidth, originalHeight, … }`), so the image metadata line the
 *    model receives came out empty.
 *  - Nothing referenced the image in the prompt text, so neither the transcript
 *    nor the model could point at "image #2".
 *
 * Albums (media_group_id) arrive as one update per photo; they are buffered
 * briefly and flushed as a single turn.
 */

import type { PastedContent } from '../utils/config.js'
import type { QueuedCommand } from '../types/textInputTypes.js'

/** One downloaded inbound image, ready to become a PastedContent. */
export interface IncomingImage {
  base64: string
  mediaType: string
  width?: number
  height?: number
  filename?: string
}

/**
 * Paste ids must be unique per process (imageStore writes one file per id) and
 * never `0` (falsy ids suppress the transcript link). Seeded from the clock so
 * ids don't collide with the keyboard paste path, which does the same.
 */
let nextId = Date.now()

export function nextImagePasteId(): number {
  return ++nextId
}

/** Test helper — make ids deterministic. */
export function _setImagePasteIdSeed(seed: number): void {
  nextId = seed
}

const DEFAULT_CAPTION = 'Analyze this image'

/**
 * Build the queued command for one or more inbound images.
 *
 * The `[Image #N]` markers are appended to the text because that is how the
 * keyboard paste path refers to attachments; it keeps the transcript, the
 * stored file and the model's view of the turn consistently numbered.
 */
export function buildImageQueueCommand(
  caption: string,
  images: IncomingImage[],
): QueuedCommand | undefined {
  const usable = images.filter(img => img.base64.length > 0)
  if (usable.length === 0) return undefined

  const pastedContents: Record<number, PastedContent> = {}
  const refs: string[] = []

  for (const image of usable) {
    const id = nextImagePasteId()
    const hasDims = image.width !== undefined && image.height !== undefined
    pastedContents[id] = {
      id,
      type: 'image',
      content: image.base64,
      mediaType: image.mediaType,
      ...(image.filename && { filename: image.filename }),
      ...(hasDims && {
        dimensions: {
          originalWidth: image.width,
          originalHeight: image.height,
        },
      }),
    }
    refs.push(`[Image #${id}]`)
  }

  const head = caption.trim() || DEFAULT_CAPTION
  return {
    value: `${head}\n${refs.join(' ')}`,
    mode: 'prompt',
    pastedContents,
  }
}

// ---------------------------------------------------------------------------
// Album buffering
// ---------------------------------------------------------------------------

interface AlbumBuffer {
  caption: string
  images: IncomingImage[]
  timer: ReturnType<typeof setTimeout>
}

const ALBUMS = new Map<string, AlbumBuffer>()

/**
 * Telegram delivers an album as N separate updates sharing one media_group_id,
 * with the caption on a single item. Wait a moment for the rest so the whole
 * album becomes one turn instead of N.
 */
export const ALBUM_FLUSH_MS = 1200

export function collectAlbumImage(params: {
  groupId: string
  caption: string
  image: IncomingImage
  flushMs?: number
  onFlush: (command: QueuedCommand) => void
}): void {
  const existing = ALBUMS.get(params.groupId)
  if (existing) {
    existing.images.push(params.image)
    // Only one item of an album carries the caption.
    if (!existing.caption && params.caption) existing.caption = params.caption
    clearTimeout(existing.timer)
    existing.timer = setTimeout(
      () => flushAlbum(params.groupId, params.onFlush),
      params.flushMs ?? ALBUM_FLUSH_MS,
    )
    return
  }

  ALBUMS.set(params.groupId, {
    caption: params.caption,
    images: [params.image],
    timer: setTimeout(
      () => flushAlbum(params.groupId, params.onFlush),
      params.flushMs ?? ALBUM_FLUSH_MS,
    ),
  })
}

function flushAlbum(
  groupId: string,
  onFlush: (command: QueuedCommand) => void,
): void {
  const buffer = ALBUMS.get(groupId)
  if (!buffer) return
  ALBUMS.delete(groupId)
  clearTimeout(buffer.timer)
  const command = buildImageQueueCommand(buffer.caption, buffer.images)
  if (command) onFlush(command)
}

/** Test helper — drop pending album buffers. */
export function resetAlbumBuffers(): void {
  for (const buffer of ALBUMS.values()) clearTimeout(buffer.timer)
  ALBUMS.clear()
}

/** Number of albums currently buffered (tests/diagnostics). */
export function pendingAlbumCount(): number {
  return ALBUMS.size
}
