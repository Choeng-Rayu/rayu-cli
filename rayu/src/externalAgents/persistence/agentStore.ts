/**
 * Durable state for external agent instances.
 *
 * Mirrors the proven conventions in `src/utils/concurrentSessions.ts`: a
 * mode-0700 directory under `~/.rayu`, PID-liveness probes via
 * `isProcessRunning`, `registerCleanup` so a graceful exit leaves accurate
 * state, and a WSL carve-out because PIDs are not probeable across that
 * boundary.
 *
 * Two deliberate departures from that file, both about not losing data:
 *
 *  1. **Reads distinguish missing from corrupt.** `concurrentSessions` treats an
 *     unreadable PID file as absent, which is fine for telemetry. Here a
 *     corrupt record may be the only record of a running agent, so callers get
 *     an explicit `corrupt` result and must decide. Treating corrupt as missing
 *     would let the next write clobber it.
 *
 *  2. **The sweep never unlinks.** It marks stale agents `dead` and records
 *     forensics. `concurrentSessions` unlinks stale PID files, guarded by a
 *     strict `/^\d+\.json$/` filename check added after lenient parsing caused
 *     silent user data loss (anthropics/claude-code#34210). Rather than rely on
 *     a filename guard for directories, deletion is a separate explicit call
 *     (`pruneAgentRecord`), and crash forensics — which Task 16's recovery path
 *     needs — survive until then.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage, isFsInaccessible } from '../../utils/errors.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { getPlatform } from '../../utils/platform.js'
import { safeParseJSON } from '../../utils/json.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AgentInstanceId,
  formatAgentInstanceId,
  parseAgentInstanceId,
  type ProviderId,
} from '../core/types.js'
import {
  getAgentDir,
  getAgentRecordPath,
  getAgentSessionsPath,
  getAgentTasksPath,
  getAgentsRootDir,
  isSafePathSegment,
} from './paths.js'
import {
  type AgentForensics,
  type AgentRecord,
  agentRecordSchema,
  type AgentSessionsRecord,
  agentSessionsRecordSchema,
  type AgentTasksRecord,
  agentTasksRecordSchema,
} from './schemas.js'

const DIR_MODE = 0o700
/** Records describe spawned processes and their endpoints — owner-only. */
const FILE_MODE = 0o600

/**
 * Read outcome. `corrupt` is distinct from `missing` on purpose: a caller that
 * conflates them will overwrite state belonging to a live agent.
 */
export type RecordReadResult<T> =
  | { status: 'ok'; record: T }
  | { status: 'missing' }
  | { status: 'corrupt'; reason: string }

// ---------------------------------------------------------------------------
// Atomic JSON IO
// ---------------------------------------------------------------------------

/**
 * Write JSON via temp-file + rename so a crash mid-write cannot leave a
 * truncated record. Same sequence as `atomicWriteToZipCache`, kept local
 * because importing from `utils/plugins/zipCache.js` would couple persistence
 * to the plugin cache.
 *
 * The temp file is created in the destination directory so the rename stays on
 * one filesystem and is therefore atomic.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  const tmpPath = join(
    dir,
    `.${basename(path)}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`,
  )
  try {
    await writeFile(tmpPath, jsonStringify(value), {
      encoding: 'utf-8',
      mode: FILE_MODE,
    })
    await rename(tmpPath, path)
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw e
  }
}

/** Read + validate a JSON record, separating absence from corruption. */
async function readJsonValidated<T>(
  path: string,
  parse: (raw: unknown) => { success: true; data: T } | { success: false; error: unknown },
): Promise<RecordReadResult<T>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (e) {
    if (isFsInaccessible(e)) return { status: 'missing' }
    return { status: 'corrupt', reason: errorMessage(e) }
  }
  const parsed = parse(safeParseJSON(raw, false))
  if (!parsed.success) {
    return { status: 'corrupt', reason: `schema validation failed: ${path}` }
  }
  return { status: 'ok', record: parsed.data }
}

// ---------------------------------------------------------------------------
// Agent records
// ---------------------------------------------------------------------------

export type NewAgentRecordInput = Omit<
  AgentRecord,
  'createdAt' | 'updatedAt' | 'ownerPid' | 'ownerSessionId' | 'slot'
>

/**
 * Create or replace an agent record, stamping ownership with this RAYU process.
 *
 * `ownerPid` is what makes `session-bound` liveness decidable after a crash:
 * the foreign pid alone cannot distinguish "RAYU exited so the pipe died" from
 * "the agent is still running under some other RAYU".
 */
