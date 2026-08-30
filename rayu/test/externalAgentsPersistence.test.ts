/**
 * On-disk state: path safety, agent records, liveness classification and write
 * leases.
 *
 * These files survive crashes and are the only evidence the recovery path has,
 * so the tests here are mostly about NOT losing data: corrupt must stay distinct
 * from missing, the sweep must never delete, and liveness must answer `unknown`
 * rather than guess.
 *
 * `RAYU_CONFIG_DIR` is re-pointed at a temp dir per test. `getRayuConfigHomeDir`
 * is memoized on that variable's value, so changing it genuinely relocates the
 * store rather than reusing a cached path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getAgentDir,
  getAgentEventsDir,
  getAgentRecordPath,
  getAgentSessionsPath,
  getAgentTasksPath,
  getAgentsRootDir,
  getLeasesDir,
  getProviderDir,
  isSafePathSegment,
} from '../src/externalAgents/persistence/paths.ts'
import {
  classifyLiveness,
  listAgentInstanceIds,
  listAgentRecords,
  patchAgentRecord,
  pruneAgentRecord,
  readAgentRecord,
  readAgentSessions,
  readAgentTasks,
  sweepStaleAgents,
  writeAgentRecord,
  writeAgentSessions,
  writeAgentTasks,
  type NewAgentRecordInput,
} from '../src/externalAgents/persistence/agentStore.ts'
import {
  listWriteLeases,
  releaseAllLeasesForAgent,
  releaseWriteLease,
  sweepStaleLeases,
  tryAcquireWriteLease,
} from '../src/externalAgents/persistence/workspaceLease.ts'
import {
  asProviderId,
  noCapabilities,
  type AgentInstanceId,
} from '../src/externalAgents/core/types.ts'

const CODEX = 'codex:agent_01' as AgentInstanceId
const CLAUDE = 'claude-code:agent_01' as AgentInstanceId

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-persist-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

function newRecord(
  overrides: Partial<NewAgentRecordInput> = {},
): NewAgentRecordInput {
  return {
    agentInstanceId: CODEX,
    provider: asProviderId('codex'),
    adoption: 'managed',
    durability: 'session-bound',
    capabilities: { ...noCapabilities(), messages: 'full', process: 'full' },
    transport: { kind: 'stdio' },
    cwd: '/tmp/project',
    pid: process.pid,
    processState: 'running',
    connectionState: 'connected',
    agentState: 'idle',
    ...overrides,
  }
}

/** A pid that is almost certainly not running. */
const DEAD_PID = 0x7ffffffe

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('agent state paths', () => {
  test('nests <provider>/<slot> rather than using the raw id', () => {
    // `:` is illegal in a Windows path component, so the rendered instance id
    // cannot be a directory name.
    expect(getAgentDir(CODEX)).toBe(join(dir, 'agents', 'codex', 'agent_01'))
    expect(getProviderDir(asProviderId('codex'))).toBe(
      join(dir, 'agents', 'codex'),
    )
    expect(getAgentsRootDir()).toBe(join(dir, 'agents'))
  })

  test('all four per-agent files live under the agent dir', () => {
    const base = getAgentDir(CODEX)
    expect(getAgentRecordPath(CODEX)).toBe(join(base, 'agent.json'))
    expect(getAgentSessionsPath(CODEX)).toBe(join(base, 'sessions.json'))
    expect(getAgentTasksPath(CODEX)).toBe(join(base, 'tasks.json'))
    expect(getAgentEventsDir(CODEX)).toBe(join(base, 'events'))
    expect(getLeasesDir()).toBe(join(dir, 'agents', '.leases'))
  })

  test('follows RAYU_CONFIG_DIR when it changes', () => {
    const other = mkdtempSync(join(tmpdir(), 'rayu-ext-other-'))
    try {
      process.env.RAYU_CONFIG_DIR = other
      expect(getAgentsRootDir()).toBe(join(other, 'agents'))
    } finally {
      process.env.RAYU_CONFIG_DIR = dir
      rmSync(other, { recursive: true, force: true })
    }
  })

  test.each([
    ['plain', 'codex', true],
    ['underscored', 'agent_01', true],
    ['dashed', 'my-agent', true],
    ['dotted', 'agent.1', true],
    ['parent traversal', '..', false],
    ['self', '.', false],
    ['embedded traversal', '../../etc', false],
    ['posix separator', 'a/b', false],
    ['windows separator', 'a\\b', false],
    ['leading dot', '.hidden', false],
    ['empty', '', false],
    ['nul byte', 'a\u0000b', false],
    ['newline', 'a\nb', false],
    ['space', 'a b', false],
    ['colon', 'a:b', false],
    ['windows device', 'CON', false],
    ['windows device with ext', 'nul.json', false],
    ['com port', 'COM1', false],
    ['too long', 'x'.repeat(65), false],
    ['max length', 'x'.repeat(64), true],
  ])('isSafePathSegment %s', (_label, segment, expected) => {
    expect(isSafePathSegment(segment)).toBe(expected)
  })

  test('throws rather than sanitizing an unsafe provider id', () => {
    // Silently rewriting `../../etc` would make two distinct agent ids collide
    // on one directory — a correctness bug on top of the security one.
    expect(() => getProviderDir(asProviderId('../../etc'))).toThrow(
      /Unsafe provider id/,
    )
    expect(() =>
      getAgentDir('codex:../../../etc/passwd' as AgentInstanceId),
    ).toThrow(/Unsafe slot/)
  })

  test('rejects an id that is not <provider>:<slot>', () => {
    expect(() => getAgentDir('nocolon' as AgentInstanceId)).toThrow(
      /Not a valid agent instance id/,
    )
  })
})

