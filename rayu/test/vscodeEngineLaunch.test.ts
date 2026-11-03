/**
 * engine/engineLaunch.ts — the one place the extension host decides how an engine is
 * started, and the helper-child runner every flag-selected helper uses.
 *
 * The runner is exercised against a small fake engine script run by this test's own
 * runtime (`process.execPath`), so no build is needed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeDefaultEngineHeapCapMB,
  describeEngineStartFailure,
  engineSpawnEnv,
  ensureEngineExecutable,
  nativeEngineLaunch,
  resolveEngineLaunch,
  runEngineChild,
  scriptEngineLaunch,
  stderrExcerpt,
  type EngineLaunch,
} from '../src/vscode/host/engine/engineLaunch.js'
import { NATIVE_RSS_ALLOWANCE_MB } from '../src/vscode/host/engine/engineMemoryLimit.js'

const GB = 1024 * 1024 * 1024

describe('scriptEngineLaunch', () => {
  test('runs engine.mjs with the editor\'s embedded Node by default', () => {
    const launch = scriptEngineLaunch({ enginePath: '/ext/engine.mjs', execPath: '/app/code' })
    expect(launch.runtime).toBe('script')
    expect(launch.source).toBe('bundled')
    expect(launch.command).toBe('/app/code')
    expect(launch.baseArgs).toEqual(['/ext/engine.mjs'])
    expect(launch.env).toEqual({ NO_COLOR: '1', FORCE_COLOR: '0', ELECTRON_RUN_AS_NODE: '1' })
  })

  test('a supplied Node is used as-is, without the run-as-node switch', () => {
    const launch = scriptEngineLaunch({
      enginePath: '/ext/engine.mjs',
      nodePath: '/usr/bin/node',
      execPath: '/app/code',
    })
    expect(launch.command).toBe('/usr/bin/node')
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(launch.env.NO_COLOR).toBe('1')
  })
})

describe('resolveEngineLaunch (which engine this extension runs)', () => {
  const base = { extensionRoot: '/ext', execPath: '/app/code' }

  test('a platform VSIX runs its compiled engine, with no script and no run-as-node', () => {
    const { launch, warning } = resolveEngineLaunch({
      ...base,
      platform: 'linux',
      isFile: path => path === '/ext/bin/rayucode-engine',
    })
    expect(warning).toBeUndefined()
    expect(launch).toMatchObject({ runtime: 'native', source: 'bundled', command: '/ext/bin/rayucode-engine' })
    expect(launch.baseArgs).toEqual([])
    expect('ELECTRON_RUN_AS_NODE' in launch.env && launch.env.ELECTRON_RUN_AS_NODE === undefined).toBe(true)
  })

  test('the Windows engine is the .exe', () => {
    const { launch } = resolveEngineLaunch({
      ...base,
      extensionRoot: 'C:\\ext',
      platform: 'win32',
      isFile: path => path.endsWith('rayucode-engine.exe'),
    })
    expect(launch.runtime).toBe('native')
    expect(launch.command.endsWith('rayucode-engine.exe')).toBe(true)
  })

  test('the universal VSIX runs engine.mjs on the editor\'s Node', () => {
    const { launch } = resolveEngineLaunch({ ...base, platform: 'linux', isFile: () => false })
    expect(launch).toMatchObject({ runtime: 'script', source: 'bundled', command: '/app/code' })
    expect(launch.baseArgs).toEqual(['/ext/engine.mjs'])
  })

  test('an overriding script runs on the editor\'s Node, even beside a bundled binary', () => {
    const { launch } = resolveEngineLaunch({
      ...base, platform: 'linux', overridePath: ' /dev/rayu/dist/vscode/engine.mjs ', isFile: () => true,
    })
    expect(launch).toMatchObject({ runtime: 'script', source: 'override', command: '/app/code' })
    expect(launch.baseArgs).toEqual(['/dev/rayu/dist/vscode/engine.mjs'])
  })

  test('an overriding executable runs directly', () => {
    const { launch } = resolveEngineLaunch({
      ...base, platform: 'linux', overridePath: '/opt/rayu/rayucode-engine', isFile: () => false,
    })
    expect(launch).toMatchObject({ runtime: 'native', source: 'override', command: '/opt/rayu/rayucode-engine' })
  })

  test('a relative override is refused with a warning, and the bundled engine is used', () => {
    const { launch, warning } = resolveEngineLaunch({
      ...base, platform: 'linux', overridePath: 'engine.mjs', isFile: () => false,
    })
    expect(launch.source).toBe('bundled')
    expect(warning).toContain('absolute path')
  })

  test('an empty override is ignored', () => {
    const { launch, warning } = resolveEngineLaunch({ ...base, platform: 'linux', overridePath: '  ', isFile: () => false })
    expect(launch.source).toBe('bundled')
    expect(warning).toBeUndefined()
  })
})

describe('describeEngineStartFailure', () => {
  test('keeps the raw message for the bundled script engine', () => {
    const launch = scriptEngineLaunch({ enginePath: '/ext/engine.mjs', execPath: '/app/code' })
    expect(describeEngineStartFailure(launch, 'spawn EPERM')).toBe('spawn EPERM')
  })

  test('names a compiled engine and suggests a reinstall', () => {
    const message = describeEngineStartFailure(nativeEngineLaunch('/ext/bin/rayucode-engine'), 'spawn EACCES')
    expect(message).toContain('/ext/bin/rayucode-engine')
    expect(message).toContain('Reinstall Rayucode')
  })

  test('points an override at its setting', () => {
    const message = describeEngineStartFailure(nativeEngineLaunch('/opt/x', 'override'), 'spawn ENOENT')
    expect(message).toContain('"rayucode.engine.path"')
  })
})

describe('engineSpawnEnv', () => {
  const launch = scriptEngineLaunch({ enginePath: '/ext/engine.mjs', execPath: '/app/code' })

  test('the launch environment wins over the caller overlay', () => {
    const env = engineSpawnEnv(launch, { PATH: '/bin' }, { NO_COLOR: undefined, EXTRA: 'x' })
    expect(env.PATH).toBe('/bin')
    expect(env.EXTRA).toBe('x')
    expect(env.NO_COLOR).toBe('1')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  test('conversation engines get the heap cap from RAYU_ENGINE_MAX_OLD_SPACE_MB', () => {
    const env = engineSpawnEnv(
      launch,
      { RAYU_ENGINE_MAX_OLD_SPACE_MB: '3072', NODE_OPTIONS: '--enable-source-maps' },
      {},
      { limitMemory: true },
    )
    expect(env.NODE_OPTIONS).toBe('--enable-source-maps --max-old-space-size=3072')
  })

  test('an explicit heap flag in NODE_OPTIONS wins', () => {
    const env = engineSpawnEnv(
      launch,
      { RAYU_ENGINE_MAX_OLD_SPACE_MB: '3072', NODE_OPTIONS: '--max_old_space_size=1000' },
      {},
      { limitMemory: true },
    )
    expect(env.NODE_OPTIONS).toBe('--max_old_space_size=1000')
  })

  test('helper children are not capped', () => {
    const env = engineSpawnEnv(launch, { RAYU_ENGINE_MAX_OLD_SPACE_MB: '3072' })
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  test('the overlay can carry the cap setting, as before the launcher existed', () => {
    const env = engineSpawnEnv(launch, {}, { RAYU_ENGINE_MAX_OLD_SPACE_MB: '2048' }, { limitMemory: true })
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=2048')
  })

  test('a compiled engine gets its limit as RSS, not a V8 heap flag, and loses the inherited run-as-node switch', () => {
    const env = engineSpawnEnv(
      nativeEngineLaunch('/ext/bin/rayucode-engine'),
      { ELECTRON_RUN_AS_NODE: '1', RAYU_ENGINE_MAX_OLD_SPACE_MB: '3072' },
      {},
      { limitMemory: true },
    )
    expect(env.NODE_OPTIONS).toBeUndefined()
    // A heap-sized figure plus the runtime's resident overhead.
    expect(env.RAYU_ENGINE_MAX_MEMORY_MB).toBe(String(3072 + NATIVE_RSS_ALLOWANCE_MB))
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.NO_COLOR).toBe('1')
  })

  test('a launch resolved at activation carries its limit, and null means none', () => {
    const native = nativeEngineLaunch('/ext/bin/rayucode-engine')
    const limited = engineSpawnEnv({ ...native, memoryLimit: { mb: 2048, source: 'setting' } }, {}, {}, { limitMemory: true })
    expect(limited.RAYU_ENGINE_MAX_MEMORY_MB).toBe('2048')
    const unlimited = engineSpawnEnv({ ...native, memoryLimit: null }, { RAYU_ENGINE_MAX_OLD_SPACE_MB: '3072' }, {}, { limitMemory: true })
    expect(unlimited.RAYU_ENGINE_MAX_MEMORY_MB).toBeUndefined()
  })
})

describe('ensureEngineExecutable', () => {
  test.skipIf(process.platform === 'win32')('restores a lost exec bit on a compiled engine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-exec-'))
    try {
      const binary = join(dir, 'rayucode-engine')
      writeFileSync(binary, '#!/bin/sh\n')
      chmodSync(binary, 0o644)
      ensureEngineExecutable(nativeEngineLaunch(binary), 'linux')
      expect(statSync(binary).mode & 0o111).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('leaves script engines alone', () => {
    // The command is the editor itself; touching it would be wrong even if it were possible.
    expect(() => ensureEngineExecutable(scriptEngineLaunch({ enginePath: '/x', execPath: '/nope' }), 'linux')).not.toThrow()
  })
})

describe('computeDefaultEngineHeapCapMB', () => {
  test.each([
    [16 * GB, 2048],
    [64 * GB, 4096],
    [2 * GB, null],
    [Number.NaN, null],
    [0, null],
  ])('%p bytes of RAM -> %p MB', (total, expected) => {
    expect(computeDefaultEngineHeapCapMB(total)).toBe(expected)
  })
})

describe('stderrExcerpt', () => {
  test('is empty for silence and keeps only the tail otherwise', () => {
    expect(stderrExcerpt('  \n')).toBe('')
    expect(stderrExcerpt('abcdef', 3)).toBe(' def')
  })
})

// ── runEngineChild ───────────────────────────────────────────────────────────

/**
 * A fake engine. The last argv element is the helper flag, which selects a behaviour:
 *   --echo      emit a progress frame, then a result frame carrying stdin and argv
 *   --die       write to stderr and exit 3 without a result
 *   --hang      never answer
 *   --garbage   emit a line that is not JSON
 */
