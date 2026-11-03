/**
 * Tests for installs created by https://rayucode.com/install.
 *
 * These cover the classification, not the shell script: the script's own
 * end-to-end behaviour is exercised by running it, but the CLI's *reaction* to
 * such an install is what decides whether `rayu update` installs a second copy
 * into npm's prefix and whether `rayu uninstall` reports a false clean. Both are
 * silent-wrong-answer failure modes, so they get unit coverage here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getInstallerCommand,
  getInstallerHomeDir,
  getInstallerManifestPath,
  getInstallerOwnedPaths,
  getInstallerScriptPath,
  getInstallerUninstallCommand,
  isInstallerManagedInstall,
  readInstallerManifest,
} from '../src/utils/installerManifest.ts'
import { detectInstallMethod } from '../src/cli/uninstall/installMethod.ts'
import { buildScopeManifest, isPathInScope } from '../src/cli/uninstall/scopeManifest.ts'
import { getCurrentInstallationType } from '../src/utils/doctorDiagnostic.ts'

const VALID_MANIFEST = {
  installer: 'rayucode.com/install',
  method: 'tarball' as const,
  version: '1.6.13',
  platform: 'linux-x64',
  node: '/usr/bin/node',
  installedAt: '2026-09-01T00:00:00Z',
}

let home: string
let originalRayuHome: string | undefined
let originalArgv1: string | undefined
let originalNodeEnv: string | undefined

/** Lay out a $RAYU_HOME exactly as install.sh does. */
function seedInstall(manifest: Record<string, unknown> | string | null = VALID_MANIFEST): {
  binDir: string
  libDir: string
} {
  const binDir = join(home, 'bin')
  const libDir = join(home, 'lib')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(libDir, 'rayu-1.6.13'), { recursive: true })
  mkdirSync(join(home, 'runtime'), { recursive: true })
  writeFileSync(join(binDir, 'rayu'), '#!/bin/sh\n')
  writeFileSync(join(binDir, '.rayu-installer'), '#!/bin/sh\n')
  writeFileSync(join(libDir, 'rayu-1.6.13', 'rayu.js'), '// bundle\n')
  if (manifest !== null) {
    writeFileSync(
      join(home, 'install.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
    )
  }
  return { binDir, libDir }
}

beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), 'rayu-installer-')), '.rayu')
  mkdirSync(home, { recursive: true })
  originalRayuHome = process.env.RAYU_HOME
  originalArgv1 = process.argv[1]
  originalNodeEnv = process.env.NODE_ENV
  process.env.RAYU_HOME = home
  // NODE_ENV=development short-circuits getCurrentInstallationType().
  delete process.env.NODE_ENV
})

afterEach(() => {
  if (originalRayuHome === undefined) delete process.env.RAYU_HOME
  else process.env.RAYU_HOME = originalRayuHome
  if (originalArgv1 === undefined) process.argv.splice(1, 1)
  else process.argv[1] = originalArgv1
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  rmSync(join(home, '..'), { recursive: true, force: true })
})

describe('installer home resolution', () => {
  test('honours RAYU_HOME', () => {
    expect(getInstallerHomeDir()).toBe(home)
    expect(getInstallerManifestPath()).toBe(join(home, 'install.json'))
  })

  test('falls back to ~/.rayu when RAYU_HOME is unset', () => {
    delete process.env.RAYU_HOME
    expect(getInstallerHomeDir().endsWith('.rayu')).toBe(true)
  })
})

describe('readInstallerManifest', () => {
  test('returns null when install.json is absent', () => {
    expect(readInstallerManifest()).toBeNull()
  })

  test('parses a manifest written by the installer', () => {
    seedInstall()
    const manifest = readInstallerManifest()
    expect(manifest?.method).toBe('tarball')
    expect(manifest?.version).toBe('1.6.13')
  })

  test('returns null on unparseable JSON instead of throwing', () => {
    seedInstall('{ not json')
    expect(readInstallerManifest()).toBeNull()
  })

  test('rejects a file without the installer marker', () => {
    // An unrelated install.json must not be able to convince the CLI that it is
    // installer-managed — that would redirect update and uninstall.
    seedInstall({ version: '9.9.9' })
    expect(readInstallerManifest()).toBeNull()
  })

  test('rejects a non-object payload', () => {
    seedInstall('["rayucode.com/install"]')
    expect(readInstallerManifest()).toBeNull()
  })
})

