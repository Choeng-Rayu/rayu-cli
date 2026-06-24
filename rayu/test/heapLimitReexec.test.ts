import { describe, expect, test } from 'bun:test'
import {
  MAX_OLD_SPACE_MB_CAP,
  MIN_USEFUL_OLD_SPACE_MB,
  computeDesiredOldSpaceMB,
  hasMaxOldSpaceFlag,
  shouldReexecForHeap,
} from '../src/utils/heapLimitReexec.js'

const MB = 1024 * 1024
const GB = 1024 * MB

describe('heapLimitReexec — computeDesiredOldSpaceMB', () => {
  test('15GB RAM, ~2.24GB ceiling → capped at 8192', () => {
    // Affected host: total 15160MB, heap_size_limit 2240MiB.
    expect(computeDesiredOldSpaceMB(15160 * MB, 2240 * MB)).toBe(
      MAX_OLD_SPACE_MB_CAP,
    )
  })

  test('4GB RAM → 75% = 3072MB (below cap, above current+margin)', () => {
    expect(computeDesiredOldSpaceMB(4096 * MB, 2240 * MB)).toBe(3072)
  })

  test('2GB RAM → target below MIN_USEFUL → null', () => {
    expect(computeDesiredOldSpaceMB(2048 * MB, 2240 * MB)).toBeNull()
    // sanity: the floor is what rejects it
    expect(Math.floor(2048 * 0.75)).toBeLessThan(MIN_USEFUL_OLD_SPACE_MB)
  })

  test('already-high ceiling → no worthwhile raise → null', () => {
    expect(computeDesiredOldSpaceMB(15160 * MB, 8000 * MB)).toBeNull()
  })

  test('target must beat current by RAISE_MARGIN → null when within margin', () => {
    // 6GB RAM → target 4608MB; current 4500MB → within 256MB margin → null
    expect(computeDesiredOldSpaceMB(6144 * MB, 4500 * MB)).toBeNull()
    // current a bit lower → now worthwhile
    expect(computeDesiredOldSpaceMB(6144 * MB, 4000 * MB)).toBe(4608)
  })

  test('invalid RAM → null', () => {
    expect(computeDesiredOldSpaceMB(0, 2 * GB)).toBeNull()
    expect(computeDesiredOldSpaceMB(Number.NaN, 2 * GB)).toBeNull()
    expect(computeDesiredOldSpaceMB(-1, 2 * GB)).toBeNull()
  })
})

describe('heapLimitReexec — hasMaxOldSpaceFlag', () => {
  test('detects flag in execArgv (both spellings)', () => {
    expect(hasMaxOldSpaceFlag(['--max-old-space-size=4096'], undefined)).toBe(
      true,
    )
    expect(hasMaxOldSpaceFlag(['--max_old_space_size=4096'], undefined)).toBe(
      true,
    )
  })

  test('detects flag in NODE_OPTIONS', () => {
    expect(hasMaxOldSpaceFlag([], '--max-old-space-size=2048')).toBe(true)
    expect(
      hasMaxOldSpaceFlag([], '--enable-source-maps --max_old_space_size=2048'),
    ).toBe(true)
  })

  test('false when no flag present', () => {
    expect(hasMaxOldSpaceFlag([], undefined)).toBe(false)
    expect(hasMaxOldSpaceFlag(['--enable-source-maps'], '--inspect')).toBe(
      false,
    )
  })
})

describe('heapLimitReexec — shouldReexecForHeap', () => {
  const base = {
    sentinelSet: false,
    isBun: false,
    optOut: false,
    hasFlag: false,
    isInteractiveOrRemote: true,
  }

  test('re-execs when all clear and interactive/remote', () => {
    expect(shouldReexecForHeap(base)).toBe(true)
  })

  test('never loops: sentinel set → false', () => {
    expect(shouldReexecForHeap({ ...base, sentinelSet: true })).toBe(false)
  })

  test('skips under Bun (JSC)', () => {
    expect(shouldReexecForHeap({ ...base, isBun: true })).toBe(false)
  })

  test('respects opt-out and existing flag', () => {
    expect(shouldReexecForHeap({ ...base, optOut: true })).toBe(false)
    expect(shouldReexecForHeap({ ...base, hasFlag: true })).toBe(false)
  })

  test('skips non-interactive headless sessions', () => {
    expect(
      shouldReexecForHeap({ ...base, isInteractiveOrRemote: false }),
    ).toBe(false)
  })
})
