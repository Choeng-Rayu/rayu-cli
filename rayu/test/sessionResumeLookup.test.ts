/**
 * Engine resume lookup must agree with the extension host's pre-spawn guard.
 *
 * ── THE BUG THIS PINS ──────────────────────────────────────────────────────────
 *
 * The host runs `resolveSessionFilePath(id, cwd)` before spawning `--resume <id>`
 * and only keeps the flag when it finds the transcript. The engine then re-derives
 * the project dir from `getOriginalCwd()`. On macOS those two can disagree: File
 * Provider mounts (iCloud/OneDrive/Dropbox) reject realpath's per-component lstat
 * with EPERM intermittently, so one process resolves a symlinked/cloud path and the
 * other keeps the raw one — and `sanitizePath` turns the differing strings into
 * differing project directories. Transcripts also live under sibling worktrees or
 * long-path hash variants the strict single-dir lookup never checks.
 *
 * Before the fix, `loadSessionFile` looked in exactly one directory, so a transcript
 * the host found was missed by the engine: `getLastSessionLog` returned null and
 * resume died with "No conversation found" → exit code 1 (the panel sees only the
 * exit, because the message goes to stdout as a result frame).
 *
 * These tests write a transcript under a project dir DIFFERENT from the one
 * `getOriginalCwd()` derives and assert the engine still finds it by id.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setOriginalCwd } from '../src/bootstrap/state.js'
import { getLastSessionLog } from '../src/utils/sessionStorage.js'
import { getProjectDir } from '../src/utils/sessionStoragePortable.js'

let configDir: string
let savedConfigDir: string | undefined

beforeEach(async () => {
  savedConfigDir = process.env.RAYU_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'rayu-resume-lookup-'))
  process.env.RAYU_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  await rm(configDir, { recursive: true, force: true })
})

/** Write a minimal valid one-message transcript under the project dir for `cwd`. */
async function writeTranscript(cwd: string, sessionId: string): Promise<void> {
  const dir = getProjectDir(cwd)
  await mkdir(dir, { recursive: true })
  const record = {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
    isSidechain: false,
    cwd,
    message: { role: 'user', content: 'hello' },
  }
  await writeFile(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
}

test('finds a transcript written under a different project dir than getOriginalCwd()', async () => {
  // The engine's realpath fell back to the raw path; the host resolved a different
  // canonical form and wrote the transcript there. The id is globally unique, so
  // the engine must still find it rather than exiting 1.
  setOriginalCwd('/ws/engine-view')
  const sessionId = randomUUID()
  await writeTranscript('/ws/host-view', sessionId)

  const log = await getLastSessionLog(sessionId)
  expect(log).not.toBeNull()
  expect(log?.messages.length).toBeGreaterThan(0)
  // print.ts resumes with switchSession(id, dirname(fullPath)) — the log must
  // carry the file ACTUALLY read, or the continued conversation writes to the
  // cwd-derived dir and splits the transcript across two directories.
  expect(log?.fullPath).toBe(join(getProjectDir('/ws/host-view'), `${sessionId}.jsonl`))
})

test('still finds a transcript in the expected project dir (common path)', async () => {
  const cwd = '/ws/normal'
  setOriginalCwd(cwd)
  const sessionId = randomUUID()
  await writeTranscript(cwd, sessionId)

  const log = await getLastSessionLog(sessionId)
  expect(log).not.toBeNull()
  expect(log?.messages.length).toBeGreaterThan(0)
  expect(log?.fullPath).toBe(join(getProjectDir(cwd), `${sessionId}.jsonl`))
})

test('returns null when no transcript exists anywhere (no false positive)', async () => {
  setOriginalCwd('/ws/empty')
  const log = await getLastSessionLog(randomUUID())
  expect(log).toBeNull()
})

test('finds a transcript in a sibling git worktree (extension guard worktree fallback)', async () => {
  // The extension host keeps --resume when resolveSessionFilePath finds the
  // transcript via a sibling worktree; the engine must resolve it the same way.
  const mainWs = await mkdtemp(join(tmpdir(), 'rayu-resume-main-'))
  const siblingWs = join(tmpdir(), `rayu-resume-sib-${randomUUID().slice(0, 8)}`)
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: mainWs, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  try {
    git('init', '-q')
    git('config', 'user.email', 'resume@test.local')
    git('config', 'user.name', 'Resume Test')
    await writeFile(join(mainWs, 'f.txt'), 'x')
    git('add', 'f.txt')
    git('commit', '-qm', 'init')
    git('worktree', 'add', '-q', siblingWs)

    setOriginalCwd(mainWs)
    const sessionId = randomUUID()
    await writeTranscript(siblingWs, sessionId)

    const log = await getLastSessionLog(sessionId)
    expect(log).not.toBeNull()
    expect(log?.messages.length).toBeGreaterThan(0)
    expect(log?.fullPath).toBe(join(getProjectDir(siblingWs), `${sessionId}.jsonl`))
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', siblingWs], { cwd: mainWs })
    await rm(mainWs, { recursive: true, force: true })
    await rm(siblingWs, { recursive: true, force: true })
  }
})
