// macOS keychain startup-hang regression tests.
//
// Root cause being pinned: on macOS the CLI reads Claude.ai OAuth credentials
// from the login keychain via `security` during startup. When the keychain is
// LOCKED (SSH sessions, lock-on-sleep) or an entry's ACL demands user consent
// (fresh/updated binary), `security` waits on a prompt. If that wait happens
// inside a SYNC spawn with a 10-minute timeout, the whole event loop freezes
// and `rayu` appears stuck at launch. These tests pin the defenses:
//
//   1. read()/readAsync() never spawn `security find-generic-password` when the
//      login keychain is locked (they return null / serve stale cache instead).
//   2. Every sync/async `security` spawn on the read path carries a BOUNDED
//      timeout (KEYCHAIN_SYNC_SPAWN_TIMEOUT_MS), never the 10-minute default.
//   3. The startup prefetch detects a locked keychain and resolves immediately
//      without priming, so preAction does not wait out a blocked password spawn.
//
// execa (sync + async) and node:child_process execFile are mocked — nothing
// here touches a real keychain. The platform is spoofed to 'darwin'.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mock execa (process-wide for this test file). Both the sync shell-string
// form (execSyncWithDefaults_DEPRECATED) and the (file, args, opts) form
// (macOsKeychainStorage / execFileNoThrow) route through here.
// ---------------------------------------------------------------------------

type SpawnCall = {
  cmd: string
  args: string[] | null
  opts: Record<string, unknown> | undefined
}

let spawnCalls: SpawnCall[] = []

// Per-test handlers. The sync handler returns an execa sync result; the async
// handler returns what execFileNoThrow's `execa(...).then(...)` chain expects.
let execaSyncHandler: (call: SpawnCall) => {
  exitCode: number
  stdout: string
  stderr?: string
}
let execaAsyncHandler: (call: SpawnCall) => {
  failed: boolean
  exitCode: number
  stdout: string
  stderr: string
}

const realExecaModule = await import('execa')
mock.module('execa', () => ({
  ...realExecaModule,
  execaSync: (cmd: string, arg2?: unknown, arg3?: unknown) => {
    // Both signatures occur: (command, opts) and (file, args, opts).
    const isFileArgsForm = Array.isArray(arg2)
    const call: SpawnCall = {
      cmd,
      args: isFileArgsForm ? (arg2 as string[]) : null,
      opts: (isFileArgsForm ? arg3 : arg2) as Record<string, unknown>,
    }
    spawnCalls.push(call)
    return execaSyncHandler(call)
  },
  execa: (cmd: string, args: string[], opts?: Record<string, unknown>) => {
    const call: SpawnCall = { cmd, args, opts }
    spawnCalls.push(call)
    return Promise.resolve(execaAsyncHandler(call))
  },
}))

// Mock node:child_process execFile for the keychainPrefetch tests.
type ExecFileCall = { cmd: string; args: string[]; opts: Record<string, unknown> }
let execFileCalls: ExecFileCall[] = []
let execFileHandler: (
  call: ExecFileCall,
) => { err: (Error & { killed?: boolean }) | null; stdout: string } | 'never-returns'

const realChildProcess = await import('node:child_process')
mock.module('node:child_process', () => ({
  ...realChildProcess,
  execFile: (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: (Error & { killed?: boolean }) | null, stdout: string) => void,
  ) => {
    const call: ExecFileCall = { cmd, args, opts }
    execFileCalls.push(call)
    const result = execFileHandler(call)
    if (result !== 'never-returns') {
      // Defer so callers can attach .then() chains like production code.
      queueMicrotask(() => cb(result.err, result.stdout))
    }
    return {} as ReturnType<typeof realChildProcess.execFile>
  },
}))

// ---------------------------------------------------------------------------
// Platform spoofing
// ---------------------------------------------------------------------------

const originalPlatform = process.platform
let dir: string

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-keychain-startup-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  spawnCalls = []
  execFileCalls = []
  execaSyncHandler = () => ({ exitCode: 0, stdout: '' })
  execaAsyncHandler = () => ({ failed: true, exitCode: 1, stdout: '', stderr: '' })
  execFileHandler = () => ({ err: new Error('unset'), stdout: '' })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

// Fresh module instance per test — the keychain modules keep module-level
// caches (locked-state cache, prefetch promise) that must not leak across
// tests. Cache-busting query strings give each import its own instance.
let moduleNonce = 0
async function freshStorage() {
  moduleNonce++
  const [storage, helpers] = await Promise.all([
    import(`../src/utils/secureStorage/macOsKeychainStorage.ts?case=${moduleNonce}`),
    import('../src/utils/secureStorage/macOsKeychainHelpers.ts'),
  ])
  helpers.clearKeychainCache()
  return { storage, helpers }
}

