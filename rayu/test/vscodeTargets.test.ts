/**
 * scripts/vscodeTargets.ts — the platform table and `--target` parsing for the VSIX build.
 */
import { describe, expect, test } from 'bun:test'

import {
  engineBinaryName,
  NATIVE_TARGETS,
  parseTargetArgs,
} from '../scripts/vscodeTargets.ts'

const ids = (plan: ReturnType<typeof parseTargetArgs>): string[] => plan.targets.map(t => t.id)

describe('parseTargetArgs', () => {
  test('no --target builds the universal VSIX alone, as build:vscode always has', () => {
    expect(parseTargetArgs([])).toEqual({ universal: true, targets: [] })
  })

  test('targets are repeatable and comma-separated, without duplicates', () => {
    const plan = parseTargetArgs(['--target', 'linux-x64', '--target=darwin-arm64,linux-x64'])
    expect(plan.universal).toBe(false)
    expect(ids(plan)).toEqual(['linux-x64', 'darwin-arm64'])
  })

  test('all is every platform plus universal', () => {
    const plan = parseTargetArgs(['--target', 'all'])
    expect(plan.universal).toBe(true)
    expect(ids(plan)).toEqual(NATIVE_TARGETS.map(t => t.id))
  })

  test('universal can be named alongside platforms', () => {
    const plan = parseTargetArgs(['--target', 'universal,win32-x64'])
    expect(plan.universal).toBe(true)
    expect(ids(plan)).toEqual(['win32-x64'])
  })

  test('an unknown target fails instead of being skipped', () => {
    expect(() => parseTargetArgs(['--target', 'linux-x86'])).toThrow('Unknown --target "linux-x86"')
    expect(() => parseTargetArgs(['--target'])).toThrow('--target needs a value')
  })
})

describe('NATIVE_TARGETS', () => {
  test('covers the agreed platforms, each with a Bun and a ripgrep target', () => {
    expect(NATIVE_TARGETS.map(t => t.id)).toEqual([
      'linux-x64', 'linux-arm64', 'alpine-x64', 'alpine-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64',
    ])
    for (const target of NATIVE_TARGETS) {
      expect(target.bunTarget.startsWith('bun-')).toBe(true)
      expect(target.rgTriple.length).toBeGreaterThan(0)
    }
  })

  test('x64 uses the baseline runtime and Alpine uses musl', () => {
    for (const target of NATIVE_TARGETS) {
      if (target.id.endsWith('-x64')) expect(target.bunTarget).toContain('baseline')
      if (target.id.startsWith('alpine-')) expect(target.bunTarget).toContain('musl')
    }
  })

  test('only Windows has an .exe', () => {
    for (const target of NATIVE_TARGETS) {
      expect(engineBinaryName(target)).toBe(
        target.id.startsWith('win32') ? 'bin/rayucode-engine.exe' : 'bin/rayucode-engine',
      )
    }
  })
})