const FAKE_ENGINE = `
const flag = process.argv[process.argv.length - 1]
let input = ''
process.stdin.on('data', c => { input += c })
process.stdin.on('end', () => {
  if (flag === '--echo') {
    process.stdout.write(JSON.stringify({ type: 'progress' }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'result', input, argv: process.argv.slice(2), color: process.env.NO_COLOR }) + '\\n')
  }
  if (flag === '--die') { process.stderr.write('boom: helper failed\\n'); process.exit(3) }
  if (flag === '--garbage') process.stdout.write('not json\\n')
})
if (flag === '--hang') setInterval(() => {}, 1000)
`

let dir = ''
let launch: EngineLaunch

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-launch-'))
  const script = join(dir, 'fake-engine.mjs')
  writeFileSync(script, FAKE_ENGINE)
  launch = scriptEngineLaunch({ enginePath: script, nodePath: process.execPath, execPath: process.execPath })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function untilResult(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  return frame.type === 'result' ? frame : undefined
}

describe('runEngineChild', () => {
  test('delivers frames until one settles it, with the stdin payload and the flag last', async () => {
    const seen: unknown[] = []
    const result = await runEngineChild(launch, {
      flag: '--echo',
      cwd: dir,
      stdin: '{"action":"list"}',
      timeoutMs: 10_000,
      onFrame: frame => {
        seen.push(frame.type)
        return untilResult(frame)
      },
    })
    expect(result.kind).toBe('done')
    if (result.kind !== 'done') return
    expect(seen).toEqual(['progress', 'result'])
    expect(result.value.input).toBe('{"action":"list"}')
    expect(result.value.argv).toEqual(['--echo'])
    expect(result.value.color).toBe('1')
  })

  test('a helper that exits without a result reports its code and stderr', async () => {
    const result = await runEngineChild(launch, {
      flag: '--die', stdin: '', timeoutMs: 10_000, onFrame: untilResult,
    })
    expect(result).toEqual({ kind: 'exited', code: 3, stderrTail: 'boom: helper failed\n' })
  })

  test('a helper that never answers times out', async () => {
    const started = Date.now()
    const result = await runEngineChild(launch, {
      flag: '--hang', stdin: '', timeoutMs: 300, onFrame: untilResult,
    })
    expect(result.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('aborting stops the helper', async () => {
    const controller = new AbortController()
    const pending = runEngineChild(launch, {
      flag: '--hang', timeoutMs: 10_000, signal: controller.signal, onFrame: untilResult,
    })
    setTimeout(() => controller.abort(), 100)
    expect((await pending).kind).toBe('aborted')
  })

  test('an already-aborted signal never spawns', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runEngineChild(launch, {
      flag: '--echo', timeoutMs: 10_000, signal: controller.signal, onFrame: untilResult,
    }, { spawn: (() => { throw new Error('must not spawn') }) as never })
    expect(result.kind).toBe('aborted')
  })

  test('an unreadable line is a protocol error', async () => {
    const result = await runEngineChild(launch, {
      flag: '--garbage', stdin: '', timeoutMs: 10_000, onFrame: untilResult,
    })
    expect(result.kind).toBe('protocol-error')
  })

  test('a frame handler that throws is reported, not thrown into the host', async () => {
    const result = await runEngineChild(launch, {
      flag: '--echo',
      stdin: '',
      timeoutMs: 10_000,
      onFrame: () => {
        throw new Error('bad frame')
      },
    })
    expect(result).toEqual({ kind: 'protocol-error', message: 'bad frame' })
  })

  test('a missing executable is a spawn error that names it', async () => {
    const missing = nativeEngineLaunch(join(dir, 'does-not-exist'))
    const result = await runEngineChild(missing, {
      flag: '--echo', stdin: '', timeoutMs: 10_000, onFrame: untilResult,
    })
    expect(result.kind).toBe('spawn-error')
    if (result.kind === 'spawn-error') expect(result.message).toContain('does-not-exist')
  })
})