export async function writeAgentRecord(
  input: NewAgentRecordInput,
): Promise<AgentRecord> {
  const parsed = parseAgentInstanceId(input.agentInstanceId)
  if (!parsed) {
    throw new Error(
      `Cannot persist agent: ${JSON.stringify(input.agentInstanceId)} is not '<provider>:<slot>'.`,
    )
  }
  const now = Date.now()
  const existing = await readAgentRecord(
    input.agentInstanceId as AgentInstanceId,
  )
  const record: AgentRecord = {
    ...input,
    slot: parsed.slot,
    ownerPid: process.pid,
    ownerSessionId: getSessionId(),
    createdAt: existing.status === 'ok' ? existing.record.createdAt : now,
    updatedAt: now,
  }
  await writeJsonAtomic(
    getAgentRecordPath(input.agentInstanceId as AgentInstanceId),
    record,
  )
  return record
}

export async function readAgentRecord(
  agentInstanceId: AgentInstanceId,
): Promise<RecordReadResult<AgentRecord>> {
  return readJsonValidated(getAgentRecordPath(agentInstanceId), raw =>
    agentRecordSchema().safeParse(raw),
  )
}

/**
 * Merge `patch` into an existing record. No-ops when the record is missing or
 * corrupt — a patch must never resurrect a record it cannot read in full,
 * because the result would be a record with default-filled unknown fields.
 */
export async function patchAgentRecord(
  agentInstanceId: AgentInstanceId,
  patch: Partial<Omit<AgentRecord, 'agentInstanceId' | 'provider' | 'slot'>>,
): Promise<AgentRecord | null> {
  const current = await readAgentRecord(agentInstanceId)
  if (current.status !== 'ok') {
    logForDebugging(
      `[agentStore] patch skipped for ${agentInstanceId}: record ${current.status}`,
    )
    return null
  }
  const next: AgentRecord = {
    ...current.record,
    ...patch,
    updatedAt: Date.now(),
  }
  await writeJsonAtomic(getAgentRecordPath(agentInstanceId), next)
  return next
}

/** Delete one agent's entire state directory. The only destructive operation here. */
export async function pruneAgentRecord(
  agentInstanceId: AgentInstanceId,
): Promise<void> {
  await rm(getAgentDir(agentInstanceId), { recursive: true, force: true })
}

/**
 * Enumerate every persisted instance id by walking `<provider>/<slot>`.
 *
 * Skips any directory name that is not a safe path segment. Such a name cannot
 * have been produced by `getAgentDir` and is therefore foreign to this store —
 * it is ignored, never parsed and never removed.
 */
