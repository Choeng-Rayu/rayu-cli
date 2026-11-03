/**
 * Discovery and adoption classification.
 *
 * Answers "what agent CLIs are on this machine, which are running, and what can
 * RAYU actually do with each?" — and the last part is the whole point. The three
 * providers differ fundamentally in how reachable an *externally started*
 * instance is, and a UI that blurred that would promise control RAYU does not
 * have:
 *
 *   - **Codex** exposes a control socket, so a running instance is `adoptable`.
 *   - **OpenCode**'s TUI is a client of its own HTTP server, so a running
 *     instance is `adoptable` — the only one RAYU can also *type into*.
 *   - **Claude Code** exposes no listener at all. A running instance is
 *     `observable`: RAYU can see it and read its transcript, and that is all.
 *
 * ## Capabilities are downgraded by adoption class
 *
 * An adapter's `capabilityCeiling` describes what it can do when *RAYU launches*
 * the agent. That ceiling is not what an externally-running instance offers, so
 * `capabilitiesForAdoption` reduces it. Claude Code's ceiling includes
 * `messages: 'message'`, but an `observable` Claude Code gets `messages: 'none'`
 * — because there is genuinely no channel to send on. This is what makes the
 * `/agent discover` table honest rather than aspirational.
 *
 * ## Evidence, not assertions
 *
 * Every classification carries the `evidence` that produced it, so the user can
 * see *why* RAYU thinks something is running. Where a signal is a heuristic
 * (transcript recency, with no control channel to confirm) the evidence says so.
 */

import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import {
  detectHosts,
  getClaudeCodeConfigDir,
  getCodexHomeDir,
} from '../../plugins/installers/detect.js'
import { whichSync } from '../../utils/which.js'
import {
  CLAUDE_CODE_PROVIDER,
} from '../adapters/claudeCode/ClaudeCodeAdapter.js'
import {
  findClaudeTranscriptsForCwd,
  looksRecentlyActive,
  type ClaudeTranscript,
} from '../adapters/claudeCode/observe.js'
import {
  CODEX_PROVIDER,
  getCodexControlSocketPath,
  hasCodexControlSocket,
} from '../adapters/codex/CodexAdapter.js'
import {
  discoverOpenCodeServer,
  OPENCODE_DEFAULT_PORT,
} from '../adapters/opencode/httpClient.js'
import { OPENCODE_PROVIDER } from '../adapters/opencode/OpenCodeAdapter.js'
import { classifyLiveness, listAgentRecords } from '../persistence/agentStore.js'
import type { AgentTransport } from '../persistence/schemas.js'
import { listAdapters } from './adapterRegistry.js'
import { findProcessesNamed, isProcessScanSupported, scanProcesses } from './processScan.js'
import {
  type AdoptionClass,
  type AgentCapabilities,
  type AgentInstanceId,
  type AgentOperation,
  type AgentCapabilities as Caps,
  noCapabilities,
  OPERATION_REQUIREMENTS,
  type ProviderId,
  supportsOperation,
} from './types.js'

/** What the user can do with a discovered entry. */
export type DiscoveryAction =
  /** Launch a fresh instance under RAYU. */
  | 'start'
  /** Attach RAYU's control channel to a running instance. */
  | 'adopt'
  /** Re-establish a channel to an instance RAYU previously managed. */
  | 'reconnect'
  /** View its terminal, without control. */
  | 'attach'
  /** Read its transcript, without control. */
  | 'observe'
  /** Stop it and start an equivalent instance under RAYU. */
  | 'restart-under-rayu'

