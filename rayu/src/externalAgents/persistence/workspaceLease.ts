/**
 * Per-file write leases for concurrent external agents.
 *
 * When Codex and Claude Code both hold work in the same checkout, nothing stops
 * them editing `auth.ts` at the same time. A lease lets RAYU *notice* that and
 * react (warn, serialize, or isolate into worktrees — see Task 12).
 *
 * ## What this does and does not guarantee
 *
 * This is **advisory at RAYU's boundary**, not enforcement. A foreign agent CLI
 * writes files through its own tooling and never asks RAYU for permission, so a
 * lease cannot physically block it. What a lease does give you:
 *
 *   - RAYU-mediated writes (its own tools, and anything routed through the
 *     RAYU MCP server that foreign agents call back into) can check first.
 *   - Overlap becomes *detectable* before the merge conflict, so the
 *     orchestrator can choose worktree isolation instead of hoping.
 *
 * Presenting it as a mutex would be a lie, and a dangerous one — callers would
 * skip isolation believing they were protected. Worktree isolation is the real
 * remedy; leases are the detector.
 *
 * ## Mechanics
 *
 * Same proven pattern as `src/utils/cronTasksLock.ts`: `O_EXCL` create for
 * atomic test-and-set, PID-liveness probe on the holder, stale-lock recovery,
 * and cleanup-on-exit. Lease files live in one flat directory keyed by a hash
 * of the target path, since an absolute path cannot itself be a filename.
 */

import { createHash } from 'crypto'
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage, getErrnoCode, isFsInaccessible } from '../../utils/errors.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { safeParseJSON } from '../../utils/json.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlatform } from '../../utils/platform.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { AgentInstanceId } from '../core/types.js'
import { getLeasesDir } from './paths.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

const leaseSchema = lazySchema(() =>
  z.object({
    /** Absolute path being written. Kept so a lease is self-describing. */
    path: z.string().min(1),
    agentInstanceId: z.string().min(1),
    /** RAYU process that acquired it — the liveness anchor. */
    ownerPid: z.number(),
    acquiredAt: z.number(),
  }),
)

export type WriteLease = z.infer<ReturnType<typeof leaseSchema>>

export type LeaseResult =
  | { acquired: true; lease: WriteLease }
  | { acquired: false; heldBy: WriteLease }
  /** The lease directory could not be used; caller should proceed unprotected. */
  | { acquired: false; heldBy: null; error: string }

/**
 * Lease filename for a target path.
 *
 * sha256 of the absolute path, truncated to 32 hex chars. Truncation is safe
 * here: a collision would only cause a spurious overlap warning between two
 * unrelated files, never a missed one, and never a wrong file being written.
 */
function leasePathFor(targetPath: string): string {
  const digest = createHash('sha256').update(targetPath).digest('hex')
  return join(getLeasesDir(), `${digest.slice(0, 32)}.lease`)
}

async function readLease(leaseFile: string): Promise<WriteLease | undefined> {
  let raw: string
  try {
    raw = await readFile(leaseFile, 'utf-8')
  } catch {
    return undefined
  }
  const parsed = leaseSchema().safeParse(safeParseJSON(raw, false))
  return parsed.success ? parsed.data : undefined
}

/** Atomic create. False means someone else already holds it. */
async function tryCreateExclusive(
  leaseFile: string,
  lease: WriteLease,
): Promise<boolean> {
  const body = jsonStringify(lease)
  try {
    await writeFile(leaseFile, body, { flag: 'wx', mode: FILE_MODE })
    return true
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'EEXIST') return false
    if (code === 'ENOENT') {
      await mkdir(getLeasesDir(), { recursive: true, mode: DIR_MODE })
      try {
        await writeFile(leaseFile, body, { flag: 'wx', mode: FILE_MODE })
        return true
      } catch (retry) {
        if (getErrnoCode(retry) === 'EEXIST') return false
        throw retry
      }
    }
    throw e
  }
}

/**
 * True when a held lease may be taken over.
 *
 * Conservative on WSL, where a PID recorded by a Windows-native RAYU is not
 * probeable and would look dead — stealing then would let two agents write the
 * same file believing each was exclusive.
 */
function isLeaseStale(lease: WriteLease): boolean {
  if (lease.ownerPid === process.pid) return false
  if (getPlatform() === 'wsl') return false
  return !isProcessRunning(lease.ownerPid)
}

/**
 * Try to claim write ownership of `targetPath` for `agentInstanceId`.
 *
 * Re-acquiring a lease this agent already holds succeeds idempotently. A lease
 * held by a dead RAYU is recovered; if two processes race that recovery, only
 * one `O_EXCL` create wins and the loser is told who holds it.
 */
