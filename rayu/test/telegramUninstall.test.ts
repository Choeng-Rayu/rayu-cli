/**
 * Device lifecycle + remote uninstall suite (Tasks 14–17).
 *
 * This is the most dangerous code path in the bridge, so almost every test here
 * asserts a REFUSAL and then checks that nothing was destroyed.
 *
 * The invariant behind all of it: **Telegram can drive RAYU's named operations,
 * but Telegram must never become arbitrary shell access.** So there is no command
 * string anywhere in the request the helper receives, and four independent gates
 * stand between a chat message and a wiped machine:
 *   1. a local opt-in that defaults OFF and cannot be enabled from the chat;
 *   2. explicit device targeting (a bare `/uninstall` never resolves a device);
 *   3. a single-use confirmation code bound to user + chat + device;
 *   4. a concurrency lock during teardown.
 * Plus two more inside the helper: an HMAC over a key that only exists in argv,
 * and independent re-derivation of the removable scope.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

// ---------------------------------------------------------------------------
// Test doubles.
//
// The orchestrator and the device API are stubbed because the real ones would
// tear this machine down / hit the network. Telegram output is intercepted via
// the REAL hosted-router seam instead of `mock.module`, because mock.module is
// process-wide in Bun and stubbing telegramApi here would break every other
// telegram test file in the same run.
// ---------------------------------------------------------------------------

let sent: Array<{ chatId: number; text: string }> = []
let cards: Array<{ chatId: number; text: string }> = []
let startCalls: Array<{ requestId: string; origin: string; keepData?: boolean }> = []
let devices: Array<Record<string, unknown>> = []

/** A complete RemoteDevice as the backend would return it. */
function remoteDevice(deviceId: string, deviceName: string, online = true) {
  return {
    deviceId,
    deviceName,
    platform: 'linux',
    arch: 'x64',
    version: '1.0.0',
    status: online ? 'online' : 'offline',
    online,
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }
}

mock.module('../src/cli/uninstall/uninstallOrchestrator.ts', () => ({
  IPC_SHUTDOWN: 'rayu:shutdown',
  startUninstall: async (input: { requestId: string; origin: string }) => {
    startCalls.push(input)
    return 'started' as const
  },
  registerShutdownHandler: () => {},
}))

mock.module('../src/services/rayuAuth/rayuDevices.ts', () => ({
  DEVICE_HEARTBEAT_INTERVAL_MS: 60_000,
  listDevices: async () => devices,
  registerThisDevice: async () => null,
  heartbeatThisDevice: async () => null,
  setDeviceStatus: async () => null,
  unregisterDevice: async () => null,
  startDeviceHeartbeat: () => {},
  stopDeviceHeartbeat: () => {},
}))

const { setHostedRouter } = await import('../src/telegram/telegramApi.ts')

const {
  HELPER_REQUEST_VERSION,
  generateHelperKey,
  generateHelperNonce,
  signHelperRequest,
  verifyHelperRequest,
} = await import('../src/cli/uninstall/helperRequest.ts')

const { buildScopeManifest, isPathInScope, NEVER_REMOVED } = await import(
  '../src/cli/uninstall/scopeManifest.ts'
)

const {
  UNINSTALL_PROGRESS_STATES,
  UNINSTALL_TERMINAL_STATES,
  beginUninstallRun,
  describeUninstallRun,
  finishUninstallRun,
  isTerminal,
  isUninstallInProgress,
  readUninstallRun,
  recordUninstallStep,
} = await import('../src/cli/uninstall/uninstallState.ts')

const { getDeviceFacts, getDeviceIdentity, setDeviceName, _resetDeviceIdentityCache } =
  await import('../src/utils/deviceIdentity.ts')

const { isRemoteUninstallAllowed, setRemoteUninstallAllowed, writeTelegramConfig } =
  await import('../src/telegram/telegramConfig.ts')

const { handleUninstallCommand, handleUninstallCallback, CB_UNINSTALL_CANCEL, _resetUninstallConfirmation } =
  await import('../src/telegram/telegramUninstall.ts')

