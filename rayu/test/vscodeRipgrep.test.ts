/**
 * Ripgrep for the Rayucode engine: where the host finds one (`ripgrepLocation.ts`) and
 * how the build fetches the one a platform VSIX ships (`scripts/fetchRipgrep.ts`).
 *
 * No network: downloads are faked, and the success path uses a local archive pinned for
 * the test.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRipgrep } from '../src/vscode/host/engine/ripgrepLocation.js'
import {
  archiveName,
  archiveUrl,
  fetchRipgrep,
  RIPGREP_PINS,
  verifyArchive,
} from '../scripts/fetchRipgrep.ts'
import { NATIVE_TARGETS } from '../scripts/vscodeTargets.ts'

describe('resolveRipgrep', () => {
  const base = { extensionRoot: '/ext', appRoot: '/app', platform: 'linux' as const, arch: 'x64' }

  test('the copy a platform VSIX ships comes first', () => {
    expect(resolveRipgrep({ ...base, isFile: () => true })).toEqual({ path: '/ext/bin/rg', source: 'bundled' })
  })

  test.each([
    '/app/node_modules/@vscode/ripgrep/bin/rg',
    '/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg',
    '/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/linux-x64/rg',
  ])('then VS Code\'s own ripgrep, wherever this release keeps it: %s', path => {
    expect(resolveRipgrep({ ...base, isFile: p => p === path })).toEqual({ path, source: 'vscode' })
  })

  test('Windows looks for rg.exe', () => {
    const found = resolveRipgrep({
      ...base, extensionRoot: 'C:\\ext', platform: 'win32', isFile: p => p.startsWith('C:') && p.endsWith('rg.exe'),
    })
    expect(found.source).toBe('bundled')
    expect(found.path?.endsWith('rg.exe')).toBe(true)
  })

  test('with neither, the engine keeps its own PATH fallback', () => {
    expect(resolveRipgrep({ ...base, isFile: () => false })).toEqual({ path: null, source: 'system' })
    expect(resolveRipgrep({ ...base, appRoot: undefined, isFile: () => false }).source).toBe('system')
  })
})

describe('fetchRipgrep', () => {
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'rg-fetch-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('every platform target has a pinned archive', () => {
    for (const target of NATIVE_TARGETS) {
      expect(RIPGREP_PINS[target.rgTriple]).toMatch(/^[0-9a-f]{64}$/)
      expect(archiveUrl(target.rgTriple)).toContain(archiveName(target.rgTriple))
    }
    expect(archiveName('x86_64-pc-windows-msvc').endsWith('.zip')).toBe(true)
    expect(archiveName('x86_64-unknown-linux-musl').endsWith('.tar.gz')).toBe(true)
  })

  test('a download that does not match its pin is refused and never cached', async () => {
    const cacheDir = tempDir()
    const target = NATIVE_TARGETS.find(t => t.id === 'linux-x64')!
    await expect(
      fetchRipgrep(target, { cacheDir, download: async () => new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow('checksum mismatch')
    expect(existsSync(join(cacheDir, archiveName(target.rgTriple)))).toBe(false)
  })

  test('verifyArchive rejects a triple with no pin', () => {
    expect(() => verifyArchive('mips-unknown-linux', new Uint8Array())).toThrow('No pinned ripgrep checksum')
  })

  test('a verified archive is cached and its rg extracted as an executable', async () => {
    // A real tar.gz holding an `rg`, pinned for this test only.
    const work = tempDir()
    writeFileSync(join(work, 'rg'), '#!/bin/sh\necho fake\n')
    const archive = join(work, 'fixture.tar.gz')
    expect(Bun.spawnSync(['tar', '-czf', archive, '-C', work, 'rg']).exitCode).toBe(0)
    const bytes = new Uint8Array(readFileSync(archive))
    const triple = 'x86_64-unknown-linux-musl'
    const pins = { [triple]: createHash('sha256').update(bytes).digest('hex') }
    const cacheDir = tempDir()
    let downloads = 0
    const download = async (): Promise<Uint8Array> => {
      downloads++
      return bytes
    }

    const rg = await fetchRipgrep({ rgTriple: triple, exe: '' }, { cacheDir, download, pins })
    expect(readFileSync(rg, 'utf8')).toContain('echo fake')
    expect(statSync(rg).mode & 0o111).not.toBe(0)

    // The second fetch is served from the verified cache.
    await fetchRipgrep({ rgTriple: triple, exe: '' }, { cacheDir, download, pins })
    expect(downloads).toBe(1)
  })

  test('a corrupt cache entry is replaced, not trusted', async () => {
    const work = tempDir()
    writeFileSync(join(work, 'rg'), 'x')
    const archive = join(work, 'fixture.tar.gz')
    Bun.spawnSync(['tar', '-czf', archive, '-C', work, 'rg'])
    const bytes = new Uint8Array(readFileSync(archive))
    const triple = 'x86_64-unknown-linux-musl'
    const pins = { [triple]: createHash('sha256').update(bytes).digest('hex') }
    const cacheDir = tempDir()
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, archiveName(triple)), 'truncated')
    let downloads = 0
    await fetchRipgrep({ rgTriple: triple, exe: '' }, {
      cacheDir, pins, download: async () => { downloads++; return bytes },
    })
    expect(downloads).toBe(1)
  })
})
