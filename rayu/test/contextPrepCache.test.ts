import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  _resetContextPrepCacheForTesting,
  getCachedSearchResults,
  getContextPrepCacheStatsForTesting,
  getOrSetContextPrep,
  setCachedSearchResults,
  stableContextPrepCacheKey,
} from '../src/utils/contextPrepCache.ts'
import { readFileInRange } from '../src/utils/readFileInRange.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-context-cache-'))
  _resetContextPrepCacheForTesting()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  _resetContextPrepCacheForTesting()
})

describe('context prep cache', () => {
  test('deduplicates context prep work and returns cloned values', async () => {
    let calls = 0
    const key = stableContextPrepCacheKey({ cwd: dir, model: 'm' })
    const clone = (value: { parts: string[] }) => ({
      parts: [...value.parts],
    })

    const first = await getOrSetContextPrep(
      key,
      async () => {
        calls++
        return { parts: ['system'] }
      },
      clone,
    )
    first.parts.push('mutated')

    const second = await getOrSetContextPrep(
      key,
      async () => {
        calls++
        return { parts: ['wrong'] }
      },
      clone,
    )

    expect(calls).toBe(1)
    expect(second.parts).toEqual(['system'])
    expect(getContextPrepCacheStatsForTesting().contextPrep).toBe(1)
  })

  test('evicts failed context prep work so later calls can recover', async () => {
    let calls = 0
    const key = stableContextPrepCacheKey({ cwd: dir, model: 'recover' })
    const clone = (value: { parts: string[] }) => ({
      parts: [...value.parts],
    })

    await expect(
      getOrSetContextPrep(
        key,
        async () => {
          calls++
          throw new Error('temporary failure')
        },
        clone,
      ),
    ).rejects.toThrow('temporary failure')

    const recovered = await getOrSetContextPrep(
      key,
      async () => {
        calls++
        return { parts: ['ok'] }
      },
      clone,
    )

    expect(calls).toBe(2)
    expect(recovered.parts).toEqual(['ok'])
  })

  test('caches small file range reads by mtime and size', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'first\nsecond\n')

    const first = await readFileInRange(file, 0, undefined, undefined)
    const second = await readFileInRange(file, 0, undefined, undefined)
    expect(first.content).toBe('first\nsecond\n')
    expect(second.content).toBe(first.content)
    expect(getContextPrepCacheStatsForTesting().readRanges).toBe(1)

    writeFileSync(file, 'changed\n')
    const future = new Date(Date.now() + 2_000)
    utimesSync(file, future, future)

    const changed = await readFileInRange(file, 0, undefined, undefined)
    expect(changed.content).toBe('changed\n')
    expect(getContextPrepCacheStatsForTesting().readRanges).toBe(2)
  })

  test('search result cache returns cloned arrays', () => {
    const key = stableContextPrepCacheKey({ type: 'search', q: 'foo' })
    setCachedSearchResults(key, ['a.ts'])

    const first = getCachedSearchResults(key)
    first?.push('b.ts')

    expect(getCachedSearchResults(key)).toEqual(['a.ts'])
    expect(getContextPrepCacheStatsForTesting().searchResults).toBe(1)
  })
})