// ---------------------------------------------------------------------------
// Shared isolated-config harness
// ---------------------------------------------------------------------------

let configDir: string
const origConfigDir = process.env.RAYU_CONFIG_DIR
const origArgv1 = process.argv[1]

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'rayu-unin-'))
  process.env.RAYU_CONFIG_DIR = configDir
  // `isDevelopmentCheckout` correctly REFUSES to uninstall a source checkout, and
  // the test runner's entry is a .ts file. Present an installed-looking entry so
  // the non-development paths are reachable at all.
  process.argv[1] = '/opt/rayu/dist/rayu.js'
  sent = []
  cards = []
  startCalls = []
  devices = []
  // Capture outbound Telegram traffic through the real routing seam.
  setHostedRouter({
    getUpdates: async () => ({ kind: 'ok' as const, updates: [] }),
    call: async (method: string, params: Record<string, unknown>) => {
      const chatId = Number(params.chat_id ?? 0)
      const text = String(params.text ?? '')
      if (method === 'sendMessage') {
        sent.push({ chatId, text })
        if (params.reply_markup !== undefined) cards.push({ chatId, text })
      }
      return { message_id: sent.length }
    },
    botUsername: async () => 'rayu_shared_bot',
  })
  _resetDeviceIdentityCache()
  _resetUninstallConfirmation()
})

