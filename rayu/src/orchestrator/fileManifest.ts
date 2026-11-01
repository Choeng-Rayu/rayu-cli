/**
 * Change detection for a project that is not in a git repository.
 *
 * A manifest maps every project file to a fingerprint (size and modification time), so
 * "did anything change between these two moments" and "which files" can be answered
 * without git. It stands in for gitSnapshot.ts: the baseline, checkpoints, the
 * verifier's before/after comparison and the gate's "has the project changed since the
 * verification" all work on manifests in such a project.
 *
 * It is a heuristic, on purpose cheap: a stat per file, no content is read, so an edit
 * that keeps both the size and the modification time is missed. A scan of 10,000 files
 * takes under 100 ms. Directories that are never project work (`.git`, `node_modules`,
 * build output, caches) are skipped, and a scan over MAX_FILES or MAX_SCAN_MS gives up
 * (null), so a huge directory degrades to "not tracked" instead of stalling the run.
 *
 * Manifests are kept in memory under an id that is a hash of their content. The baseline
 * and the latest checkpoint are pinned; the rest are dropped oldest first.
 */
import { createHash } from 'crypto'
import { lstat, readdir } from 'fs/promises'
import { join } from 'path'

export type Manifest = ReadonlyMap<string, string>

/** Directory names skipped at any depth: dependencies, build output, caches, VCS data. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.gradle',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.venv', 'venv', '.tox', '.idea',
])

export const MAX_MANIFEST_FILES = 150_000
export const MAX_SCAN_MS = 8_000
/** Concurrent lstat calls within one directory. */
const STAT_BATCH = 64
const MAX_REMEMBERED = 24

export type ScanOptions = {
  /** Project-relative paths (directories or files) to leave out, forward slashes. */
  excludePaths?: readonly string[]
  maxFiles?: number
  maxMs?: number
}

function isExcluded(path: string, excluded: readonly string[]): boolean {
  return excluded.some(item => path === item || path.startsWith(`${item}/`))
}

async function fingerprint(path: string): Promise<string | null> {
  try {
    const stats = await lstat(path)
    return `${stats.size}:${Math.round(stats.mtimeMs)}`
  } catch {
    // Removed while scanning: it is simply not there.
    return null
  }
}

/** Scan `root`. Null when the tree is too large or takes too long to scan. */
export async function scanManifest(root: string, options: ScanOptions = {}): Promise<Manifest | null> {
  const excluded = (options.excludePaths ?? []).map(item => item.replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean)
  const maxFiles = options.maxFiles ?? MAX_MANIFEST_FILES
  const deadline = Date.now() + (options.maxMs ?? MAX_SCAN_MS)
  const manifest = new Map<string, string>()
  const pending: string[] = ['']
  while (pending.length > 0) {
    if (Date.now() > deadline) return null
    const relativeDir = pending.pop()!
    let entries
    try {
      entries = await readdir(join(root, relativeDir), { withFileTypes: true })
    } catch {
      continue
    }
    const files: string[] = []
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (isExcluded(relative, excluded)) continue
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(relative)
      } else {
        files.push(relative)
      }
    }
    if (manifest.size + files.length > maxFiles) return null
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const batch = files.slice(i, i + STAT_BATCH)
      const prints = await Promise.all(batch.map(path => fingerprint(join(root, path))))
      batch.forEach((path, index) => {
        const print = prints[index]
        if (print !== null && print !== undefined) manifest.set(path, print)
      })
    }
  }
  return manifest
}

/** A stable id for a manifest: the same files and fingerprints always give the same id. */
export function manifestId(manifest: Manifest): string {
  const hash = createHash('sha1')
  for (const path of [...manifest.keys()].sort()) hash.update(`${path}\0${manifest.get(path)}\n`)
  return `files:${hash.digest('hex')}`
}

/** Paths whose presence or fingerprint differs between two manifests, sorted. */
export function diffManifests(from: Manifest, to: Manifest): string[] {
  const paths = new Set([...from.keys(), ...to.keys()])
  return [...paths].filter(path => from.get(path) !== to.get(path)).sort()
}

const remembered = new Map<string, Manifest>()
const pinned = new Set<string>()

/** Keep `manifest` so it can be compared with later; `pin` exempts it from eviction. */
export function rememberManifest(manifest: Manifest, pin = false): string {
  const id = manifestId(manifest)
  remembered.delete(id)
  remembered.set(id, manifest)
  if (pin) pinned.add(id)
  for (const key of remembered.keys()) {
    if (remembered.size <= MAX_REMEMBERED) break
    if (!pinned.has(key) && key !== id) remembered.delete(key)
  }
  return id
}

export function recallManifest(id: string): Manifest | undefined {
  return remembered.get(id)
}

/** Let a pinned manifest be evicted (a replaced checkpoint, an ended run's baseline). */
export function unpinManifest(id: string): void {
  pinned.delete(id)
}
