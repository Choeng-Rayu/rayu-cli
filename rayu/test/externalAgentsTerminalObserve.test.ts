/**
 * Terminal hosting refusals, Claude Code transcript observation, Codex control
 * socket detection, and process scanning.
 *
 * ## Why the tmux-dependent paths are NOT faked here
 *
 * tmux is not installed in this environment, and there is no honest way to fake
 * it from inside the test process:
 *
 *   - `tmuxSession.ts` calls `spawnSync(TMUX_COMMAND, …)` WITHOUT an explicit
 *     `env`, so the command is resolved from a PATH snapshot taken when the
 *     process started. Adding a directory to `process.env.PATH` afterwards is
 *     invisible to it. (That is correct for production, where PATH is fixed.)
 *   - `TMUX_COMMAND` is an exported `const` string, which the bundler may inline
 *     at the import site, so `mock.module` cannot reliably redirect it either.
 *   - Writing a file named `tmux` into a directory already on the real PATH would
 *     risk shadowing a tool the user depends on. Not an acceptable trade.
 *
 * So what is covered here is the honest half: every path RAYU takes when tmux is
 * ABSENT, which is the path most users on a fresh machine will hit. Session
 * creation, send-keys and a live `tmux attach` against a real TTY remain
 * unverified by automated tests and are called out as such in the final report;
 * the argv those functions construct is asserted separately and purely in
 * `externalAgentsDiscoveryTerminal.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  canHostAgentTerminals,
  hasAgentSession,
  listAgentSessions,
} from '../src/externalAgents/terminal/tmuxSession.ts'
import {
  attachToAgentTerminal,
  describeAttachFallback,
  isAttachSupported,
} from '../src/externalAgents/terminal/attach.ts'
import {
  describeTerminalOptions,
  listHostedTerminals,
  provisionAgentTerminal,
  releaseAgentTerminal,
} from '../src/externalAgents/terminal/index.ts'
import {
  encodeProjectDirName,
  findClaudeTranscriptsForCwd,
  getClaudeProjectsDir,
  listClaudeTranscripts,
  looksRecentlyActive,
  readTranscriptTail,
} from '../src/externalAgents/adapters/claudeCode/observe.ts'
import {
  findProcessesNamed,
  isProcessScanSupported,
  scanProcesses,
} from '../src/externalAgents/core/processScan.ts'
import {
  getCodexControlSocketPath,
  hasCodexControlSocket,
} from '../src/externalAgents/adapters/codex/CodexAdapter.ts'
import type { AgentInstanceId } from '../src/externalAgents/core/types.ts'

const AGENT = 'codex:agent_01' as AgentInstanceId

let dir: string
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-term-'))
  savedEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
  }
  process.env.RAYU_CONFIG_DIR = join(dir, 'config')
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete process.env.RAYU_CONFIG_DIR
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Behaviour with no tmux
// ---------------------------------------------------------------------------

describe('terminal hosting without tmux', () => {
  test('reports that it cannot host agent terminals', async () => {
    expect(await canHostAgentTerminals()).toBe(false)
  })

  test('attach is unsupported, and the reason is actionable', async () => {
    expect(await isAttachSupported()).toBe(false)
    const fallback = describeAttachFallback()
    expect(fallback).toContain('tmux')
    // Names the alternative rather than only stating the problem.
    expect(fallback).toContain('event view')
  })

  test('no session exists for any agent', () => {
    expect(hasAgentSession(AGENT)).toBe(false)
  })

  test('listing sessions is empty rather than an error', async () => {
    // A socket with no server exits non-zero; that means "none", not "broken".
    expect(await listAgentSessions()).toEqual([])
  })

  test('describeTerminalOptions reports what is genuinely available', async () => {
    const options = await describeTerminalOptions()
    // No tmux → no full-screen attach and no side-by-side pane.
    expect(options.canAttach).toBe(false)
    expect(options.canSplit).toBe(false)
    // The streamed event view needs nothing, so it is always offered.
    expect(options.canStreamEvents).toBe(true)
    expect(options.note).toBeTruthy()
  })

  test('provisioning returns null instead of a name that would not work', () => {
    // A caller must be able to tell that no terminal was hosted, so it can fall
    // back to the streamed event view.
    expect(
      provisionAgentTerminal({ agentId: AGENT, cwd: dir, command: 'codex' }),
    ).toBeNull()
  })

  test('no terminals are hosted', async () => {
    expect(await listHostedTerminals()).toEqual([])
  })

  test('releasing a terminal that was never hosted is safe', async () => {
    await expect(releaseAgentTerminal(AGENT)).resolves.toBeDefined()
  })

  test('attach REFUSES with a reportable reason, never throws', async () => {
    const result = await attachToAgentTerminal(AGENT)
    expect(result.attached).toBe(false)
    if (result.attached) return
    // "tmux is not installed" is a normal situation, not an exception.
    expect(result.fallback).toBe('install-tmux')
    expect(result.reason).toContain('tmux')
  })

  test('every attach outcome is a value, so callers have one code path', async () => {
    for (const agentId of [AGENT, 'opencode:agent_09' as AgentInstanceId]) {
      const result = await attachToAgentTerminal(agentId)
      expect(typeof result.attached).toBe('boolean')
      if (!result.attached) {
        expect(['event-view', 'install-tmux', 'start-agent']).toContain(
          result.fallback,
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Claude Code transcript observation
// ---------------------------------------------------------------------------

describe('claude code transcript observation', () => {
  let claudeDir: string

  beforeEach(() => {
    claudeDir = join(dir, 'claude')
    process.env.CLAUDE_CONFIG_DIR = claudeDir
  })

  /** Write a rollout, optionally back-dated. */
  function transcript(
    project: string,
    sessionId: string,
    lines: unknown[],
    ageMs = 0,
  ): string {
    const projectDir = join(claudeDir, 'projects', project)
    mkdirSync(projectDir, { recursive: true })
    const path = join(projectDir, `${sessionId}.jsonl`)
    writeFileSync(path, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs)
      utimesSync(path, when, when)
    }
    return path
  }

  test('the projects dir follows CLAUDE_CONFIG_DIR', () => {
    expect(getClaudeProjectsDir()).toBe(join(claudeDir, 'projects'))
  })

  test('a machine with no Claude Code returns nothing rather than throwing', async () => {
    // Absence is the normal case, not an error.
    expect(await listClaudeTranscripts()).toEqual([])
    expect(await findClaudeTranscriptsForCwd('/home/u/repo')).toEqual([])
  })

  test('encodes a cwd the way Claude Code does', () => {
    expect(encodeProjectDirName('/home/u/my.project')).toBe('-home-u-my-project')
    expect(encodeProjectDirName('C:\\work\\repo')).toBe('C:-work-repo')
  })

  test('lists transcripts newest first, with session id and size', async () => {
    transcript('-home-u-old', 'sess-old', [{ type: 'user' }], 60_000)
    transcript('-home-u-new', 'sess-new', [{ type: 'user' }])
    const found = await listClaudeTranscripts()
    expect(found.map(t => t.sessionId)).toEqual(['sess-new', 'sess-old'])
    expect(found[0]!.project).toBe('-home-u-new')
    expect(found[0]!.sizeBytes).toBeGreaterThan(0)
  })

  test('ignores files that are not rollouts', async () => {
    const projectDir = join(claudeDir, 'projects', '-home-u-repo')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'notes.txt'), 'hello')
    writeFileSync(join(projectDir, 'sess.jsonl'), '{}\n')
    expect((await listClaudeTranscripts()).map(t => t.sessionId)).toEqual(['sess'])
  })

  test('prefers an exact encoded-name match for a cwd', async () => {
    transcript('-home-u-repo', 'mine', [{ a: 1 }])
    transcript('-home-u-other', 'theirs', [{ a: 1 }])
    expect(
      (await findClaudeTranscriptsForCwd('/home/u/repo')).map(t => t.sessionId),
    ).toEqual(['mine'])
  })

  test('an encoding change DEGRADES ordering rather than hiding everything', async () => {
    // Filtering on the encoded name alone would silently return nothing if Claude
    // Code changed how it encodes paths.
    transcript('some-unexpected-encoding', 'still-found', [{ a: 1 }])
    expect(
      (await findClaudeTranscriptsForCwd('/home/u/repo')).map(t => t.sessionId),
    ).toEqual(['still-found'])
  })

  test('recency is a labelled heuristic, with a configurable window', async () => {
    // Rollout mtime is the only signal available without a control channel, and
    // it is used to DESCRIBE an observable instance, never to claim control.
    transcript('-p', 'fresh', [{ a: 1 }])
    transcript('-p', 'stale', [{ a: 1 }], 10 * 60 * 1000)
    const all = await listClaudeTranscripts()
    const fresh = all.find(t => t.sessionId === 'fresh')!
    const stale = all.find(t => t.sessionId === 'stale')!
    expect(looksRecentlyActive(fresh)).toBe(true)
    expect(looksRecentlyActive(stale)).toBe(false)
    expect(looksRecentlyActive(stale, 30 * 60 * 1000)).toBe(true)
  })

  test('reads only the TAIL of a long rollout', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ n: i }))
    transcript('-p', 'long', lines)
    const [found] = await listClaudeTranscripts()
    const tail = await readTranscriptTail(found!, 5)
    expect(tail).toHaveLength(5)
    expect(tail[4]).toEqual({ n: 199 })
  })

  test('a byte-window slice never hands the parser a partial line', async () => {
    // The first line inside the window is dropped because it may start mid-line.
    const lines = Array.from({ length: 50 }, (_, i) => ({
      n: i,
      pad: 'x'.repeat(200),
    }))
    transcript('-p', 'wide', lines)
    const [found] = await listClaudeTranscripts()
    const tail = await readTranscriptTail(found!, 100, 2_000)
    expect(tail.length).toBeGreaterThan(0)
    for (const entry of tail) {
      expect(entry).toHaveProperty('n')
    }
  })

  test('a corrupt rollout yields what is parseable rather than throwing', async () => {
    const projectDir = join(claudeDir, 'projects', '-p')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'mixed.jsonl'), '{"ok":1}\nnot json\n{"ok":2}\n')
    const [found] = await listClaudeTranscripts()
    expect(await readTranscriptTail(found!)).toEqual([{ ok: 1 }, { ok: 2 }])
  })

  test('a vanished transcript returns nothing rather than throwing', async () => {
    transcript('-p', 'gone', [{ a: 1 }])
    const [found] = await listClaudeTranscripts()
    rmSync(found!.path)
    expect(await readTranscriptTail(found!)).toEqual([])
  })

  test('observation NEVER writes to Claude Code’s state', async () => {
    // Mutating a live agent's rollout would be a good way to corrupt a user's
    // session, so this whole module is read-only by construction.
    const path = transcript('-p', 'readonly', [{ a: 1 }])
    const before = readFileSync(path, 'utf-8')
    const [found] = await listClaudeTranscripts()
    await readTranscriptTail(found!)
    await findClaudeTranscriptsForCwd('/whatever')
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Codex control socket detection
// ---------------------------------------------------------------------------

describe('codex control socket detection', () => {
  test('the socket path follows CODEX_HOME', () => {
    const codexHome = join(dir, 'codex')
    process.env.CODEX_HOME = codexHome
    expect(getCodexControlSocketPath()).toBe(
      join(codexHome, 'app-server-control', 'app-server-control.sock'),
    )
  })

  test('absence means RAYU cannot adopt', () => {
    // A `codex` started without --listen has no socket, so it is observable at
    // best — never adoptable.
    process.env.CODEX_HOME = join(dir, 'codex')
    expect(hasCodexControlSocket()).toBe(false)
  })

  test('presence is what makes an adopt attempt meaningful', () => {
    // The socket is authoritative for "an app-server is listening", which is
    // exactly what adopt connects to.
    const codexHome = join(dir, 'codex')
    process.env.CODEX_HOME = codexHome
    mkdirSync(join(codexHome, 'app-server-control'), { recursive: true })
    writeFileSync(getCodexControlSocketPath(), '')
    expect(hasCodexControlSocket()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Process scanning
// ---------------------------------------------------------------------------

describe('process scanning', () => {
  test('is supported on this platform', () => {
    expect(isProcessScanSupported()).toBe(true)
  })

  test('finds this very process, with a usable command line', async () => {
    const processes = await scanProcesses()
    expect(processes.length).toBeGreaterThan(0)
    const self = processes.find(p => p.pid === process.pid)
    expect(self).toBeDefined()
    expect(self!.command.length).toBeGreaterThan(0)
    // The name is a lowercased basename, so matching does not depend on how the
    // binary was invoked.
    expect(self!.name).toBe(self!.name.toLowerCase())
    expect(self!.name).not.toContain('/')
  })

  test('every entry has a real pid and no kernel threads', async () => {
    for (const entry of await scanProcesses()) {
      expect(Number.isInteger(entry.pid)).toBe(true)
      expect(entry.pid).toBeGreaterThan(0)
      // Kernel threads have an empty cmdline and are skipped.
      expect(entry.command.trim().length).toBeGreaterThan(0)
    }
  })

  test('name matching is case-insensitive and covers the command line', async () => {
    const processes = await scanProcesses()
    for (const match of await findProcessesNamed('bun', { processes })) {
      expect(`${match.name} ${match.command}`.toLowerCase()).toContain('bun')
    }
  })

  test('a name nothing is running under yields nothing', async () => {
    expect(
      await findProcessesNamed('definitely-not-a-real-binary-xyz', {
        processes: await scanProcesses(),
      }),
    ).toEqual([])
  })

  test('a supplied snapshot is reused rather than rescanned', async () => {
    // Discovery scans once and hands the snapshot to every probe, so three
    // providers do not mean three scans.
    const snapshot = [
      { pid: 4242, command: '/usr/bin/codex app-server', name: 'codex' },
    ]
    expect(await findProcessesNamed('codex', { processes: snapshot })).toEqual(
      snapshot,
    )
  })
})
