/**
 * `compileBuildOptions` (scripts/bundleConfig.ts) — the options every standalone
 * executable is compiled with: the native CLI binaries and the Rayucode engine.
 *
 * The native builders used to keep their own copy of the options, and the copy lost
 * every RAYU_FEATURES define, which shipped binaries that threw on startup. These
 * checks pin the properties that copy lacked, plus the autoload switches that keep
 * a workspace's bunfig.toml preload out of the compiled process.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  compileBuildOptions,
  EXTERNAL,
  sharedBuildOptions,
} from '../scripts/bundleConfig.ts'
import { ENABLED_FEATURES } from '../scripts/macroValues.ts'

const ROOT = resolve(import.meta.dir, '..')
const ALL_FLAGS: string[] = JSON.parse(
  readFileSync(resolve(ROOT, 'feature-flags.json'), 'utf8'),
)

const options = compileBuildOptions({
  entry: 'src/entrypoints/vscodeHost.ts',
  bunTarget: 'bun-linux-x64-baseline',
  outfile: '/tmp/rayucode-engine',
})
const define = options.define ?? {}
const compile = options.compile as {
  target?: string
  outfile?: string
  autoloadBunfig?: boolean
  autoloadDotenv?: boolean
}

describe('compileBuildOptions', () => {
  test('bakes the build config object that getBakedBuildConfig() reads', () => {
    expect(define.RAYU_BAKED_BUILD_CONFIG).toBeDefined()
    expect(JSON.parse(define.RAYU_BAKED_BUILD_CONFIG as string)).toHaveProperty('VERSION')
  })

  test('defines one RAYU_FEATURES.<flag> literal per known flag', () => {
    const featureKeys = Object.keys(define).filter(k => k.startsWith('RAYU_FEATURES.'))
    expect(featureKeys.length).toBe(ALL_FLAGS.length)
    const enabled = new Set<string>(ENABLED_FEATURES)
    for (const flag of ALL_FLAGS) {
      expect(define[`RAYU_FEATURES.${flag}`]).toBe(enabled.has(flag) ? 'true' : 'false')
    }
  })

  test('keeps the production React define the heap-OOM fix depends on', () => {
    expect(define['process.env.NODE_ENV']).toBe(JSON.stringify('production'))
  })

  test('passes the entry, target and outfile through', () => {
    expect(options.entrypoints).toEqual(['src/entrypoints/vscodeHost.ts'])
    expect(options.target).toBe('bun')
    expect(compile.target).toBe('bun-linux-x64-baseline')
    expect(compile.outfile).toBe('/tmp/rayucode-engine')
  })

  test('keeps the shared externals, features, plugins and loaders', () => {
    const shared = sharedBuildOptions()
    expect(options.external).toEqual(EXTERNAL)
    expect(options.features).toEqual([...ENABLED_FEATURES])
    expect(options.plugins?.map(p => p.name)).toEqual(shared.plugins?.map(p => p.name))
    expect(options.loader).toEqual(shared.loader)
  })

  test('does not read bunfig.toml or .env from the directory the binary starts in', () => {
    expect(compile.autoloadBunfig).toBe(false)
    expect(compile.autoloadDotenv).toBe(false)
  })
})
