import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'

import {
  _resetRayuTempDirForTest,
  ensureRayuTempDir,
  getRayuTempDir,
  getRayuTempDirName,
} from '../src/utils/rayuTempDir.ts'

const prevRayu = process.env.RAYU_CODE_TMPDIR
const prevClaude = process.env.CLAUDE_CODE_TMPDIR
const scratchDirs: string[] = []

function scratchBase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayu-tempdir-test-'))
  scratchDirs.push(dir)
  return realpathSync(dir)
}

function restoreEnv(): void {
  if (prevRayu === undefined) delete process.env.RAYU_CODE_TMPDIR
  else process.env.RAYU_CODE_TMPDIR = prevRayu
  if (prevClaude === undefined) delete process.env.CLAUDE_CODE_TMPDIR
  else process.env.CLAUDE_CODE_TMPDIR = prevClaude
  _resetRayuTempDirForTest()
}

afterEach(() => {
  restoreEnv()
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the temp namespace is Rayu-owned', () => {
  test('the directory name is rayu-{uid}, never claude-{uid}', () => {
    const expected =
      process.platform === 'win32'
        ? 'rayu'
        : `rayu-${process.getuid?.() ?? 0}`
    expect(getRayuTempDirName()).toBe(expected)
    expect(getRayuTempDirName()).not.toContain('claude')
  })

  test('RAYU_CODE_TMPDIR wins over the legacy CLAUDE_CODE_TMPDIR', () => {
    const rayuBase = scratchBase()
    const claudeBase = scratchBase()
    process.env.RAYU_CODE_TMPDIR = rayuBase
    process.env.CLAUDE_CODE_TMPDIR = claudeBase
    _resetRayuTempDirForTest()

    expect(getRayuTempDir()).toBe(join(rayuBase, getRayuTempDirName()) + sep)
  })

  test('CLAUDE_CODE_TMPDIR is still honoured as a fallback', () => {
    const claudeBase = scratchBase()
    delete process.env.RAYU_CODE_TMPDIR
    process.env.CLAUDE_CODE_TMPDIR = claudeBase
    _resetRayuTempDirForTest()

    expect(getRayuTempDir()).toBe(
      join(realpathSync(claudeBase), getRayuTempDirName()) + sep,
    )
  })

  test('ensureRayuTempDir creates the root owner-only', async () => {
    const base = scratchBase()
    process.env.RAYU_CODE_TMPDIR = base
    delete process.env.CLAUDE_CODE_TMPDIR
    _resetRayuTempDirForTest()

    const dir = await ensureRayuTempDir()
    expect(dir).toBe(getRayuTempDir())
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
  })
})
