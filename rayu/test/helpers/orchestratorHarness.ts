/**
 * Drives the REAL engine, from source, headless over stream-json — the same protocol
 * Rayucode speaks — against a scripted model, in a throwaway git repository.
 *
 * Everything is hermetic: a temp HOME, a temp RAYU_CONFIG_DIR with its own
 * providers.json, and a copy of a fixture project committed into a fresh repo. Only the
 * model is fake (./scriptedProvider.ts); tools, permissions, subagents and background
 * tasks are the engine's own.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startScriptedProvider, type Script, type ScriptedProvider } from './scriptedProvider.js'

const ROOT = resolve(import.meta.dir, '../..')
const FIXTURES = resolve(import.meta.dir, '../fixtures')

/** The flags Rayucode always passes (src/entrypoints/vscodeHost.ts REQUIRED_FLAGS). */
const ENGINE_FLAGS = [
  '--print',
  '--input-format=stream-json',
  '--output-format=stream-json',
  '--verbose',
  '--permission-prompt-tool=stdio',
  '--allow-dangerously-skip-permissions',
] as const

export type EngineEvent = Record<string, any>

export type HarnessOptions = {
  script: Script
  /** A directory under test/fixtures, copied and committed as the project. */
  fixture?: string
  /** Launch permission mode. Defaults to Orchestrator. */
  permissionMode?: string
  /** Extra settings.json content for the session. */
  settings?: Record<string, unknown>
  env?: Record<string, string>
  /** Answer a `can_use_tool` request. Defaults to allowing it unchanged. */
  onPermissionRequest?: (request: EngineEvent) => Record<string, unknown>
}

export type EngineRun = {
  /** The project directory (a git repository). */
  dir: string
  configDir: string
  events: EngineEvent[]
  provider: ScriptedProvider
  /**
   * Send a user prompt and wait until the engine is idle again — background workers and
   * the turns their notifications start included. Resolves with the last `result`.
   */
  prompt: (text: string, timeoutMs?: number) => Promise<EngineEvent>
  /** Wait until the engine is idle after event index `from`; resolves with the last `result`. */
  settle: (from: number, timeoutMs?: number) => Promise<EngineEvent>
  /** Send a control request and wait for its response. */
  control: (request: Record<string, unknown>, timeoutMs?: number) => Promise<EngineEvent>
  waitFor: (predicate: (event: EngineEvent) => boolean, timeoutMs?: number) => Promise<EngineEvent>
  readFile: (path: string) => string
  /** Run a command in the project directory. */
  run: (command: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string }
  stderr: () => string
  close: () => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 90_000

export async function startOrchestratorRun(options: HarnessOptions): Promise<EngineRun> {
  const root = mkdtempSync(join(tmpdir(), 'rayu-orchestrator-'))
  const home = join(root, 'home')
  const configDir = join(root, 'config')
  const dir = join(root, 'project')
  mkdirSync(home)
  mkdirSync(configDir)
  const provider = await startScriptedProvider(options.script)
  writeConfig(configDir, provider.url, options.settings)
  const gitEnv = hermeticGitEnv(home)
  createProject(dir, options.fixture ?? 'orchestrator-app', gitEnv)

  const child = Bun.spawn(
    [
      process.execPath,
      '--preload', join(ROOT, 'scripts/preload.ts'),
      join(ROOT, 'src/entrypoints/cli.tsx'),
      ...ENGINE_FLAGS,
      '--permission-mode', options.permissionMode ?? 'orchestrator',
    ],
    {
      cwd: dir,
      env: {
        ...gitEnv,
        RAYU_CONFIG_DIR: configDir,
        RAYU_AUTH_CONFIG_DIR: configDir,
        USE_RAYU_OAUTH: 'false',
        RAYU_EXTERNAL_AGENTS: '0',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        // Headless start-up otherwise polls for an editor lockfile for ~30s
        // (`findAvailableIDE`, main.tsx) — there is no editor in a test.
        CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
        // Rayucode sets this (sessionHandle.ts): `session_state_changed: idle` is the
        // engine's authoritative "everything, background work included, is done".
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        // HOME is a fresh temp dir, which would also make Bun's transpiler cache cold
        // on every run. A stable location keeps engine start-up fast across tests.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tmpdir(), 'rayu-harness-transpiler-cache'),
        ...options.env,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const events: EngineEvent[] = []
  let stderrText = ''
  const write = (frame: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(frame)}\n`)
    child.stdin.flush()
  }
  const answerPermission = options.onPermissionRequest
    ?? ((request: EngineEvent) => ({ behavior: 'allow', updatedInput: request.request?.input ?? {} }))
  void readLines(child.stdout, line => {
    let event: EngineEvent
    try { event = JSON.parse(line) } catch { return }
    events.push(event)
    if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') {
      write({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: answerPermission(event) } })
    }
  })
  void readLines(child.stderr, line => { stderrText = `${stderrText}${line}\n`.slice(-50_000) })

  const waitFor = (predicate: (event: EngineEvent) => boolean, timeoutMs = DEFAULT_TIMEOUT_MS) =>
    waitForEvent(events, predicate, timeoutMs, () => stderrText)
  const settle = (from: number, timeoutMs = DEFAULT_TIMEOUT_MS) =>
    waitForIdle(events, from, timeoutMs, () => stderrText)

  return {
    dir,
    configDir,
    events,
    provider,
    async prompt(text, timeoutMs) {
      const from = events.length
      write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
      return settle(from, timeoutMs)
    },
    settle,
    async control(request, timeoutMs) {
      const requestId = randomUUID()
      write({ type: 'control_request', request_id: requestId, request })
      return waitFor(event => event.type === 'control_response' && event.response?.request_id === requestId, timeoutMs)
    },
    waitFor,
    readFile: path => readFileSync(join(dir, path), 'utf8'),
    run: (command, args) => {
      const out = spawnSync(command, [...args], { cwd: dir, env: gitEnv, encoding: 'utf8' })
      return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
    },
    stderr: () => stderrText,
    async close() {
      try { child.stdin.end() } catch { /* already closed */ }
      const exited = await Promise.race([child.exited.then(() => true), sleep(15_000).then(() => false)])
      if (!exited) child.kill('SIGKILL')
      await provider.close()
      if (!process.env.RAYU_KEEP_HARNESS_DIR) rmSync(root, { recursive: true, force: true })
    },
  }
}

function writeConfig(configDir: string, providerUrl: string, settings: Record<string, unknown> = {}): void {
  writeFileSync(join(configDir, 'providers.json'), JSON.stringify({
    activeProvider: 'test',
    providers: [{
      id: 'test',
      kind: 'openai-compatible',
      baseURL: providerUrl,
      apiKey: 'fixture-key',
      defaultModel: 'test-model',
      fetchedModels: ['test-model'],
      // Large on purpose: a small window would trigger compaction mid-scenario.
      modelContextWindows: { 'test-model': 1_000_000 },
    }],
  }), { mode: 0o600 })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ alwaysThinkingEnabled: false, ...settings }))
}

/** A minimal environment: no user git config, no inherited credentials. */
function hermeticGitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmpdir(),
    SHELL: process.env.SHELL ?? '/bin/bash',
    LANG: 'C.UTF-8',
    USER_TYPE: 'external',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  }
}

function createProject(dir: string, fixture: string, env: Record<string, string>): void {
  cpSync(join(FIXTURES, fixture), dir, { recursive: true })
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']]) {
    const out = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' })
    if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`)
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) onLine(line)
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer.trim()) onLine(buffer)
}

async function waitForEvent(
  events: readonly EngineEvent[],
  predicate: (event: EngineEvent) => boolean,
  timeoutMs: number,
  stderr: () => string,
): Promise<EngineEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found) return found
    await sleep(50)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for an engine event.\nLast events: ${JSON.stringify(events.slice(-5)).slice(0, 3000)}\nstderr tail: ${stderr().slice(-3000)}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const isIdle = (event: EngineEvent) =>
  event.type === 'system' && event.subtype === 'session_state_changed' && event.state === 'idle'

