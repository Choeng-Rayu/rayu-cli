/**
 * The per-engine memory limit, end to end:
 *   - the watchdog the compiled engine runs on itself (src/utils/engineMemoryWatchdog.ts);
 *   - how the host chooses the number (src/vscode/host/engine/engineMemoryLimit.ts);
 *   - what the panel does when an engine stops at it: a notice, and the next message
 *     resumes the same conversation;
 *   - the real engine entrypoint exiting with the dedicated code.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  parseMemoryLimitMB,
  startMemoryWatchdog,
} from '../src/utils/engineMemoryWatchdog.js'
import {
  applyMemoryLimit,
  NATIVE_RSS_ALLOWANCE_MB,
  resolveMemoryLimit,
} from '../src/vscode/host/engine/engineMemoryLimit.js'
import { ENGINE_EXIT_MEMORY_LIMIT } from '../src/vscode/shared/engineExitCodes.js'
import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import { sessionCallbacks, until } from './helpers/vscodeSession.js'

const MB = 1024 * 1024
const GB = 1024 * MB

describe('startMemoryWatchdog', () => {
  test('acts only after the limit has been exceeded for consecutive samples', () => {
    const samples = [100, 600, 100, 600, 600, 600]
    const hits: number[] = []
    const watchdog = startMemoryWatchdog({
      limitMB: 500,
      intervalMs: 60_000,
      readRssBytes: () => (samples.shift() ?? 0) * MB,
      onLimit: rss => hits.push(rss),
    })
    for (let i = 0; i < 4; i++) watchdog.check()
    expect(hits).toEqual([])
    watchdog.check()
    expect(hits).toEqual([600])
    // Once acted, it stays quiet.
    watchdog.check()
    expect(hits).toEqual([600])
  })

  test('a stopped watchdog never acts', () => {
    let hits = 0
    const watchdog = startMemoryWatchdog({
      limitMB: 1, intervalMs: 60_000, sustainedSamples: 1, readRssBytes: () => 10 * MB, onLimit: () => hits++,
    })
    watchdog.stop()
    watchdog.check()
    expect(hits).toBe(0)
  })

  test('samples on its own timer', async () => {
    let hit = 0
    const watchdog = startMemoryWatchdog({
      limitMB: 1, intervalMs: 5, sustainedSamples: 1, readRssBytes: () => 10 * MB, onLimit: rss => { hit = rss },
    })
    await until(() => hit > 0, 2_000)
    watchdog.stop()
    expect(hit).toBe(10)
  })

  test('the limit must be a bare positive integer', () => {
    expect(parseMemoryLimitMB('2048')).toBe(2048)
    for (const raw of [undefined, '', '0', '-1', '1.5', '2048MB']) expect(parseMemoryLimitMB(raw)).toBeNull()
  })
})

describe('resolveMemoryLimit', () => {
  test('the setting wins and is applied as written', () => {
    expect(resolveMemoryLimit({ runtime: 'native', settingMB: 3000, hostEnv: { RAYU_ENGINE_MAX_OLD_SPACE_MB: '1000' } }))
      .toEqual({ mb: 3000, source: 'setting' })
  })

  test('an unusable setting falls through to the environment', () => {
    for (const settingMB of [null, '4096', 100, 1024.5]) {
      expect(resolveMemoryLimit({ runtime: 'script', settingMB, hostEnv: { RAYU_ENGINE_MAX_OLD_SPACE_MB: '3072' } }))
        .toEqual({ mb: 3072, source: 'environment' })
    }
  })

  test('heap-sized figures gain the resident allowance for a compiled engine', () => {
    expect(resolveMemoryLimit({ runtime: 'native', hostEnv: { RAYU_ENGINE_MAX_OLD_SPACE_MB: '3072' } }))
      .toEqual({ mb: 3072 + NATIVE_RSS_ALLOWANCE_MB, source: 'environment' })
    expect(resolveMemoryLimit({ runtime: 'native', hostEnv: {}, totalBytes: 16 * GB }))
      .toEqual({ mb: 2048 + NATIVE_RSS_ALLOWANCE_MB, source: 'default' })
    expect(resolveMemoryLimit({ runtime: 'script', hostEnv: {}, totalBytes: 16 * GB }))
      .toEqual({ mb: 2048, source: 'default' })
  })

  test('a machine too small for a default gets none', () => {
    expect(resolveMemoryLimit({ runtime: 'native', hostEnv: {}, totalBytes: 2 * GB })).toBeNull()
  })

  test('applyMemoryLimit uses the mechanism each runtime honours', () => {
    const native: Record<string, string | undefined> = {}
    applyMemoryLimit(native, 'native', 2500)
    expect(native).toEqual({ RAYU_ENGINE_MAX_MEMORY_MB: '2500' })
    const script: Record<string, string | undefined> = { NODE_OPTIONS: '--trace-warnings' }
    applyMemoryLimit(script, 'script', 2048)
    expect(script.NODE_OPTIONS).toBe('--trace-warnings --max-old-space-size=2048')
  })
})

// ── the panel's side ─────────────────────────────────────────────────────────

const dirs: string[] = []
const sessions: ChatSession[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A fake engine that answers `initialize`, reports a session id, and — on its FIRST
 * start only — exits with the memory-limit code as soon as a prompt arrives. Every start
 * appends its argv to `starts.log`.
 */
