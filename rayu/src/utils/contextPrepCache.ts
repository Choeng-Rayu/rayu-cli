import { createHash } from 'crypto'
import { logForDebugging } from './debug.js'
import type { ReadFileRangeResult } from './readFileInRange.js'

type CacheEntry<T> = {
  value: T
  expiresAt?: number
}

const CONTEXT_PREP_MAX_ENTRIES = 64
const READ_RANGE_MAX_ENTRIES = 128
const SEARCH_MAX_ENTRIES = 64
const SEARCH_TTL_MS = 5_000

const contextPrep = new Map<string, CacheEntry<unknown>>()
const readRanges = new Map<string, CacheEntry<ReadFileRangeResult>>()
const searchResults = new Map<string, CacheEntry<string[]>>()

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`
}

export function stableContextPrepCacheKey(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function setBounded<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  maxEntries: number,
  expiresAt?: number,
): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, { value, expiresAt })
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function getFresh<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

export async function getOrSetContextPrep<T>(
  key: string,
  compute: () => Promise<T>,
  clone: (value: T) => T,
): Promise<T> {
  const cached = getFresh(contextPrep, key) as Promise<T> | undefined
  if (cached) {
    try {
      return clone(await cached)
    } catch (error) {
      contextPrep.delete(key)
      throw error
    }
  }

  const promise = compute()
  setBounded(contextPrep, key, promise, CONTEXT_PREP_MAX_ENTRIES)
  try {
    return clone(await promise)
  } catch (error) {
    contextPrep.delete(key)
    throw error
  }
}

function cloneReadRange(value: ReadFileRangeResult): ReadFileRangeResult {
  return { ...value }
}

export function getCachedReadFileRange(
  key: string,
): ReadFileRangeResult | undefined {
  const cached = getFresh(readRanges, key)
  return cached ? cloneReadRange(cached) : undefined
}

export function setCachedReadFileRange(
  key: string,
  value: ReadFileRangeResult,
): void {
  setBounded(readRanges, key, cloneReadRange(value), READ_RANGE_MAX_ENTRIES)
}

export function getCachedSearchResults(key: string): string[] | undefined {
  const cached = getFresh(searchResults, key)
  return cached ? [...cached] : undefined
}

export function setCachedSearchResults(key: string, value: string[]): void {
  setBounded(
    searchResults,
    key,
    [...value],
    SEARCH_MAX_ENTRIES,
    Date.now() + SEARCH_TTL_MS,
  )
}

export function clearContextPrepCache(reason = 'manual'): void {
  const total = contextPrep.size + readRanges.size + searchResults.size
  contextPrep.clear()
  readRanges.clear()
  searchResults.clear()
  if (total > 0) {
    logForDebugging(
      `[context-cache] cleared ${total} entr${total === 1 ? 'y' : 'ies'} (${reason})`,
    )
  }
}

export function getContextPrepCacheStatsForTesting(): {
  contextPrep: number
  readRanges: number
  searchResults: number
} {
  return {
    contextPrep: contextPrep.size,
    readRanges: readRanges.size,
    searchResults: searchResults.size,
  }
}

export function _resetContextPrepCacheForTesting(): void {
  clearContextPrepCache('test')
}
