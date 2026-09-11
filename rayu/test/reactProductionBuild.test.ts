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
// scripts/build.ts and scripts/build-vscode.ts both take their define map from
// scripts/bundleConfig.ts, so that is where the guard applies for them. The two
// native/binary builders still construct their own.
const BUILD_SCRIPTS = [
  'scripts/bundleConfig.ts',
  'scripts/build-binaries.ts',
  'scripts/build-native.ts',
]

/** Scripts that must OBTAIN the define map rather than define NODE_ENV inline. */
const SHARED_CONFIG_CONSUMERS = ['scripts/build.ts', 'scripts/build-vscode.ts']

describe('react production build define (heap-OOM regression guard)', () => {
  for (const rel of BUILD_SCRIPTS) {
    test(`${rel} defines NODE_ENV=production`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      expect(src).toContain(
        `'process.env.NODE_ENV': JSON.stringify('production')`,
      )
    })
  }

  for (const rel of SHARED_CONFIG_CONSUMERS) {
    test(`${rel} takes its defines from the shared config`, () => {
      // The CLI bundle and the library bundle must use the SAME define map: rayu
      // is built from partial source, and several `require()`d modules only
      // disappear because a define folds a branch to a constant. A bundle that
      // assembled its own map would either miss the NODE_ENV production define
      // (the heap-OOM this file guards) or fail to link at all.
      const src = readFileSync(join(ROOT, rel), 'utf8')
      expect(src).toContain('sharedBuildOptions')
      expect(src).toContain('bundleConfig.ts')
    })
  }
})
