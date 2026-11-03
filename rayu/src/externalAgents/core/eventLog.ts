/**
 * Append-only normalized event log, one directory per agent instance.
 *
 *   ~/.rayu/agents/<provider>/<slot>/events/events.jsonl
 *   ~/.rayu/agents/<provider>/<slot>/events/events.1.jsonl   (previous segment)
 *
 * This is what makes a crash recoverable. `agent.json` records the agent's last
 * known *state*; this log records how it got there, which is the only way to
 * answer "what was it doing when it died" after the process is gone.
 *
 * ## Bounded by construction
 *
 * A chatty agent streaming token deltas produces a lot of lines. The existing
 * `TaskOutput` carries a 5GB disk cap because unbounded background output once
 * filled 768GB of a user's disk (see `ShellCommand.#startSizeWatchdog`). The
 * same hazard applies here, so the log rotates at a segment cap and keeps
 * exactly one previous segment — bounded total footprint per agent, with enough
 * history to explain a crash.
 *
 * ## Serialized writes
 *
 * Appends for one agent are chained through a per-agent promise. Concurrent
 * `appendFile` calls on the same descriptor can interleave partial writes and
 * corrupt a JSONL line, which would poison the reader for every earlier event
 * too — the exact failure the recovery path cannot tolerate.
 */

import { appendFile, mkdir, readFile, rename, rm, stat } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage, isFsInaccessible } from '../../utils/errors.js'
import { parseJSONL } from '../../utils/json.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getAgentEventsDir } from '../persistence/paths.js'
import type { AgentInstanceId, ExternalAgentEvent } from './types.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * Rotate at 32MB per segment, keeping one previous segment: at most ~64MB per
 * agent. Deliberately far below `MAX_TASK_OUTPUT_BYTES` (5GB) because this log
 * holds structured events for diagnosis, not command output a user asked for.
 */
const SEGMENT_CAP_BYTES = 32 * 1024 * 1024

/** Per-agent write chain — see "Serialized writes" above. */
const writeChains = new Map<AgentInstanceId, Promise<void>>()

function currentSegment(agentId: AgentInstanceId): string {
  return join(getAgentEventsDir(agentId), 'events.jsonl')
}

function previousSegment(agentId: AgentInstanceId): string {
  return join(getAgentEventsDir(agentId), 'events.1.jsonl')
}

/**
 * Rotate when the active segment is at or over the cap.
 *
 * Rotation is a rename, so it cannot lose the segment being retired; the older
 * previous segment is dropped only after the rename succeeds.
 */
async function rotateIfNeeded(agentId: AgentInstanceId): Promise<void> {
  const active = currentSegment(agentId)
  let size: number
  try {
    size = (await stat(active)).size
  } catch {
    return // No segment yet.
  }
  if (size < SEGMENT_CAP_BYTES) return
  try {
    await rm(previousSegment(agentId), { force: true })
    await rename(active, previousSegment(agentId))
    logForDebugging(`[eventLog] rotated segment for ${agentId}`)
  } catch (e) {
    // A failed rotation must not stop logging — worst case the segment grows
    // past the cap until the next append retries.
    logForDebugging(
      `[eventLog] rotation failed for ${agentId}: ${errorMessage(e)}`,
    )
  }
}

/**
 * Append one event. Never throws — logging must not break an agent's turn.
 *
 * @returns a promise that settles when this event is on disk. Callers may
 *   ignore it; the chain still serializes.
 */
export function appendEvent(event: ExternalAgentEvent): Promise<void> {
  const agentId = event.agentId
  const previous = writeChains.get(agentId) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      await mkdir(getAgentEventsDir(agentId), {
        recursive: true,
        mode: DIR_MODE,
      })
      await rotateIfNeeded(agentId)
      await appendFile(currentSegment(agentId), `${jsonStringify(event)}\n`, {
        encoding: 'utf-8',
        mode: FILE_MODE,
      })
    })
    .catch(e => {
      logForDebugging(
        `[eventLog] append failed for ${agentId}: ${errorMessage(e)}`,
      )
    })
  writeChains.set(agentId, next)
  return next
}

/** Flush pending appends for one agent, so a reader sees everything published. */
export async function flushEventLog(agentId: AgentInstanceId): Promise<void> {
  await (writeChains.get(agentId) ?? Promise.resolve())
}

async function readSegment(path: string): Promise<ExternalAgentEvent[]> {
  try {
    return parseJSONL<ExternalAgentEvent>(await readFile(path, 'utf-8'))
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[eventLog] read ${path} failed: ${errorMessage(e)}`)
    }
    return []
  }
}

/**
 * Read an agent's logged events, oldest first, across both segments.
 *
 * @param sinceSeq return only events with `seq` greater than this. Pass the
 *   persisted `lastEventSeq` after a reconnect to replay just the tail.
 */
export async function readEvents(
  agentId: AgentInstanceId,
  options: { sinceSeq?: number; limit?: number } = {},
): Promise<ExternalAgentEvent[]> {
  await flushEventLog(agentId)
  const events = [
    ...(await readSegment(previousSegment(agentId))),
    ...(await readSegment(currentSegment(agentId))),
  ]
  const sinceSeq = options.sinceSeq
  const filtered =
    sinceSeq === undefined
      ? events
      : events.filter(event => event.seq > sinceSeq)
  return options.limit !== undefined
    ? filtered.slice(-options.limit)
    : filtered
}

/**
 * The last event recorded for an agent, or null.
 *
 * Task 16's forensics use this to report what the agent was doing at the moment
 * it stopped, which `agent.json` alone cannot say.
 */
export async function readLastEvent(
  agentId: AgentInstanceId,
): Promise<ExternalAgentEvent | null> {
  const events = await readEvents(agentId, { limit: 1 })
  return events[events.length - 1] ?? null
}

/** Drop an agent's log. Called from `pruneAgentRecord`-style teardown. */
export async function clearEventLog(
  agentId: AgentInstanceId,
): Promise<void> {
  await flushEventLog(agentId)
  writeChains.delete(agentId)
  await rm(getAgentEventsDir(agentId), { recursive: true, force: true })
}
