import { LRUCache } from 'lru-cache'
import { normalize } from 'path'

export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  // True when this entry was populated by auto-injection (e.g. RAYU.md) and
  // the injected content did not match disk (stripped HTML comments, stripped
  // frontmatter, truncated MEMORY.md). The model has only seen a partial view;
  // Edit/Write must require an explicit Read first. `content` here holds the
  // RAW disk bytes (for getChangedFiles diffing), not what the model saw.
  isPartialView?: boolean
  /**
   * True when the model saw the ENTIRE file, so `content` can be compared
   * byte-for-byte against disk to decide whether an mtime bump was a real
   * change.
   *
   * Edit/Write cannot infer this from `offset === undefined`: FileReadTool.call
   * destructures `{ offset = 1 }`, so EVERY Read-produced entry stores
   * `offset: 1` even when the model passed no offset at all. That made the
   * `isFullRead` content-equality bypass in FileEditTool unreachable after a
   * Read, so any mtime bump (formatter, LSP format-on-save, git op, watcher,
   * cloud sync) produced "File has been modified since read … Read it again
   * without offset or limit" — an instruction the model could never satisfy,
   * because the next Read stored `offset: 1` again. Hence an explicit flag,
   * derived from the RAW tool input before that default is applied.
   *
   * Writers that replace the whole file (Edit/Write/Bash/NotebookEdit) leave
   * this unset and signal the same thing via `offset: undefined`; consumers
   * accept either.
   */
  fullRead?: boolean
}

// Default max entries for read file state caches
export const READ_FILE_STATE_CACHE_SIZE = 100

/**
 * True when `state.content` is the WHOLE file as the model saw it, so comparing
 * it against disk is a valid way to decide whether an mtime bump was a real
 * change.
 *
 * Accepts either signal, because the two kinds of writer mark it differently:
 *   - FileReadTool sets `fullRead` explicitly (it always stores a concrete
 *     `offset`, so `offset === undefined` is never true for a Read).
 *   - Whole-file writers (FileEditTool, FileWriteTool, BashTool, NotebookEdit,
 *     attachment injection) store `offset: undefined`.
 *
 * A partial view can never qualify: the model only saw a slice, so equality
 * against the full file is meaningless.
 */
export function isFullViewOfFile(state: FileState | undefined): boolean {
  if (!state || state.isPartialView) return false
  if (state.fullRead === true) return true
  return state.offset === undefined && state.limit === undefined
}

/**
 * Carrier for the force-fresh-read channel. Structurally compatible with
 * ToolUseContext but declared locally so this module stays free of a Tool.ts
 * import (Tool.ts already imports FileStateCache).
 */
type ForceFreshReadCarrier = { forceFreshReadPaths?: Set<string> }

/**
 * Mark `filePath` so the next Read of it bypasses the dedup stub.
 *
 * Called from Edit/Write validation failures that instruct the model to read
 * the file again. Normalizes with the same `normalize()` FileStateCache uses so
 * the key matches regardless of separator style or redundant segments.
 */
export function markForceFreshRead(
  carrier: ForceFreshReadCarrier | undefined,
  filePath: string,
): void {
  carrier?.forceFreshReadPaths?.add(normalize(filePath))
}

/**
 * Consume the force-fresh-read marker for `filePath`, returning whether one was
 * set. One-shot: the Read that services the recovery clears it so normal dedup
 * resumes on subsequent reads.
 */
export function consumeForceFreshRead(
  carrier: ForceFreshReadCarrier | undefined,
  filePath: string,
): boolean {
  const paths = carrier?.forceFreshReadPaths
  if (!paths) return false
  return paths.delete(normalize(filePath))
}

/**
 * The "you must Read this file first" message, worded according to WHY there is
 * no usable cache entry.
 *
 * Three distinct causes used to share one sentence ("File has not been read
 * yet"), which made two of them read as a lie and gave the model no way to pick
 * a different strategy:
 *   - never read       → read it (the original, correct case)
 *   - aged out of LRU  → it WAS read; the entry was evicted, so read it again
 *   - partial view     → it was read, but only a slice / a rewritten injection
 *
 * `retryHint` is the tool-specific tail (Edit wants an exact old_string, Write
 * wants full content), so the shared part stays in one place.
 */
