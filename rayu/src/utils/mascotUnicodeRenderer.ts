import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'

/**
 * Converts a PNG image into colored Unicode half-block art for terminals
 * without inline-image protocol support.
 *
 * Technique: sample raw RGBA pixels via sharp, then render each terminal
 * character cell as an upper-half-block (▀) whose foreground color is the
 * top source pixel and background color is the bottom source pixel. This
 * doubles vertical resolution versus one-pixel-per-cell (the standard
 * approach used by chafa/viu/similar terminal image viewers) and reads as
 * a genuine (if blocky) rendering of the source image rather than hand-drawn
 * line art.
 *
 * Transparent pixels (alpha below the threshold) are rendered as a space
 * with no color codes, letting the terminal's own background show through.
 */

const UPPER_HALF_BLOCK = '\u2580' // ▀
const ALPHA_VISIBLE_THRESHOLD = 32 // out of 255; below this, treat as transparent

export type UnicodeBlockArt = {
  /** ANSI-colored lines, one per output row (already includes reset codes). */
  lines: string[]
  /** Character-cell width of the rendered art. */
  widthCells: number
  /** Character-cell height of the rendered art (rows). */
  heightCells: number
}

/**
 * Renders a PNG buffer as Unicode half-block art at approximately
 * `targetWidthCells` character cells wide (height is derived from the
 * source aspect ratio, accounting for the 2:1 pixel-to-cell compression and
 * typical terminal cells being roughly twice as tall as wide).
 */
export async function renderUnicodeBlockArt(
  pngBuffer: Buffer,
  targetWidthCells: number,
): Promise<UnicodeBlockArt> {
  const sharp = await getImageProcessor()
  const metadata = await sharp(pngBuffer).metadata()
  const srcWidth = metadata.width ?? targetWidthCells
  const srcHeight = metadata.height ?? targetWidthCells

  // Terminal cells are roughly 2x taller than wide, and half-blocks pack 2
  // source pixel-rows per output row, so the pixel grid we sample at is
  // targetWidthCells wide by (targetWidthCells * srcHeight/srcWidth) * 2
  // *0.5 tall — the 2x/0.5x cancel, leaving a straightforward aspect-ratio
  // scaled pixel grid sampled at 2 px per output row.
  const sampleWidth = Math.max(1, targetWidthCells)
  const sampleHeight = Math.max(
    2,
    Math.round((sampleWidth * srcHeight) / srcWidth) * 2,
  )
  // Round up to an even number of pixel rows so half-blocks pair cleanly.
  const evenSampleHeight =
    sampleHeight % 2 === 0 ? sampleHeight : sampleHeight + 1

  const sharp2 = await getImageProcessor()
  const { data, info } = await sharp2(pngBuffer)
    .resize(sampleWidth, evenSampleHeight, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const channels = info.channels // 4 (RGBA) after ensureAlpha()
  const width = info.width
  const height = info.height

  const pixelAt = (x: number, y: number): [number, number, number, number] => {
    const idx = (y * width + x) * channels
    return [data[idx]!, data[idx + 1]!, data[idx + 2]!, data[idx + 3]!]
  }

  const lines: string[] = []
  for (let cellY = 0; cellY < height / 2; cellY++) {
    let line = ''
    for (let x = 0; x < width; x++) {
      const [tr, tg, tb, ta] = pixelAt(x, cellY * 2)
      const [br, bg, bb, ba] = pixelAt(x, cellY * 2 + 1)
      const topVisible = ta >= ALPHA_VISIBLE_THRESHOLD
      const bottomVisible = ba >= ALPHA_VISIBLE_THRESHOLD

      if (!topVisible && !bottomVisible) {
        line += ' '
        continue
      }
      if (topVisible && !bottomVisible) {
        // Only top pixel visible: full block in top's color, no background.
        line += `\x1b[38;2;${tr};${tg};${tb}m${UPPER_HALF_BLOCK}\x1b[39m`
        continue
      }
      if (!topVisible && bottomVisible) {
        // Only bottom pixel visible: lower half block in bottom's color.
        line += `\x1b[38;2;${br};${bg};${bb}m\u2584\x1b[39m`
        continue
      }
      // Both visible: half-block with fg=top, bg=bottom.
      line += `\x1b[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m${UPPER_HALF_BLOCK}\x1b[0m`
    }
    lines.push(line)
  }

  return { lines, widthCells: width, heightCells: lines.length }
}
