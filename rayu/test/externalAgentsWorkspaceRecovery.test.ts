/**
 * Workspace selection and crash recovery.
 *
 * Two decisions carry the weight here:
 *
 *   - `releaseWorkspace` PRESERVES a worktree unless removal is explicitly
 *     requested. A stopped agent's work is still on disk, and deleting it is the
 *     one mistake that cannot be undone.
 *   - `planRecovery` is READ-ONLY. It sweeps provably-dead records and then
 *     REPORTS a recommendation; it never relaunches a third-party process the
 *     user did not ask for in this session.
 *
 * Worktree CREATION is deliberately not exercised: `createAgentWorktree` leaves
 * an open handle behind (pre-existing, unrelated to this subsystem) which can
 * stop the test runner from exiting. The worktree-specific logic that IS testable
 * without git — slug derivation, release semantics, report rendering — is covered.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  formatWorkspaceReport,
  getWorkspace,
  listWorkspaces,
  prepareWorkspace,
  releaseWorkspace,
  resetWorkspaceManager,
  workspaceRootFor,
  worktreeSlugForAgent,
  type AgentWorkspace,
} from '../src/externalAgents/workspace/workspaceManager.ts'
import {
  installWorkspaceTracking,
  uninstallWorkspaceTracking,
} from '../src/externalAgents/workspace/install.ts'
import {
  getChangeSummary,
  listChangedFiles,
  resetChangeTracker,
} from '../src/externalAgents/workspace/changeTracker.ts'
import {
  applyRecovery,
  formatRecoveryReport,
  planRecovery,
  recordShutdownForensics,
  type RecoveryCandidate,
} from '../src/externalAgents/recovery/recover.ts'
import {
  listWriteLeases,
  tryAcquireWriteLease,
} from '../src/externalAgents/persistence/workspaceLease.ts'
import {
  patchAgentRecord,
  readAgentRecord,
  writeAgentRecord,
  type NewAgentRecordInput,
} from '../src/externalAgents/persistence/agentStore.ts'
import { writeAgentSessions } from '../src/externalAgents/persistence/agentStore.ts'
import {
  registerAdapter,
  resetAdapterRegistry,
} from '../src/externalAgents/core/adapterRegistry.ts'
import { createStubAdapter } from '../src/externalAgents/adapters/stub/StubAdapter.ts'
import {
  listLiveAgents,
  resetAgentManager,
  startAgent,
} from '../src/externalAgents/core/AgentManager.ts'
import { clearEventLog } from '../src/externalAgents/core/eventLog.ts'
import { installEventSinks } from '../src/externalAgents/core/eventSinks.ts'
import { resetEventBus } from '../src/externalAgents/core/eventBus.ts'
import { emitEvent } from '../src/externalAgents/core/normalizer.ts'
import {
  asProviderId,
  noCapabilities,
  type AgentInstanceId,
} from '../src/externalAgents/core/types.ts'

const STUB = asProviderId('stub')
const AGENT = 'stub:agent_01' as AgentInstanceId
const OTHER = 'stub:agent_02' as AgentInstanceId
const DEAD_PID = 0x7ffffffe

let dir: string
let workdir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-ws-'))
  workdir = mkdtempSync(join(tmpdir(), 'rayu-ext-work-'))
  process.env.RAYU_CONFIG_DIR = dir
  resetWorkspaceManager()
  resetChangeTracker()
  resetAdapterRegistry()
  resetAgentManager()
  resetEventBus()
})
afterEach(async () => {
  uninstallWorkspaceTracking()
  await clearEventLog(AGENT)
  resetWorkspaceManager()
  resetChangeTracker()
  resetAdapterRegistry()
  resetAgentManager()
  resetEventBus()
  rmSync(dir, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

function record(overrides: Partial<NewAgentRecordInput> = {}): NewAgentRecordInput {
  return {
    agentInstanceId: AGENT,
    provider: STUB,
    adoption: 'managed',
    durability: 'session-bound',
    capabilities: { ...noCapabilities(), messages: 'full', process: 'full' },
    transport: { kind: 'stdio' },
    cwd: workdir,
    pid: process.pid,
    processState: 'running',
    connectionState: 'connected',
    agentState: 'idle',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Worktree slugs
// ---------------------------------------------------------------------------

describe('worktree slugs', () => {
  test('sanitizes the colon a slug segment cannot contain', () => {
    const slug = worktreeSlugForAgent('codex:agent_01' as AgentInstanceId)
    expect(slug).not.toContain(':')
    expect(slug).toStartWith('rayu-agent-')
  })

  test('two ids that sanitize identically still get distinct slugs', () => {
    // Sanitizing alone would let these share one worktree.
    expect(worktreeSlugForAgent('codex:agent.01' as AgentInstanceId)).not.toBe(
      worktreeSlugForAgent('codex-agent-01' as AgentInstanceId),
    )
  })

  test('stays inside the 64-character segment budget', () => {
    const slug = worktreeSlugForAgent(`acp:${'x'.repeat(200)}` as AgentInstanceId)
    expect(slug.length).toBeLessThanOrEqual(64)
    expect(slug).toMatch(/-[0-9a-f]{6}$/)
  })

  test('is deterministic', () => {
    const id = 'codex:agent_01' as AgentInstanceId
    expect(worktreeSlugForAgent(id)).toBe(worktreeSlugForAgent(id))
  })
})

// ---------------------------------------------------------------------------
// Preparing a workspace
// ---------------------------------------------------------------------------

describe('preparing a shared workspace', () => {
  test('resolves the requested directory and defaults to shared', async () => {
    const result = await prepareWorkspace({ agentId: AGENT, cwd: workdir })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workspace.isolation).toBe('shared')
    expect(result.workspace.cwd).toBe(resolve(workdir))
    expect(result.workspace.exclusive).toBe(false)
    expect(result.workspace.worktree).toBeUndefined()
  })

  test('a missing directory is a reasoned result, not a throw', async () => {
    // Checked before spawning: a missing cwd otherwise surfaces as ENOENT on the
    // EXECUTABLE, which reads as "agent not installed".
    const result = await prepareWorkspace({
      agentId: AGENT,
      cwd: join(workdir, 'does-not-exist'),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unavailable')
    expect(result.message).toContain('does not exist')
  })

  test('re-preparing the same agent reuses its workspace', async () => {
    // A relaunch or reconnect must not create a second worktree for one logical
    // agent.
    const first = await prepareWorkspace({ agentId: AGENT, cwd: workdir })
    const second = await prepareWorkspace({
      agentId: AGENT,
      cwd: tmpdir(),
      isolation: 'worktree',
    })
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.workspace).toBe(first.workspace)
    expect(second.workspace.cwd).toBe(resolve(workdir))
  })

  test('an exclusive request takes the root lease', async () => {
    const result = await prepareWorkspace({
      agentId: AGENT,
      cwd: workdir,
      exclusive: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workspace.exclusive).toBe(true)
    // Leasing the ROOT is checked BEFORE an agent starts and works across RAYU
    // processes, unlike per-file leases which can only report after the fact.
    const leases = await listWriteLeases()
    expect(leases.map(l => l.path)).toEqual([resolve(workdir)])
  })

  test('a second agent asking for a held root is REFUSED with the holder named', async () => {
    await prepareWorkspace({ agentId: AGENT, cwd: workdir, exclusive: true })
    const result = await prepareWorkspace({
      agentId: OTHER,
      cwd: workdir,
      exclusive: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('locked')
    if (result.reason !== 'locked') return
    expect(result.heldBy).toBe(AGENT)
    expect(result.message).toContain('worktree isolation')
  })

  test('a NON-exclusive request may still share a leased root', async () => {
    // Overlap inside one shared directory stays detectable but is not prevented,
    // and the code does not imply otherwise.
    await prepareWorkspace({ agentId: AGENT, cwd: workdir, exclusive: true })
    const result = await prepareWorkspace({ agentId: OTHER, cwd: workdir })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.workspace.exclusive).toBe(false)
  })

  test('lookups and listings reflect what was prepared', async () => {
    await prepareWorkspace({ agentId: AGENT, cwd: workdir })
    expect(getWorkspace(AGENT)?.cwd).toBe(resolve(workdir))
    expect(getWorkspace(OTHER)).toBeUndefined()
    expect(listWorkspaces()).toHaveLength(1)
  })

  test('workspaceRootFor falls back for an agent RAYU never prepared', async () => {
    // An adopted instance discovered mid-flight still needs relative paths
    // resolved rather than dropped.
    expect(workspaceRootFor(AGENT, workdir)).toBe(resolve(workdir))
    await prepareWorkspace({ agentId: AGENT, cwd: workdir })
    expect(workspaceRootFor(AGENT, '/elsewhere')).toBe(resolve(workdir))
  })
})

// ---------------------------------------------------------------------------
// Releasing
// ---------------------------------------------------------------------------

describe('releasing a workspace', () => {
  test('always frees the leases', async () => {
    await prepareWorkspace({ agentId: AGENT, cwd: workdir, exclusive: true })
    const result = await releaseWorkspace(AGENT)
    expect(result.releasedLeases).toEqual([resolve(workdir)])
    expect(await listWriteLeases()).toEqual([])
    expect(getWorkspace(AGENT)).toBeUndefined()
  })

  test('frees every lease the agent held, not just the root', async () => {
    await prepareWorkspace({ agentId: AGENT, cwd: workdir, exclusive: true })
    await tryAcquireWriteLease('/some/file.ts', AGENT)
    expect((await releaseWorkspace(AGENT)).releasedLeases).toHaveLength(2)
  })

  test('a shared workspace reports no worktree removal', async () => {
    await prepareWorkspace({ agentId: AGENT, cwd: workdir })
    const result = await releaseWorkspace(AGENT, { removeWorktree: true })
    expect(result.worktreeRemoved).toBe(false)
    expect(result.worktreeRetainedBecause).toBeUndefined()
  })

  test('releasing an unknown agent is safe', async () => {
    expect(await releaseWorkspace(AGENT)).toEqual({
      releasedLeases: [],
      worktreeRemoved: false,
    })
  })
})

describe('workspace report', () => {
  function workspace(overrides: Partial<AgentWorkspace> = {}): AgentWorkspace {
    return {
      agentId: AGENT,
      isolation: 'shared',
      cwd: '/repo',
      requestedCwd: '/repo',
      exclusive: false,
      preparedAtMs: Date.now(),
      ...overrides,
    }
  }

  test('an empty list says so', () => {
    expect(formatWorkspaceReport([])).toBe('No external agent workspaces.')
  })

  test('renders isolation, exclusivity and the cwd', () => {
    const text = formatWorkspaceReport([workspace({ exclusive: true })])
    expect(text).toContain(`${AGENT}  [shared, exclusive]`)
    expect(text).toContain('cwd: /repo')
  })

  test('a worktree shows its branch and what it was isolated from', () => {
    const text = formatWorkspaceReport([
      workspace({
        isolation: 'worktree',
        cwd: '/wt/rayu-agent-stub-abc123',
        requestedCwd: '/repo',
        worktree: {
          path: '/wt/rayu-agent-stub-abc123',
          branch: 'rayu/agent-stub',
          gitRoot: '/repo',
          hookBased: false,
        },
      }),
    ])
    expect(text).toContain('worktree: /wt/rayu-agent-stub-abc123')
    expect(text).toContain('branch rayu/agent-stub')
    expect(text).toContain('isolated from: /repo')
  })

  test('a hook-based worktree is labelled as such', () => {
    const text = formatWorkspaceReport([
      workspace({
        isolation: 'worktree',
        worktree: { path: '/wt/x', hookBased: true },
      }),
    ])
    expect(text).toContain('hook-based')
  })
})

// ---------------------------------------------------------------------------
// Change tracking installer
// ---------------------------------------------------------------------------

describe('workspace tracking installer', () => {
  test('a file_changed event reaches the tracker with the agent’s real root', async () => {
    await prepareWorkspace({ agentId: AGENT, cwd: workdir })
    installWorkspaceTracking()
    emitEvent(
      { agentId: AGENT },
      { type: 'file_changed', path: 'src/a.ts', change: 'modified' },
    )
    const files = listChangedFiles(AGENT)
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe(join(resolve(workdir), 'src/a.ts'))
    expect(getChangeSummary(AGENT)!.workspaceRoot).toBe(resolve(workdir))
  })

  test('uninstalling stops tracking', () => {
    installWorkspaceTracking()
    uninstallWorkspaceTracking()
    emitEvent(
      { agentId: AGENT },
      { type: 'file_changed', path: '/a.ts', change: 'modified' },
    )
    expect(listChangedFiles(AGENT)).toEqual([])
  })

  test('non-file events are ignored', () => {
    installWorkspaceTracking()
    emitEvent({ agentId: AGENT }, { type: 'agent_idle' })
    expect(listChangedFiles(AGENT)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Recovery survey
// ---------------------------------------------------------------------------

describe('recovery survey', () => {
  beforeEach(() => {
    registerAdapter(createStubAdapter({ provider: STUB }))
  })

  test('an empty store reports nothing to recover', async () => {
    const report = await planRecovery()
    expect(report.candidates).toEqual([])
    expect(formatRecoveryReport(report)).toBe(
      'No external agents from previous sessions.',
    )
  })

  test('a dead session-bound agent is recommended for relaunch, resuming its session', async () => {
    await writeAgentRecord(record({ agentState: 'working' }))
    await writeAgentSessions(AGENT, {
      activeSessionId: 'thread_abc',
      sessions: [
        { agentSessionId: 'thread_abc', createdAt: 1, lastUsedAt: 2 },
      ],
    })
    await patchAgentRecord(AGENT, { ownerPid: DEAD_PID })

    const report = await planRecovery()
    // The sweep runs FIRST so the cause of death is recorded before classifying.
    expect(report.sweptDead).toEqual([AGENT])
    expect(report.candidates).toHaveLength(1)
    const candidate = report.candidates[0]!
    expect(candidate.action).toBe('relaunch')
    expect(candidate.liveness).toBe('dead')
    expect(String(candidate.resumeSessionId)).toBe('thread_abc')
    expect(candidate.reason).toContain('thread_abc')
  })

  test('with no recorded session id the report SAYS the conversation restarts', async () => {
    // Better than implying continuity that does not exist.
    await writeAgentRecord(record({ agentState: 'working' }))
    await patchAgentRecord(AGENT, { ownerPid: DEAD_PID })
    const candidate = (await planRecovery()).candidates[0]!
    expect(candidate.action).toBe('relaunch')
    expect(candidate.reason).toContain('fresh conversation')
  })

  test('an agent owned by ANOTHER live RAYU is left alone', async () => {
    // process.ppid is a live process that is not us — exactly the situation.
    await writeAgentRecord(record({ durability: 'session-bound' }))
    await patchAgentRecord(AGENT, { ownerPid: process.ppid })
    const candidate = (await planRecovery()).candidates[0]!
    expect(candidate.action).toBe('owned-elsewhere')
    expect(candidate.reason).toContain(String(process.ppid))
    expect(candidate.reason).toContain('Leave it to that session')
  })

  test('an intentionally stopped agent is inert', async () => {
    await writeAgentRecord(record({ agentState: 'stopped' }))
    const candidate = (await planRecovery()).candidates[0]!
    expect(candidate.action).toBe('inert')
    expect(candidate.reason).toContain('on purpose')
  })

  test('a provider with NO registered adapter is inert, not "relaunch"', async () => {
    // Saying relaunch would produce an UnknownProviderError the moment the user
    // tried it.
    resetAdapterRegistry()
    await writeAgentRecord(record({ agentState: 'working' }))
    await patchAgentRecord(AGENT, { ownerPid: DEAD_PID })
    const candidate = (await planRecovery()).candidates[0]!
    expect(candidate.action).toBe('inert')
    expect(candidate.reason).toContain('No adapter is registered')
  })

  test('a durable agent with no pid is UNDECIDABLE, never guessed', async () => {
    await writeAgentRecord(
      record({
        durability: 'process-durable',
        pid: undefined,
        transport: { kind: 'http', endpoint: 'http://127.0.0.1:4096' },
        agentState: 'working',
      }),
    )
    const candidate = (await planRecovery()).candidates[0]!
    expect(candidate.action).toBe('undecidable')
    expect(candidate.reason).toContain('never learned a pid')
    expect(candidate.reason).toContain('/agent discover')
    // The sweep left its state alone rather than marking it dead.
    const stored = await readAgentRecord(AGENT)
    if (stored.status === 'ok') expect(stored.record.agentState).toBe('working')
  })

  test('a live durable agent whose adapter can re-attach is a reconnect', async () => {
    registerAdapter(
      createStubAdapter({ provider: STUB, durability: 'process-durable' }),
    )
    await writeAgentRecord(
      record({ durability: 'process-durable', pid: process.pid }),
    )
    const candidate = (await planRecovery()).candidates[0]!
    expect(candidate.action).toBe('reconnect')
    expect(candidate.liveness).toBe('live')
  })

  test('a live durable agent whose adapter CANNOT re-attach is inert', async () => {
    // session-bound stub adapters have no reconnect method.
    await writeAgentRecord(
      record({ durability: 'process-durable', pid: process.pid }),
    )
    const candidate = (await planRecovery()).candidates[0]!
    expect(candidate.action).toBe('inert')
    expect(candidate.reason).toContain('cannot be re-attached')
  })

  test('an agent already connected to THIS session is reported as such', async () => {
    const handle = await startAgent({ provider: STUB, cwd: workdir })
    const candidate = (await planRecovery()).candidates.find(
      c => c.agentInstanceId === handle.agentId,
    )!
    expect(candidate.action).toBe('already-connected')
  })

  test('a record claiming to run under this pid with no handle is undecidable', async () => {
    // The record outlived the handle within one process: trustworthy enough to
    // report, not to act on silently.
    await writeAgentRecord(record({ durability: 'session-bound' }))
    const candidate = (await planRecovery()).candidates[0]!
    expect(candidate.action).toBe('undecidable')
    expect(candidate.reason).toContain('no live handle exists')
  })

  test('the last logged event says what the agent was doing when it died', async () => {
    // agent.json records the final state; only the event log explains it.
    const uninstall = installEventSinks((() => {}) as never)
    try {
      await writeAgentRecord(record({ agentState: 'working' }))
      emitEvent(
        { agentId: AGENT },
        { type: 'task_failed', message: 'ran out of context' },
      )
      await patchAgentRecord(AGENT, { ownerPid: DEAD_PID })
      const candidate = (await planRecovery()).candidates[0]!
      expect(candidate.lastActivity).toContain('task_failed')
      expect(candidate.lastActivity).toContain('ran out of context')
    } finally {
      uninstall()
    }
  })

  test('a corrupt record is skipped and named rather than crashing the survey', async () => {
    await writeAgentRecord(record())
    const { mkdirSync, writeFileSync } = await import('fs')
    const { getAgentDir, getAgentRecordPath } = await import(
      '../src/externalAgents/persistence/paths.ts'
    )
    mkdirSync(getAgentDir(OTHER), { recursive: true })
    writeFileSync(getAgentRecordPath(OTHER), 'not json')

    const report = await planRecovery()
    expect(report.corrupt).toEqual([OTHER])
    expect(report.candidates).toHaveLength(1)
    expect(formatRecoveryReport(report)).toContain('could not be read')
  })
})

// ---------------------------------------------------------------------------
// Acting on a candidate
// ---------------------------------------------------------------------------

describe('applying a recovery action', () => {
  beforeEach(() => {
    registerAdapter(createStubAdapter({ provider: STUB }))
  })

  function candidate(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
    return {
      agentInstanceId: AGENT,
      provider: STUB,
      action: 'relaunch',
      reason: 'not running',
      liveness: 'dead',
      durability: 'session-bound',
      adoption: 'managed',
      cwd: workdir,
      ownerPid: DEAD_PID,
      ...overrides,
    }
  }

  test('relaunch keeps the SAME instance id so history stays attached', async () => {
    const outcome = await applyRecovery(candidate())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.handle.agentId).toBe(AGENT)
    expect(listLiveAgents()).toHaveLength(1)
    expect(outcome.note).toContain('fresh conversation')
  })

  test('relaunch resumes the recorded session when there is one', async () => {
    const outcome = await applyRecovery(
      candidate({ resumeSessionId: 'thread_abc' as never }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(String(outcome.handle.activeSessionId())).toBe('thread_abc')
    expect(outcome.note).toContain('resuming session thread_abc')
  })

  test('reconnect re-attaches a durable agent', async () => {
    registerAdapter(
      createStubAdapter({ provider: STUB, durability: 'process-durable' }),
    )
    await writeAgentRecord(
      record({ durability: 'process-durable', pid: process.pid }),
    )
    const outcome = await applyRecovery(
      candidate({ action: 'reconnect', durability: 'process-durable' }),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.note).toContain('Reconnected')
  })

  test.each([
    'owned-elsewhere',
    'undecidable',
    'already-connected',
    'inert',
  ] as const)('REFUSES to execute "%s" — it describes, it does not instruct', action => {
    // The same principle as "a method that always throws should not exist".
    return applyRecovery(candidate({ action })).then(outcome => {
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.message).toContain('there is nothing to execute')
      expect(outcome.message).toContain(action)
      expect(listLiveAgents()).toEqual([])
    })
  })

  test('a failing relaunch is reported, not thrown', async () => {
    resetAdapterRegistry()
    registerAdapter(createStubAdapter({ provider: STUB, failLaunch: true }))
    const outcome = await applyRecovery(candidate())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('Could not relaunch')
  })
})

// ---------------------------------------------------------------------------
// Shutdown forensics
// ---------------------------------------------------------------------------

describe('shutdown forensics', () => {
  test('records WHY this RAYU let go, per durability', async () => {
    registerAdapter(createStubAdapter({ provider: asProviderId('bound') }))
    registerAdapter(
      createStubAdapter({
        provider: asProviderId('durable'),
        durability: 'process-durable',
      }),
    )
    const bound = await startAgent({ provider: asProviderId('bound'), cwd: workdir })
    const durable = await startAgent({
      provider: asProviderId('durable'),
      cwd: workdir,
    })

    await recordShutdownForensics([bound, durable])

    const boundRecord = await readAgentRecord(bound.agentId)
    if (boundRecord.status === 'ok') {
      expect(boundRecord.record.forensics?.reason).toBe('shutdown')
      expect(boundRecord.record.forensics?.message).toContain('cannot outlive')
    }
    const durableRecord = await readAgentRecord(durable.agentId)
    if (durableRecord.status === 'ok') {
      // A durable agent is left running and can be reconnected.
      expect(durableRecord.record.forensics?.message).toContain('reconnected')
    }
  })

  test('captures the state the agent was in at shutdown', async () => {
    registerAdapter(createStubAdapter({ provider: STUB, holdTurns: true }))
    const handle = await startAgent({ provider: STUB, cwd: workdir })
    await handle.send({ text: 'busy work' })
    await recordShutdownForensics([handle])
    const stored = await readAgentRecord(handle.agentId)
    if (stored.status === 'ok') {
      expect(stored.record.forensics?.lastKnownAgentState).toBe('working')
      expect(stored.record.forensics?.agentSessionId).toBeDefined()
    }
  })

  test('a write failure does not abort teardown for the others', async () => {
    registerAdapter(createStubAdapter({ provider: STUB }))
    const handle = await startAgent({ provider: STUB, cwd: workdir })
    // A handle with no persisted record: the patch is a no-op, not a throw.
    // Teardown runs inside gracefulShutdown's Promise.all, where one throwing
    // handler would abandon cleanup for the whole application.
    const ghost = {
      agentId: 'stub:ghost' as AgentInstanceId,
      durability: 'session-bound' as const,
      status: () => ({
        processState: 'exited' as const,
        connectionState: 'lost' as const,
        agentState: 'dead' as const,
      }),
      activeSessionId: () => undefined,
    }
    await expect(
      recordShutdownForensics([ghost, handle] as never),
    ).resolves.toBeUndefined()

    // The real handle's forensics still landed.
    const stored = await readAgentRecord(handle.agentId)
    if (stored.status === 'ok') {
      expect(stored.record.forensics?.reason).toBe('shutdown')
    }
  })
})

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

describe('recovery report rendering', () => {
  test('leads with how many records and how many are ACTIONABLE', async () => {
    registerAdapter(createStubAdapter({ provider: STUB }))
    await writeAgentRecord(record({ agentState: 'working' }))
    await patchAgentRecord(AGENT, { ownerPid: DEAD_PID })
    const text = formatRecoveryReport(await planRecovery())
    expect(text).toContain('1 external agent record found, 1 actionable.')
    expect(text).toContain(`[relaunch] ${AGENT}`)
    expect(text).toContain('newly marked dead by this survey')
  })

  test('a non-actionable record is listed but not counted as actionable', async () => {
    registerAdapter(createStubAdapter({ provider: STUB }))
    await writeAgentRecord(record({ agentState: 'stopped' }))
    const text = formatRecoveryReport(await planRecovery())
    expect(text).toContain('1 external agent record found, 0 actionable.')
    expect(text).toContain('[inert]')
  })

  test('forensics are surfaced so the user knows how it died', async () => {
    registerAdapter(createStubAdapter({ provider: STUB }))
    await writeAgentRecord(record({ agentState: 'working' }))
    await patchAgentRecord(AGENT, {
      ownerPid: DEAD_PID,
      forensics: {
        reason: 'protocol_disconnect',
        at: Date.now(),
        lastKnownAgentState: 'working',
        message: 'socket dropped mid-turn',
      },
    })
    const text = formatRecoveryReport(await planRecovery())
    expect(text).toContain('died: protocol_disconnect')
    expect(text).toContain('socket dropped mid-turn')
  })
})
