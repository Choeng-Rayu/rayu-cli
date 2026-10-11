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
function writeFakeEngine(dir: string, options: {
  refuse?: string
  startupFailures?: number
  initializeDelayMs?: number
  exitOnPrompt?: boolean
  stderrSuffix?: string
} = {}): {
  enginePath: string
  logPath: string
  startsPath: string
} {
  const enginePath = join(dir, 'engine.mjs')
  const logPath = join(dir, 'frames.log')
  const startsPath = join(dir, 'starts.log')
  writeFileSync(
    enginePath,
    `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const LOG = ${JSON.stringify(logPath)}
const REFUSE = ${JSON.stringify(options.refuse ?? null)}
const STARTS = ${JSON.stringify(startsPath)}
const attempt = existsSync(STARTS) ? readFileSync(STARTS, 'utf8').trim().split('\\n').length + 1 : 1
appendFileSync(STARTS, process.pid + '\\n')
const crash = () => { process.stderr.write('fixture: provider profile is not ready\\n' + ${JSON.stringify(options.stderrSuffix ?? '')}); process.exit(23) }
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
    if (frame.type === 'user' && ${options.exitOnPrompt ?? false}) crash()
    if (frame.type !== 'control_request') continue
    const subtype = frame.request?.subtype
    if (subtype === 'initialize' && attempt <= ${options.startupFailures ?? 0}) crash()
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
    const respond = () => process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: frame.request_id, response: payload },
    }) + '\\n')
    if (subtype === 'initialize') setTimeout(respond, ${options.initializeDelayMs ?? 0})
    else respond()
  }
})
// Keep the child alive until it is killed, as the real engine does.
setInterval(() => {}, 1000)
`,
    'utf8',
  )
  return { enginePath, logPath, startsPath }
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

test('first prompt and concurrent warmups preserve a startup crash once in the transcript', async () => {
  const dir = tempDir()
  const { enginePath, logPath } = writeFakeEngine(dir, {
    startupFailures: 1,
    stderrSuffix: '    at fixtureStartup (engine.mjs:1:1)\n'.repeat(30),
  })
  const errors: string[] = []
  const session = new ChatSession(
    { enginePath, cwd: dir, nodePath: process.execPath },
    sessionCallbacks({ onError: message => errors.push(message) }),
  )
  sessions.push(session)

  await Promise.all([session.warmup(), session.warmup(), session.submitPrompt('hi')])

  const notices = session.transcript.filter(entry => entry.kind === 'notice')
  expect(notices).toHaveLength(1)
  expect(notices[0]?.severity).toBe('error')
  expect(notices[0]?.text).toContain('code 23')
  expect(notices[0]?.text).toContain('fixture: provider profile is not ready')
  expect(errors).toHaveLength(1)
  expect(errors[0]).not.toContain('engine is not running')
  expect(session.controlClient).toBeNull()
  expect(session.isTurnRunning).toBe(false)
  expect(framesFrom(logPath).filter(entry => entry.frame.type === 'user')).toHaveLength(0)

  // A failed first child must not poison this extension window until VS Code reloads.
  await session.submitPrompt('hi again')
  await until(() => framesFrom(logPath).some(entry => entry.frame.type === 'user'))
  expect(framesFrom(logPath).filter(entry => entry.frame.type === 'user')).toHaveLength(1)
  expect(errors).toHaveLength(1)
  expect(session.controlClient).not.toBeNull()
})

test('a refused initialize fails startup instead of delivering a prompt to an unready engine', async () => {
  const dir = tempDir()
  const { enginePath, logPath } = writeFakeEngine(dir, { refuse: 'initialize' })
  const session = new ChatSession(
    { enginePath, cwd: dir, nodePath: process.execPath },
    sessionCallbacks(),
  )
  sessions.push(session)
  await Promise.all([session.warmup(), session.submitPrompt('hi')])
  const notices = session.transcript.filter(entry => entry.kind === 'notice')
  expect(notices).toHaveLength(1)
  expect(notices[0]?.severity).toBe('error')
  expect(notices[0]?.text).toContain('refused by fixture')
  expect(framesFrom(logPath).filter(entry => entry.frame.type === 'user')).toHaveLength(0)
  expect(session.controlClient).toBeNull()
  expect(session.isTurnRunning).toBe(false)
})

test('first prompt shares warmup and waits for login preparation before spawning', async () => {
  const dir = tempDir()
  const { enginePath, logPath, startsPath } = writeFakeEngine(dir, { initializeDelayMs: 75 })
  let finishPreparation!: () => void
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve })
  let preparations = 0
  const session = new ChatSession({
    enginePath, cwd: dir, nodePath: process.execPath,
    prepareStartup: () => { preparations++; return preparation },
  }, sessionCallbacks())
  sessions.push(session)
  const pending = Promise.all([session.warmup(), session.warmup(), session.submitPrompt('hi')])
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(session.isTurnRunning).toBe(true)
  expect(existsSync(startsPath)).toBe(false)
  finishPreparation()
  await pending
  await until(() => framesFrom(logPath).some(entry => entry.frame.type === 'user'))
  expect(preparations).toBe(1)
  expect(readFileSync(startsPath, 'utf8').trim().split('\n')).toHaveLength(1)
  const frames = framesFrom(logPath)
  expect(frames.filter(entry => entry.frame.request?.subtype === 'initialize')).toHaveLength(1)
  expect(frames.filter(entry => entry.frame.type === 'user')).toHaveLength(1)
  expect(frames.at(-1)?.frame).toMatchObject({ type: 'user', message: { content: 'hi' } })
})