afterEach(() => {
  setHostedRouter(null)
  if (origConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = origConfigDir
  if (origArgv1 === undefined) delete process.argv[1]
  else process.argv[1] = origArgv1
  rmSync(configDir, { recursive: true, force: true })
})

// ===========================================================================
// Task 14 — device identity
// ===========================================================================

describe('device identity', () => {
  test('generates a stable id and persists it 0600', () => {
    const first = getDeviceIdentity()
    expect(first.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(first.deviceName.length).toBeGreaterThan(0)

    // Same process: memoised. Fresh read: same value from disk.
    expect(getDeviceIdentity().deviceId).toBe(first.deviceId)
    _resetDeviceIdentityCache()
    expect(getDeviceIdentity().deviceId).toBe(first.deviceId)

    if (process.platform !== 'win32') {
      expect(statSync(join(configDir, 'device.json')).mode & 0o777).toBe(0o600)
    }
  })

  test('the device id satisfies the backend DTO pattern', () => {
    // The backend validates /^[A-Za-z0-9_-]{8,64}$/ because the id is
    // client-generated AND appears in a URL path param.
    const { deviceId } = getDeviceIdentity()
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  })

  test('regenerates rather than throwing on a corrupt file', () => {
    writeFileSync(join(configDir, 'device.json'), 'not json')
    _resetDeviceIdentityCache()
    expect(() => getDeviceIdentity()).not.toThrow()
    expect(getDeviceIdentity().deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/)

    // A hand-edited file with the wrong shape is also replaced.
    writeFileSync(join(configDir, 'device.json'), JSON.stringify({ nope: 1 }))
    _resetDeviceIdentityCache()
    expect(getDeviceIdentity().deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  test('device names are sanitised and length-capped', () => {
    const updated = setDeviceName('  My <Laptop> & "Desk";rm -rf  ')
    expect(updated.deviceName).toMatch(/^[A-Za-z0-9 _-]*$/)
    expect(updated.deviceName.length).toBeLessThanOrEqual(60)

    const long = setDeviceName('x'.repeat(500))
    expect(long.deviceName.length).toBeLessThanOrEqual(60)
  })

  test('an empty or fully-stripped name falls back rather than becoming blank', () => {
    const stripped = setDeviceName('!!!@@@###')
    expect(stripped.deviceName.length).toBeGreaterThan(0)
  })

  test('facts are read live, not persisted into the identity file', () => {
    getDeviceIdentity()
    const stored: unknown = JSON.parse(readFileSync(join(configDir, 'device.json'), 'utf8'))
    // Platform/arch/version change when the user upgrades or moves the config
    // dir between machines; caching them would report stale facts forever.
    expect(Object.keys(stored as object)).not.toContain('platform')
    expect(Object.keys(stored as object)).not.toContain('version')

    const facts = getDeviceFacts()
    expect(facts.platform).toBe(process.platform)
    expect(facts.arch).toBe(process.arch)
  })
})

// ===========================================================================
// Task 15 — scope manifest
// ===========================================================================

describe('scope manifest', () => {
  test('lists remote-control state INDIVIDUALLY, before the whole config dir', () => {
    const manifest = buildScopeManifest('npm-global')
    const paths = manifest.map(a => a.path)

    // A --keep-data uninstall must still sever remote control: leaving
    // telegram.json behind leaves a linked chat pointed at a "clean" machine.
    for (const name of [
      'telegram.json',
      'telegram-attached.json',
      'telegram-bridge.lock',
      'device.json',
      'sessions',
      'uninstall-state.json',
    ]) {
      expect(paths).toContain(`${configDir}${sep}${name}`)
    }

    // The config dir is LAST, so a half-failed run has already removed the
    // individually-listed control files.
    expect(paths[paths.length - 1]).toBe(configDir)
    expect(manifest[manifest.length - 1]!.userData).toBe(true)
    expect(manifest.filter(a => a.userData)).toHaveLength(1)
  })

  test('includes the IPC socket directory, which lives outside the config dir', () => {
    // Sockets are deliberately not under the config dir, so a config-dir removal
    // would otherwise leave stale endpoints behind.
    const manifest = buildScopeManifest('npm-global')
    const socketEntry = manifest.find(a => a.label === 'Local IPC sockets')
    expect(socketEntry).toBeDefined()
    expect(socketEntry!.path.startsWith(configDir)).toBe(false)
  })

  test('only a native install lists binaries and version directories', () => {
    const native = buildScopeManifest('native').map(a => a.label)
    expect(native).toContain('rayu executable (user bin)')
    expect(native).toContain('Installed versions')

    const npm = buildScopeManifest('npm-global').map(a => a.label)
    // An npm-global install is removed by npm; aiming a file delete at a native
    // layout that this run never used would destroy an unrelated install.
    expect(npm).not.toContain('rayu executable (user bin)')
    expect(npm).not.toContain('Installed versions')
  })

  test('accepts manifest entries and paths CONTAINED by manifest directories', () => {
    const manifest = buildScopeManifest('npm-global')
    expect(isPathInScope(`${configDir}${sep}telegram.json`, manifest)).toBe(true)
    expect(isPathInScope(configDir, manifest)).toBe(true)
    expect(isPathInScope(`${configDir}${sep}sessions${sep}123.json`, manifest)).toBe(true)
    expect(isPathInScope(`${configDir}${sep}anything${sep}deep${sep}file`, manifest)).toBe(true)
  })

  test('REFUSES a sibling directory with a shared prefix', () => {
    // A plain startsWith would accept `<configDir>-evil`.
    const manifest = buildScopeManifest('npm-global')
    expect(isPathInScope(`${configDir}-evil`, manifest)).toBe(false)
    expect(isPathInScope(`${configDir}-evil${sep}secrets`, manifest)).toBe(false)
  })

  test.each([
    ['a traversal escape', 'not-a-path/../../../../etc/passwd'],
    ['an absolute foreign path', '/etc/passwd'],
    ['a home-relative project', '/home/dev/my-project'],
    ['an empty path', ''],
  ])('REFUSES %s', (_label, target) => {
    const manifest = buildScopeManifest('npm-global')
    expect(isPathInScope(target, manifest)).toBe(false)
  })

  test('REFUSES root and single-segment paths as removal TARGETS', () => {
    // Belt-and-braces: isObviouslyUnsafe fires on the target before the allowlist
    // is consulted, so even a manifest that recklessly named these cannot make
    // them removable. (A path CONTAINED by a named directory is still in scope —
    // that is correct allowlist behaviour, and the real protection is that
    // buildScopeManifest never names a directory like /usr.)
    const reckless = [
      { path: sep, kind: 'directory' as const, label: 'root', userData: false },
      { path: `${sep}usr`, kind: 'directory' as const, label: 'usr', userData: false },
    ]
    expect(isPathInScope(sep, reckless)).toBe(false)
    expect(isPathInScope(`${sep}usr`, reckless)).toBe(false)
  })

  test('REFUSES a bare home directory', () => {
    const home = process.env.HOME ?? process.env.USERPROFILE
    if (!home) return
    const reckless = [
      { path: home, kind: 'directory' as const, label: 'home', userData: false },
    ]
    expect(isPathInScope(home, reckless)).toBe(false)
  })

  test('publishes the promise about what is never touched', () => {
    expect(NEVER_REMOVED.join(' ')).toMatch(/projects|source code|git/i)
    expect(NEVER_REMOVED.join(' ')).toMatch(/shell configuration|bashrc|zshrc/i)
  })
})

// ===========================================================================
// Task 16 — signed helper request
// ===========================================================================

describe('helper request signing', () => {
  const key = generateHelperKey()
  const nonce = generateHelperNonce()

  function payload(over: Record<string, unknown> = {}) {
    return {
      version: HELPER_REQUEST_VERSION,
      requestId: 'req-1',
      nonce,
      createdAt: Date.now(),
      pids: [111, 222],
      paths: ['/home/dev/.rayu/telegram.json'],
      recursivePaths: [],
      reportPath: '/tmp/report.json',
      ...over,
    }
  }

  test('carries NO command string — only paths, pids and a package NAME', () => {
    const signed = signHelperRequest(payload({ npmPackage: '@rayu-dev/rayu-cli' }), key)
    const keys = Object.keys(signed)
    // If the helper could be told to "run this", it would be a general-purpose
    // RCE primitive reachable from a chat message.
    for (const forbidden of ['command', 'cmd', 'shell', 'exec', 'argv', 'script']) {
      expect(keys).not.toContain(forbidden)
    }
    expect(keys.sort()).toEqual(
      [
        'createdAt',
        'nonce',
        'npmPackage',
        'paths',
        'pids',
        'recursivePaths',
        'reportPath',
        'requestId',
        'signature',
        'version',
      ].sort(),
    )
  })

  test('verifies a correctly signed request', () => {
    const signed = signHelperRequest(payload(), key)
    const out = verifyHelperRequest(signed, key, nonce)
    expect(out.ok).toBe(true)
  })

  test('REJECTS a request whose paths were tampered with after signing', () => {
    const signed = signHelperRequest(payload(), key)
    const tampered = { ...signed, paths: ['/home/dev/precious-project'] }
    const out = verifyHelperRequest(tampered, key, nonce)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toBe('bad-signature')
  })

  test.each([
    ['pids', { pids: [999999] }],
    ['recursivePaths', { recursivePaths: ['/home/dev'] }],
    ['npmPackage', { npmPackage: 'something-else' }],
    ['reportPath', { reportPath: '/tmp/elsewhere.json' }],
    ['requestId', { requestId: 'req-2' }],
    ['createdAt', { createdAt: Date.now() - 5_000 }],
  ])('REJECTS a request with a tampered %s', (_field, over) => {
    const signed = signHelperRequest(payload(), key)
    const out = verifyHelperRequest({ ...signed, ...over }, key, nonce)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toBe('bad-signature')
  })

  test('REJECTS a request signed with a different key (a planted file)', () => {
    // The key exists only in argv for the lifetime of one spawn, so an attacker
    // who can write the request file still cannot produce a matching MAC.
    const signed = signHelperRequest(payload(), generateHelperKey())
    const out = verifyHelperRequest(signed, key, nonce)
    expect(out.ok === false && out.reason).toBe('bad-signature')
  })

  test('REJECTS a replayed request carrying a stale nonce', () => {
    const signed = signHelperRequest(payload(), key)
    const out = verifyHelperRequest(signed, key, generateHelperNonce())
    expect(out.ok === false && out.reason).toBe('nonce-mismatch')
  })

  test('REJECTS an expired request', () => {
    const signed = signHelperRequest(payload({ createdAt: Date.now() - 11 * 60_000 }), key)
    const out = verifyHelperRequest(signed, key, nonce)
    expect(out.ok === false && out.reason).toBe('expired')
  })

  test('REJECTS a version mismatch', () => {
    const signed = signHelperRequest(payload({ version: 99 }), key)
    const out = verifyHelperRequest(signed, key, nonce)
    expect(out.ok === false && out.reason).toBe('version-mismatch')
  })

  test.each([
    ['null', null],
    ['a string', 'nope'],
    ['a number', 7],
    ['an empty object', {}],
    ['a missing signature', { ...signHelperRequest({ version: HELPER_REQUEST_VERSION, requestId: 'r', nonce: 'n', createdAt: Date.now(), pids: [], paths: [], recursivePaths: [], reportPath: '/tmp/r' }, 'k'), signature: undefined }],
    ['non-string paths', { version: HELPER_REQUEST_VERSION, requestId: 'r', nonce: 'n', createdAt: Date.now(), pids: [], paths: [1, 2], recursivePaths: [], reportPath: '/tmp/r', signature: 'x' }],
    ['non-integer pids', { version: HELPER_REQUEST_VERSION, requestId: 'r', nonce: 'n', createdAt: Date.now(), pids: [1.5], paths: [], recursivePaths: [], reportPath: '/tmp/r', signature: 'x' }],
  ])('REJECTS %s as malformed, without throwing', (_label, raw) => {
    // Structure is validated BEFORE the MAC, so a malformed file never reaches
    // canonicalize() and throws on a missing field.
    let out: ReturnType<typeof verifyHelperRequest> | undefined
    expect(() => {
      out = verifyHelperRequest(raw, key, nonce)
    }).not.toThrow()
    expect(out!.ok).toBe(false)
  })

  test('the MAC is independent of key insertion order', () => {
    const base = payload()
    const reordered = {
      reportPath: base.reportPath,
      recursivePaths: base.recursivePaths,
      paths: base.paths,
      pids: base.pids,
      createdAt: base.createdAt,
      nonce: base.nonce,
      requestId: base.requestId,
      version: base.version,
    }
    // Otherwise verification would fail for reasons that look random.
    expect(signHelperRequest(base, key).signature).toBe(
      signHelperRequest(reordered, key).signature,
    )
  })

  test('array order does not change the MAC either', () => {
    const a = payload({ pids: [1, 2, 3], paths: ['/a', '/b'] })
    const b = payload({ pids: [3, 1, 2], paths: ['/b', '/a'], createdAt: a.createdAt })
    expect(signHelperRequest(a, key).signature).toBe(signHelperRequest(b, key).signature)
  })

  test('keys and nonces are unique per spawn', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateHelperKey()))
    const nonces = new Set(Array.from({ length: 100 }, () => generateHelperNonce()))
    expect(keys.size).toBe(100)
    expect(nonces.size).toBe(100)
  })
})

// ===========================================================================
// Task 16 — persisted state machine
// ===========================================================================

describe('uninstall state machine', () => {
  test('starts with no run, and reports no teardown in progress', () => {
    expect(readUninstallRun()).toBeNull()
    expect(isUninstallInProgress()).toBe(false)
  })

  test('persists a run 0600 so a later launch can report the outcome', () => {
    beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    const run = readUninstallRun()
    expect(run).toMatchObject({ requestId: 'r1', deviceId: 'd1', state: 'REQUESTED' })
    expect(isUninstallInProgress()).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(join(configDir, 'uninstall-state.json')).mode & 0o777).toBe(0o600)
    }
  })

  test('is IDEMPOTENT by requestId — a retried tap does not restart it', () => {
    const first = beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    recordUninstallStep('CONFIRMED', true)
    const again = beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })

    expect(again).not.toBeNull()
    expect(again!.startedAt).toBe(first!.startedAt)
    // Progress is preserved, so a duplicate update delivery cannot rewind it.
    expect(again!.state).toBe('CONFIRMED')
  })

  test('REFUSES a different run while one is in progress', () => {
    beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    // Two interleaved teardowns would produce an unreportable mess.
    expect(
      beginUninstallRun({ requestId: 'r2', deviceId: 'd1', origin: 'local', keepData: false }),
    ).toBeNull()
  })

  test('allows a new run once the previous one is terminal', () => {
    beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    finishUninstallRun('FAILED')
    expect(isUninstallInProgress()).toBe(false)
    const second = beginUninstallRun({ requestId: 'r2', deviceId: 'd1', origin: 'local', keepData: false })
    expect(second?.requestId).toBe('r2')
  })

  test('a failed step does NOT terminate the run', () => {
    beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    recordUninstallStep('STOPPING_SESSIONS', false, 'session 42 would not stop')
    // Several steps are best-effort; terminating here would lose the remaining
    // steps' results, and PARTIAL is decided once at the end.
    const run = readUninstallRun()!
    expect(isTerminal(run.state)).toBe(false)
    expect(run.state).toBe('STOPPING_SESSIONS')

    recordUninstallStep('DISCONNECTING', true)
    expect(readUninstallRun()!.steps).toHaveLength(2)
  })

  test('FORCES PARTIAL when files remain, even if COMPLETED was requested', () => {
    beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    recordUninstallStep('REMOVING_FILES', true)

    const run = finishUninstallRun('COMPLETED', ['/home/dev/.rayu/telegram.json'])

    // The caller cannot claim success against the evidence.
    expect(run!.state).toBe('PARTIAL')
    expect(run!.leftovers).toEqual(['/home/dev/.rayu/telegram.json'])
  })

  test('FORCES PARTIAL when any step failed, even with no leftovers', () => {
    beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    recordUninstallStep('STOPPING_SESSIONS', false, 'stubborn pid')
    recordUninstallStep('REMOVING_FILES', true)

    expect(finishUninstallRun('COMPLETED', [])!.state).toBe('PARTIAL')
  })

  test('allows COMPLETED only with no leftovers and no failed steps', () => {
    beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    recordUninstallStep('STOPPING_SESSIONS', true)
    recordUninstallStep('REMOVING_FILES', true)
    expect(finishUninstallRun('COMPLETED', [])!.state).toBe('COMPLETED')
  })

  test('does not upgrade an explicitly requested failure', () => {
    beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    recordUninstallStep('REMOVING_FILES', true)
    expect(finishUninstallRun('TIMEOUT', [])!.state).toBe('TIMEOUT')
    // Terminal, so a later step cannot revive it.
    expect(recordUninstallStep('UNREGISTERING_DEVICE', true)!.state).toBe('TIMEOUT')
  })

  test('classifies every state exactly once', () => {
    for (const state of UNINSTALL_PROGRESS_STATES) expect(isTerminal(state)).toBe(false)
    for (const state of UNINSTALL_TERMINAL_STATES) expect(isTerminal(state)).toBe(true)
    const overlap = UNINSTALL_PROGRESS_STATES.filter(s =>
      (UNINSTALL_TERMINAL_STATES as readonly string[]).includes(s),
    )
    expect(overlap).toEqual([])
  })

  test('surfaces the messy middle case in its description', () => {
    beginUninstallRun({ requestId: 'r1', deviceId: 'd1', origin: 'telegram', keepData: false })
    recordUninstallStep('STOPPING_SESSIONS', false, 'pid 42 would not stop')
    recordUninstallStep('REMOVING_FILES', true)
    const run = finishUninstallRun('COMPLETED', ['/home/dev/.rayu'])!

    const description = describeUninstallRun(run)
    // "Uninstalled: yes/no" cannot express three sessions running, two stopped,
    // one refusing to die, and files still on disk.
    expect(description).toContain('PARTIAL')
    expect(description).toContain('pid 42 would not stop')
    expect(description).toContain('/home/dev/.rayu')
    expect(description).toMatch(/1\/2 ok/)
  })

  test('a corrupt state file reads as "no run" instead of throwing', () => {
    writeFileSync(join(configDir, 'uninstall-state.json'), 'not json')
    expect(readUninstallRun()).toBeNull()
    expect(isUninstallInProgress()).toBe(false)
  })
})