export type DiscoveredAgent = {
  readonly provider: ProviderId
  readonly displayName: string
  readonly adoption: AdoptionClass
  /** CLI on PATH or config directory present. */
  readonly installed: boolean
  readonly cliPath?: string
  readonly configDir?: string
  /** Set when this entry corresponds to a RAYU-managed instance. */
  readonly agentInstanceId?: AgentInstanceId
  /** How RAYU would reach it, when reachable. */
  readonly transport?: AgentTransport
  /** Effective capabilities *for this adoption class* — not the adapter ceiling. */
  readonly capabilities: AgentCapabilities
  readonly actions: readonly DiscoveryAction[]
  /** Why RAYU classified it this way, in the user's words. */
  readonly evidence: readonly string[]
  /** Pids observed for this provider, when a scan was possible. */
  readonly pids: readonly number[]
  /** What observation revealed, for `observable` entries. */
  readonly observation?: {
    readonly sessionId?: string
    readonly transcriptPath?: string
    readonly lastActivityAt?: number
  }
}

export type DiscoveryReport = {
  readonly agents: readonly DiscoveredAgent[]
  /** True when the platform allowed a process scan. */
  readonly processScanAvailable: boolean
  /** Limitations worth telling the user about, rather than silently degrading. */
  readonly caveats: readonly string[]
}

/**
 * Reduce an adapter's ceiling to what an instance in this adoption class offers.
 *
 * `managed` and `adoptable` keep the ceiling — in both cases RAYU holds a real
 * control channel. `observable` keeps only terminal observation and drops
 * everything else to `none`, and `unknown` grants nothing at all.
 */
export function capabilitiesForAdoption(
  ceiling: AgentCapabilities,
  adoption: AdoptionClass,
): AgentCapabilities {
  switch (adoption) {
    case 'managed':
    case 'adoptable':
      return ceiling
    case 'observable':
      return {
        ...noCapabilities(),
        // Never *raise* a capability: an adapter that cannot observe a terminal
        // does not gain the ability by being classified observable.
        terminal: ceiling.terminal === 'none' ? 'none' : 'observe',
      }
    case 'unknown':
      return noCapabilities()
  }
}

/** Per-operation truth for a discovered entry, for rendering the table. */
export function discoveredOperations(
  agent: DiscoveredAgent,
): Record<AgentOperation, boolean> {
  const operations = {} as Record<AgentOperation, boolean>
  for (const operation of Object.keys(OPERATION_REQUIREMENTS) as AgentOperation[]) {
    operations[operation] = supportsOperation(agent.capabilities, operation)
  }
  return operations
}

// ---------------------------------------------------------------------------
// Per-provider probes
// ---------------------------------------------------------------------------

type ProbeContext = {
  readonly cwd: string
  readonly processes: Awaited<ReturnType<typeof scanProcesses>>
}

type ProviderProbe = {
  /** Running instances RAYU did not launch. */
  adoption: AdoptionClass
  transport?: AgentTransport
  evidence: string[]
  pids: number[]
  observation?: DiscoveredAgent['observation']
}

/**
 * Codex: a control socket means adoptable.
 *
 * The socket is authoritative — its presence means an app-server is listening,
 * which is exactly what `adopt` connects to. A `codex` process with no socket is
 * running without `--listen`, so it is only observable.
 */
async function probeCodex(context: ProbeContext): Promise<ProviderProbe> {
  const processes = await findProcessesNamed('codex', {
    processes: context.processes,
  })
  const pids = processes.map(p => p.pid)
  const socketPath = getCodexControlSocketPath()

  if (hasCodexControlSocket()) {
    return {
      adoption: 'adoptable',
      transport: { kind: 'unix', endpoint: socketPath },
      evidence: [
        `control socket present at ${socketPath}`,
        ...(pids.length > 0 ? [`${pids.length} codex process(es) running`] : []),
      ],
      pids,
    }
  }

  if (pids.length > 0) {
    return {
      adoption: 'observable',
      evidence: [
        `${pids.length} codex process(es) running`,
        `no control socket at ${socketPath} — started without \`--listen\`, so RAYU cannot attach`,
      ],
      pids,
    }
  }

  return { adoption: 'unknown', evidence: ['no running codex process found'], pids: [] }
}