test.each([
  ['login', 'dispose'], ['login', 'newSession'],
  ['environment', 'dispose'], ['environment', 'newSession'],
] as const)('no child spawns during %s preparation after %s', async (phase, action) => {
  const dir = tempDir()
  const { enginePath, startsPath } = writeFakeEngine(dir)
  let finishPreparation!: () => void
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve })
  let requested = false
  const prepare = async () => { requested = true; await preparation }
  const session = new ChatSession({
    enginePath, cwd: dir, nodePath: process.execPath,
    ...(phase === 'login' ? { prepareStartup: prepare } : {
      resolveEnv: async () => { await prepare(); return {} },
    }),
  }, sessionCallbacks())
  sessions.push(session)
  const pending = session.warmup()
  await until(() => requested)
  session[action]()
  finishPreparation()
  await pending
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(existsSync(startsPath)).toBe(false)
  expect(session.controlClient).toBeNull()
})

test('late startup preparation from a replaced session cannot overwrite its new engine', async () => {
  const dir = tempDir()
  const { enginePath, logPath, startsPath } = writeFakeEngine(dir)
  let finishOldEnvironment!: (value: Record<string, string>) => void
  const oldEnvironment = new Promise<Record<string, string>>(resolve => { finishOldEnvironment = resolve })
  let preparations = 0
  const session = new ChatSession({
    enginePath, cwd: dir, nodePath: process.execPath,
    resolveEnv: () => ++preparations === 1 ? oldEnvironment : Promise.resolve({}),
  }, sessionCallbacks())
  sessions.push(session)
  const oldWarmup = session.warmup()
  await until(() => preparations === 1)
  session.newSession()
  await session.warmup()
  const newControl = session.controlClient
  finishOldEnvironment({})
  await oldWarmup
  expect(session.controlClient).toBe(newControl)
  await session.submitPrompt('hi')
  await until(() => framesFrom(logPath).some(entry => entry.frame.type === 'user'))
  expect(readFileSync(startsPath, 'utf8').trim().split('\n')).toHaveLength(1)
  expect(session.transcript.filter(entry => entry.kind === 'notice')).toHaveLength(0)
})

test('a crash after startup keeps the underlying stderr in the visible transcript', async () => {
  const dir = tempDir()
  const { enginePath } = writeFakeEngine(dir, { exitOnPrompt: true })
  const errors: string[] = []
  const session = new ChatSession({ enginePath, cwd: dir, nodePath: process.execPath },
    sessionCallbacks({ onError: message => errors.push(message) }))
  sessions.push(session)
  await session.warmup()
  await session.submitPrompt('hi')
  await until(() => errors.length > 0)
  const notices = session.transcript.filter(entry => entry.kind === 'notice')
  expect(notices).toHaveLength(1)
  expect(notices[0]?.severity).toBe('error')
  expect(notices[0]?.text).toContain('fixture: provider profile is not ready')
})