// ---------------------------------------------------------------------------
// Agent records
// ---------------------------------------------------------------------------

describe('agent records', () => {
  test('write then read round-trips and stamps ownership', () => {
    return (async () => {
      const written = await writeAgentRecord(newRecord())
      expect(written.ownerPid).toBe(process.pid)
      expect(written.slot).toBe('agent_01')
      expect(written.ownerSessionId.length).toBeGreaterThan(0)

      const read = await readAgentRecord(CODEX)
      expect(read.status).toBe('ok')
      if (read.status !== 'ok') return
      expect(read.record.agentInstanceId).toBe(CODEX)
      expect(read.record.capabilities.messages).toBe('full')
      expect(read.record.transport).toEqual({ kind: 'stdio' })
    })()
  })

  test('derives slot from the instance id, not from the caller', async () => {
    const written = await writeAgentRecord(
      newRecord({ agentInstanceId: 'codex:slot_zz' as AgentInstanceId }),
    )
    expect(written.slot).toBe('slot_zz')
  })

  test('refuses to persist an unparseable instance id', async () => {
    await expect(
      writeAgentRecord(newRecord({ agentInstanceId: 'bogus' as AgentInstanceId })),
    ).rejects.toThrow(/is not '<provider>:<slot>'/)
  })

  test('record and directory are owner-only', async () => {
    await writeAgentRecord(newRecord())
    // Records describe spawned processes and their endpoints.
    expect(statSync(getAgentRecordPath(CODEX)).mode & 0o777).toBe(0o600)
    expect(statSync(getAgentDir(CODEX)).mode & 0o777).toBe(0o700)
  })

  test('rewriting preserves createdAt but advances updatedAt', async () => {
    const first = await writeAgentRecord(newRecord())
    await new Promise(r => setTimeout(r, 5))
    const second = await writeAgentRecord(newRecord({ agentState: 'working' }))
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThan(first.createdAt - 1)
    expect(second.agentState).toBe('working')
  })

  test('a missing record reads as missing, not as an error', async () => {
    expect(await readAgentRecord(CODEX)).toEqual({ status: 'missing' })
  })

  test('a corrupt record is reported as corrupt, NOT as missing', async () => {
    // The central data-loss guard: conflating the two lets the next write
    // clobber the only record of a live agent.
    mkdirSync(getAgentDir(CODEX), { recursive: true })
    writeFileSync(getAgentRecordPath(CODEX), '{not json at all')
    const result = await readAgentRecord(CODEX)
    expect(result.status).toBe('corrupt')
    if (result.status === 'corrupt') {
      expect(result.reason).toContain('schema validation failed')
    }
  })

  test('a schema-invalid record is corrupt, not silently defaulted', async () => {
    mkdirSync(getAgentDir(CODEX), { recursive: true })
    writeFileSync(
      getAgentRecordPath(CODEX),
      JSON.stringify({ agentInstanceId: CODEX, provider: 'codex' }),
    )
    expect((await readAgentRecord(CODEX)).status).toBe('corrupt')
  })

  test('an unknown enum value makes the record corrupt', async () => {
    // The `satisfies` clauses in schemas.ts make a union/schema drift a compile
    // error; this covers the runtime half — a hand-edited or future-version file.
    await writeAgentRecord(newRecord())
    const raw = JSON.parse(readFileSync(getAgentRecordPath(CODEX), 'utf-8'))
    raw.agentState = 'teleporting'
    writeFileSync(getAgentRecordPath(CODEX), JSON.stringify(raw))
    expect((await readAgentRecord(CODEX)).status).toBe('corrupt')
  })

  test('patch merges and bumps updatedAt', async () => {
    await writeAgentRecord(newRecord())
    const patched = await patchAgentRecord(CODEX, {
      agentState: 'working',
      activeTurn: { id: 'turn_1', kind: 'regular' },
    })
    expect(patched?.agentState).toBe('working')
    expect(patched?.activeTurn).toEqual({ id: 'turn_1', kind: 'regular' })
    // Untouched fields survive.
    expect(patched?.cwd).toBe('/tmp/project')
  })

  test('patch no-ops on a missing record instead of creating a partial one', async () => {
    // A patch must never resurrect a record it cannot read in full — the result
    // would be a record with default-filled unknown fields.
    expect(await patchAgentRecord(CODEX, { agentState: 'dead' })).toBeNull()
    expect((await readAgentRecord(CODEX)).status).toBe('missing')
  })

  test('patch no-ops on a corrupt record and leaves the bytes alone', async () => {
    mkdirSync(getAgentDir(CODEX), { recursive: true })
    writeFileSync(getAgentRecordPath(CODEX), 'garbage')
    expect(await patchAgentRecord(CODEX, { agentState: 'dead' })).toBeNull()
    expect(readFileSync(getAgentRecordPath(CODEX), 'utf-8')).toBe('garbage')
  })

  test('lists instance ids across providers', async () => {
    await writeAgentRecord(newRecord())
    await writeAgentRecord(
      newRecord({
        agentInstanceId: CLAUDE,
        provider: asProviderId('claude-code'),
      }),
    )
    expect((await listAgentInstanceIds()).sort()).toEqual([CLAUDE, CODEX])
  })

  test('ignores foreign directory names rather than parsing or deleting them', async () => {
    await writeAgentRecord(newRecord())
    mkdirSync(join(getAgentsRootDir(), '.leases'), { recursive: true })
    mkdirSync(join(getAgentsRootDir(), 'codex', '.tmpjunk'), { recursive: true })
    const ids = await listAgentInstanceIds()
    expect(ids).toEqual([CODEX])
    // Nothing was removed.
    expect(statSync(join(getAgentsRootDir(), '.leases')).isDirectory()).toBe(true)
  })

  test('an empty store lists nothing without throwing', async () => {
    expect(await listAgentInstanceIds()).toEqual([])
    expect(await listAgentRecords()).toEqual({ records: [], corrupt: [] })
  })

  test('listAgentRecords separates readable records from corrupt ids', async () => {
    await writeAgentRecord(newRecord())
    mkdirSync(getAgentDir(CLAUDE), { recursive: true })
    writeFileSync(getAgentRecordPath(CLAUDE), 'nope')
    const { records, corrupt } = await listAgentRecords()
    expect(records.map(r => r.agentInstanceId)).toEqual([CODEX])
    expect(corrupt).toEqual([CLAUDE])
  })

  test('prune is the only destructive operation', async () => {
    await writeAgentRecord(newRecord())
    await pruneAgentRecord(CODEX)
    expect((await readAgentRecord(CODEX)).status).toBe('missing')
    expect(await listAgentInstanceIds()).toEqual([])
  })

  test('sessions and tasks round-trip with defaults applied', async () => {
    await writeAgentSessions(CODEX, {
      activeSessionId: 'thread_abc',
      sessions: [
        {
          agentSessionId: 'thread_abc',
          createdAt: 1,
          lastUsedAt: 2,
          native: { rolloutPath: '/tmp/r.jsonl' },
        },
      ],
    })
    const sessions = await readAgentSessions(CODEX)
    expect(sessions.status).toBe('ok')
    if (sessions.status === 'ok') {
      expect(sessions.record.activeSessionId).toBe('thread_abc')
      expect(sessions.record.sessions[0]!.native).toEqual({
        rolloutPath: '/tmp/r.jsonl',
      })
    }

    await writeAgentTasks(CODEX, {
      tasks: [
        {
          taskRef: 'task_1',
          prompt: 'do the thing',
          externalState: 'running',
          createdAt: 1,
          updatedAt: 2,
          changedFiles: [],
        },
      ],
    })
    const tasks = await readAgentTasks(CODEX)
    expect(tasks.status).toBe('ok')
    if (tasks.status === 'ok') {
      expect(tasks.record.tasks[0]!.externalState).toBe('running')
    }
  })

  test('missing sessions and tasks read as missing', async () => {
    expect((await readAgentSessions(CODEX)).status).toBe('missing')
    expect((await readAgentTasks(CODEX)).status).toBe('missing')
  })
})

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