export async function tryAcquireWriteLease(
  targetPath: string,
  agentInstanceId: AgentInstanceId,
): Promise<LeaseResult> {
  const leaseFile = leasePathFor(targetPath)
  const lease: WriteLease = {
    path: targetPath,
    agentInstanceId,
    ownerPid: process.pid,
    acquiredAt: Date.now(),
  }

  try {
    if (await tryCreateExclusive(leaseFile, lease)) {
      return { acquired: true, lease }
    }
    const existing = await readLease(leaseFile)

    // Unparseable lease file — treat as stale rather than blocking forever.
    if (!existing || isLeaseStale(existing)) {
      await unlink(leaseFile).catch(() => {})
      if (await tryCreateExclusive(leaseFile, lease)) {
        return { acquired: true, lease }
      }
      const winner = await readLease(leaseFile)
      return winner
        ? { acquired: false, heldBy: winner }
        : { acquired: false, heldBy: null, error: 'lease contention unresolved' }
    }

    if (existing.agentInstanceId === agentInstanceId) {
      return { acquired: true, lease: existing }
    }
    return { acquired: false, heldBy: existing }
  } catch (e) {
    logForDebugging(
      `[workspaceLease] acquire failed for ${targetPath}: ${errorMessage(e)}`,
    )
    return { acquired: false, heldBy: null, error: errorMessage(e) }
  }
}

/** Release a lease if `agentInstanceId` still owns it. Safe to call blind. */
export async function releaseWriteLease(
  targetPath: string,
  agentInstanceId: AgentInstanceId,
): Promise<void> {
  const leaseFile = leasePathFor(targetPath)
  const existing = await readLease(leaseFile)
  if (!existing || existing.agentInstanceId !== agentInstanceId) return
  await unlink(leaseFile).catch(() => {})
}

/**
 * Release every lease held by one agent. Called when an agent stops so its
 * files do not stay locked against the rest of the session.
 *
 * @returns paths released.
 */
export async function releaseAllLeasesForAgent(
  agentInstanceId: AgentInstanceId,
): Promise<string[]> {
  const released: string[] = []
  for (const { file, lease } of await readAllLeases()) {
    if (lease.agentInstanceId !== agentInstanceId) continue
    await unlink(file).catch(() => {})
    released.push(lease.path)
  }
  return released
}

/** Every parseable lease currently on disk, with its backing file path. */
async function readAllLeases(): Promise<
  { file: string; lease: WriteLease }[]
> {
  const dir = getLeasesDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[workspaceLease] readdir failed: ${errorMessage(e)}`)
    }
    return []
  }
  const out: { file: string; lease: WriteLease }[] = []
  for (const entry of entries) {
    // Strict guard, same reasoning as concurrentSessions' `/^\d+\.json$/`:
    // only files this module could have produced are candidates for removal.
    if (!/^[0-9a-f]{32}\.lease$/.test(entry)) continue
    const file = join(dir, entry)
    const lease = await readLease(file)
    if (lease) out.push({ file, lease })
  }
  return out
}

/**
 * Current lease holders, keyed by target path. Used by the Workspace Manager to
 * report overlap and by `/agent inspect` to show who owns what.
 */
export async function listWriteLeases(): Promise<WriteLease[]> {
  return (await readAllLeases()).map(entry => entry.lease)
}

/**
 * Drop leases whose owning RAYU process is gone.
 *
 * Unlike `agentStore.sweepStaleAgents`, deleting here is correct and necessary:
 * a lease is pure coordination state with no forensic value, and leaving dead
 * ones behind would block live agents indefinitely.
 *
 * @returns paths whose leases were reclaimed.
 */
export async function sweepStaleLeases(): Promise<string[]> {
  const reclaimed: string[] = []
  for (const { file, lease } of await readAllLeases()) {
    if (!isLeaseStale(lease)) continue
    await unlink(file).catch(() => {})
    reclaimed.push(lease.path)
    logForDebugging(
      `[workspaceLease] reclaimed stale lease on ${lease.path} from pid ${lease.ownerPid}`,
    )
  }
  return reclaimed
}

/**
 * Release all of this process's leases on exit, so a graceful shutdown never
 * leaves a live-looking lease behind.
 */
export function registerLeaseCleanup(): () => void {
  return registerCleanup(async () => {
    for (const { file, lease } of await readAllLeases()) {
      if (lease.ownerPid !== process.pid) continue
      await unlink(file).catch(() => {})
    }
  })
}