export function readRequiredMessage(
  cache: FileStateCache,
  filePath: string,
  retryHint: string,
): string {
  const state = cache.get(filePath)
  if (state?.isPartialView) {
    return `You have only seen part of this file, so an exact match cannot be verified. Read it again without offset or limit, then ${retryHint}`
  }
  if (cache.wasEverRead(filePath)) {
    return `Your earlier Read of this file has aged out of the read cache (it holds a bounded number of files), so its contents can no longer be verified. Read it again without offset or limit, then ${retryHint}`
  }
  return `File has not been read yet. Read it without offset or limit first, then ${retryHint}`
}
// Default size limit for file state caches (25MB)
// This prevents unbounded memory growth from large file contents
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024

/**
 * A file state cache that normalizes all path keys before access.
 * This ensures consistent cache hits regardless of whether callers pass
 * relative vs absolute paths with redundant segments (e.g. /foo/../bar)
 * or mixed path separators on Windows (/ vs \).
 */
export class FileStateCache {
  private cache: LRUCache<string, FileState>
  /**
   * Every normalized key ever written, retained past LRU eviction.
   *
   * The LRU is bounded (100 entries / 25MB), so in a busy session an entry the
   * model legitimately read gets evicted and Edit/Write then reported "File has
   * not been read yet" — indistinguishable from never having read it, which
   * made the tool look broken and sent the model into a re-read loop. Keeping
   * the keys (paths only, never content) lets the error say "your earlier Read
   * aged out of the cache" instead, which is both true and actionable.
   */
  private everSeen = new Set<string>()

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => Math.max(1, Buffer.byteLength(value.content)),
    })
  }

  get(key: string): FileState | undefined {
    return this.cache.get(normalize(key))
  }

  set(key: string, value: FileState): this {
    const normalized = normalize(key)
    this.cache.set(normalized, value)
    this.everSeen.add(normalized)
    return this
  }

  has(key: string): boolean {
    return this.cache.has(normalize(key))
  }

  /**
   * True when this path was cached at some point this session, even if the entry
   * has since been evicted. Distinguishes "aged out" from "never read".
   */
  wasEverRead(key: string): boolean {
    return this.everSeen.has(normalize(key))
  }

  delete(key: string): boolean {
    return this.cache.delete(normalize(key))
  }

  clear(): void {
    this.cache.clear()
    this.everSeen.clear()
  }

  get size(): number {
    return this.cache.size
  }

  get max(): number {
    return this.cache.max
  }

  get maxSize(): number {
    return this.cache.maxSize
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize
  }

  keys(): Generator<string> {
    return this.cache.keys()
  }

  entries(): Generator<[string, FileState]> {
    return this.cache.entries()
  }

  dump(): ReturnType<LRUCache<string, FileState>['dump']> {
    return this.cache.dump()
  }

  load(entries: ReturnType<LRUCache<string, FileState>['dump']>): void {
    this.cache.load(entries)
    // Keys are already normalized (set() normalizes before insert), so a clone
    // inherits the ever-read history and does not regress to "never read".
    for (const [key] of entries) {
      this.everSeen.add(key)
    }
  }
}

/**
 * Factory function to create a size-limited FileStateCache.
 * Uses LRUCache's built-in size-based eviction to prevent memory bloat.
 * Note: Images are not cached (see FileReadTool) so size limit is mainly
 * for large text files, notebooks, and other editable content.
 */
export function createFileStateCacheWithSizeLimit(
  maxEntries: number,
  maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}

// Helper function to convert cache to object (used by compact.ts)
export function cacheToObject(
  cache: FileStateCache,
): Record<string, FileState> {
  return Object.fromEntries(cache.entries())
}

// Helper function to get all keys from cache (used by several components)
export function cacheKeys(cache: FileStateCache): string[] {
  return Array.from(cache.keys())
}

// Helper function to clone a FileStateCache
// Preserves size limit configuration from the source cache
export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const cloned = createFileStateCacheWithSizeLimit(cache.max, cache.maxSize)
  cloned.load(cache.dump())
  return cloned
}

// Merge two file state caches, with more recent entries (by timestamp) overriding older ones
export function mergeFileStateCaches(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  const merged = cloneFileStateCache(first)
  for (const [filePath, fileState] of second.entries()) {
    const existing = merged.get(filePath)
    // Only override if the new entry is more recent
    if (!existing || fileState.timestamp > existing.timestamp) {
      merged.set(filePath, fileState)
    }
  }
  return merged
}
