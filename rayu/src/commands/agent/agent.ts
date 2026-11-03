/**
 * `/agent` implementation — argument parsing and delegation.
 *
 * No orchestration logic lives here. Every decision (can this agent be sent to?
 * should this be queued or steered? is that CLI adoptable?) belongs to
 * `AgentManager`, `resolveAdmission` and `discoverAgents`; this file turns a
 * string into one of those calls and renders the answer.
 *
 * Two rules shape the parsing:
 *   1. A bare `/agent` runs `list`, which is read-only. A typo must never launch
 *      or kill a process.
 *   2. Free text is only consumed by `send` / `steer`, and it is taken verbatim
 *      after the agent id — so a prompt containing `--worktree` is a prompt, not
 *      a flag.
 */

import { registerAdapters } from '../../externalAgents/adapters/registry.js'
import {
  adoptAgent,
  allocateAgentId,
  assign,
  findLiveAgent,
  inspectAgent,
  interruptAgent,
  listLiveAgents,
  pendingCount,
  reconnectAgent,
  startAgent,
  stopAgent,
} from '../../externalAgents/core/AgentManager.js'
import {
  discoverAgents,
  formatDiscoveryReport,
} from '../../externalAgents/core/discovery.js'
import {
  AdmissionError,
  CapabilityError,
  UnknownAgentError,
  UnknownProviderError,
} from '../../externalAgents/core/errors.js'
import {
  applyRecovery,
  formatRecoveryReport,
  planRecovery,
} from '../../externalAgents/recovery/recover.js'
import { asProviderId, type AgentInstanceId } from '../../externalAgents/core/types.js'
import { getExternalAgentsDisabledReason } from '../../externalAgents/featureGate.js'
import {
  listPendingApprovals,
  resurfacePendingApprovals,
} from '../../externalAgents/permissions/permissionBroker.js'
import {
  attachToAgentTerminal,
  describeAttachFallback,
} from '../../externalAgents/terminal/index.js'
import {
  findConflicts,
  formatConflictReport,
  getChangeSummary,
} from '../../externalAgents/workspace/changeTracker.js'
import {
  formatWorkspaceReport,
  listWorkspaces,
  prepareWorkspace,
  releaseWorkspace,
} from '../../externalAgents/workspace/workspaceManager.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { toError } from '../../utils/errors.js'
import {
  AGENT_USAGE,
  formatAgentList,
  formatApprovals,
  formatChangedFiles,
  formatInspection,
} from './render.js'

type Flags = {
  cwd?: string
  model?: string
  worktree: boolean
  exclusive: boolean
  removeWorktree: boolean
  show: boolean
  unknown?: string
}

type Parsed = {
  subcommand: string
  /** Positional tokens after the subcommand, flags removed. */
  positional: string[]
  /** Everything after the first positional, verbatim — used by send/steer. */
  rest: string
  flags: Flags
}

const FLAGS_WITH_VALUES = new Set(['--cwd', '--model'])

/**
 * Subcommands whose tail is free text. Their arguments are NOT flag-parsed —
 * `send codex:agent_01 run tests with --verbose` must send `--verbose` to the
 * agent, not reject the command for an unknown flag.
 */
const FREE_TEXT_SUBCOMMANDS = new Set(['send', 'steer'])

/** Peel one whitespace-delimited token off the front, keeping the tail verbatim. */
function peel(value: string): { head: string; tail: string } {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(value)
  return { head: match?.[1] ?? '', tail: match?.[2] ?? '' }
}

function emptyFlags(): Flags {
  return {
    worktree: false,
    exclusive: false,
    removeWorktree: false,
    show: false,
  }
}

/**
 * Split `raw` into a subcommand, positionals and flags.
 *
 * For free-text subcommands the tail is taken verbatim from the ORIGINAL string,
 * so a prompt's internal whitespace and any `--`-prefixed words survive intact.
 *
 * Exported for verification: `call` is wrapped in a build-time `feature()` gate
 * that is always false when running from source, so parsing and dispatch would
 * otherwise be unreachable outside a real bundle.
 */
