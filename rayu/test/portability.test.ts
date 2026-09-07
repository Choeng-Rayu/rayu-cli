/**
 * Portability suite — the Bun leg. RAYU_CORE_MIGRATION_PLAN.md Task 5.
 *
 * The same expectations as packages/rayu-core/test/portability.test.ts, which
 * runs under plain Node via vitest. Together they prove both branches of every
 * `typeof Bun !== 'undefined'` guard behave correctly, which nothing checked
 * before: the CLI only ever ran the Bun branch, and the fallback branch is
 * precisely what the VS Code extension will execute.
 *
 * Imported through rayu's own utils re-exports rather than from core directly, so
 * this also proves the Task 6 re-export shims did not change any behaviour that
 * existing call sites depend on.
 */
import { describe, expect, test } from 'bun:test'
import { djb2Hash, hashContent, hashPair } from '../src/utils/hash.ts'
import { gt, gte, lt, lte, order, satisfies } from '../src/utils/semver.ts'
import { parseYaml } from '../src/utils/yaml.ts'

test('this suite really is running WITH a Bun global', () => {
  // The mirror of the assertion in core's Node leg. If this fails, both legs are
  // testing the same branch and the pair proves nothing.
  expect(typeof Bun).not.toBe('undefined')
})

describe('hash — stability, not cross-runtime equality', () => {
  test('hashContent is stable and distinguishes inputs', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'))
    expect(hashContent('hello')).not.toBe(hashContent('hello '))
    expect(hashContent('')).toBe(hashContent(''))
  })

  test('hashContent on the Bun path is a wyhash decimal, not a sha256 hex', () => {
    // The documented divergence, asserted rather than assumed: Bun.hash returns a
    // number/bigint stringified to decimal digits. Comparing a hash from this
    // runtime with one from Node is therefore meaningless — which is exactly why
    // neither leg asserts equality with the other.
    expect(hashContent('x')).toMatch(/^\d+$/)
    expect(hashContent('x')).not.toMatch(/^[0-9a-f]{64}$/)
  })

  test('hashPair disambiguates without a separator collision', () => {
    // Under Bun this works by seed-chaining wyhash rather than by a separator.
    expect(hashPair('ts', 'code')).not.toBe(hashPair('tsc', 'ode'))
    expect(hashPair('a', 'b')).toBe(hashPair('a', 'b'))
    expect(hashPair('a', 'b')).not.toBe(hashPair('b', 'a'))
  })

  test('djb2Hash is identical on every runtime, so it is safe to persist', () => {
    // The SAME fixed vectors as the Node leg. These two assertions are the only
    // place the two runtimes are required to agree.
    expect(djb2Hash('')).toBe(0)
    expect(djb2Hash('a')).toBe(97)
    expect(djb2Hash('hello')).not.toBe(djb2Hash('world'))
    const big = djb2Hash('x'.repeat(10_000))
    expect(Number.isInteger(big)).toBe(true)
    expect(big).toBeGreaterThanOrEqual(-(2 ** 31))
    expect(big).toBeLessThan(2 ** 31)
  })
})