describe('liveness classification', () => {
  async function record(
    overrides: Partial<NewAgentRecordInput>,
    ownerPid?: number,
  ) {
    await writeAgentRecord(newRecord(overrides))
    if (ownerPid !== undefined) {
      // writeAgentRecord always stamps the CURRENT pid, so simulating a previous
      // session requires patching afterwards.
      await patchAgentRecord(CODEX, { ownerPid })
    }
    const read = await readAgentRecord(CODEX)
    if (read.status !== 'ok') throw new Error('setup failed')
    return read.record
  }

  test('session-bound owned by this process is live', async () => {
    expect(classifyLiveness(await record({ durability: 'session-bound' }))).toBe(
      'live',
    )
  })

  test('session-bound owned by a dead RAYU is dead', async () => {
    // The pipe belonged to that process; the agent is unreachable even if its
    // own process somehow lingers.
    const rec = await record({ durability: 'session-bound' }, DEAD_PID)
    expect(classifyLiveness(rec)).toBe('dead')
  })

  test('our own session-bound agent is live without probing the child pid', async () => {
    // Short-circuit by design: when THIS process holds the pipe, the in-memory
    // registry is authoritative. Probing a pid we already own would let a
    // transient probe failure mark our own working agent dead.
    const rec = await record({ durability: 'session-bound', pid: DEAD_PID })
    expect(rec.ownerPid).toBe(process.pid)
    expect(classifyLiveness(rec)).toBe('live')
  })

  test('session-bound under another LIVE RAYU with a dead child is dead', async () => {
    // process.ppid is a genuinely live process that is not us, which is the only
    // way to reach the child-pid branch.
    const rec = await record(
      { durability: 'session-bound', pid: DEAD_PID },
      process.ppid,
    )
    expect(classifyLiveness(rec)).toBe('dead')
  })

  test('session-bound under another LIVE RAYU with a live child is live', async () => {
    // Owned elsewhere but genuinely running — the recovery path must not steal it.
    const rec = await record(
      { durability: 'session-bound', pid: process.pid },
      process.ppid,
    )
    expect(classifyLiveness(rec)).toBe('live')
  })

  test('session-bound with no recorded child pid falls back to owner liveness', async () => {
    const rec = await record(
      { durability: 'session-bound', pid: undefined },
      process.ppid,
    )
    expect(classifyLiveness(rec)).toBe('live')
  })

  test('process-durable with no pid is unknown, never guessed', async () => {
    // An agent adopted over HTTP has no pid RAYU ever learned. Guessing `dead`
    // would orphan a live agent; only an endpoint probe can answer.
    const rec = await record({
      durability: 'process-durable',
      pid: undefined,
      transport: { kind: 'http', endpoint: 'http://127.0.0.1:4096' },
    })
    expect(classifyLiveness(rec)).toBe('unknown')
  })

  test('process-durable with a live pid is live regardless of owner', async () => {
    const rec = await record(
      {
        durability: 'process-durable',
        pid: process.pid,
        transport: { kind: 'unix', endpoint: '/tmp/codex.sock' },
      },
      DEAD_PID,
    )
    expect(classifyLiveness(rec)).toBe('live')
  })

  test('process-durable with a dead pid is dead', async () => {
    const rec = await record({
      durability: 'process-durable',
      pid: DEAD_PID,
      transport: { kind: 'unix', endpoint: '/tmp/codex.sock' },
    })
    expect(classifyLiveness(rec)).toBe('dead')
  })
})

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