function findGenericPasswordCalls(): SpawnCall[] {
  return spawnCalls.filter(c =>
    c.cmd.includes
      ? c.cmd.includes('find-generic-password') ||
        (c.args?.join(' ').includes('find-generic-password') ?? false)
      : false,
  )
}

const TOKENS = { claudeAiOauth: { accessToken: 'tok-1', refreshToken: 'r-1' } }

describe('macOsKeychainStorage.read() — launch-time freeze defenses', () => {
  test('locked keychain: returns null WITHOUT spawning find-generic-password', async () => {
    const { storage } = await freshStorage()
    execaSyncHandler = call => {
      const text = call.args?.join(' ') ?? call.cmd
      if (text.includes('show-keychain-info')) return { exitCode: 36, stdout: '' }
      throw new Error(`unexpected sync spawn: ${text}`)
    }

    expect(storage.macOsKeychainStorage.read()).toBeNull()
    expect(findGenericPasswordCalls()).toHaveLength(0)
  })

  test('locked keychain: serves stale-while-error when a value was cached', async () => {
    const { storage, helpers } = await freshStorage()
    // Seed a cache entry, then expire it past the TTL.
    const now = Date.now()
    helpers.keychainCacheState.cache = { data: TOKENS, cachedAt: now - 120_000 }
    execaSyncHandler = call => {
      const text = call.args?.join(' ') ?? call.cmd
      if (text.includes('show-keychain-info')) return { exitCode: 36, stdout: '' }
      throw new Error(`unexpected sync spawn: ${text}`)
    }

    expect(storage.macOsKeychainStorage.read()).toEqual(TOKENS)
    expect(findGenericPasswordCalls()).toHaveLength(0)
  })

  test('unlocked keychain: find-generic-password spawn is bounded by KEYCHAIN_SYNC_SPAWN_TIMEOUT_MS', async () => {
    const { storage } = await freshStorage()
    execaSyncHandler = call => {
      const text = call.args?.join(' ') ?? call.cmd
      if (text.includes('show-keychain-info')) return { exitCode: 0, stdout: 'timeout: 300' }
      if (text.includes('find-generic-password')) {
        return { exitCode: 0, stdout: JSON.stringify(TOKENS) }
      }
      return { exitCode: 1, stdout: '' }
    }

    expect(storage.macOsKeychainStorage.read()).toEqual(TOKENS)
    const spawns = findGenericPasswordCalls()
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.opts?.timeout).toBe(storage.KEYCHAIN_SYNC_SPAWN_TIMEOUT_MS)
    // Sanity: the bound is short enough to never be perceived as a hang.
    expect(storage.KEYCHAIN_SYNC_SPAWN_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })
})

describe('macOsKeychainStorage.readAsync() — non-blocking path', () => {
  test('locked keychain: resolves null without spawning find-generic-password', async () => {
    const { storage } = await freshStorage()
    execaSyncHandler = call => {
      const text = call.args?.join(' ') ?? call.cmd
      if (text.includes('show-keychain-info')) return { exitCode: 36, stdout: '' }
      throw new Error(`unexpected sync spawn: ${text}`)
    }
    execaAsyncHandler = call => {
      throw new Error(`unexpected async spawn: ${call.args?.join(' ')}`)
    }

    expect(await storage.macOsKeychainStorage.readAsync()).toBeNull()
    expect(findGenericPasswordCalls()).toHaveLength(0)
  })

  test('unlocked keychain: async spawn is bounded by KEYCHAIN_SYNC_SPAWN_TIMEOUT_MS', async () => {
    const { storage } = await freshStorage()
    execaSyncHandler = () => ({ exitCode: 0, stdout: 'timeout: 300' })
    execaAsyncHandler = call => {
      if (call.args?.includes('find-generic-password')) {
        return { failed: false, exitCode: 0, stdout: JSON.stringify(TOKENS), stderr: '' }
      }
      return { failed: true, exitCode: 1, stdout: '', stderr: '' }
    }

    expect(await storage.macOsKeychainStorage.readAsync()).toEqual(TOKENS)
    const spawns = findGenericPasswordCalls()
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.opts?.timeout).toBe(storage.KEYCHAIN_SYNC_SPAWN_TIMEOUT_MS)
  })
})