// ===========================================================================
// Task 17 — the four gates
// ===========================================================================

describe('/uninstall gates', () => {
  const CHAT = 5555
  const USER = 777
  const lastMessage = (): string => sent[sent.length - 1]?.text ?? ''

  /** Nothing at all may have been started. */
  function expectNothingStarted(): void {
    expect(startCalls).toEqual([])
    expect(readUninstallRun()).toBeNull()
  }

  test('GATE 1: disabled by default — and reveals nothing about devices', async () => {
    devices = [
      remoteDevice('laptop-id', 'laptop'),
      remoteDevice('desktop-id', 'desktop'),
    ]
    expect(isRemoteUninstallAllowed()).toBe(false)

    await handleUninstallCommand('tok', CHAT, USER, '')

    expectNothingStarted()
    // Checked first, so an opted-out machine does not enumerate its devices.
    expect(lastMessage()).not.toContain('laptop')
    expect(lastMessage()).not.toContain('desktop')
  })

  test('GATE 1 FAILS CLOSED on a hand-edited truthy value', async () => {
    writeTelegramConfig({ allowRemoteUninstall: 'yes' as unknown as boolean })
    // Only `=== true` enables it; 'yes' is not a boolean and must not pass.
    expect(isRemoteUninstallAllowed()).toBe(false)

    await handleUninstallCommand('tok', CHAT, USER, '')
    expectNothingStarted()
  })

  test('the enable switch is a boolean and can be turned back off', () => {
    setRemoteUninstallAllowed(true)
    expect(isRemoteUninstallAllowed()).toBe(true)
    setRemoteUninstallAllowed(false)
    expect(isRemoteUninstallAllowed()).toBe(false)
  })

  test('GATE 2: a BARE /uninstall never resolves a device', async () => {
    setRemoteUninstallAllowed(true)
    devices = [remoteDevice(getDeviceIdentity().deviceId, 'only-machine')]

    await handleUninstallCommand('tok', CHAT, USER, '')

    // Convenience with one machine becomes wiping the WRONG machine with two.
    expectNothingStarted()
    expect(cards).toEqual([])
  })

  test('GATE 2: an unknown device name is refused', async () => {
    setRemoteUninstallAllowed(true)
    devices = [remoteDevice('laptop-id', 'laptop')]

    await handleUninstallCommand('tok', CHAT, USER, 'a-machine-that-does-not-exist')

    expectNothingStarted()
  })

  test('GATE 3: targeting this device issues a card with NO confirm button', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]

    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)

    expect(cards).toHaveLength(1)
    const card = cards[0]!.text
    expect(card).toMatch(/cannot be undone/i)
    // The promise about what is never touched is on the card, where it is read.
    expect(card).toMatch(/projects|source code/i)
    // Typing the code proves the card was read; a one-tap wipe is too easy to
    // hit by accident.
    expect(card).not.toMatch(/tap .*confirm/i)
    // Issuing a card must not itself start anything.
    expectNothingStarted()
  })

  test('GATE 3: a WRONG code is refused and starts nothing', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)

    await handleUninstallCommand('tok', CHAT, USER, 'confirm ZZZZZZ')

    expectNothingStarted()
  })

  test('GATE 3: attempts are BOUNDED and the code is burnt on exhaustion', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)
    const code = extractCode(cards[0]!.text)
    expect(code).toBeTruthy()

    for (let i = 0; i < 3; i++) {
      await handleUninstallCommand('tok', CHAT, USER, 'confirm WRONG1')
    }
    // Burnt: even the CORRECT code no longer works, so guessing cannot be
    // retried indefinitely against one card.
    await handleUninstallCommand('tok', CHAT, USER, `confirm ${code!}`)

    expectNothingStarted()
  })

  test('GATE 3: a valid code from the WRONG CHAT is refused', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)
    const code = extractCode(cards[0]!.text)!

    await handleUninstallCommand('tok', 9999, USER, `confirm ${code}`)

    // A forwarded or observed code cannot be replayed elsewhere.
    expectNothingStarted()
  })

  test('GATE 3: a valid code from the WRONG USER is refused', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)
    const code = extractCode(cards[0]!.text)!

    await handleUninstallCommand('tok', CHAT, 12345, `confirm ${code}`)

    expectNothingStarted()
  })

  test('GATE 3: the correct code from the right user and chat starts the teardown', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)
    const code = extractCode(cards[0]!.text)!

    await handleUninstallCommand('tok', CHAT, USER, `confirm ${code}`)

    expect(startCalls).toHaveLength(1)
    expect(startCalls[0]).toMatchObject({ origin: 'telegram' })
  })

  test('GATE 3: the code is SINGLE USE — a duplicate delivery cannot start twice', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)
    const code = extractCode(cards[0]!.text)!

    await handleUninstallCommand('tok', CHAT, USER, `confirm ${code}`)
    await handleUninstallCommand('tok', CHAT, USER, `confirm ${code}`)

    // Burnt BEFORE starting, so a retried tap cannot begin a second teardown.
    expect(startCalls).toHaveLength(1)
  })

  test('the confirmation code avoids visually ambiguous characters', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)
    const code = extractCode(cards[0]!.text)!
    // A mistyped destructive code is a bad experience; 0/O and 1/I are out.
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/)
  })

  test('Cancel clears the pending confirmation', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)
    const code = extractCode(cards[0]!.text)!

    expect(await handleUninstallCallback('tok', CHAT, CB_UNINSTALL_CANCEL)).toBe(true)
    await handleUninstallCommand('tok', CHAT, USER, `confirm ${code}`)

    expectNothingStarted()
  })

  test('a foreign callback is ignored, leaving the confirmation intact', async () => {
    setRemoteUninstallAllowed(true)
    expect(await handleUninstallCallback('tok', CHAT, 'perm:allow:1')).toBe(false)
    expect(await handleUninstallCallback('tok', CHAT, 'unin:something-else')).toBe(false)
    expectNothingStarted()
  })

  test('GATE 4: a teardown in progress locks out a new request', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    beginUninstallRun({ requestId: 'already-running', deviceId: id.deviceId, origin: 'local', keepData: false })

    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)

    expect(startCalls).toEqual([])
    expect(cards).toEqual([])
    // Reports progress rather than starting a second teardown.
    expect(readUninstallRun()!.requestId).toBe('already-running')
  })

  test('every refusal leaves the config directory intact', async () => {
    setRemoteUninstallAllowed(true)
    writeFileSync(join(configDir, 'precious.json'), '{"keep":true}')
    devices = [remoteDevice('other-id', 'other')]

    await handleUninstallCommand('tok', CHAT, USER, '')
    await handleUninstallCommand('tok', CHAT, USER, 'nope-not-a-device')
    await handleUninstallCommand('tok', CHAT, USER, 'confirm ZZZZZZ')

    expect(existsSync(join(configDir, 'precious.json'))).toBe(true)
    expect(existsSync(configDir)).toBe(true)
    expectNothingStarted()
  })

  test('refuses to uninstall a development checkout', async () => {
    setRemoteUninstallAllowed(true)
    const id = getDeviceIdentity()
    devices = [remoteDevice(id.deviceId, id.deviceName)]
    // A source checkout is someone's working tree, not an install.
    process.argv[1] = resolve(process.cwd(), 'src/entrypoints/cli.tsx')

    await handleUninstallCommand('tok', CHAT, USER, id.deviceName)

    expectNothingStarted()
  })
})

/** Pull the six-character confirmation code out of the card text. */
function extractCode(card: string): string | null {
  const match = /<code>([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4,12})<\/code>/.exec(card)
  if (match) return match[1] ?? null
  const bare = /\b([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6})\b/.exec(card)
  return bare ? (bare[1] ?? null) : null
}
