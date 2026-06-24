import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'

/**
 * Regression guard for the interactive-session heap OOM root cause.
 *
 * Without `process.env.NODE_ENV = "production"` in the Bun `define` map, the
 * bundler resolves react-reconciler's NODE_ENV conditional to the DEVELOPMENT
 * build, which calls performance.measure() on every commit. Node never clears
 * the User Timing buffer, so a long session accumulates millions of
 * PerformanceMeasure entries and OOMs. These assertions fail loudly if anyone
 * drops the define from a build script.
 */
const ROOT = join(import.meta.dir, '..')
const BUILD_SCRIPTS = [
  'scripts/build.ts',
  'scripts/build-binaries.ts',
  'scripts/build-native.ts',
]

describe('react production build define (heap-OOM regression guard)', () => {
  for (const rel of BUILD_SCRIPTS) {
    test(`${rel} defines NODE_ENV=production`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      expect(src).toContain(
        `'process.env.NODE_ENV': JSON.stringify('production')`,
      )
    })
  }
})