export function parse(raw: string): Parsed {
  const { head, tail } = peel(raw.trim())
  const subcommand = (head || 'list').toLowerCase()

  if (FREE_TEXT_SUBCOMMANDS.has(subcommand)) {
    const { head: agentId, tail: prompt } = peel(tail)
    return {
      subcommand,
      positional: agentId ? [agentId] : [],
      rest: prompt.trim(),
      flags: emptyFlags(),
    }
  }

  const flags = emptyFlags()
  const positional: string[] = []
  const tokens = tail.split(/\s+/).filter(Boolean)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    if (FLAGS_WITH_VALUES.has(token)) {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) {
        flags.unknown ??= `${token} needs a value`
        continue
      }
      if (token === '--cwd') flags.cwd = value
      else flags.model = value
      i++
      continue
    }
    switch (token) {
      case '--worktree':
        flags.worktree = true
        break
      case '--exclusive':
        flags.exclusive = true
        break
      case '--remove-worktree':
        flags.removeWorktree = true
        break
      case '--show':
        flags.show = true
        break
      default:
        flags.unknown ??= `Unknown flag ${token}`
    }
  }

  return { subcommand, positional, rest: '', flags }
}

function text(value: string): { type: 'text'; value: string } {
  return { type: 'text', value }
}

/**
 * Resolve a user-typed agent id.
 *
 * Accepts the full `provider:slot` id, or a unique prefix, so the user does not
 * have to retype `codex:agent_01`. An ambiguous prefix is refused with the
 * candidates rather than resolved arbitrarily — picking one would send work to
 * an agent the user did not mean.
 */
function resolveAgentId(
  token: string | undefined,
): { ok: true; agentId: AgentInstanceId } | { ok: false; message: string } {
  if (!token) {
    return { ok: false, message: 'Which agent? Run /agent list to see them.' }
  }
  const exact = findLiveAgent(token as AgentInstanceId)
  if (exact) return { ok: true, agentId: exact.agentId }

  const matches = listLiveAgents().filter(handle =>
    handle.agentId.startsWith(token),
  )
  if (matches.length === 1) return { ok: true, agentId: matches[0]!.agentId }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `"${token}" matches ${matches.map(m => m.agentId).join(', ')}. Use the full id.`,
    }
  }
  const running = listLiveAgents()
  return {
    ok: false,
    message:
      running.length === 0
        ? `No agent "${token}" is connected. Run /agent discover to find one.`
        : `No agent "${token}". Connected: ${running.map(m => m.agentId).join(', ')}.`,
  }
}

export const call: LocalCommandCall = async args => {
  const disabled = getExternalAgentsDisabledReason()
  if (disabled) return text(disabled)

  const parsed = parse(args)
  if (parsed.flags.unknown) {
    return text(`${parsed.flags.unknown}\n\n${AGENT_USAGE}`)
  }

  try {
    return text(await dispatch(parsed))
  } catch (error) {
    // An admission refusal, a capability shortfall or an unknown id/provider are
    // NORMAL answers, not crashes — their messages are already written for the
    // user and name the agent. Framing them as a failure would bury the point.
    if (
      error instanceof AdmissionError ||
      error instanceof CapabilityError ||
      error instanceof UnknownAgentError ||
      error instanceof UnknownProviderError
    ) {
      return text(toError(error).message)
    }
    return text(`/agent ${parsed.subcommand} failed: ${toError(error).message}`)
  }
}