test('a permission mode chosen before the engine exists is replayed onto it', async () => {
  const dir = tempDir()
  const { enginePath, logPath } = writeFakeEngine(dir)
  const session = new ChatSession(
    { enginePath, cwd: dir, nodePath: process.execPath },
    sessionCallbacks(),
  )
  sessions.push(session)

  // Exactly the reported sequence: pick Full Manage on a cold panel, THEN start.
  expect(await session.setPermissionMode(permissionModeById('fullManage'))).toBe(true)
  await session.warmup()
  await until(() =>
    framesFrom(logPath).some(entry => entry.frame.request?.subtype === 'set_permission_mode'),
  )

  const requests = framesFrom(logPath)
    .map(entry => entry.frame.request)
    .filter(Boolean)
  const modes = requests.filter((r: any) => r.subtype === 'set_permission_mode')
  expect(modes).toHaveLength(1)
  expect(modes[0].mode).toBe('fullManage')
  // Ordering matters: the mode has to be in force before the child can be handed a turn.
  expect(requests.findIndex((r: any) => r.subtype === 'initialize')).toBeLessThan(
    requests.findIndex((r: any) => r.subtype === 'set_permission_mode'),
  )
  expect(session.currentPermissionMode.id).toBe('fullManage')
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

  await session.setPermissionMode(permissionModeById('fullManage'))
  await session.warmup()
  await until(() =>
    framesFrom(logPath).some(entry => entry.frame.request?.subtype === 'set_permission_mode'),
  )
  await until(() => reported.length > 0)

  // The pill must not be left claiming a mode the engine rejected.
  expect(session.currentPermissionMode.id).toBe('default')
  expect(reported).toEqual(['default'])
  expect(errors.join(' ')).toContain('Full Manage')
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
      details: [],
    },
    {
      kind: 'tool_use',
      toolUseId: 'read-1',
      parentToolUseId: 'task-1',
      name: 'Read',
      label: 'src/a.ts',
      parameters: '{}',
      details: [],
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
      details: [],
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
  const shown: Array<{ key: string; requestId: string }> = []
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
      // The callbacks carry their OWNING entry and fire unconditionally: a background
      // conversation's card belongs in ITS tab, so the active key no longer gates it.
      onShowPermission: (entry, request) =>
        shown.push({ key: entry.key, requestId: request.requestId }),
      onDismissPermission: (_entry, requestId) => {
        const index = shown.findIndex(card => card.requestId === requestId)
        if (index !== -1) shown.splice(index, 1)
      },
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

test('a resumed conversation is recognized as open before its engine sends a frame', () => {
  const dir = tempDir()
  const { registry } = makeRegistry(dir)
  sessions.push(registry)

  const resumed = registry.create({ resumeSessionId: 'history-session-123' })

  // The session list uses this id to hide the duplicate history row, and the resume handler
  // uses it to activate this entry instead of spawning another child.
  expect(resumed.session.engineSessionId).toBe('history-session-123')
  expect(registry.findByEngineSessionId('history-session-123')).toBe(resumed)
  expect(registry.summaries()).toContainEqual(expect.objectContaining({
    key: resumed.key,
    sessionId: 'history-session-123',
  }))
})

test('an open conversation keeps its custom name when switching away and back', () => {
  const dir = tempDir()
  const { registry } = makeRegistry(dir)
  sessions.push(registry)
  const first = registry.create()
  first.session.restoreTranscript([{ kind: 'prompt', text: 'Original prompt' }])
  expect(registry.setTitle(first.key, 'Canva research')).toBe(true)
  const second = registry.create()
  registry.activate(first.key)
  expect(registry.summaries().find(item => item.key === first.key)?.label).toBe('Canva research')
  expect(registry.summaries().find(item => item.key === second.key)?.label).toBe('New conversation')
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

test('a background approval is shown on ITS conversation, and is not auto-answered', async () => {
  const dir = tempDir()
  const { registry, shown } = makeRegistry(dir)
  sessions.push(registry)

  const first = registry.create()
  registry.create()

  // A card raised by a background conversation is routed to THAT conversation — a background
  // tab must render its own card. It is never suppressed, but it must also NOT be
  // auto-answered: that would grant or refuse consent nobody gave. The engine stays blocked
  // and the live list reports it.
  first.permissions.present({
    requestId: 'req-1',
    request: { tool_name: 'Bash', input: { command: 'rm -rf /' } },
  } as never)

  expect(shown).toEqual([{ key: first.key, requestId: 'req-1' }])
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


test('a new engine starts with the thinking choice persisted now, not at construction', async () => {
  // Thinking is a product-wide choice. A conversation created before another one turned
  // thinking off used to spawn its engine with `--thinking enabled` regardless, because it
  // only read the profile once, when it was created.
  const dir = tempDir()
  const { enginePath, logPath } = writeFakeEngine(dir)
  const savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  try {
    const preferences = join(dir, 'rayucode-preferences.json')
    writeFileSync(preferences, JSON.stringify({ thinkingEnabled: true }))
    const session = new ChatSession(
      { enginePath, cwd: dir, nodePath: process.execPath },
      sessionCallbacks(),
    )
    sessions.push(session)

    writeFileSync(preferences, JSON.stringify({ thinkingEnabled: false }))
    await session.warmup()
    await until(() => framesFrom(logPath).length > 0)

    const argv = framesFrom(logPath)[0]!.argv
    expect(argv[argv.indexOf('--thinking') + 1]).toBe('disabled')
  } finally {
    if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
  }
})