function writeFakeEngine(dir: string, sessionId: string): { enginePath: string; startsPath: string } {
  const enginePath = join(dir, 'engine.mjs')
  const startsPath = join(dir, 'starts.log')
  writeFileSync(enginePath, `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const STARTS = ${JSON.stringify(startsPath)}
const first = !existsSync(STARTS)
appendFileSync(STARTS, JSON.stringify(process.argv.slice(2)) + '\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const frame = JSON.parse(line)
    if (frame.type === 'user' && first) {
      process.stderr.write('Rayu engine memory limit reached\\n')
      process.exit(${ENGINE_EXIT_MEMORY_LIMIT})
    }
    if (frame.type !== 'control_request') continue
    const payload = frame.request?.subtype === 'initialize' ? { commands: [], models: [], agents: [] } : {}
    // A status frame is the smallest message that carries the session id the host records.
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'status', status: null, uuid: '11111111-1111-4111-8111-111111111111', session_id: ${JSON.stringify(sessionId)} }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: payload } }) + '\\n')
  }
})
setInterval(() => {}, 1000)
`)
  return { enginePath, startsPath }
}

function starts(path: string): string[][] {
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
}

test('an engine that stops at its memory limit gets a notice, and the next message resumes the conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-memlimit-'))
  dirs.push(dir)
  // The host looks for the transcript under the config home before resuming; keep that
  // lookup (and anything else) inside this test's directory.
  const savedConfigDir = process.env.RAYU_CONFIG_DIR
  process.env.RAYU_CONFIG_DIR = dir
  try {
    const sessionId = '6b0e4d8c-0000-4000-8000-000000000001'
    const { enginePath, startsPath } = writeFakeEngine(dir, sessionId)
    const errors: string[] = []
    const session = new ChatSession(
      { enginePath, cwd: dir, nodePath: process.execPath },
      sessionCallbacks({ onError: message => errors.push(message) }),
    )
    sessions.push(session)

    await session.submitPrompt('build something big')
    await until(() => session.transcript.some(entry => entry.kind === 'notice'))
    const notice = session.transcript.find(entry => entry.kind === 'notice')
    expect(notice).toMatchObject({ severity: 'warning' })
    expect(notice?.kind === 'notice' ? notice.text : '').toContain('restarted its engine to free memory')
    // Not reported as an error the user has to deal with.
    expect(errors).toEqual([])

    // The conversation's transcript, where the real engine would have written it.
    const { canonicalizePath, sanitizePath } = await import('../src/utils/sessionStoragePortable.js')
    const projectDir = join(dir, 'projects', sanitizePath(await canonicalizePath(dir)))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{"type":"user"}\n')

    await session.submitPrompt('carry on')
    await until(() => starts(startsPath).length >= 2)
    const second = starts(startsPath)[1]!
    expect(second).toContain('--resume')
    expect(second[second.indexOf('--resume') + 1]).toBe(sessionId)
  } finally {
    if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
    else process.env.RAYU_CONFIG_DIR = savedConfigDir
  }
}, 30_000)

// ── the engine's side ────────────────────────────────────────────────────────

const ENGINE_MJS = resolve(import.meta.dir, '../dist/vscode-stage/engine.mjs')
const NATIVE_ENGINE = resolve(
  import.meta.dir,
  `../dist/vscode/targets/${process.platform}-${process.arch}/rayucode-engine${process.platform === 'win32' ? '.exe' : ''}`,
)

async function runOverLimit(command: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-memlimit-engine-'))
  dirs.push(dir)
  const child = Bun.spawn(command, {
    cwd: dir,
    // 1 MB: any process is over it, so the watchdog fires after two 5 s samples.
    env: { ...process.env, RAYU_CONFIG_DIR: dir, RAYU_AUTH_CONFIG_DIR: dir, USE_RAYU_OAUTH: 'false', RAYU_ENGINE_MAX_MEMORY_MB: '1' },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 40_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  clearTimeout(timer)
  return { code, stderr, stdout }
}

test.if(existsSync(NATIVE_ENGINE))('the compiled engine exits with the memory-limit code at its limit, writing no frame', async () => {
  const { code, stderr, stdout } = await runOverLimit([NATIVE_ENGINE])
  expect(code).toBe(ENGINE_EXIT_MEMORY_LIMIT)
  expect(stderr).toContain('Rayu engine memory limit reached')
  // The host treats an unexpected stdout frame as a protocol fault.
  expect(stdout).not.toContain('memory limit')
}, 60_000)

test.if(existsSync(ENGINE_MJS) && !!Bun.which('node'))('engine.mjs honours the same limit when one is passed', async () => {
  const { code } = await runOverLimit(['node', ENGINE_MJS])
  expect(code).toBe(ENGINE_EXIT_MEMORY_LIMIT)
}, 60_000)