/** Exported for verification — see the note on `parse`. */
export async function dispatch(parsed: Parsed): Promise<string> {
  const { subcommand, positional, rest, flags } = parsed

  switch (subcommand) {
    case 'list':
      return formatAgentList(listLiveAgents(), handle =>
        pendingCount(handle.agentId),
      )

    case 'discover': {
      // Registration is explicit (never a module side effect) so the adapters
      // stay dead-code-eliminable; discovery is the first thing that needs them.
      registerAdapters()
      return formatDiscoveryReport(await discoverAgents({ cwd: getCwd() }))
    }

    case 'start':
      return startSubcommand(positional[0], flags)

    case 'adopt': {
      registerAdapters()
      const provider = positional[0]
      if (!provider) {
        return 'Which provider? Run /agent discover to see what is adoptable.'
      }
      return adoptSubcommand(provider)
    }

    case 'reconnect': {
      registerAdapters()
      const target = resolveAgentId(positional[0])
      if (!target.ok) return target.message
      const handle = await reconnectAgent(target.agentId)
      return `Reconnected ${handle.agentId} (${handle.status().connectionState}).`
    }

    case 'send':
    case 'steer': {
      const target = resolveAgentId(positional[0])
      if (!target.ok) return target.message
      if (!rest) return `Nothing to send. Usage: /agent ${subcommand} <agentId> <text>`
      const outcome = await assign(
        target.agentId,
        { text: rest },
        { preferSteer: subcommand === 'steer' },
      )
      return describeAssign(target.agentId, outcome)
    }

    case 'interrupt': {
      const target = resolveAgentId(positional[0])
      if (!target.ok) return target.message
      await interruptAgent(target.agentId)
      return `Interrupted ${target.agentId}.`
    }

    case 'stop': {
      const target = resolveAgentId(positional[0])
      if (!target.ok) return target.message
      await stopAgent(target.agentId)
      const release = await releaseWorkspace(target.agentId, {
        removeWorktree: flags.removeWorktree,
      })
      const notes = [`Stopped ${target.agentId}.`]
      if (release.worktreeRemoved) notes.push('Worktree removed.')
      else if (release.worktreeRetainedBecause) {
        notes.push(release.worktreeRetainedBecause)
      }
      return notes.join(' ')
    }

    case 'inspect': {
      const target = resolveAgentId(positional[0])
      if (!target.ok) return target.message
      return formatInspection(await inspectAgent(target.agentId))
    }

    case 'attach': {
      const target = resolveAgentId(positional[0])
      if (!target.ok) return target.message
      const result = await attachToAgentTerminal(target.agentId)
      if (result.attached) {
        return `Detached from ${result.sessionName}. The agent is still running.`
      }
      return `${result.reason}\n${describeAttachFallback()}`
    }

    case 'approvals': {
      const pending = listPendingApprovals()
      if (flags.show && pending.length > 0) {
        const shown = resurfacePendingApprovals()
        return shown > 0
          ? `Brought ${shown} approval prompt${shown === 1 ? '' : 's'} back on screen.`
          : 'No interactive session is attached, so the prompts cannot be shown here.'
      }
      return formatApprovals(pending)
    }

    case 'workspaces':
      return formatWorkspaceReport(listWorkspaces())

    case 'conflicts':
      return formatConflictReport(findConflicts())

    case 'files': {
      const target = resolveAgentId(positional[0])
      if (!target.ok) return target.message
      const summary = getChangeSummary(target.agentId)
      return formatChangedFiles(
        target.agentId,
        summary?.files ?? [],
        summary?.overflowCount ?? 0,
      )
    }

    case 'recover':
      return recoverSubcommand(positional[0])

    case 'help':
      return AGENT_USAGE

    default:
      return `Unknown subcommand "${subcommand}".\n\n${AGENT_USAGE}`
  }
}

async function startSubcommand(
  provider: string | undefined,
  flags: Flags,
): Promise<string> {
  if (!provider) {
    return 'Which provider? Run /agent discover to see what is installed.'
  }
  registerAdapters()

  const requestedCwd = flags.cwd ?? getCwd()
  // Allocate the real instance id FIRST. Preparing the workspace under a
  // placeholder would register the lease and worktree against an id that never
  // exists, so `workspaceRootFor` would later miss it and `releaseWorkspace`
  // would leave the lease behind.
  const agentId = await allocateAgentId(asProviderId(provider))

  // Prepared BEFORE launching: a held exclusive lease or a missing directory
  // must be reported as itself, not surface later as a spawn failure that reads
  // like a broken install.
  const workspace = await prepareWorkspace({
    agentId,
    cwd: requestedCwd,
    isolation: flags.worktree ? 'worktree' : 'shared',
    exclusive: flags.exclusive,
  })
  if (!workspace.ok) return workspace.message

  let handle
  try {
    handle = await startAgent({
      agentId,
      provider: asProviderId(provider),
      cwd: workspace.workspace.cwd,
      model: flags.model,
    })
  } catch (error) {
    // Launch failed, so the workspace it reserved must not stay claimed. The
    // worktree is kept (it may hold checked-out state) but the lease is freed.
    await releaseWorkspace(agentId)
    throw error
  }

  const notes = [`Started ${handle.agentId} in ${workspace.workspace.cwd}.`]
  if (workspace.workspace.worktree) {
    notes.push(`Isolated in a worktree off ${workspace.workspace.requestedCwd}.`)
  }
  if (flags.exclusive && !workspace.workspace.exclusive) {
    notes.push(
      'Exclusive access was requested but could not be recorded; other agents are not blocked.',
    )
  }
  notes.push(`Assign work with /agent send ${handle.agentId} <text>.`)
  return notes.join(' ')
}