export async function listAgentInstanceIds(): Promise<AgentInstanceId[]> {
  const root = getAgentsRootDir()
  const ids: AgentInstanceId[] = []
  let providerDirs
  try {
    providerDirs = await readdir(root, { withFileTypes: true })
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[agentStore] readdir ${root} failed: ${errorMessage(e)}`)
    }
    return ids
  }
  for (const providerEntry of providerDirs) {
    if (!providerEntry.isDirectory()) continue
    if (!isSafePathSegment(providerEntry.name)) continue
    const provider = providerEntry.name as ProviderId
    let slotDirs
    try {
      slotDirs = await readdir(join(root, provider), { withFileTypes: true })
    } catch {
      continue
    }
    for (const slotEntry of slotDirs) {
      if (!slotEntry.isDirectory()) continue
      if (!isSafePathSegment(slotEntry.name)) continue
      ids.push(formatAgentInstanceId(provider, slotEntry.name))
    }
  }
  return ids
}

/** Every readable record, plus the ids whose records could not be parsed. */
export async function listAgentRecords(): Promise<{
  records: AgentRecord[]
  corrupt: AgentInstanceId[]
}> {
  const records: AgentRecord[] = []
  const corrupt: AgentInstanceId[] = []
  for (const id of await listAgentInstanceIds()) {
    const result = await readAgentRecord(id)
    if (result.status === 'ok') {
      records.push(result.record)
    } else if (result.status === 'corrupt') {
      corrupt.push(id)
    }
  }
  return { records, corrupt }
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

export type Liveness = 'live' | 'dead' | 'unknown'

/**
 * Decide whether a persisted agent is still alive, using only PID probes.
 *
 * Returns `unknown` rather than guessing when PIDs cannot settle it. Two cases
 * matter and both are real:
 *
 *  - A `process-durable` agent adopted over HTTP has no pid RAYU ever learned.
 *    Only an endpoint probe can answer, which is discovery's job (Task 9).
 *  - On WSL, `~/.rayu` may be shared with a Windows-native install, so a
 *    Windows PID is not probeable and `isProcessRunning` would report a live
 *    agent as dead. `concurrentSessions.countConcurrentSessions` accepts an
 *    undercount there; we cannot, because acting on it would mark a working
 *    agent dead and orphan its task.
 *
 * Pure and synchronous so the recovery path and the tests can drive it directly.
 */
export function classifyLiveness(record: AgentRecord): Liveness {
  const pidProbesUnreliable = getPlatform() === 'wsl'

  if (record.durability === 'session-bound') {
    // The control channel is a pipe owned by `ownerPid`. If that RAYU process
    // is gone the pipe is gone, so the agent is unreachable even if its own
    // process somehow lingers.
    if (record.ownerPid === process.pid) return 'live'
    if (pidProbesUnreliable) return 'unknown'
    if (!isProcessRunning(record.ownerPid)) return 'dead'
    return record.pid !== undefined && !isProcessRunning(record.pid)
      ? 'dead'
      : 'live'
  }

  // process-durable: the agent outlives any single RAYU, so ownerPid says
  // nothing about it. Only its own pid does — and only if we know it.
  if (record.pid === undefined) return 'unknown'
  if (pidProbesUnreliable) return 'unknown'
  return isProcessRunning(record.pid) ? 'live' : 'dead'
}

/**
 * Mark every unambiguously-dead agent as `dead`, recording forensics.
 *
 * Does not delete anything (see the module header). Records already in a
 * terminal state are left untouched so the first observed cause of death is
 * preserved rather than overwritten by a later sweep.
 *
 * @returns ids reclaimed by this call.
 */
export async function sweepStaleAgents(): Promise<AgentInstanceId[]> {
  const { records } = await listAgentRecords()
  const reclaimed: AgentInstanceId[] = []
  for (const record of records) {
    if (record.agentState === 'dead' || record.agentState === 'stopped') {
      continue
    }
    if (classifyLiveness(record) !== 'dead') continue
    const id = record.agentInstanceId as AgentInstanceId
    const forensics: AgentForensics = record.forensics ?? {
      reason: 'process_exit',
      at: Date.now(),
      lastKnownAgentState: record.agentState,
      lastEventSeq: record.lastEventSeq,
      message: 'Detected as not running during startup sweep.',
    }
    await patchAgentRecord(id, {
      agentState: 'dead',
      processState: 'exited',
      connectionState: 'lost',
      activeTurn: undefined,
      forensics,
    })
    reclaimed.push(id)
    logForDebugging(`[agentStore] reclaimed stale agent ${id}`)
  }
  return reclaimed
}

/**
 * Mark a `session-bound` agent dead when this RAYU process exits.
 *
 * Registered per agent at spawn time. Without it, a clean RAYU exit would leave
 * records claiming `working`, and the next startup could not tell a graceful
 * shutdown from a crash.
 *
 * @returns unregister function, to call when the agent is stopped normally.
 */
export function registerAgentExitCleanup(
  agentInstanceId: AgentInstanceId,
): () => void {
  return registerCleanup(async () => {
    try {
      await patchAgentRecord(agentInstanceId, {
        agentState: 'stopped',
        connectionState: 'disconnected',
        activeTurn: undefined,
        forensics: {
          reason: 'shutdown',
          at: Date.now(),
          lastKnownAgentState: 'stopped',
          message: 'RAYU exited; session-bound control channel closed.',
        },
      })
    } catch (e) {
      logForDebugging(
        `[agentStore] exit cleanup failed for ${agentInstanceId}: ${errorMessage(e)}`,
      )
    }
  })
}

// ---------------------------------------------------------------------------
// Sessions + tasks
// ---------------------------------------------------------------------------

export async function readAgentSessions(
  agentInstanceId: AgentInstanceId,
): Promise<RecordReadResult<AgentSessionsRecord>> {
  return readJsonValidated(getAgentSessionsPath(agentInstanceId), raw =>
    agentSessionsRecordSchema().safeParse(raw),
  )
}

export async function writeAgentSessions(
  agentInstanceId: AgentInstanceId,
  record: AgentSessionsRecord,
): Promise<void> {
  await writeJsonAtomic(getAgentSessionsPath(agentInstanceId), record)
}

export async function readAgentTasks(
  agentInstanceId: AgentInstanceId,
): Promise<RecordReadResult<AgentTasksRecord>> {
  return readJsonValidated(getAgentTasksPath(agentInstanceId), raw =>
    agentTasksRecordSchema().safeParse(raw),
  )
}

export async function writeAgentTasks(
  agentInstanceId: AgentInstanceId,
  record: AgentTasksRecord,
): Promise<void> {
  await writeJsonAtomic(getAgentTasksPath(agentInstanceId), record)
}
