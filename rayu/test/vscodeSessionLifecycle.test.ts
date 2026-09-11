/**
 * Session lifecycle against a scripted engine child.
 *
 * ── WHY A FAKE ENGINE RATHER THAN THE REAL ONE ─────────────────────────────────
 *
 * The properties under test are all about the ORDER and PRESENCE of control requests the
 * host sends around a spawn: that a permission mode chosen before the child existed is
 * replayed onto it, and that starting a second session does not tear the first one down.
 * The real engine can demonstrate those too, but only at ~60s per assertion and only when
 * a VSIX has been built. A scripted child records every frame it receives, which is
 * exactly the observation these tests need and is deterministic.
 *
 * The child speaks the real NDJSON control protocol — `control_request` in,
 * `control_response` out with a matching `request_id` — so the transport, the correlation
 * and the timeout paths are the production ones. Only the engine's BEHAVIOUR is scripted.
 */
import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('vscode', () => ({
  window: { showQuickPick: () => Promise.resolve(undefined) },
  workspace: { workspaceFolders: [] },
}))

const { ChatSession } = await import('../src/vscode/host/panel/sessionHandle.js')
const { permissionModeById } = await import('../src/vscode/shared/permissionModes.js')
const { sessionCallbacks, until } = await import('./helpers/vscodeSession.js')

/**
 * A child that answers `initialize` and every other request with success, and appends one
 * JSON line per received frame to `logPath`.
 *
 * `refuse` names a subtype to answer with an error, so the "engine rejected the mode"
 * branch can be exercised without disabling bypass in real settings.
 */
function writeFakeEngine(dir: string, options: { refuse?: string } = {}): {
  enginePath: string
  logPath: string
} {
  const enginePath = join(dir, 'engine.mjs')
  const logPath = join(dir, 'frames.log')
  writeFileSync(
    enginePath,
    `import { appendFileSync } from 'node:fs'
const LOG = ${JSON.stringify(logPath)}
const REFUSE = ${JSON.stringify(options.refuse ?? null)}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    appendFileSync(LOG, JSON.stringify({ argv: process.argv.slice(2), frame }) + '\\n')
    if (frame.type !== 'control_request') continue
    const subtype = frame.request?.subtype
    if (subtype === REFUSE) {
      process.stdout.write(JSON.stringify({
        type: 'control_response',
        response: { subtype: 'error', request_id: frame.request_id, error: 'refused by fixture' },
      }) + '\\n')
      continue
    }
    const payload = subtype === 'initialize'
      ? { commands: [], models: [], agents: [] }
      : subtype === 'get_settings'
        ? { inference: { supportsEffort: false, supportedLevels: [], effort: null, effortEnvOverride: null, supportsThinking: true, thinkingEnabled: true } }
        : {}
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: frame.request_id, response: payload },
    }) + '\\n')
  }
})
// Keep the child alive until it is killed, as the real engine does.
setInterval(() => {}, 1000)
`,
    'utf8',
  )
  return { enginePath, logPath }
}

function framesFrom(logPath: string): Array<{ argv: string[]; frame: any }> {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
}

const dirs: string[] = []
const sessions: Array<{ dispose: () => void }> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-lifecycle-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('a permission mode chosen before the engine exists is replayed onto it', async () => {
  const dir = tempDir()
  const { enginePath, logPath } = writeFakeEngine(dir)
  const session = new ChatSession(
    { enginePath, cwd: dir, nodePath: process.execPath },
    sessionCallbacks(),
  )
  sessions.push(session)

  // Exactly the reported sequence: pick Full access on a cold panel, THEN start.
  expect(await session.setPermissionMode(permissionModeById('bypassPermissions'))).toBe(true)
  await session.warmup()
  await until(() =>
    framesFrom(logPath).some(entry => entry.frame.request?.subtype === 'set_permission_mode'),
  )

  const requests = framesFrom(logPath)
    .map(entry => entry.frame.request)
    .filter(Boolean)
  const modes = requests.filter((r: any) => r.subtype === 'set_permission_mode')
  expect(modes).toHaveLength(1)
  expect(modes[0].mode).toBe('bypassPermissions')
  // Ordering matters: the mode has to be in force before the child can be handed a turn.
  expect(requests.findIndex((r: any) => r.subtype === 'initialize')).toBeLessThan(
    requests.findIndex((r: any) => r.subtype === 'set_permission_mode'),
  )
  expect(session.currentPermissionMode.id).toBe('bypassPermissions')
})

test('a refused replay falls back to the mode that is actually enforced', async () => {
  const dir = tempDir()
  const { enginePath, logPath } = writeFakeEngine(dir, { refuse: 'set_permission_mode' })
  const reported: string[] = []
  const errors: string[] = []
  const session = new ChatSession(
    { enginePath, cwd: dir, nodePath: process.execPath },
    sessionCallbacks({
      onPermissionMode: mode => reported.push(mode.id),
      onError: message => errors.push(message),
    }),
  )
  sessions.push(session)

  await session.setPermissionMode(permissionModeById('bypassPermissions'))
  await session.warmup()
  await until(() =>
    framesFrom(logPath).some(entry => entry.frame.request?.subtype === 'set_permission_mode'),
  )
  await until(() => reported.length > 0)

  // The pill must not be left claiming a mode the engine rejected.
  expect(session.currentPermissionMode.id).toBe('default')
  expect(reported).toEqual(['default'])
  expect(errors.join(' ')).toContain('Full access')
})