/**
 * Adopt an instance running outside RAYU.
 *
 * The transport comes from DISCOVERY, not from a guess: a Codex adopt needs the
 * control socket path, an OpenCode adopt needs the port that actually answered
 * `/global/health`. Fabricating a transport here would produce a connect failure
 * that looks like the agent's fault.
 */
/**
 * Survey (or act on) agents left behind by a previous session.
 *
 * With no argument this is READ-ONLY: it reports what is recoverable and why.
 * Naming an agent is the explicit act — recovery never relaunches a third-party
 * process on its own, because that would spawn work the user did not ask for in
 * this session.
 */
async function recoverSubcommand(token: string | undefined): Promise<string> {
  registerAdapters()
  const report = await planRecovery()

  if (!token) return formatRecoveryReport(report)

  const candidate =
    report.candidates.find(entry => entry.agentInstanceId === token) ??
    report.candidates.find(entry => entry.agentInstanceId.startsWith(token))
  if (!candidate) {
    return report.candidates.length === 0
      ? 'No external agents from previous sessions.'
      : `No recoverable record matches "${token}". Known: ${report.candidates
          .map(entry => entry.agentInstanceId)
          .join(', ')}.`
  }

  const outcome = await applyRecovery(candidate)
  return outcome.ok ? outcome.note : outcome.message
}

async function adoptSubcommand(provider: string): Promise<string> {
  const report = await discoverAgents({ cwd: getCwd() })
  const found = report.agents.find(entry => entry.provider === provider)
  if (!found) {
    return `Nothing known about "${provider}". Run /agent discover to see the options.`
  }
  if (found.adoption !== 'adoptable') {
    // The honest refusal. `evidence` already explains why, so pass it through
    // rather than inventing a shorter, vaguer reason.
    return [
      `${found.displayName} is ${found.adoption}, not adoptable, so RAYU cannot take control of it.`,
      ...found.evidence.map(line => `  ${line}`),
      found.actions.includes('restart-under-rayu')
        ? `  Run /agent start ${provider} to have RAYU launch one it can drive.`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  if (!found.transport) {
    return `${found.displayName} looks adoptable but discovery did not establish how to reach it. Run /agent discover for details.`
  }

  const agentId = await allocateAgentId(asProviderId(provider))
  const handle = await adoptAgent({
    agentId,
    transport: found.transport,
    cwd: getCwd(),
    pid: found.pids[0],
  })
  return `Adopted ${handle.agentId}. ${describeAdopted(handle.adoption)}`
}

function describeAssign(
  agentId: AgentInstanceId,
  outcome: Awaited<ReturnType<typeof assign>>,
): string {
  switch (outcome.action) {
    case 'dispatch':
      return `Sent to ${agentId} (turn ${outcome.turnId ?? 'pending'}).`
    case 'steer':
      return `Steered ${agentId}'s running turn ${outcome.turnId ?? ''}`.trim()
    case 'queue':
      return `${agentId} is busy, so this is queued at position ${outcome.queuePosition ?? 1}. ${outcome.reason}`
    case 'resume':
      return `Reconnecting ${agentId} before sending. ${outcome.reason}`
    case 'relaunch':
      return `${agentId} needs relaunching first; the input is held. ${outcome.reason}`
    default:
      return `${agentId}: ${outcome.reason}`
  }
}

function describeAdopted(adoption: string): string {
  return adoption === 'adoptable'
    ? 'RAYU can send it work and broker its approvals.'
    : `RAYU has limited control over an ${adoption} instance — run /agent inspect to see exactly what.`
}
