// Best-effort: extract the first frame of an MP4 as a PNG using ffmpeg, so the
// model can "see" a still from the generated video. Returns null when ffmpeg is
// unavailable or extraction fails — the tool then degrades to a text-only result.
import { execa } from 'execa'
import { readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export async function extractPreviewFrame(
  videoPath: string,
): Promise<{ base64: string; mediaType: string } | null> {
  const out = join(tmpdir(), `rayu-frame-${Date.now()}.png`)
  try {
    await execa(
      'ffmpeg',
      ['-y', '-i', videoPath, '-vf', 'select=eq(n\\,0)', '-vframes', '1', out],
      { timeout: 30_000 },
    )
    const buf = await readFile(out)
    return { base64: buf.toString('base64'), mediaType: 'image/png' }
  } catch {
    return null
  } finally {
    await rm(out, { force: true }).catch(() => {})
  }
}