test('the mode survives an engine replacement', async () => {
  const dir = tempDir()
  const { enginePath, logPath } = writeFakeEngine(dir)
  const session = new ChatSession(
    { enginePath, cwd: dir, nodePath: process.execPath },
    sessionCallbacks(),
  )
  sessions.push(session)

  await session.warmup()
  await session.setPermissionMode(permissionModeById('acceptEdits'))
  // Starting a new conversation replaces the child. Nothing about that is a mode change,
  // so the previously accepted mode has to be re-established on the replacement.
  session.newSession()
  await session.warmup()
  await until(
    () =>
      framesFrom(logPath).filter(
        entry => entry.frame.request?.subtype === 'set_permission_mode',
      ).length >= 2,
  )

  const modes = framesFrom(logPath)
    .map(entry => entry.frame.request)
    .filter((r: any) => r?.subtype === 'set_permission_mode')
  expect(modes.map((r: any) => r.mode)).toEqual(['acceptEdits', 'acceptEdits'])
  expect(session.currentPermissionMode.id).toBe('acceptEdits')
})


test('a subagent tool call is attributed to the Task that spawned it', () => {
  const dir = tempDir()
  const { enginePath } = writeFakeEngine(dir)
  const session = new ChatSession(
    { enginePath, cwd: dir, nodePath: process.execPath },
    sessionCallbacks(),
  )
  sessions.push(session)

  // Exactly the shape the engine streams: the Task call itself has no parent, and every
  // frame the subagent produces carries the Task's tool_use id as `parent_tool_use_id`.
  session.restoreTranscript([
    {
      kind: 'tool_use',
      toolUseId: 'task-1',
      parentToolUseId: null,
      name: 'Task',
      label: 'review the diff',
      parameters: '{}',
    },
    {
      kind: 'tool_use',
      toolUseId: 'read-1',
      parentToolUseId: 'task-1',
      name: 'Read',
      label: 'src/a.ts',
      parameters: '{}',
    },
  ])

  const tools = session.transcript.filter(entry => entry.kind === 'tool')
  expect(tools).toHaveLength(2)
  // The main-thread call carries no badge: "agent: main" on every row would be noise.
  expect(tools[0]).toMatchObject({ name: 'Task' })
  expect(tools[0]?.kind === 'tool' && tools[0].agent).toBeUndefined()
  expect(tools[1]).toMatchObject({ name: 'Read', agent: 'Task · review the diff' })
})

test('a subagent call whose parent was trimmed away still says it is a subagent', () => {
  const dir = tempDir()
  const { enginePath } = writeFakeEngine(dir)
  const session = new ChatSession(
    { enginePath, cwd: dir, nodePath: process.execPath },
    sessionCallbacks(),
  )
  sessions.push(session)

  // Restoring a long session keeps only the tail, so the spawning Task can be missing. The
  // row must not claim to be main-thread work.
  session.restoreTranscript([
    {
      kind: 'tool_use',
      toolUseId: 'read-1',
      parentToolUseId: 'task-gone',
      name: 'Read',
      label: 'src/a.ts',
      parameters: '{}',
    },
  ])

  expect(session.transcript.filter(e => e.kind === 'tool')[0]).toMatchObject({
    agent: 'Subagent',
  })
})


// ── THE REGISTRY ─────────────────────────────────────────────────────────────
//
// The reported bug was that pressing + killed the turn that was running. These assert the
// property that fixes it — several engines alive at once — and the two things that made the
// single-session design leak between conversations: a shared model selection, and a shared
// permission router.

const { SessionRegistry, MAX_LIVE_SESSIONS } = await import(
  '../src/vscode/host/panel/sessionRegistry.js'
)

/** A registry over the scripted engine, with the pushes recorded instead of posted. */
function makeRegistry(dir: string) {
  const { enginePath, logPath } = writeFakeEngine(dir)
  const posts: string[] = []
  const shown: string[] = []
  const activations: string[] = []
  const registry = new SessionRegistry(
    { enginePath, cwd: dir, nodePath: process.execPath },
    {
      sessionCallbacks: (entry, isActive) =>
        sessionCallbacks({
          onEntry: () => {
            if (isActive()) posts.push(`entry:${entry.key}`)
          },
          onPermissionRequest: request => entry.permissions.present(request),
        }),
      onShowPermission: request => shown.push(request.requestId),
      onDismissPermission: requestId => shown.splice(shown.indexOf(requestId), 1),
      onChanged: () => {},
      onActivate: entry => activations.push(entry.key),
    },
  )
  return { registry, logPath, posts, shown, activations }
}

