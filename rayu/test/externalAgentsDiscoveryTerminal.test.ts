/**
 * Discovery classification, tmux session naming, and the feature gate.
 *
 * The rule that matters most here is honesty about what RAYU can actually do:
 * `capabilitiesForAdoption` may only ever LOWER an adapter's ceiling, and an
 * `observable` instance must never advertise send or steer. Claiming otherwise
 * would put a control the user cannot use in front of them, and turn a clear
 * refusal into a failing protocol call.
 *
 * tmux itself is not installed in this environment, so the tests here cover
 * naming and command CONSTRUCTION, which is where the subtle bugs live (tmux
 * parses `:` and `.` as target syntax). A real attach against a live TTY is
 * verified manually and is called out as such in the report.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  capabilitiesForAdoption,
  discoverAgents,
  discoveredOperations,
  formatDiscoveryReport,
  type DiscoveredAgent,
  type DiscoveryReport,
} from '../src/externalAgents/core/discovery.ts'
import {
  buildAttachArgs,
  buildAttachCommand,
  getAgentTmuxSocket,
  toTmuxSessionName,
} from '../src/externalAgents/terminal/tmuxSession.ts'
import { describeAttachFallback } from '../src/externalAgents/terminal/attach.ts'
import {
  getExternalAgentsDisabledReason,
  isExternalAgentsEnabled,
} from '../src/externalAgents/featureGate.ts'
import {
  registerAdapter,
  resetAdapterRegistry,
} from '../src/externalAgents/core/adapterRegistry.ts'
import {
  createObserveOnlyStubAdapter,
  createStubAdapter,
} from '../src/externalAgents/adapters/stub/StubAdapter.ts'
import { resetAgentManager } from '../src/externalAgents/core/AgentManager.ts'
import { resetEventBus } from '../src/externalAgents/core/eventBus.ts'
import {
  asProviderId,
  noCapabilities,
  type AgentCapabilities,
  type AgentInstanceId,
} from '../src/externalAgents/core/types.ts'

const FULL: AgentCapabilities = {
  terminal: 'full',
  messages: 'full',
  sessions: 'full',
  process: 'full',
  permissions: 'full',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-discover-'))
  process.env.RAYU_CONFIG_DIR = dir
  resetAdapterRegistry()
  resetAgentManager()
  resetEventBus()
})
afterEach(() => {
  resetAdapterRegistry()
  resetAgentManager()
  resetEventBus()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

// ---------------------------------------------------------------------------
// Adoption capability derivation
// ---------------------------------------------------------------------------

describe('capabilities for an adoption class', () => {
  test('managed and adoptable keep the full ceiling', () => {
    // In both cases RAYU holds a real control channel.
    expect(capabilitiesForAdoption(FULL, 'managed')).toEqual(FULL)
    expect(capabilitiesForAdoption(FULL, 'adoptable')).toEqual(FULL)
  })

  test('observable keeps ONLY terminal observation', () => {
    // RAYU cannot inject input into a foreign full-screen TUI it did not launch.
    const caps = capabilitiesForAdoption(FULL, 'observable')
    expect(caps.terminal).toBe('observe')
    expect(caps.messages).toBe('none')
    expect(caps.sessions).toBe('none')
    expect(caps.process).toBe('none')
    expect(caps.permissions).toBe('none')
  })

  test('observable caps terminal at observe rather than keeping full', () => {
    // Being watchable does not make it drivable.
    expect(capabilitiesForAdoption(FULL, 'observable').terminal).toBe('observe')
  })

  test('observable NEVER raises a capability', () => {
    // An adapter that cannot observe a terminal does not gain the ability by
    // being classified observable.
    const noTerminal = { ...FULL, terminal: 'none' as const }
    expect(capabilitiesForAdoption(noTerminal, 'observable').terminal).toBe('none')
  })

  test('unknown grants nothing at all', () => {
    expect(capabilitiesForAdoption(FULL, 'unknown')).toEqual(noCapabilities())
  })

  test('derivation is monotonically non-increasing for every axis', () => {
    const rank = { none: 0, observe: 1, message: 2, full: 3 }
    for (const adoption of ['managed', 'adoptable', 'observable', 'unknown'] as const) {
      const derived = capabilitiesForAdoption(FULL, adoption)
      for (const axis of Object.keys(FULL) as (keyof AgentCapabilities)[]) {
        expect(rank[derived[axis]]).toBeLessThanOrEqual(rank[FULL[axis]])
      }
    }
  })
})

describe('discovered operation matrix', () => {
  function entry(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
    return {
      provider: asProviderId('codex'),
      displayName: 'Codex',
      adoption: 'managed',
      installed: true,
      capabilities: FULL,
      actions: [],
      evidence: [],
      pids: [],
      ...overrides,
    }
  }

  test('a managed entry can do everything its ceiling allows', () => {
    const operations = discoveredOperations(entry())
    expect(operations.sendMessage).toBe(true)
    expect(operations.steer).toBe(true)
    expect(operations.attachTerminal).toBe(true)
  })

  test('an observable entry reports messages: none, so no send and no steer', () => {
    const operations = discoveredOperations(
      entry({
        adoption: 'observable',
        capabilities: capabilitiesForAdoption(FULL, 'observable'),
      }),
    )
    expect(operations.attachTerminal).toBe(true)
    expect(operations.observeTerminal).toBe(true)
    expect(operations.sendMessage).toBe(false)
    expect(operations.steer).toBe(false)
    expect(operations.interrupt).toBe(false)
    expect(operations.brokerPermissions).toBe(false)
  })

  test('an unknown entry reports every operation false', () => {
    const operations = discoveredOperations(
      entry({ adoption: 'unknown', capabilities: noCapabilities() }),
    )
    expect(Object.values(operations).every(v => v === false)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Discovery run
// ---------------------------------------------------------------------------

describe('discovery run', () => {
  test('classifies a provider with no dedicated probe as unknown', async () => {
    // Without provider-specific knowledge there is no way to tell a live control
    // channel from a stray process, and claiming `adoptable` would produce a
    // failing adopt attempt.
    registerAdapter(createStubAdapter({ provider: asProviderId('mystery-acp') }))
    const report = await discoverAgents({ cwd: dir })
    const entry = report.agents.find(a => a.provider === 'mystery-acp')!
    expect(entry.adoption).toBe('unknown')
    expect(entry.evidence.join(' ')).toContain('no provider-specific probe')
  })

  test('an unknown entry offers no adopt action', async () => {
    registerAdapter(createStubAdapter({ provider: asProviderId('mystery-acp') }))
    const report = await discoverAgents({ cwd: dir })
    const entry = report.agents.find(a => a.provider === 'mystery-acp')!
    expect(entry.actions).not.toContain('adopt')
  })

  test('EVERY observable or unknown entry reports messages: none', async () => {
    // The structural honesty guarantee: nothing that RAYU cannot drive may claim
    // it can be sent to.
    registerAdapter(createStubAdapter({ provider: asProviderId('a') }))
    registerAdapter(createObserveOnlyStubAdapter(asProviderId('b')))
    const report = await discoverAgents({ cwd: dir })
    for (const agent of report.agents) {
      if (agent.adoption === 'observable' || agent.adoption === 'unknown') {
        expect(agent.capabilities.messages).toBe('none')
      }
    }
  })

  test('reports whether a process scan was possible', async () => {
    const report = await discoverAgents({ cwd: dir })
    expect(typeof report.processScanAvailable).toBe('boolean')
    if (!report.processScanAvailable) {
      // A limitation is stated rather than silently degrading the result.
      expect(report.caveats.join(' ')).toContain('Process scanning is unavailable')
    }
  })

  test('an empty registry yields no entries', async () => {
    const report = await discoverAgents({ cwd: dir })
    expect(report.agents).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

describe('discovery report rendering', () => {
  function report(agents: DiscoveredAgent[], caveats: string[] = []): DiscoveryReport {
    return { agents, processScanAvailable: true, caveats }
  }

  test('an empty report tells the user what to install', () => {
    expect(formatDiscoveryReport(report([]))).toContain('Install Codex')
  })

  test('renders adoption, transport, evidence and actions', () => {
    const text = formatDiscoveryReport(
      report([
        {
          provider: asProviderId('opencode'),
          displayName: 'OpenCode',
          adoption: 'adoptable',
          installed: true,
          transport: { kind: 'http', endpoint: 'http://127.0.0.1:4096' },
          capabilities: FULL,
          actions: ['adopt', 'start'],
          evidence: ['server responding on 127.0.0.1:4096'],
          pids: [1234],
        },
      ]),
    )
    expect(text).toContain('OpenCode  [ADOPTABLE]')
    expect(text).toContain('via http http://127.0.0.1:4096')
    expect(text).toContain('server responding')
    expect(text).toContain('actions: adopt, start')
  })

  test('the capability marks are ticks and crosses, not prose', () => {
    const text = formatDiscoveryReport(
      report([
        {
          provider: asProviderId('claude-code'),
          displayName: 'Claude Code',
          adoption: 'observable',
          installed: true,
          capabilities: capabilitiesForAdoption(FULL, 'observable'),
          actions: ['attach', 'observe', 'restart-under-rayu'],
          evidence: ['a claude process is running'],
          pids: [99],
        },
      ]),
    )
    // Attach is available; send and steer are visibly not.
    expect(text).toContain('Attach \u2713')
    expect(text).toContain('Send \u2717')
    expect(text).toContain('Steer \u2717')
  })

  test('a managed record is titled by its instance id', () => {
    const text = formatDiscoveryReport(
      report([
        {
          provider: asProviderId('codex'),
          displayName: 'Codex',
          adoption: 'managed',
          installed: true,
          agentInstanceId: 'codex:agent_01' as AgentInstanceId,
          capabilities: FULL,
          actions: ['reconnect'],
          evidence: ['RAYU record'],
          pids: [],
        },
      ]),
    )
    expect(text).toContain('codex:agent_01  [MANAGED]')
  })

  test('an entry with no actions says so explicitly', () => {
    const text = formatDiscoveryReport(
      report([
        {
          provider: asProviderId('x'),
          displayName: 'X',
          adoption: 'unknown',
          installed: false,
          capabilities: noCapabilities(),
          actions: [],
          evidence: ['nothing found'],
          pids: [],
        },
      ]),
    )
    expect(text).toContain('actions: (none)')
  })

  test('caveats are appended as notes', () => {
    const text = formatDiscoveryReport(
      report(
        [
          {
            provider: asProviderId('x'),
            displayName: 'X',
            adoption: 'unknown',
            installed: false,
            capabilities: noCapabilities(),
            actions: [],
            evidence: [],
            pids: [],
          },
        ],
        ['Observable instances can be watched but not driven.'],
      ),
    )
    expect(text).toContain('Note: Observable instances can be watched')
  })

  test('an observed transcript session is surfaced', () => {
    const text = formatDiscoveryReport(
      report([
        {
          provider: asProviderId('claude-code'),
          displayName: 'Claude Code',
          adoption: 'observable',
          installed: true,
          capabilities: capabilitiesForAdoption(FULL, 'observable'),
          actions: ['observe'],
          evidence: [],
          pids: [],
          observation: {
            sessionId: 'abc-123',
            transcriptPath: '/home/u/.claude/projects/x/abc-123.jsonl',
            lastActivityAt: Date.now(),
          },
        },
      ]),
    )
    expect(text).toContain('session abc-123')
  })
})

// ---------------------------------------------------------------------------
// tmux naming and command construction
// ---------------------------------------------------------------------------

describe('tmux session naming', () => {
  test('sanitizes the colon tmux would read as target syntax', () => {
    // `tmux attach -t codex:agent_01` would be parsed as window `agent_01` of
    // session `codex`.
    const name = toTmuxSessionName('codex:agent_01' as AgentInstanceId)
    expect(name).not.toContain(':')
    expect(name).toContain('codex-agent_01')
  })

  test('sanitizes dots too', () => {
    expect(toTmuxSessionName('codex:agent.01' as AgentInstanceId)).not.toContain('.')
  })

  test('two ids that sanitize identically still get distinct names', () => {
    // Without the hash suffix these would silently share one session.
    const a = toTmuxSessionName('codex:agent.01' as AgentInstanceId)
    const b = toTmuxSessionName('codex-agent-01' as AgentInstanceId)
    expect(a).not.toBe(b)
  })

  test('the suffix is a stable 6-hex-char digest', () => {
    const id = 'codex:agent_01' as AgentInstanceId
    expect(toTmuxSessionName(id)).toMatch(/-[0-9a-f]{6}$/)
    expect(toTmuxSessionName(id)).toBe(toTmuxSessionName(id))
  })

  test('the name contains only characters tmux treats as literal', () => {
    for (const id of [
      'codex:agent_01',
      'claude-code:agent_99',
      'acp:my.custom agent',
      'x:a$b`c;d',
    ] as AgentInstanceId[]) {
      expect(toTmuxSessionName(id)).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  test('the socket is private to this RAYU instance', () => {
    // The user's own tmux sessions stay untouched, and two RAYU instances cannot
    // fight over session names.
    const socket = getAgentTmuxSocket()
    expect(socket).toStartWith('rayu-agent-')
    expect(socket.length).toBeLessThanOrEqual('rayu-agent-'.length + 8)
  })
})

describe('tmux attach command construction', () => {
  const AGENT = 'codex:agent_01' as AgentInstanceId

  test('argv targets RAYU’s private socket, never the default one', () => {
    const args = buildAttachArgs(AGENT)
    expect(args[0]).toBe('-L')
    expect(args[1]).toBe(getAgentTmuxSocket())
    expect(args).toContain('attach-session')
    expect(args).toContain(toTmuxSessionName(AGENT))
  })

  test('the shell form matches the argv form', () => {
    const command = buildAttachCommand(AGENT)
    expect(command).toContain(`-L ${getAgentTmuxSocket()}`)
    expect(command).toContain(`attach-session -t ${toTmuxSessionName(AGENT)}`)
  })

  test('the shell form carries no shell metacharacters from the agent id', () => {
    // The session name is sanitized upstream, so nothing injectable reaches the
    // command string.
    const command = buildAttachCommand('x:a;rm -rf /' as AgentInstanceId)
    expect(command).not.toContain(';rm')
  })

  test('the fallback message tells the user how to attach by hand', () => {
    // With no tmux there is nothing to attach to, so the guidance has to be
    // actionable rather than an apology.
    const fallback = describeAttachFallback()
    expect(fallback.toLowerCase()).toContain('tmux')
    expect(fallback.length).toBeGreaterThan(20)
  })
})

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

describe('feature gate', () => {
  test('reports unavailable under bun test, because feature() is build-time only', () => {
    // `feature('EXTERNAL_AGENTS')` is statically evaluated by the bundler, so it
    // is always false here. Tests therefore import subsystem modules DIRECTLY;
    // the enabled-in-bundle behaviour is verified against the built artifact, not
    // from here.
    expect(isExternalAgentsEnabled()).toBe(false)
    expect(getExternalAgentsDisabledReason()).toContain('not available in this build')
  })

  test('the disabled reason is a sentence a user can act on', () => {
    const reason = getExternalAgentsDisabledReason()!
    expect(reason.endsWith('.')).toBe(true)
    expect(reason).toContain('External agent orchestration')
  })
})