describe('stale agent sweep', () => {
  test('marks a provably dead agent dead and records forensics', async () => {
    await writeAgentRecord(newRecord({ agentState: 'working' }))
    await patchAgentRecord(CODEX, { ownerPid: DEAD_PID })

    expect(await sweepStaleAgents()).toEqual([CODEX])

    const read = await readAgentRecord(CODEX)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.record.agentState).toBe('dead')
    expect(read.record.processState).toBe('exited')
    expect(read.record.connectionState).toBe('lost')
    expect(read.record.forensics?.reason).toBe('process_exit')
    // What it was doing when it died is preserved for the recovery report.
    expect(read.record.forensics?.lastKnownAgentState).toBe('working')
  })

  test('NEVER deletes — the record survives for recovery to read', async () => {
    await writeAgentRecord(newRecord({ agentState: 'working' }))
    await patchAgentRecord(CODEX, { ownerPid: DEAD_PID })
    await sweepStaleAgents()
    expect(await listAgentInstanceIds()).toEqual([CODEX])
    expect((await readAgentRecord(CODEX)).status).toBe('ok')
  })

  test('clears a stale active turn', async () => {
    await writeAgentRecord(
      newRecord({
        agentState: 'working',
        activeTurn: { id: 'turn_9', kind: 'regular' },
      }),
    )
    await patchAgentRecord(CODEX, { ownerPid: DEAD_PID })
    await sweepStaleAgents()
    const read = await readAgentRecord(CODEX)
    if (read.status === 'ok') expect(read.record.activeTurn).toBeUndefined()
  })

  test('leaves a live agent alone', async () => {
    await writeAgentRecord(newRecord({ agentState: 'working' }))
    expect(await sweepStaleAgents()).toEqual([])
    const read = await readAgentRecord(CODEX)
    if (read.status === 'ok') expect(read.record.agentState).toBe('working')
  })

  test('leaves an unknown-liveness agent untouched', async () => {
    // Marking it dead would orphan a live adopted agent.
    await writeAgentRecord(
      newRecord({
        durability: 'process-durable',
        pid: undefined,
        agentState: 'working',
        transport: { kind: 'http', endpoint: 'http://127.0.0.1:4096' },
      }),
    )
    expect(await sweepStaleAgents()).toEqual([])
    const read = await readAgentRecord(CODEX)
    if (read.status === 'ok') expect(read.record.agentState).toBe('working')
  })

  test('preserves the first observed cause of death', async () => {
    // A later sweep must not overwrite forensics with a generic reason.
    await writeAgentRecord(newRecord({ agentState: 'working' }))
    await patchAgentRecord(CODEX, {
      ownerPid: DEAD_PID,
      forensics: {
        reason: 'protocol_disconnect',
        at: 111,
        lastKnownAgentState: 'working',
        message: 'socket dropped',
      },
    })
    await sweepStaleAgents()
    const read = await readAgentRecord(CODEX)
    if (read.status === 'ok') {
      expect(read.record.forensics?.reason).toBe('protocol_disconnect')
      expect(read.record.forensics?.message).toBe('socket dropped')
    }
  })

  test('skips records already in a terminal state', async () => {
    await writeAgentRecord(newRecord({ agentState: 'stopped' }))
    await patchAgentRecord(CODEX, { ownerPid: DEAD_PID })
    expect(await sweepStaleAgents()).toEqual([])
  })

  test('a corrupt record does not abort the sweep of the others', async () => {
    await writeAgentRecord(newRecord({ agentState: 'working' }))
    await patchAgentRecord(CODEX, { ownerPid: DEAD_PID })
    mkdirSync(getAgentDir(CLAUDE), { recursive: true })
    writeFileSync(getAgentRecordPath(CLAUDE), 'broken')
    expect(await sweepStaleAgents()).toEqual([CODEX])
  })
})