describe('delete() and isMacOsKeychainLocked() bounds', () => {
  test('delete() spawn is bounded', async () => {
    const { storage } = await freshStorage()
    execaSyncHandler = call => {
      const text = call.args?.join(' ') ?? call.cmd
      if (text.includes('show-keychain-info')) return { exitCode: 0, stdout: '' }
      return { exitCode: 0, stdout: '' }
    }

    storage.macOsKeychainStorage.delete()
    const deletes = spawnCalls.filter(c => {
      const text = c.args?.join(' ') ?? c.cmd
      return text.includes('delete-generic-password')
    })
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.opts?.timeout).toBe(storage.KEYCHAIN_SYNC_SPAWN_TIMEOUT_MS)
  })

  test('isMacOsKeychainLocked(): exit 36 => true, exit 0 => false, spawn is bounded', async () => {
    const { storage } = await freshStorage()
    execaSyncHandler = () => ({ exitCode: 36, stdout: '' })
    expect(storage.isMacOsKeychainLocked()).toBe(true)
    const calls = spawnCalls.filter(c =>
      (c.args?.join(' ') ?? c.cmd).includes('show-keychain-info'),
    )
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]!.opts?.timeout).toBeLessThanOrEqual(5_000)

    // Fresh module instance → fresh lock cache.
    const second = await freshStorage()
    execaSyncHandler = () => ({ exitCode: 0, stdout: 'timeout: 300' })
    expect(second.storage.isMacOsKeychainLocked()).toBe(false)
  })
})

describe('keychainPrefetch — locked keychain must not stall preAction', () => {
  async function freshPrefetch() {
    moduleNonce++
    const mod = await import(
      `../src/utils/secureStorage/keychainPrefetch.ts?case=${moduleNonce}`
    )
    const helpers = await import('../src/utils/secureStorage/macOsKeychainHelpers.ts')
    helpers.clearKeychainCache()
    return { mod, helpers }
  }

  test('locked keychain: prefetch resolves fast and does NOT prime the cache', async () => {
    const { mod, helpers } = await freshPrefetch()
    execFileHandler = call => {
      if (call.args.includes('show-keychain-info')) {
        // show-keychain-info signals "locked" via exit code 36 (err, not killed).
        const err = Object.assign(new Error('locked'), { code: 36 })
        return { err, stdout: '' }
      }
      // Password spawns would block on the unlock prompt in production.
      return 'never-returns'
    }

    mod.startKeychainPrefetch()
    // Must settle quickly even though the password spawns never return.
    await Promise.race([
      mod.ensureKeychainPrefetchCompleted(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('prefetch stalled on locked keychain')), 1_000),
      ),
    ])
    expect(helpers.keychainCacheState.cache.cachedAt).toBe(0)
    expect(mod.getLegacyApiKeyPrefetchResult()).toBeNull()
  })

  test('unlocked keychain: both reads prime as before', async () => {
    const { mod, helpers } = await freshPrefetch()
    execFileHandler = call => {
      if (call.args.includes('show-keychain-info')) {
        return { err: null, stdout: 'timeout: 300' }
      }
      if (call.args.some(a => a.includes('-credentials'))) {
        return { err: null, stdout: JSON.stringify(TOKENS) }
      }
      // Legacy API key entry: "not found" (exit 44) → err, stdout ''.
      return { err: Object.assign(new Error('not found'), { code: 44 }), stdout: '' }
    }

    mod.startKeychainPrefetch()
    await Promise.race([
      mod.ensureKeychainPrefetchCompleted(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('prefetch stalled')), 1_000),
      ),
    ])
    expect(helpers.keychainCacheState.cache.data).toEqual(TOKENS)
    expect(mod.getLegacyApiKeyPrefetchResult()).toEqual({ stdout: null })
  })

  test('all three spawns fire synchronously at start (parallelism preserved)', async () => {
    const { mod } = await freshPrefetch()
    execFileHandler = call => {
      if (call.args.includes('show-keychain-info')) {
        return { err: null, stdout: 'timeout: 300' }
      }
      if (call.args.some(a => a.includes('-credentials'))) {
        return { err: null, stdout: JSON.stringify(TOKENS) }
      }
      return { err: Object.assign(new Error('not found'), { code: 44 }), stdout: '' }
    }

    mod.startKeychainPrefetch()
    // All three subprocesses fired synchronously before any result settled
    // (the mock delivers results via queueMicrotask).
    expect(
      execFileCalls.filter(c => c.args.includes('find-generic-password')),
    ).toHaveLength(2)
    expect(
      execFileCalls.filter(c => c.args.includes('show-keychain-info')),
    ).toHaveLength(1)
    await mod.ensureKeychainPrefetchCompleted()
  })
})
