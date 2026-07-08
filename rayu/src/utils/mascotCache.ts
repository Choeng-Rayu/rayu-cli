import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import envPaths from 'env-paths'
import { join } from 'path'
import type { ImageProtocol } from '../ink/imageProtocol.js'

// Separate namespace from CACHE_PATHS in cachePaths.ts (which is
// project-scoped, keyed by cwd) — mascot renders are global, not
// per-project, and keyed by protocol/size/source-hash instead.
const paths = envPaths('rayu-cli')
const MASCOT_CACHE_DIR = join(paths.cache, 'mascot')

export type MascotCacheKey = {
  mascotId: string
  protocol: ImageProtocol
  /** Target width used for the render (pixels for image protocols, cells
   *  for the Unicode fallback) — different sizes get different cache
   *  entries. */
  targetSize: number
}

/**
 * Cache entry is versioned by a hash of the source PNG bytes so that
 * regenerating assets/goose.png automatically invalidates old cache
 * entries without needing an explicit cache-clear step.
 */
function cacheFileName(key: MascotCacheKey, sourceHash: string): string {
  const safeMascotId = key.mascotId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${safeMascotId}-${key.protocol}-${key.targetSize}-${sourceHash}.cache`
}

/** Hashes the source image bytes to key cache entries by content. */
export function hashSourceBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16)
}

/**
 * Reads a cached, already-processed mascot render (raw escape-sequence
 * bytes ready to write to stdout) if present. Returns null on any miss or
 * read error — callers should treat this as "not cached" and regenerate.
 */
export async function readMascotCache(
  key: MascotCacheKey,
  sourceHash: string,
): Promise<string | null> {
  try {
    const filePath = join(MASCOT_CACHE_DIR, cacheFileName(key, sourceHash))
    const contents = await readFile(filePath, { encoding: 'utf8' })
    return contents
  } catch {
    return null
  }
}

/**
 * Writes a processed mascot render to the on-disk cache. Best-effort —
 * failures (e.g. read-only filesystem) are swallowed since the cache is
 * purely a startup-time optimization, not correctness-critical.
 */
export async function writeMascotCache(
  key: MascotCacheKey,
  sourceHash: string,
  renderedOutput: string,
): Promise<void> {
  try {
    await mkdir(MASCOT_CACHE_DIR, { recursive: true })
    const filePath = join(MASCOT_CACHE_DIR, cacheFileName(key, sourceHash))
    await writeFile(filePath, renderedOutput, { encoding: 'utf8' })
  } catch {
    // Best-effort cache write; ignore failures.
  }
}