test('opening a session leaves the previous one alive and running', async () => {
  const dir = tempDir()
  const { registry, activations } = makeRegistry(dir)
  sessions.push(registry)

  const first = registry.create()
  await first.session.warmup()
  expect(first.session.controlClient).not.toBeNull()

  const second = registry.create()
  await second.session.warmup()

  // The whole point: two engines, both connected, the first NOT torn down.
  expect(registry.all).toHaveLength(2)
  expect(first.session.controlClient).not.toBeNull()
  expect(second.session.controlClient).not.toBeNull()
  expect(registry.activeSessionKey).toBe(second.key)
  expect(activations).toEqual([first.key, second.key])
})

test('switching back activates the existing engine instead of respawning it', async () => {
  const dir = tempDir()
  const { registry, activations } = makeRegistry(dir)
  sessions.push(registry)

  const first = registry.create()
  await first.session.warmup()
  const control = first.session.controlClient
  registry.create()

  registry.activate(first.key)

  expect(registry.activeSessionKey).toBe(first.key)
  // The SAME control client, i.e. the same child. A respawn is what used to lose the turn.
  expect(first.session.controlClient).toBe(control)
  expect(activations[activations.length - 1]).toBe(first.key)
})

test('only the active session writes to the panel', async () => {
  const dir = tempDir()
  const { registry, posts } = makeRegistry(dir)
  sessions.push(registry)

  const first = registry.create()
  first.session.restoreTranscript([{ kind: 'prompt', text: 'first' }])
  const second = registry.create()
  second.session.restoreTranscript([{ kind: 'prompt', text: 'second' }])
  // Appended while it is in the BACKGROUND: the transcript still grows, the panel is not told.
  first.session.restoreTranscript([{ kind: 'prompt', text: 'more first' }])

  expect(posts).toEqual([`entry:${first.key}`, `entry:${second.key}`])
  // The state is retained regardless, which is what makes activation a plain resync.
  expect(first.session.transcript).toHaveLength(2)
})

test('a background approval is not shown, and is not answered either', async () => {
  const dir = tempDir()
  const { registry, shown } = makeRegistry(dir)
  sessions.push(registry)

  const first = registry.create()
  registry.create()

  // A card raised by a background conversation. Suppressing it is correct — the user is
  // looking elsewhere — but it must NOT be auto-answered: that would grant or refuse consent
  // nobody gave. The engine stays blocked and the live list reports it.
  first.permissions.present({
    requestId: 'req-1',
    request: { tool_name: 'Bash', input: { command: 'rm -rf /' } },
  } as never)

  expect(shown).toEqual([])
  expect(first.permissions.hasPending).toBe(true)
  expect(registry.summaries().find(s => s.key === first.key)?.pendingApprovals).toBe(1)

  // Switching to it is what surfaces the card, through the state snapshot.
  expect(first.permissions.snapshot()).toHaveLength(1)
})

test('each session keeps its own model selection', async () => {
  const dir = tempDir()
  const { registry } = makeRegistry(dir)
  sessions.push(registry)

  const first = registry.create()
  await first.session.warmup()
  await first.session.setModel('model-a')
  const second = registry.create()
  await second.session.warmup()
  await second.session.setModel('model-b')

  // Reading back through the registry's own summary, which is what the list shows. The
  // previous design re-read a GLOBAL config on every session change, so selecting a model in
  // one conversation silently moved the other one onto it.
  const summaries = registry.summaries()
  expect(summaries.find(s => s.key === first.key)?.model).toBe('model-a')
  expect(summaries.find(s => s.key === second.key)?.model).toBe('model-b')
})

test('the live list reports the running flag for a background conversation', async () => {
  const dir = tempDir()
  const { registry } = makeRegistry(dir)
  sessions.push(registry)

  const first = registry.create()
  await first.session.warmup()
  // Submitting without awaiting leaves the turn in flight, which is the state the user needs
  // to see from the OTHER conversation.
  void first.session.submitPrompt('do something slow')
  await until(() => first.session.isTurnRunning)
  registry.create()

  expect(registry.summaries().find(s => s.key === first.key)?.running).toBe(true)
})

test('capacity never retires a session that is still working', async () => {
  const dir = tempDir()
  const { registry } = makeRegistry(dir)
  sessions.push(registry)

  const busy = registry.create()
  await busy.session.warmup()
  void busy.session.submitPrompt('slow')
  await until(() => busy.session.isTurnRunning)

  for (let index = 0; index < MAX_LIVE_SESSIONS + 2; index += 1) registry.create()

  // The cap is a resource guard. Honouring it by killing a running turn would reintroduce the
  // exact bug the registry exists to fix, so the cap is exceeded instead.
  expect(registry.all.some(entry => entry.key === busy.key)).toBe(true)
  expect(busy.session.isTurnRunning).toBe(true)
})

test('closing the visible conversation leaves another one visible', async () => {
  const dir = tempDir()
  const { registry } = makeRegistry(dir)
  sessions.push(registry)

  const first = registry.create()
  const second = registry.create()
  registry.close(second.key)

  expect(registry.activeSessionKey).toBe(first.key)

  // Closing the last one must still leave something to type into rather than an empty panel.
  registry.close(first.key)
  expect(registry.all).toHaveLength(1)
  expect(registry.activeSessionKey).toBe(registry.all[0]!.key)
})