describe('isInstallerManagedInstall', () => {
  test('true when the running entrypoint lives under $RAYU_HOME', () => {
    const { libDir } = seedInstall()
    process.argv[1] = join(libDir, 'rayu-1.6.13', 'rayu.js')
    expect(isInstallerManagedInstall()).toBe(true)
  })

  test('false when a manifest exists but another copy is running', () => {
    // The npm-global case on a machine that ALSO has an installer copy: the
    // command must act on whichever install is actually executing.
    seedInstall()
    process.argv[1] = '/usr/lib/node_modules/@rayu-dev/rayu-cli/dist/rayu.js'
    expect(isInstallerManagedInstall()).toBe(false)
  })

  test('false when there is no manifest at all', () => {
    process.argv[1] = join(home, 'lib', 'current', 'rayu.js')
    expect(isInstallerManagedInstall()).toBe(false)
  })

  test('is not fooled by a sibling directory with the same prefix', () => {
    seedInstall()
    process.argv[1] = `${home}-evil/lib/rayu.js`
    expect(isInstallerManagedInstall()).toBe(false)
  })
})

describe('getInstallerScriptPath', () => {
  test('finds the local installer copy next to the launcher', () => {
    const { binDir } = seedInstall()
    expect(getInstallerScriptPath()).toBe(join(binDir, '.rayu-installer'))
  })

  test('returns null when the copy is missing', () => {
    seedInstall()
    rmSync(join(home, 'bin', '.rayu-installer'))
    expect(getInstallerScriptPath()).toBeNull()
  })
})

describe('installer command strings', () => {
  test('platform-appropriate install one-liner', () => {
    const command = getInstallerCommand()
    expect(command).toContain('rayucode.com/install')
    expect(command).toContain(process.platform === 'win32' ? 'iex' : 'bash')
  })

  test('uninstall command prefers the local copy', () => {
    seedInstall()
    expect(getInstallerUninstallCommand()).toContain('.rayu-installer')
  })

  test('uninstall command falls back to the hosted one-liner', () => {
    seedInstall()
    rmSync(join(home, 'bin', '.rayu-installer'))
    expect(getInstallerUninstallCommand()).toContain('rayucode.com/install')
  })
})

describe('getInstallerOwnedPaths', () => {
  test('launcher entries are individual files, never a directory', () => {
    const { binDir } = seedInstall()
    const owned = getInstallerOwnedPaths()
    expect(owned.files).toContain(join(binDir, 'rayu'))
    expect(owned.files).toContain(join(binDir, '.rayu-installer'))
    expect(owned.files).toContain(join(home, 'install.json'))
    // binDir itself must never be removable: --dir can point at ~/bin.
    expect(owned.directories).not.toContain(binDir)
  })

  test('recursive entries are confined to $RAYU_HOME', () => {
    seedInstall()
    const owned = getInstallerOwnedPaths()
    expect(owned.directories).toEqual([join(home, 'lib'), join(home, 'runtime')])
  })

  test('a hand-edited binDir cannot redirect a recursive delete', () => {
    seedInstall({ ...VALID_MANIFEST, binDir: '/' })
    const owned = getInstallerOwnedPaths()
    expect(owned.directories).toEqual([join(home, 'lib'), join(home, 'runtime')])
    expect(owned.files.every(p => p !== '/')).toBe(true)
  })
})

describe('uninstall classification', () => {
  test('detectInstallMethod reports installer and can remove it itself', async () => {
    const { libDir } = seedInstall()
    process.argv[1] = join(libDir, 'rayu-1.6.13', 'rayu.js')
    const info = await detectInstallMethod()
    expect(info.method).toBe('installer')
    expect(info.selfRemovable).toBe(true)
    // A manualCommand would make `rayu uninstall` print "Run this to finish"
    // after a successful removal.
    expect(info.manualCommand).toBeUndefined()
    expect(info.reason).toContain('rayucode.com/install')
  })

  test('scope manifest covers the launcher, bundles, and private runtime', () => {
    const { binDir } = seedInstall()
    const manifest = buildScopeManifest('installer')
    const paths = manifest.map(a => a.path)
    expect(paths).toContain(join(binDir, 'rayu'))
    expect(paths).toContain(join(home, 'lib'))
    expect(paths).toContain(join(home, 'runtime'))
    // Everything the manifest lists must pass the pre-delete allowlist.
    for (const artifact of manifest) {
      expect(isPathInScope(artifact.path, manifest)).toBe(true)
    }
  })

  test('scope manifest still refuses paths outside it', () => {
    seedInstall()
    const manifest = buildScopeManifest('installer')
    expect(isPathInScope('/', manifest)).toBe(false)
    expect(isPathInScope('/usr', manifest)).toBe(false)
    expect(isPathInScope(`${home}-evil/lib`, manifest)).toBe(false)
  })

  test('npm and native installs are unaffected by the new branch', () => {
    // No installer artifacts in the npm manifest.
    const npmManifest = buildScopeManifest('npm-global')
    expect(npmManifest.some(a => a.path === join(home, 'runtime'))).toBe(false)
  })
})

describe('doctor classification', () => {
  test('getCurrentInstallationType reports installer', async () => {
    const { libDir } = seedInstall()
    process.argv[1] = join(libDir, 'rayu-1.6.13', 'rayu.js')
    expect(await getCurrentInstallationType()).toBe('installer')
  })
})