// ---------------------------------------------------------------------------
// Write leases
// ---------------------------------------------------------------------------

describe('write leases', () => {
  const FILE_A = '/tmp/project/src/auth.ts'
  const FILE_B = '/tmp/project/src/db.ts'

  test('first acquire wins', async () => {
    const result = await tryAcquireWriteLease(FILE_A, CODEX)
    expect(result.acquired).toBe(true)
    if (result.acquired) {
      expect(result.lease.path).toBe(FILE_A)
      expect(result.lease.agentInstanceId).toBe(CODEX)
      expect(result.lease.ownerPid).toBe(process.pid)
    }
  })

  test('a second agent is told who holds it', async () => {
    await tryAcquireWriteLease(FILE_A, CODEX)
    const result = await tryAcquireWriteLease(FILE_A, CLAUDE)
    expect(result.acquired).toBe(false)
    if (!result.acquired) {
      expect(result.heldBy?.agentInstanceId).toBe(CODEX)
    }
  })

  test('re-acquiring your own lease is idempotent', async () => {
    await tryAcquireWriteLease(FILE_A, CODEX)
    const again = await tryAcquireWriteLease(FILE_A, CODEX)
    expect(again.acquired).toBe(true)
  })

  test('different files do not contend', async () => {
    expect((await tryAcquireWriteLease(FILE_A, CODEX)).acquired).toBe(true)
    expect((await tryAcquireWriteLease(FILE_B, CLAUDE)).acquired).toBe(true)
    expect(await listWriteLeases()).toHaveLength(2)
  })

  test('lease files are owner-only and hash-named', async () => {
    await tryAcquireWriteLease(FILE_A, CODEX)
    const leases = await listWriteLeases()
    expect(leases).toHaveLength(1)
    // The filename cannot be the absolute path, so it is a truncated sha256.
    // A truncation collision would only cause a spurious overlap warning.
    const { readdirSync } = await import('fs')
    const files = readdirSync(getLeasesDir())
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.lease$/)
    expect(statSync(join(getLeasesDir(), files[0]!)).mode & 0o777).toBe(0o600)
  })

  test('release only removes your own lease', async () => {
    await tryAcquireWriteLease(FILE_A, CODEX)
    await releaseWriteLease(FILE_A, CLAUDE)
    expect(await listWriteLeases()).toHaveLength(1)
    await releaseWriteLease(FILE_A, CODEX)
    expect(await listWriteLeases()).toHaveLength(0)
  })

  test('releasing a lease that does not exist is safe', async () => {
    await releaseWriteLease('/nowhere/at/all.ts', CODEX)
    expect(await listWriteLeases()).toEqual([])
  })

  test('releaseAllLeasesForAgent frees only that agent', async () => {
    await tryAcquireWriteLease(FILE_A, CODEX)
    await tryAcquireWriteLease(FILE_B, CLAUDE)
    expect(await releaseAllLeasesForAgent(CODEX)).toEqual([FILE_A])
    const remaining = await listWriteLeases()
    expect(remaining.map(l => l.agentInstanceId)).toEqual([CLAUDE])
  })

  test('a lease held by a dead RAYU is recovered', async () => {
    await tryAcquireWriteLease(FILE_A, CODEX)
    // Rewrite the holder pid to a dead process, as a crashed session would leave it.
    const { readdirSync } = await import('fs')
    const file = join(getLeasesDir(), readdirSync(getLeasesDir())[0]!)
    const lease = JSON.parse(readFileSync(file, 'utf-8'))
    writeFileSync(file, JSON.stringify({ ...lease, ownerPid: DEAD_PID }))

    const result = await tryAcquireWriteLease(FILE_A, CLAUDE)
    expect(result.acquired).toBe(true)
  })

  test('an unparseable lease file is treated as stale rather than blocking forever', async () => {
    mkdirSync(getLeasesDir(), { recursive: true })
    await tryAcquireWriteLease(FILE_A, CODEX)
    const { readdirSync } = await import('fs')
    const file = join(getLeasesDir(), readdirSync(getLeasesDir())[0]!)
    writeFileSync(file, 'not json')
    expect((await tryAcquireWriteLease(FILE_A, CLAUDE)).acquired).toBe(true)
  })

  test('sweep drops leases from dead processes and keeps live ones', async () => {
    await tryAcquireWriteLease(FILE_A, CODEX)
    await tryAcquireWriteLease(FILE_B, CLAUDE)
    const { readdirSync } = await import('fs')
    for (const entry of readdirSync(getLeasesDir())) {
      const file = join(getLeasesDir(), entry)
      const lease = JSON.parse(readFileSync(file, 'utf-8'))
      if (lease.path === FILE_A) {
        writeFileSync(file, JSON.stringify({ ...lease, ownerPid: DEAD_PID }))
      }
    }
    // Unlike the agent sweep, deleting here is correct: a lease has no forensic
    // value and a dead one would block live agents indefinitely.
    expect(await sweepStaleLeases()).toEqual([FILE_A])
    expect((await listWriteLeases()).map(l => l.path)).toEqual([FILE_B])
  })

  test('sweep never touches this process’s own leases', async () => {
    await tryAcquireWriteLease(FILE_A, CODEX)
    expect(await sweepStaleLeases()).toEqual([])
    expect(await listWriteLeases()).toHaveLength(1)
  })

  test('ignores files it could not have produced', async () => {
    mkdirSync(getLeasesDir(), { recursive: true })
    writeFileSync(join(getLeasesDir(), 'notes.txt'), 'hand written')
    writeFileSync(join(getLeasesDir(), 'shortname.lease'), '{}')
    expect(await listWriteLeases()).toEqual([])
    expect(await sweepStaleLeases()).toEqual([])
    // Neither was removed — only files matching the strict name pattern are
    // candidates for deletion.
    expect(statSync(join(getLeasesDir(), 'notes.txt')).isFile()).toBe(true)
  })

  test('listing with no lease directory returns empty rather than throwing', async () => {
    expect(await listWriteLeases()).toEqual([])
  })
})
