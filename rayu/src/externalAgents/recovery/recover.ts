/**
 * What to do about agents left behind by a previous RAYU session.
 *
 * Read-only by design
 * -------------------
 * `planRecovery` decides NOTHING irreversible. It sweeps unambiguously-dead
 * records (a state write, no processes touched) and then REPORTS a per-agent
 * recommendation. It deliberately does not relaunch anything automatically:
 * a relaunch spawns a third-party process the user did not ask for in this
 * session, in a directory that may have moved on, and could re-run work that
 * already half-landed. Offering is honest; acting is not.
 *
 * Preserving conversation identity
 * --------------------------------
 * A relaunch carries the foreign agent's OWN session id (Codex `threadId`,
 * Claude Code `--session-id`, OpenCode session id) from the sessions record.
 * Without it the agent starts a brand-new conversation with no history, which
 * looks like recovery but silently throws the context away.
 *
 * Never steal another RAYU's agent
 * -------------------------------
 * `classifyLiveness` reports a session-bound agent as `live` whenever its owner
 * process is alive — including when that owner is a DIFFERENT RAYU. Its control
 * channel is a pipe belonging to that process, so this session can neither
 * reconnect to it nor safely relaunch over it. Those come back as
 * `owned-elsewhere` and are left completely alone.
 */

import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import {
  findLiveAgent,
  reconnectAgent,
  startAgent,
} from '../core/AgentManager.js'
import { findAdapter } from '../core/adapterRegistry.js'
import { readLastEvent } from '../core/eventLog.js'
import type { AgentHandle } from '../core/adapter.js'
import {
  asAgentSessionId,
  asProviderId,
  type AgentInstanceId,
  type AgentSessionId,
} from '../core/types.js'
import {
  classifyLiveness,
  type Liveness,
  listAgentRecords,
  patchAgentRecord,
  readAgentSessions,
  sweepStaleAgents,
} from '../persistence/agentStore.js'
import type { AgentForensics, AgentRecord } from '../persistence/schemas.js'

export type RecoveryAction =
  /** Process-durable, alive, and its adapter can re-attach. */
  | 'reconnect'
  /** Gone. Can be relaunched, continuing its own session. */
  | 'relaunch'
  /** Alive, but another RAYU process holds the control channel. */
  | 'owned-elsewhere'
  /** Liveness genuinely cannot be determined from pids alone. */
  | 'undecidable'
  /** This process already has it connected. */
  | 'already-connected'
  /** Nothing to do: intentionally stopped, or its adapter is gone. */
  | 'inert'

export type RecoveryCandidate = {
  readonly agentInstanceId: AgentInstanceId
  readonly provider: string
  readonly action: RecoveryAction
  /** Why this action, phrased for the user. */
  readonly reason: string
  readonly liveness: Liveness
  readonly durability: AgentRecord['durability']
  readonly adoption: AgentRecord['adoption']
  readonly cwd: string
  readonly pid?: number
  readonly ownerPid: number
  readonly tmuxSession?: string
  /** The agent's own conversation id, carried into a relaunch. */
  readonly resumeSessionId?: AgentSessionId
  readonly lastEventSeq?: number
  readonly forensics?: AgentForensics
  /** What the agent was last seen doing, from the event log. */
  readonly lastActivity?: string
}

export type RecoveryReport = {
  readonly candidates: readonly RecoveryCandidate[]
  /** Records that failed schema validation and were skipped. */
  readonly corrupt: readonly AgentInstanceId[]
  /** Ids this call marked dead (state only — nothing was killed). */
  readonly sweptDead: readonly AgentInstanceId[]
}

/**
 * Survey what a previous session left behind.
 *
 * The sweep runs first so a record whose process is provably gone is marked
 * dead with forensics before it is classified — otherwise the same agent would
 * be reported as recoverable on every startup while its cause of death was
 * never recorded.
 */
