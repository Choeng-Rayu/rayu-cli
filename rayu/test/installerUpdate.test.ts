/**
 * Tests for the installer-driven auto-update path and the update kill switch.
 * These cover the pure decisions; the installer scripts themselves are
 * exercised end to end by running them against a temporary RAYU_HOME.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildInstallerArgs,
  getInstallerUrl,
  INSTALLER_API_MARKER,
  isSupportedInstaller,
  refreshInstallerCopy,
} from '../src/utils/installerUpdate.ts'
import { parseUpdatePolicy } from '../src/utils/autoUpdater.ts'

const REPO_ROOT = join(import.meta.dir, '..')

describe('installer capability marker', () => {
  test('accepts an installer that carries the marker', () => {
    expect(isSupportedInstaller(`#!/bin/sh\n# ${INSTALLER_API_MARKER}\n`)).toBe(true)
  })

  test('rejects an old installer and an empty body', () => {
    expect(isSupportedInstaller('#!/bin/sh\necho old\n')).toBe(false)
    expect(isSupportedInstaller('')).toBe(false)
  })

  test('both shipped installers carry the marker', () => {
    for (const file of ['install.sh', 'install.ps1']) {
      expect(isSupportedInstaller(readFileSync(join(REPO_ROOT, file), 'utf8'))).toBe(true)
    }
  })
})

describe('buildInstallerArgs', () => {
  test('pins the version and runs quietly in the background on Unix', () => {
    expect(buildInstallerArgs('/h/bin/.rayu-installer', '2.5.0', true, 'linux')).toEqual({
      command: '/h/bin/.rayu-installer',
      args: ['--version', '2.5.0', '--quiet', '--no-modify-path'],
    })
  })

  test('foreground Unix run with no pin passes no arguments', () => {
    expect(buildInstallerArgs('/h/bin/.rayu-installer', undefined, false, 'darwin')).toEqual({
      command: '/h/bin/.rayu-installer',
      args: [],
    })
  })

  test('uses PowerShell parameters on Windows', () => {
    expect(buildInstallerArgs('C:\\r\\.rayu-installer.ps1', '2.5.0', true, 'win32')).toEqual({
      command: 'powershell',
      args: [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\r\\.rayu-installer.ps1',
        '-Version', '2.5.0', '-Quiet', '-NoModifyPath',
      ],
    })
  })

  test('installer URL is HTTPS on rayucode.com per platform', () => {
    expect(getInstallerUrl('linux')).toBe('https://rayucode.com/install')
    expect(getInstallerUrl('win32')).toBe('https://rayucode.com/install.ps1')
  })
})

describe('refreshInstallerCopy', () => {
  let dir: string
  let script: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-installer-update-'))
    script = join(dir, '.rayu-installer')
    writeFileSync(script, '#!/bin/sh\necho original\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('refuses a non-HTTPS URL and leaves the local copy untouched', async () => {
    expect(await refreshInstallerCopy(script, 'http://rayucode.com/install')).toBe(false)
    expect(readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho original\n')
  })

  test('a failed download leaves the local copy untouched', async () => {
    // Port 9 (discard) on localhost: connection refused, no network needed.
    expect(await refreshInstallerCopy(script, 'https://127.0.0.1:9/install')).toBe(false)
    expect(readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho original\n')
  })
})

describe('parseUpdatePolicy (kill switch)', () => {
  test('no cap when nothing is published', () => {
    expect(parseUpdatePolicy({ maxVersion: null, message: null })).toEqual({})
    expect(parseUpdatePolicy(null)).toEqual({})
    expect(parseUpdatePolicy('nonsense')).toEqual({})
    expect(parseUpdatePolicy([])).toEqual({})
  })

  test('reads maxVersion and message', () => {
    expect(parseUpdatePolicy({ maxVersion: '2.4.64', message: 'Known issue' })).toEqual({
      external: '2.4.64',
      external_message: 'Known issue',
    })
  })

  test('ignores a maxVersion that is not a version', () => {
    expect(parseUpdatePolicy({ maxVersion: 'latest' })).toEqual({})
    expect(parseUpdatePolicy({ maxVersion: 5 })).toEqual({})
  })
})
