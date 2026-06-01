// Decode a generated image and render it as truecolor ANSI half-blocks (each
// character cell = 2 vertical pixels via ▀). The lines are rendered inside the
// Ink transcript via <RawAnsi>, so the preview persists in scrollback instead
// of being clobbered by Ink's next frame redraw.
import { decode as decodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'

const ESC = '\x1b'

export type DecodedImage = { width: number; height: number; data: Uint8Array }

/** Decode JPEG/PNG bytes to RGBA pixels (null on failure). */
export function decodeImage(
  buffer: Buffer,
  mediaType: string,
): DecodedImage | null {
  try {
    if (mediaType === 'image/png') {
      const png = PNG.sync.read(buffer)
      return { width: png.width, height: png.height, data: png.data }
    }
    const img = decodeJpeg(buffer, { useTArray: true, formatAsRGBA: true })
    return { width: img.width, height: img.height, data: img.data }
  } catch {
    return null
  }
}

/**
 * Render decoded RGBA as truecolor ANSI half-block rows (2 px per row).
 * Each returned line is exactly `width` cells wide (reset-terminated).
 */
export function imageToAnsiLines(
  img: DecodedImage,
  maxCols: number,
): { lines: string[]; width: number } {
  const { width: W, height: H, data: D } = img
  const cols = Math.max(1, Math.min(maxCols, W))
  const cellW = W / cols
  const rows = Math.max(1, Math.round(H / cellW / 2))
  const cellH = H / (rows * 2)
  const color = (x: number, y: number): string => {
    const xi = Math.min(W - 1, Math.max(0, Math.floor(x)))
    const yi = Math.min(H - 1, Math.max(0, Math.floor(y)))
    const i = (yi * W + xi) * 4
    return `${D[i]};${D[i + 1]};${D[i + 2]}`
  }
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cellW
      const top = color(x, (2 * r + 0.5) * cellH)
      const bot = color(x, (2 * r + 1.5) * cellH)
      line += `${ESC}[38;2;${top}m${ESC}[48;2;${bot}m▀`
    }
    lines.push(`${line}${ESC}[0m`)
  }
  return { lines, width: cols }
}