/**
 * OpenCode: a reachable HTTP server means adoptable.
 *
 * Probes the health endpoint rather than trusting the process list, because the
 * server is what RAYU talks to and a process could be mid-startup. A process with
 * no reachable server is the random-port case, which is observable at best.
 */
async function probeOpenCode(context: ProbeContext): Promise<ProviderProbe> {
  const processes = await findProcessesNamed('opencode', {
    processes: context.processes,
  })
  const pids = processes.map(p => p.pid)

  const found = await discoverOpenCodeServer().catch(() => null)
  if (found) {
    return {
      adoption: 'adoptable',
      transport: { kind: 'http', endpoint: `http://127.0.0.1:${found.port}` },
      evidence: [
        `server responding on 127.0.0.1:${found.port}${found.health.version ? ` (v${found.health.version})` : ''}`,
        ...(pids.length > 0 ? [`${pids.length} opencode process(es) running`] : []),
      ],
      pids,
    }
  }

  if (pids.length > 0) {
    return {
      adoption: 'observable',
      evidence: [
        `${pids.length} opencode process(es) running`,
        `no server on port ${OPENCODE_DEFAULT_PORT} — a TUI started without \`--port\` binds a random port RAYU cannot discover`,
      ],
      pids,
    }
  }

  return {
    adoption: 'unknown',
    evidence: ['no opencode process and no server on the default port'],
    pids: [],
  }
}

/**
 * Claude Code: never adoptable.
 *
 * This is a protocol fact, not a missing feature — Claude Code exposes no socket,
 * port or control file, so the best classification for a running instance is
 * `observable`. The evidence distinguishes a *confirmed* process from a
 * transcript-only heuristic so the user knows how strong the signal is.
 */
async function probeClaudeCode(context: ProbeContext): Promise<ProviderProbe> {
  const processes = await findProcessesNamed('claude', {
    processes: context.processes,
  })
  const pids = processes.map(p => p.pid)

  let transcripts: ClaudeTranscript[] = []
  try {
    transcripts = await findClaudeTranscriptsForCwd(context.cwd)
  } catch (e) {
    logForDebugging(`[discovery] claude transcripts unreadable: ${errorMessage(e)}`)
  }
  // Wrapped in an arrow deliberately: `Array.prototype.find` passes
  // (element, index, array), so `find(looksRecentlyActive)` would bind its
  // optional `withinMs` to the index — zero for the first element, making the
  // recency window 0ms and every transcript look stale.
  const recent = transcripts.find(transcript => looksRecentlyActive(transcript))

  const evidence: string[] = []
  if (pids.length > 0) evidence.push(`${pids.length} claude process(es) running`)
  if (recent) {
    evidence.push(
      `transcript updated recently: ${recent.path} (heuristic — Claude Code has no control channel to confirm)`,
    )
  }
  evidence.push(
    'Claude Code exposes no socket or port, so RAYU can observe and attach but never send input to an instance it did not launch',
  )

  const running = pids.length > 0 || recent !== undefined
  return {
    adoption: running ? 'observable' : 'unknown',
    evidence,
    pids,
    observation: recent
      ? {
          sessionId: recent.sessionId,
          transcriptPath: recent.path,
          lastActivityAt: recent.modifiedAt,
        }
      : undefined,
  }
}

const PROBES: Record<string, (context: ProbeContext) => Promise<ProviderProbe>> = {
  [CODEX_PROVIDER]: probeCodex,
  [OPENCODE_PROVIDER]: probeOpenCode,
  [CLAUDE_CODE_PROVIDER]: probeClaudeCode,
}

/**
 * Fallback for a provider with no dedicated probe — notably an ACP binary
 * registered by config (Task 17).
 *
 * Reports `unknown` rather than guessing: without provider-specific knowledge
 * there is no way to tell a live control channel from a stray process, and
 * claiming `adoptable` would produce a failing adopt attempt.
 */
