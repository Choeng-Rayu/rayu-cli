import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { getImageProtocol } from '../ink/imageProtocol.js'
import {
  hashSourceBuffer,
  readMascotCache,
  writeMascotCache,
} from './mascotCache.js'
import {
  encodeMascotImage,
  resizeMascotImage,
} from './mascotImageEncoder.js'
import { renderUnicodeBlockArt } from './mascotUnicodeRenderer.js'

/** Character-cell width used for both the Unicode fallback and the display
 *  width hint passed to the iTerm2 protocol (Kitty sizes itself from the
 *  PNG's own pixel dimensions, so this only matters for iTerm2/Unicode).
 *  Kept small so the banner reads as a compact mascot, not a large image. */
const MASCOT_DISPLAY_COLUMNS = 16

export type MascotId = 'goose'

const MASCOT_ASSET_PATHS: Record<MascotId, string> = {
  goose: fileURLToPath(new URL('../../assets/goose.png', import.meta.url)),
}

export type RenderedMascot = {
  /** Ready-to-write terminal output: either raw image-protocol escape
   *  sequences, or ANSI-colored Unicode block-art lines joined with \n. */
  output: string
  /** Whether a real inline image was used ('kitty'/'iterm2') or the
   *  Unicode block-art fallback ('none'). */
  usedProtocol: 'kitty' | 'iterm2' | 'none'
}

let sourceBufferCache: Buffer | null = null
async function loadSourceImage(mascotId: MascotId): Promise<Buffer> {
  if (sourceBufferCache) return sourceBufferCache
  sourceBufferCache = await readFile(MASCOT_ASSET_PATHS[mascotId])
  return sourceBufferCache
}

/**
 * Produces the final, ready-to-print mascot banner: detects the terminal's
 * inline-image capability once, resizes/encodes the source asset via the
 * best available path (Kitty Graphics Protocol → iTerm2 inline images →
 * Unicode block-art), and caches the result on disk so repeat launches
 * skip reprocessing.
 *
 * Callers are responsible for printing `output` to stdout exactly once —
 * this module has no knowledge of React/Ink render cycles and does not
 * memoize *within* a session beyond the module-level source-buffer cache.
 */
export async function renderMascotBanner(
  mascotId: MascotId = 'goose',
): Promise<RenderedMascot> {
  const protocol = getImageProtocol()
  const sourceBuffer = await loadSourceImage(mascotId)
  const sourceHash = hashSourceBuffer(sourceBuffer)
  const targetSize =
    protocol === 'none' ? MASCOT_DISPLAY_COLUMNS : MASCOT_DISPLAY_COLUMNS * 8 // approx px-per-cell for image protocols

  const cached = await readMascotCache(
    { mascotId, protocol, targetSize },
    sourceHash,
  )
  if (cached !== null) {
    return { output: cached, usedProtocol: protocol }
  }

  let output: string
  if (protocol === 'none') {
    const art = await renderUnicodeBlockArt(sourceBuffer, MASCOT_DISPLAY_COLUMNS)
    output = art.lines.join('\n')
  } else {
    const resized = await resizeMascotImage(sourceBuffer)
    output = encodeMascotImage(resized, protocol, MASCOT_DISPLAY_COLUMNS)
  }

  await writeMascotCache({ mascotId, protocol, targetSize }, sourceHash, output)
  return { output, usedProtocol: protocol }
}