/** Anything after an `idle` that means another turn is under way. */
const isFurtherWork = (event: EngineEvent) =>
  event.type !== 'system' ||
  event.subtype === 'init' ||
  event.subtype === 'task_started' ||
  (event.subtype === 'session_state_changed' && event.state !== 'idle')

/** Quiet period after `idle` that proves no further turn was already on its way. */
const SETTLE_QUIET_MS = 400

/**
 * Wait for an `idle` after `from` that is not followed by more work, then return the
 * last `result`. Notifications from background workers can start further turns after a
 * `result`; only an idle with nothing behind it means the whole run is over.
 */
async function waitForIdle(
  events: readonly EngineEvent[],
  from: number,
  timeoutMs: number,
  stderr: () => string,
): Promise<EngineEvent> {
  const deadline = Date.now() + timeoutMs
  let searchFrom = from
  while (Date.now() < deadline) {
    const idleIndex = events.findIndex((event, index) => index >= searchFrom && isIdle(event))
    if (idleIndex === -1) { await sleep(50); continue }
    await sleep(SETTLE_QUIET_MS)
    const after = events.slice(idleIndex + 1)
    if (after.some(isFurtherWork)) {
      searchFrom = idleIndex + 1
      continue
    }
    const result = [...events.slice(from, idleIndex + 1)].reverse().find(event => event.type === 'result')
    if (result) return result
    searchFrom = idleIndex + 1
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for the engine to settle.\nLast events: ${JSON.stringify(events.slice(-5)).slice(0, 3000)}\nstderr tail: ${stderr().slice(-3000)}`)
}

/** Text the engine streamed as assistant output, in order. */
export function assistantText(events: readonly EngineEvent[]): string {
  return events
    .filter(event => event.type === 'assistant')
    .flatMap(event => (Array.isArray(event.message?.content) ? event.message.content : []))
    .filter((block: EngineEvent) => block.type === 'text')
    .map((block: EngineEvent) => block.text as string)
    .join('\n')
}