async function probeGeneric(): Promise<ProviderProbe> {
  return {
    adoption: 'unknown',
    evidence: [
      'no provider-specific probe — RAYU cannot tell whether a running instance is reachable',
    ],
    pids: [],
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function actionsFor(params: {
  adoption: AdoptionClass
  installed: boolean
  capabilities: Caps
  hasAdopt: boolean
  hasReconnect: boolean
  isManagedRecord: boolean
}): DiscoveryAction[] {
  const actions: DiscoveryAction[] = []

  if (params.isManagedRecord) {
    if (params.hasReconnect) actions.push('reconnect')
    if (params.installed) actions.push('start')
    return actions
  }

  if (params.adoption === 'adoptable' && params.hasAdopt) {
    actions.push('adopt')
  }

  if (params.adoption === 'observable') {
    if (supportsOperation(params.capabilities, 'observeTerminal')) {
      actions.push('attach', 'observe')
    }
    // The honest escape hatch: RAYU cannot control this instance, but it can
    // offer to replace it with one it launched.
    if (params.installed) actions.push('restart-under-rayu')
  }

  if (params.installed && !actions.includes('start')) actions.push('start')
  return actions
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Classify every registered provider plus every persisted RAYU-managed instance.
 *
 * Probes run concurrently: each one touches the filesystem or the network, and
 * serialising three of them is a visible delay on an interactive command.
 */
export async function discoverAgents(
  options: { cwd?: string } = {},
): Promise<DiscoveryReport> {
  const cwd = options.cwd ?? process.cwd()
  const processScanAvailable = isProcessScanSupported()
  const processes = await scanProcesses()
  const context: ProbeContext = { cwd, processes }

  const hosts = detectHosts()
  const adapters = listAdapters()

  const external = await Promise.all(
    adapters.map(async adapter => {
      const probe = await (PROBES[adapter.provider] ?? probeGeneric)(context)
      const cliPath = whichSync(adapter.provider) ?? undefined
      const host = hosts.find(candidate => candidate.id === adapter.provider)
      const configDir = host?.configDir ?? knownConfigDir(adapter.provider)
      const installed = Boolean(cliPath) || Boolean(configDir)
      const capabilities = capabilitiesForAdoption(
        adapter.capabilityCeiling,
        probe.adoption,
      )
      return {
        provider: adapter.provider,
        displayName: adapter.displayName,
        adoption: probe.adoption,
        installed,
        cliPath: cliPath ?? host?.cliPath,
        configDir,
        transport: probe.transport,
        capabilities,
        actions: actionsFor({
          adoption: probe.adoption,
          installed,
          capabilities,
          hasAdopt: typeof adapter.adopt === 'function',
          hasReconnect: typeof adapter.reconnect === 'function',
          isManagedRecord: false,
        }),
        evidence: probe.evidence,
        pids: probe.pids,
        observation: probe.observation,
      } satisfies DiscoveredAgent
    }),
  )

  const managed = await discoverManagedAgents()

  const caveats: string[] = []
  if (!processScanAvailable) {
    caveats.push(
      'Process scanning is unavailable on this platform, so running instances are detected from config and transcripts only. Some may be missed.',
    )
  }
  if (external.some(agent => agent.adoption === 'observable')) {
    caveats.push(
      'Observable instances can be watched but not driven. To control one, restart it under RAYU.',
    )
  }

  return { agents: [...managed, ...external], processScanAvailable, caveats }
}

/** Config directory for a provider RAYU knows, when `detectHosts` has no entry. */
function knownConfigDir(provider: ProviderId): string | undefined {
  if (provider === CODEX_PROVIDER) return getCodexHomeDir()
  if (provider === CLAUDE_CODE_PROVIDER) return getClaudeCodeConfigDir()
  return undefined
}

/**
 * Instances RAYU has persisted state for.
 *
 * Liveness comes from `classifyLiveness`, which returns `unknown` rather than
 * guessing for adopted agents with no local pid — so a record whose liveness is
 * unclear is reported as `unknown` here too, not optimistically as running.
 */
async function discoverManagedAgents(): Promise<DiscoveredAgent[]> {
  const { records, corrupt } = await listAgentRecords()
  const adapters = new Map(listAdapters().map(a => [a.provider, a]))

  const managed = records.map(record => {
    const adapter = adapters.get(record.provider as ProviderId)
    const liveness = classifyLiveness(record)
    const adoption: AdoptionClass =
      liveness === 'live' ? 'managed' : liveness === 'dead' ? 'unknown' : 'unknown'
    const ceiling = adapter?.capabilityCeiling ?? record.capabilities
    const capabilities =
      liveness === 'live' ? ceiling : capabilitiesForAdoption(ceiling, 'unknown')

    const evidence = [
      `RAYU record from ${new Date(record.createdAt).toISOString()}`,
      `last known state: ${record.agentState} (${record.durability})`,
      liveness === 'live'
        ? 'process probe says it is alive'
        : liveness === 'dead'
          ? 'process probe says it is gone'
          : 'liveness could not be determined from a pid alone',
    ]
    if (record.forensics) {
      evidence.push(`stopped because: ${record.forensics.reason}`)
    }

    return {
      provider: record.provider as ProviderId,
      displayName: adapter?.displayName ?? record.provider,
      adoption,
      installed: true,
      configDir: knownConfigDir(record.provider as ProviderId),
      agentInstanceId: record.agentInstanceId as AgentInstanceId,
      transport: record.transport,
      capabilities,
      actions: actionsFor({
        adoption,
        installed: true,
        capabilities,
        hasAdopt: typeof adapter?.adopt === 'function',
        hasReconnect: typeof adapter?.reconnect === 'function',
        isManagedRecord: true,
      }),
      evidence,
      pids: record.pid !== undefined ? [record.pid] : [],
    } satisfies DiscoveredAgent
  })

  if (corrupt.length > 0) {
    logForDebugging(
      `[discovery] ${corrupt.length} unreadable agent record(s): ${corrupt.join(', ')}`,
    )
  }
  return managed
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const TABLE_OPERATIONS: readonly AgentOperation[] = [
  'attachTerminal',
  'sendMessage',
  'steer',
  'interrupt',
  'brokerPermissions',
]

const OPERATION_LABELS: Record<string, string> = {
  attachTerminal: 'Attach',
  sendMessage: 'Send',
  steer: 'Steer',
  interrupt: 'Interrupt',
  brokerPermissions: 'Permissions',
}

/**
 * Render the report as plain text.
 *
 * Kept out of the UI layer so `/agent discover` and any non-interactive caller
 * show identical information, and so the honesty of the table is a property of
 * this module rather than of a component.
 */
export function formatDiscoveryReport(report: DiscoveryReport): string {
  if (report.agents.length === 0) {
    return 'No agent CLIs found. Install Codex, Claude Code, or OpenCode to get started.'
  }

  const lines: string[] = []
  for (const agent of report.agents) {
    const operations = discoveredOperations(agent)
    const marks = TABLE_OPERATIONS.map(
      operation =>
        `${OPERATION_LABELS[operation]} ${operations[operation] ? '\u2713' : '\u2717'}`,
    ).join('  ')

    const title = agent.agentInstanceId ?? agent.displayName
    lines.push(`${title}  [${agent.adoption.toUpperCase()}]`)
    if (agent.transport?.endpoint) {
      lines.push(`  via ${agent.transport.kind} ${agent.transport.endpoint}`)
    }
    lines.push(`  ${marks}`)
    for (const item of agent.evidence) lines.push(`  - ${item}`)
    if (agent.observation?.transcriptPath) {
      lines.push(`  - session ${agent.observation.sessionId ?? '(unknown)'}`)
    }
    lines.push(
      `  actions: ${agent.actions.length > 0 ? agent.actions.join(', ') : '(none)'}`,
    )
    lines.push('')
  }

  for (const caveat of report.caveats) lines.push(`Note: ${caveat}`)
  return lines.join('\n').trimEnd()
}
