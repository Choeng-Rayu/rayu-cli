/**
 * The `/agent` command: argument parsing, subcommand dispatch, and rendering.
 *
 * `parse` and `dispatch` are exported specifically so they are reachable from
 * here — `call` sits behind a build-time `feature()` gate that is always false
 * when running from source, so testing through it would test nothing.
 *
 * The parsing rule that matters most: `send` and `steer` take FREE TEXT. A prompt
 * containing `--verbose` must reach the agent, not be rejected as an unknown flag.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { dispatch, parse } from '../src/commands/agent/agent.ts'
import {
  AGENT_USAGE,
  formatAgentList,
  formatApprovals,
  formatChangedFiles,
  formatInspection,
} from '../src/commands/agent/render.ts'
import {
  registerAdapter,
  resetAdapterRegistry,
} from '../src/externalAgents/core/adapterRegistry.ts'
import {
  createStubAdapter,
  type StubHandle,
} from '../src/externalAgents/adapters/stub/StubAdapter.ts'
import {
  assign,
  inspectAgent,
  listLiveAgents,
  pendingCount,
  resetAgentManager,
  startAgent,
} from '../src/externalAgents/core/AgentManager.ts'
import { resetEventBus } from '../src/externalAgents/core/eventBus.ts'
import {
  recordFileChange,
  resetChangeTracker,
} from '../src/externalAgents/workspace/changeTracker.ts'
import { resetWorkspaceManager } from '../src/externalAgents/workspace/workspaceManager.ts'
import { resetPermissionBroker } from '../src/externalAgents/permissions/permissionBroker.ts'
import {
  asProviderId,
  type AgentInstanceId,
  type FileChangedEvent,
} from '../src/externalAgents/core/types.ts'
import type { PendingApproval } from '../src/externalAgents/permissions/permissionBroker.ts'
import type { AgentHandle } from '../src/externalAgents/core/adapter.ts'

const STUB = asProviderId('stub')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-cmd-'))
  process.env.RAYU_CONFIG_DIR = dir
  resetAdapterRegistry()
  resetAgentManager()
  resetChangeTracker()
  resetWorkspaceManager()
  resetPermissionBroker()
  resetEventBus()
})
afterEach(() => {
  resetAdapterRegistry()
  resetAgentManager()
  resetChangeTracker()
  resetWorkspaceManager()
  resetPermissionBroker()
  resetEventBus()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

async function launch(
  options: Parameters<typeof createStubAdapter>[0] = {},
): Promise<AgentHandle> {
  registerAdapter(createStubAdapter({ provider: STUB, ...options }))
  return startAgent({ provider: STUB, cwd: dir })
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('argument parsing', () => {
  test('a bare invocation defaults to the READ-ONLY list', () => {
    // So a mistyped invocation never launches or kills a process.
    expect(parse('').subcommand).toBe('list')
    expect(parse('   ').subcommand).toBe('list')
  })

  test('the subcommand is case-insensitive', () => {
    expect(parse('DISCOVER').subcommand).toBe('discover')
    expect(parse('Inspect codex:agent_01').subcommand).toBe('inspect')
  })

  test('positionals and flags are separated', () => {
    const parsed = parse('start codex --cwd /repo --model gpt-5 --worktree --exclusive')
    expect(parsed.positional).toEqual(['codex'])
    expect(parsed.flags.cwd).toBe('/repo')
    expect(parsed.flags.model).toBe('gpt-5')
    expect(parsed.flags.worktree).toBe(true)
    expect(parsed.flags.exclusive).toBe(true)
    expect(parsed.flags.unknown).toBeUndefined()
  })

  test('boolean flags default to false', () => {
    const flags = parse('start codex').flags
    expect(flags.worktree).toBe(false)
    expect(flags.exclusive).toBe(false)
    expect(flags.removeWorktree).toBe(false)
    expect(flags.show).toBe(false)
  })

  test('--remove-worktree and --show are recognized', () => {
    expect(parse('stop codex:agent_01 --remove-worktree').flags.removeWorktree).toBe(
      true,
    )
    expect(parse('approvals --show').flags.show).toBe(true)
  })

  test('an unknown flag is captured rather than ignored', () => {
    expect(parse('start codex --turbo').flags.unknown).toBe('Unknown flag --turbo')
  })

  test('a value flag with no value is reported', () => {
    expect(parse('start codex --cwd').flags.unknown).toContain('--cwd needs a value')
    // A following flag is not swallowed as the value.
    const parsed = parse('start codex --cwd --worktree')
    expect(parsed.flags.unknown).toContain('--cwd needs a value')
    expect(parsed.flags.worktree).toBe(true)
  })

  test('only the FIRST problem is reported', () => {
    expect(parse('start codex --a --b').flags.unknown).toBe('Unknown flag --a')
  })

  test('send takes free text VERBATIM, flags and all', () => {
    // `--verbose` belongs to the agent's prompt, not to /agent.
    const parsed = parse('send codex:agent_01 run tests with --verbose  and  spacing')
    expect(parsed.positional).toEqual(['codex:agent_01'])
    expect(parsed.rest).toBe('run tests with --verbose  and  spacing')
    expect(parsed.flags.unknown).toBeUndefined()
  })

  test('steer is free text too', () => {
    const parsed = parse('steer codex:agent_01 also --fix the types')
    expect(parsed.rest).toBe('also --fix the types')
  })

  test('send with no prompt yields an empty rest', () => {
    expect(parse('send codex:agent_01').rest).toBe('')
    expect(parse('send').positional).toEqual([])
  })

  test('a multi-line prompt survives', () => {
    const parsed = parse('send codex:agent_01 line one\nline two')
    expect(parsed.rest).toBe('line one\nline two')
  })

  test('non-free-text subcommands collapse whitespace, which is fine for ids', () => {
    expect(parse('inspect   codex:agent_01  ').positional).toEqual([
      'codex:agent_01',
    ])
  })
})

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  const run = (raw: string) => dispatch(parse(raw))

  test('list with nothing connected points at discover', async () => {
    expect(await run('list')).toContain('/agent discover')
  })

  test('list shows all four state axes', async () => {
    // Collapsing them is exactly the confusion the state model prevents.
    const handle = await launch()
    const output = await run('list')
    expect(output).toContain(handle.agentId)
    expect(output).toContain('process running')
    expect(output).toContain('connection connected')
    expect(output).toContain('provider stub')
  })

  test('help renders the usage block', async () => {
    expect(await run('help')).toBe(AGENT_USAGE)
  })

  test('an unknown subcommand names it and shows usage', async () => {
    const output = await run('teleport')
    expect(output).toContain('Unknown subcommand "teleport"')
    expect(output).toContain('Usage: /agent')
  })

  test('a subcommand needing an agent says which agent when none is given', async () => {
    for (const subcommand of ['inspect', 'send', 'interrupt', 'stop', 'files']) {
      const output = await run(subcommand)
      expect(output.toLowerCase()).toContain('which agent')
    }
  })

  test('an unknown agent id points at discover when nothing is connected', async () => {
    expect(await run('inspect codex:agent_01')).toContain('/agent discover')
  })

  test('an unknown agent id lists what IS connected', async () => {
    const handle = await launch()
    const output = await run('inspect nope:agent_01')
    expect(output).toContain('Connected:')
    expect(output).toContain(handle.agentId)
  })

  test('a unique PREFIX resolves, so the user need not retype the full id', async () => {
    const handle = await launch()
    const output = await run('inspect stub')
    expect(output).toContain(handle.agentId)
  })

  test('an AMBIGUOUS prefix is refused with the candidates', async () => {
    // Picking one would send work to an agent the user did not mean.
    registerAdapter(createStubAdapter({ provider: STUB }))
    const first = await startAgent({ provider: STUB, cwd: dir })
    const second = await startAgent({ provider: STUB, cwd: dir })
    const output = await run('inspect stub')
    expect(output).toContain('matches')
    expect(output).toContain(first.agentId)
    expect(output).toContain(second.agentId)
    expect(output).toContain('Use the full id')
  })

  test('send dispatches and reports what admission decided', async () => {
    const handle = await launch()
    const output = await run(`send ${handle.agentId} fix the tests`)
    expect((handle as unknown as StubHandle).sent).toEqual([
      { input: { text: 'fix the tests' }, taskRef: undefined },
    ])
    expect(output).toContain(`Sent to ${handle.agentId}`)
    expect(output).toContain('turn turn_1')
  })

  test('send with no text explains the usage rather than sending empty', async () => {
    const handle = await launch()
    const output = await run(`send ${handle.agentId}`)
    expect(output).toContain('Nothing to send')
    expect((handle as unknown as StubHandle).sent).toEqual([])
  })

  test('send to a busy agent reports the queue rather than claiming success', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    const output = await run(`send ${handle.agentId} second`)
    expect(output.toLowerCase()).toContain('queue')
    expect(pendingCount(handle.agentId)).toBe(1)
  })

  test('steer injects into the running turn', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'first' })
    await run(`steer ${handle.agentId} also do this`)
    expect((handle as unknown as StubHandle).steered).toEqual([
      { turnId: 'turn_1', input: { text: 'also do this' } },
    ])
  })

  test('interrupt cancels the active turn', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'work' })
    expect(await run(`interrupt ${handle.agentId}`)).toContain('Interrupted')
    expect((handle as unknown as StubHandle).interrupted).toEqual(['turn_1'])
  })

  test('stop stops the agent and reports the worktree decision', async () => {
    const handle = await launch()
    const output = await run(`stop ${handle.agentId}`)
    expect(output).toContain(`Stopped ${handle.agentId}`)
    expect(listLiveAgents()).toEqual([])
  })

  test('inspect renders the capability matrix', async () => {
    const handle = await launch({ capabilities: { messages: 'message' } })
    const output = await run(`inspect ${handle.agentId}`)
    expect(output).toContain('capabilities')
    expect(output).toContain('\u2713 sendMessage')
    expect(output).toContain('\u2717 steer')
  })

  test('files reports nothing tracked for a fresh agent', async () => {
    const handle = await launch()
    expect(await run(`files ${handle.agentId}`)).toContain(
      'has not reported any file changes',
    )
  })

  test('files lists what the tracker recorded', async () => {
    const handle = await launch()
    const change: FileChangedEvent = {
      type: 'file_changed',
      agentId: handle.agentId,
      path: 'src/auth.ts',
      change: 'modified',
      at: Date.now(),
      seq: 1,
    }
    recordFileChange(change, dir)
    const output = await run(`files ${handle.agentId}`)
    expect(output).toContain('touched 1 file')
    expect(output).toContain('src/auth.ts')
  })

  test('conflicts reports the empty case honestly', async () => {
    expect(await run('conflicts')).toContain('No overlapping file changes')
  })

  test('workspaces reports the empty case', async () => {
    expect(await run('workspaces')).toBe('No external agent workspaces.')
  })

  test('approvals reports the empty case', async () => {
    expect(await run('approvals')).toContain('No external agent is waiting')
  })

  test('approvals --show with nothing pending still reports the list', async () => {
    expect(await run('approvals --show')).toContain('No external agent is waiting')
  })

  test('recover with no records says so', async () => {
    expect(await run('recover')).toContain('No external agents from previous sessions')
  })

  test('recover with an unmatched id says so rather than acting', async () => {
    const output = await run('recover codex:agent_99')
    expect(output).toContain('No external agents from previous sessions')
  })

  test('start with no provider asks which one', async () => {
    expect(await run('start')).toContain('Which provider?')
  })

  test('start launches into the requested directory', async () => {
    registerAdapter(createStubAdapter({ provider: STUB }))
    const output = await run(`start stub --cwd ${dir}`)
    expect(output).toContain('Started stub:agent_01')
    expect(output).toContain(dir)
    expect(output).toContain('/agent send stub:agent_01')
    expect(listLiveAgents()).toHaveLength(1)
  })

  test('start with a missing directory refuses BEFORE launching', async () => {
    // Otherwise a missing cwd surfaces as ENOENT on the executable, which reads
    // as "agent not installed".
    registerAdapter(createStubAdapter({ provider: STUB }))
    const output = await run(`start stub --cwd ${join(dir, 'nope')}`)
    expect(output).toContain('does not exist')
    expect(listLiveAgents()).toEqual([])
  })

  test('start reports when exclusivity could not be granted', async () => {
    registerAdapter(createStubAdapter({ provider: STUB }))
    await run(`start stub --cwd ${dir} --exclusive`)
    const output = await run(`start stub --cwd ${dir} --exclusive`)
    // The second agent is refused, naming the holder, rather than silently
    // sharing the directory.
    expect(output).toContain('exclusively held by stub:agent_01')
  })

  test('a failed launch releases the workspace it reserved', async () => {
    registerAdapter(createStubAdapter({ provider: STUB, failLaunch: true }))
    await expect(run(`start stub --cwd ${dir} --exclusive`)).rejects.toThrow(
      /stub launch failure/,
    )
    const { listWriteLeases } = await import(
      '../src/externalAgents/persistence/workspaceLease.ts'
    )
    expect(await listWriteLeases()).toEqual([])
  })

  test('adopt with no provider asks which one', async () => {
    expect(await run('adopt')).toContain('Which provider?')
  })

  test('adopt refuses an unknown provider', async () => {
    expect(await run('adopt nonesuch')).toContain('Nothing known about "nonesuch"')
  })

  test('adopt refuses a non-adoptable provider and passes the EVIDENCE through', async () => {
    // The evidence already explains why; inventing a shorter reason would lose
    // information the user needs.
    registerAdapter(createStubAdapter({ provider: STUB }))
    const output = await run('adopt stub')
    expect(output).toContain('not adoptable')
    expect(output).toContain('no provider-specific probe')
  })
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('rendering', () => {
  test('the agent list surfaces the turn, the queue, the pid and the session', async () => {
    const handle = await launch({ holdTurns: true })
    await assign(handle.agentId, { text: 'work' })
    await assign(handle.agentId, { text: 'queued' })
    const output = formatAgentList([handle], h => pendingCount(h.agentId))
    expect(output).toContain('turn turn_1 (regular)')
    expect(output).toContain('1 queued')
    expect(output).toContain(`pid ${process.pid}`)
    expect(output).toContain('session:')
  })

  test('the list omits the pid for an agent that has none', async () => {
    const handle = await launch({ withoutPid: true })
    expect(formatAgentList([handle], () => 0)).not.toContain('pid ')
  })

  test('inspection labels the operation matrix as declaration AND implementation', async () => {
    const handle = await launch()
    const output = formatInspection(await inspectAgent(handle.agentId))
    expect(output).toContain('declared capability AND implemented method')
  })

  test('changed files show repeat counts and diff availability', () => {
    const output = formatChangedFiles(
      'codex:agent_01',
      [
        {
          path: '/repo/src/a.ts',
          displayPath: 'src/a.ts',
          change: 'modified',
          firstChange: 'created',
          firstSeenMs: Date.now() - 5000,
          lastSeenMs: Date.now(),
          count: 3,
          hasDiff: true,
        },
      ],
      0,
    )
    expect(output).toContain('src/a.ts')
    expect(output).toContain('(3 edits)')
    expect(output).toContain('[diff available]')
  })

  test('an overflowed change list says the report is PARTIAL', () => {
    const output = formatChangedFiles(
      'codex:agent_01',
      [
        {
          path: '/a',
          displayPath: 'a',
          change: 'modified',
          firstChange: 'modified',
          firstSeenMs: 1,
          lastSeenMs: 2,
          count: 1,
          hasDiff: false,
        },
      ],
      7,
    )
    expect(output).toContain('7 further paths were not tracked')
    expect(output).toContain('partial')
  })

  test('approvals render the agent, the kind and how to bring them back', () => {
    const approval: PendingApproval = {
      agentId: 'codex:agent_01' as AgentInstanceId,
      requestId: 'req_1',
      toolUseID: 'x',
      provider: asProviderId('codex'),
      kind: 'command',
      description: 'run rm -rf build',
      cwd: '/repo',
      askedAtMs: Date.now(),
    }
    const output = formatApprovals([approval])
    expect(output).toContain('1 pending approval')
    expect(output).toContain('codex:agent_01  command')
    expect(output).toContain('run rm -rf build')
    expect(output).toContain('in /repo')
    expect(output).toContain('/agent approvals --show')
  })

  test('the usage block documents every dispatched subcommand', () => {
    // A subcommand that dispatch handles but usage omits is undiscoverable.
    for (const subcommand of [
      'list',
      'discover',
      'start',
      'adopt',
      'reconnect',
      'send',
      'steer',
      'interrupt',
      'stop',
      'inspect',
      'attach',
      'approvals',
      'workspaces',
      'conflicts',
      'files',
      'recover',
    ]) {
      expect(AGENT_USAGE).toContain(subcommand)
    }
  })
})
