import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import type { ImageProtocol } from '../ink/imageProtocol.js'

// Target size for the mascot banner. Small enough to keep startup output
// compact; sharp resizes with alpha preserved so transparent backgrounds
// composite correctly against any terminal background color.
export const MASCOT_TARGET_WIDTH_PX = 96

/** Max bytes per base64 chunk for the Kitty protocol's chunked transfer
 *  mode (protocol spec caps this at 4096; must be a multiple of 4). */
const KITTY_CHUNK_SIZE = 4096

export type ResizedMascot = {
  /** Resized PNG bytes. */
  pngBuffer: Buffer
  width: number
  height: number
}

/**
 * Resizes the source PNG to a small terminal-appropriate pixel size,
 * preserving aspect ratio and alpha transparency.
 */
export async function resizeMascotImage(
  sourcePngBuffer: Buffer,
  targetWidthPx: number = MASCOT_TARGET_WIDTH_PX,
): Promise<ResizedMascot> {
  const sharp = await getImageProcessor()
  const sourceMeta = await sharp(sourcePngBuffer).metadata()
  const sourceWidth = sourceMeta.width ?? targetWidthPx
  const sourceHeight = sourceMeta.height ?? targetWidthPx
  const targetHeight = Math.round((targetWidthPx * sourceHeight) / sourceWidth)

  const resizedBuffer = await sharp(sourcePngBuffer)
    .resize(targetWidthPx, targetHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9 })
    .toBuffer()

  const metadata = await sharp(resizedBuffer).metadata()
  return {
    pngBuffer: resizedBuffer,
    width: metadata.width ?? targetWidthPx,
    height: metadata.height ?? targetHeight,
  }
}

/**
 * Encodes a resized PNG as a Kitty Graphics Protocol escape sequence that
 * both transmits and displays the image at the current cursor position
 * (action `a=T`, format `f=100` for PNG data).
 *
 * Payload is base64-encoded and chunked into ≤4096-byte pieces per the
 * protocol's remote-client transmission mode (`m=1` for continuation
 * chunks, `m=0` for the final chunk).
 */
export function encodeKittyImage(png: ResizedMascot): string {
  const base64 = png.pngBuffer.toString('base64')
  const chunks: string[] = []
  for (let i = 0; i < base64.length; i += KITTY_CHUNK_SIZE) {
    chunks.push(base64.slice(i, i + KITTY_CHUNK_SIZE))
  }

  if (chunks.length === 0) return ''

  let out = ''
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0
    const isLast = i === chunks.length - 1
    const metadata = isFirst ? 'a=T,f=100,' : ''
    const more = isLast ? 0 : 1
    out += `\x1b_G${metadata}m=${more};${chunks[i]}\x1b\\`
  }
  return out
}

/**
 * Encodes a resized PNG as an iTerm2 inline-image OSC 1337 sequence
 * (`File=inline=1:<base64>`), sized to `width` character cells with aspect
 * ratio preserved.
 */
export function encodeIterm2Image(
  png: ResizedMascot,
  displayColumns: number,
): string {
  const base64 = png.pngBuffer.toString('base64')
  const args = [
    `width=${displayColumns}`,
    'preserveAspectRatio=1',
    'inline=1',
    `size=${png.pngBuffer.length}`,
  ].join(';')
  return `\x1b]1337;File=${args}:${base64}\x07`
}

/** Encodes the resized image for whichever protocol the terminal supports. */
export function encodeMascotImage(
  png: ResizedMascot,
  protocol: ImageProtocol,
  displayColumns: number,
): string {
  switch (protocol) {
    case 'kitty':
      return encodeKittyImage(png)
    case 'iterm2':
      return encodeIterm2Image(png, displayColumns)
    case 'none':
      return ''
  }
}