export async function planRecovery(): Promise<RecoveryReport> {
  const sweptDead = await sweepStaleAgents().catch(error => {
    // A failed sweep must not block the survey; the records are still readable
    // and a stale `agentState` only makes the report more conservative.
    logForDebugging(
      `[externalAgents] recovery sweep failed: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    return [] as AgentInstanceId[]
  })

  const { records, corrupt } = await listAgentRecords()
  const candidates = await Promise.all(
    records.map(record => classifyRecord(record)),
  )

  return { candidates, corrupt, sweptDead }
}

async function classifyRecord(
  record: AgentRecord,
): Promise<RecoveryCandidate> {
  const agentInstanceId = record.agentInstanceId as AgentInstanceId
  const liveness = classifyLiveness(record)
  const sessions = await readAgentSessions(agentInstanceId).catch(() => ({
    status: 'missing' as const,
  }))
  const resumeSessionId =
    sessions.status === 'ok' && sessions.record.activeSessionId
      ? asAgentSessionId(sessions.record.activeSessionId)
      : undefined

  const base = {
    agentInstanceId,
    provider: record.provider,
    liveness,
    durability: record.durability,
    adoption: record.adoption,
    cwd: record.cwd,
    pid: record.pid,
    ownerPid: record.ownerPid,
    tmuxSession: record.tmuxSession,
    resumeSessionId,
    lastEventSeq: record.lastEventSeq,
    forensics: record.forensics,
    lastActivity: await describeLastActivity(agentInstanceId),
  }

  return { ...base, ...decideAction(record, liveness, resumeSessionId) }
}

function decideAction(
  record: AgentRecord,
  liveness: Liveness,
  resumeSessionId: AgentSessionId | undefined,
): { action: RecoveryAction; reason: string } {
  const agentInstanceId = record.agentInstanceId as AgentInstanceId

  if (findLiveAgent(agentInstanceId)) {
    return {
      action: 'already-connected',
      reason: 'Already connected to this session.',
    }
  }

  // An agent whose adapter is not registered cannot be acted on at all —
  // saying "relaunch" would produce an UnknownProviderError the moment the user
  // tried it.
  if (!findAdapter(asProviderId(record.provider))) {
    return {
      action: 'inert',
      reason: `No adapter is registered for "${record.provider}", so RAYU cannot act on this record.`,
    }
  }

  if (record.agentState === 'stopped') {
    return {
      action: 'inert',
      reason: 'Stopped on purpose. Start a new agent if you want it back.',
    }
  }

  // Checked BEFORE liveness branching: a live session-bound agent belonging to
  // another RAYU is live *for that process*, not for this one.
  if (
    record.durability === 'session-bound' &&
    record.ownerPid !== process.pid &&
    isProcessRunning(record.ownerPid)
  ) {
    return {
      action: 'owned-elsewhere',
      reason: `Another RAYU (pid ${record.ownerPid}) owns this agent's control channel. Leave it to that session.`,
    }
  }

  switch (liveness) {
    case 'live':
      return decideForLive(record)
    case 'dead':
      return {
        action: 'relaunch',
        reason: resumeSessionId
          ? `Not running. A relaunch will resume its own session ${resumeSessionId}.`
          : 'Not running, and no native session id was recorded, so a relaunch starts a fresh conversation.',
      }
    default:
      return {
        action: 'undecidable',
        reason: describeUndecidable(record),
      }
  }
}

function decideForLive(record: AgentRecord): {
  action: RecoveryAction
  reason: string
} {
  const adapter = findAdapter(asProviderId(record.provider))
  if (record.durability === 'process-durable' && adapter?.reconnect) {
    return {
      action: 'reconnect',
      reason: 'Still running and its adapter can re-attach to it.',
    }
  }
  if (record.durability === 'process-durable') {
    return {
      action: 'inert',
      reason: `${record.provider} agents cannot be re-attached to once RAYU has let go, so this one has to be left alone or replaced.`,
    }
  }
  // session-bound + live + owned by THIS pid, yet absent from the registry:
  // the record outlived the handle within one process. Trustworthy enough to
  // report, not to act on silently.
  return {
    action: 'undecidable',
    reason:
      'The record says it is running under this process, but no live handle exists. It may have been stopped without the record being updated.',
  }
}

function describeUndecidable(record: AgentRecord): string {
  if (record.durability === 'process-durable' && record.pid === undefined) {
    return 'Adopted over the network, so RAYU never learned a pid and cannot tell whether it is still running. Run /agent discover to probe for it.'
  }
  return 'Process ids are not probeable in this environment (WSL sharing ~/.rayu with a Windows install), so liveness cannot be established. Run /agent discover to probe for it.'
}

/** One-line summary of the agent's last logged event, when the log survives. */
async function describeLastActivity(
  agentId: AgentInstanceId,
): Promise<string | undefined> {
  const event = await readLastEvent(agentId).catch(() => null)
  if (!event) return undefined
  const when = new Date(event.at).toISOString()
  switch (event.type) {
    case 'task_failed':
      return `last event: task_failed \u2014 ${event.message} (${when})`
    case 'task_completed':
      return `last event: task_completed${event.summary ? ` \u2014 ${event.summary}` : ''} (${when})`
    case 'agent_disconnected':
      return `last event: disconnected (${event.reason}) at ${when}`
    case 'agent_error':
      return `last event: agent_error \u2014 ${event.message} (${when})`
    default:
      return `last event: ${event.type} at ${when}`
  }
}

// ---------------------------------------------------------------------------
// Acting on a candidate — always explicit, never automatic
// ---------------------------------------------------------------------------

export type RecoveryOutcome =
  | { readonly ok: true; readonly handle: AgentHandle; readonly note: string }
  | { readonly ok: false; readonly message: string }

/**
 * Carry out a candidate's recommended action.
 *
 * Refuses anything other than `reconnect` and `relaunch`: the remaining actions
 * are statements about the world, not instructions, and pretending to execute
 * them would be the "method that always throws" mistake in another guise.
 */
export async function applyRecovery(
  candidate: RecoveryCandidate,
): Promise<RecoveryOutcome> {
  try {
    if (candidate.action === 'reconnect') {
      const handle = await reconnectAgent(candidate.agentInstanceId)
      return {
        ok: true,
        handle,
        note: `Reconnected to ${candidate.agentInstanceId}.`,
      }
    }

    if (candidate.action === 'relaunch') {
      const handle = await startAgent({
        // The SAME instance id, so its history, forensics and event log stay
        // attached to one logical agent across the restart.
        agentId: candidate.agentInstanceId,
        provider: asProviderId(candidate.provider),
        cwd: candidate.cwd,
        resumeSessionId: candidate.resumeSessionId,
        tmuxSession: candidate.tmuxSession,
      })
      return {
        ok: true,
        handle,
        note: candidate.resumeSessionId
          ? `Relaunched ${candidate.agentInstanceId}, resuming session ${candidate.resumeSessionId}.`
          : `Relaunched ${candidate.agentInstanceId} with a fresh conversation (no native session id was recorded).`,
      }
    }

    return {
      ok: false,
      message: `"${candidate.action}" describes the agent's situation; there is nothing to execute. ${candidate.reason}`,
    }
  } catch (error) {
    return {
      ok: false,
      message: `Could not ${candidate.action} ${candidate.agentInstanceId}: ${errorMessage(error)}`,
    }
  }
}

/**
 * Record why this RAYU is letting go of the agents it owns.
 *
 * Written BEFORE detaching, so the reason survives even if teardown itself is
 * cut short. Only touches records this process owns — another session's agents
 * are none of our business.
 */
export async function recordShutdownForensics(
  handles: readonly AgentHandle[],
): Promise<void> {
  await Promise.all(
    handles.map(async handle => {
      const status = handle.status()
      const forensics: AgentForensics = {
        reason: 'shutdown',
        at: Date.now(),
        lastKnownAgentState: status.agentState,
        agentSessionId: handle.activeSessionId(),
        message:
          handle.durability === 'process-durable'
            ? 'RAYU exited; the agent was left running and can be reconnected.'
            : 'RAYU exited; a session-bound agent cannot outlive it.',
      }
      await patchAgentRecord(handle.agentId, { forensics }).catch(error => {
        // Teardown must not fail because a forensics write did.
        logForDebugging(
          `[externalAgents] forensics write failed for ${handle.agentId}: ${errorMessage(error)}`,
        )
      })
    }),
  )
}

export function formatRecoveryReport(report: RecoveryReport): string {
  if (report.candidates.length === 0 && report.corrupt.length === 0) {
    return 'No external agents from previous sessions.'
  }

  const lines: string[] = []
  const actionable = report.candidates.filter(
    candidate =>
      candidate.action === 'reconnect' || candidate.action === 'relaunch',
  )
  lines.push(
    `${report.candidates.length} external agent record${report.candidates.length === 1 ? '' : 's'} found, ${actionable.length} actionable.`,
  )

  for (const candidate of report.candidates) {
    lines.push(
      `  [${candidate.action}] ${candidate.agentInstanceId} (${candidate.provider}, ${candidate.liveness})`,
    )
    lines.push(`      ${candidate.reason}`)
    if (candidate.lastActivity) lines.push(`      ${candidate.lastActivity}`)
    if (candidate.forensics) {
      lines.push(
        `      died: ${candidate.forensics.reason}${
          candidate.forensics.message ? ` \u2014 ${candidate.forensics.message}` : ''
        }`,
      )
    }
  }

  if (report.sweptDead.length > 0) {
    lines.push(
      `  ${report.sweptDead.length} record${report.sweptDead.length === 1 ? '' : 's'} newly marked dead by this survey.`,
    )
  }
  if (report.corrupt.length > 0) {
    lines.push(
      `  ${report.corrupt.length} record${report.corrupt.length === 1 ? '' : 's'} could not be read and were skipped: ${report.corrupt.join(', ')}`,
    )
  }
  return lines.join('\n')
}
