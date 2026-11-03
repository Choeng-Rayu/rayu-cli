/**
 * Agent lifecycle transitions, capability ladder and admission control.
 *
 * Everything here is pure and synchronous, so the decision table can be swept
 * exhaustively rather than spot-checked. The sweep at the bottom is the point of
 * this file: admission control must return a decision for EVERY combination of
 * the four state axes and never throw, because callers have exactly one code
 * path and no way to recover from an exception thrown mid-dispatch.
 */
import { describe, expect, test } from 'bun:test'
import {
  AGENT_STATE_TRANSITIONS,
  canTransitionAgentState,
  describeIllegalTransition,
  reconcileSnapshot,
  resolveAdmission,
  type AdmissionAction,
} from '../src/externalAgents/core/stateMachine.ts'
import {
  atLeastControlLevel,
  compareControlLevel,
  CAPABILITY_AXES,
  formatAgentInstanceId,
  isDispatchableAgentState,
  isSteerableTurnKind,
  isTerminalAgentState,
  isTerminalEventType,
  noCapabilities,
  OPERATION_REQUIREMENTS,
  parseAgentInstanceId,
  supportsOperation,
  toRayuTaskStatus,
  asProviderId,
  type AgentCapabilities,
  type AgentState,
  type AgentStatusSnapshot,
  type ConnectionState,
  type ControlLevel,
  type ExternalTaskState,
  type ProcessState,
} from '../src/externalAgents/core/types.ts'

const ALL_AGENT_STATES: AgentState[] = [
  'starting',
  'connecting',
  'ready',
  'working',
  'idle',
  'waiting',
  'interrupted',
  'failed',
  'dead',
  'stopped',
]
const ALL_PROCESS_STATES: ProcessState[] = [
  'spawning',
  'running',
  'exited',
  'killed',
  'absent',
]
const ALL_CONNECTION_STATES: ConnectionState[] = [
  'disconnected',
  'connecting',
  'connected',
  'degraded',
  'lost',
]
const ALL_LEVELS: ControlLevel[] = ['none', 'observe', 'message', 'full']

function caps(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return { ...noCapabilities(), ...overrides }
}

/** Everything RAYU could possibly do — the ceiling of a managed agent. */
const FULL_CAPS = caps({
  terminal: 'full',
  messages: 'full',
  sessions: 'full',
  process: 'full',
  permissions: 'full',
})

function snapshot(
  overrides: Partial<AgentStatusSnapshot> = {},
): AgentStatusSnapshot {
  return {
    processState: 'running',
    connectionState: 'connected',
    agentState: 'idle',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Instance ids
// ---------------------------------------------------------------------------

describe('agent instance ids', () => {
  test('round-trips provider and slot', () => {
    const id = formatAgentInstanceId(asProviderId('codex'), 'agent_01')
    expect(String(id)).toBe('codex:agent_01')
    const parsed = parseAgentInstanceId(id)
    expect(String(parsed?.provider)).toBe('codex')
    expect(parsed?.slot).toBe('agent_01')
  })

  test('refuses a provider id containing the separator', () => {
    // An id like `a:b:slot` cannot be parsed back unambiguously, so it must
    // never be produced in the first place.
    expect(() => formatAgentInstanceId(asProviderId('a:b'), 'x')).toThrow(
      /may not contain ':'/,
    )
  })

  test('keeps a slot that itself contains colons', () => {
    // Only the FIRST colon separates, so slots may contain colons (a worktree
    // path or an adopted url fragment can).
    const parsed = parseAgentInstanceId('acp:custom:1:2')
    expect(String(parsed?.provider)).toBe('acp')
    expect(parsed?.slot).toBe('custom:1:2')
  })

  test.each([
    ['no separator', 'codex'],
    ['empty provider', ':slot'],
    ['empty slot', 'codex:'],
    ['empty string', ''],
  ])('rejects %s', (_label, input) => {
    expect(parseAgentInstanceId(input)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Capability ladder
// ---------------------------------------------------------------------------

describe('control level ladder', () => {
  test('is totally ordered none < observe < message < full', () => {
    const sorted = [...ALL_LEVELS].reverse().sort(compareControlLevel)
    expect(sorted).toEqual(['none', 'observe', 'message', 'full'])
  })

  test('atLeastControlLevel is reflexive and monotonic', () => {
    for (let i = 0; i < ALL_LEVELS.length; i++) {
      for (let j = 0; j < ALL_LEVELS.length; j++) {
        expect(atLeastControlLevel(ALL_LEVELS[i]!, ALL_LEVELS[j]!)).toBe(i >= j)
      }
    }
  })

  test('noCapabilities covers every declared axis at none', () => {
    const zero = noCapabilities()
    for (const axis of CAPABILITY_AXES) {
      expect(zero[axis]).toBe('none')
    }
    expect(Object.keys(zero).sort()).toEqual([...CAPABILITY_AXES].sort())
  })

  test('every operation requirement names a real axis', () => {
    for (const [op, req] of Object.entries(OPERATION_REQUIREMENTS)) {
      expect(CAPABILITY_AXES).toContain(req.axis)
      expect(ALL_LEVELS).toContain(req.level)
      // A requirement of `none` would make the gate meaningless.
      expect(req.level).not.toBe('none')
      expect(supportsOperation(noCapabilities(), op as never)).toBe(false)
    }
  })

  test('steer needs strictly more than sendMessage', () => {
    // This asymmetry is the whole reason messages has four levels rather than a
    // boolean: an agent can accept prompts yet reject same-turn injection.
    const messageOnly = caps({ messages: 'message' })
    expect(supportsOperation(messageOnly, 'sendMessage')).toBe(true)
    expect(supportsOperation(messageOnly, 'steer')).toBe(false)
    expect(supportsOperation(caps({ messages: 'full' }), 'steer')).toBe(true)
  })

  test('kill needs strictly more than interrupt', () => {
    const signalOnly = caps({ process: 'message' })
    expect(supportsOperation(signalOnly, 'interrupt')).toBe(true)
    expect(supportsOperation(signalOnly, 'kill')).toBe(false)
    expect(supportsOperation(caps({ process: 'full' }), 'kill')).toBe(true)
  })

  test('observe-level sessions can list but not resume', () => {
    const observeSessions = caps({ sessions: 'observe' })
    expect(supportsOperation(observeSessions, 'listSessions')).toBe(true)
    expect(supportsOperation(observeSessions, 'resumeSession')).toBe(false)
    expect(supportsOperation(observeSessions, 'forkSession')).toBe(false)
  })

  test('attaching a terminal does not imply driving it', () => {
    const observeTerminal = caps({ terminal: 'observe' })
    expect(supportsOperation(observeTerminal, 'attachTerminal')).toBe(true)
    expect(supportsOperation(observeTerminal, 'observeTerminal')).toBe(true)
    expect(supportsOperation(observeTerminal, 'driveTerminal')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// State predicates
// ---------------------------------------------------------------------------

describe('state predicates', () => {
  test('terminal states are exactly failed, dead, stopped', () => {
    const terminal = ALL_AGENT_STATES.filter(isTerminalAgentState)
    expect(terminal.sort()).toEqual(['dead', 'failed', 'stopped'])
  })

  test('dispatchable states are exactly ready and idle', () => {
    const dispatchable = ALL_AGENT_STATES.filter(isDispatchableAgentState)
    expect(dispatchable.sort()).toEqual(['idle', 'ready'])
  })

  test('no state is both terminal and dispatchable', () => {
    for (const state of ALL_AGENT_STATES) {
      expect(isTerminalAgentState(state) && isDispatchableAgentState(state)).toBe(
        false,
      )
    }
  })

  test('only regular turns are steerable', () => {
    expect(isSteerableTurnKind('regular')).toBe(true)
    for (const kind of ['review', 'compaction', 'shell', 'unknown'] as const) {
      expect(isSteerableTurnKind(kind)).toBe(false)
    }
  })

  test('waiting-provider projects to running, not to a finished status', () => {
    // Mapping it to anything terminal would let the task framework evict work
    // that is merely blocked upstream.
    expect(toRayuTaskStatus('waiting-provider')).toBe('running')
  })

  test.each<[ExternalTaskState, string]>([
    ['queued', 'pending'],
    ['dispatched', 'running'],
    ['running', 'running'],
    ['waiting-provider', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'killed'],
  ])('%s projects onto RAYU status %s', (state, expected) => {
    expect(String(toRayuTaskStatus(state))).toBe(expected)
  })

  test('terminal event types end a task', () => {
    expect(isTerminalEventType('task_completed')).toBe(true)
    expect(isTerminalEventType('task_failed')).toBe(true)
    expect(isTerminalEventType('agent_message')).toBe(false)
    expect(isTerminalEventType('tool_output')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

describe('agent state transitions', () => {
  test('every state has a transition entry', () => {
    expect(Object.keys(AGENT_STATE_TRANSITIONS).sort()).toEqual(
      [...ALL_AGENT_STATES].sort(),
    )
  })

  test('self-transitions are always allowed as no-ops', () => {
    for (const state of ALL_AGENT_STATES) {
      expect(canTransitionAgentState(state, state)).toBe(true)
    }
  })

  test('no transition table entry lists an unknown state', () => {
    for (const targets of Object.values(AGENT_STATE_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_AGENT_STATES).toContain(target)
      }
    }
  })

  test('failed, dead and stopped all lead back to starting', () => {
    // Relaunch is recovery of the SAME logical agent, not a new one, so the
    // terminal states must not be dead ends.
    for (const state of ['failed', 'dead', 'stopped'] as const) {
      expect(canTransitionAgentState(state, 'starting')).toBe(true)
    }
  })

  test('dead cannot jump straight to working', () => {
    expect(canTransitionAgentState('dead', 'working')).toBe(false)
    expect(describeIllegalTransition('dead', 'working')).toContain(
      'dead -> working',
    )
    expect(describeIllegalTransition('dead', 'working')).toContain('starting')
  })

  test('every non-terminal state can reach dead and stopped', () => {
    // A process can die or be killed at any moment; a table that forbade it
    // would make honest bookkeeping impossible.
    for (const state of ALL_AGENT_STATES) {
      if (state === 'dead' || state === 'stopped') continue
      expect(canTransitionAgentState(state, 'dead')).toBe(true)
      expect(canTransitionAgentState(state, 'stopped')).toBe(true)
    }
  })

  test('only working and waiting can become interrupted', () => {
    const canInterrupt = ALL_AGENT_STATES.filter(
      s => s !== 'interrupted' && canTransitionAgentState(s, 'interrupted'),
    )
    expect(canInterrupt.sort()).toEqual(['waiting', 'working'])
  })
})

// ---------------------------------------------------------------------------
// reconcileSnapshot
// ---------------------------------------------------------------------------

describe('reconcileSnapshot', () => {
  test('an exited process makes a working agent dead', () => {
    const out = reconcileSnapshot(
      snapshot({
        processState: 'exited',
        agentState: 'working',
        activeTurn: { id: 't1', kind: 'regular' },
      }),
    )
    expect(out.agentState).toBe('dead')
    expect(out.connectionState).toBe('lost')
    expect(out.activeTurn).toBeUndefined()
  })

  test('a killed process makes it stopped, not dead', () => {
    // `killed` means someone asked for it; `dead` means it died on its own. The
    // distinction is what recovery uses to decide whether to offer a relaunch.
    const out = reconcileSnapshot(
      snapshot({ processState: 'killed', agentState: 'working' }),
    )
    expect(out.agentState).toBe('stopped')
  })

  test('does NOT reconcile a lost connection on a live process', () => {
    // The central invariant: alive-but-unreachable is reconnect-and-resume.
    // Rewriting it to dead here would make the orchestrator relaunch and
    // abandon a live session.
    const input = snapshot({
      processState: 'running',
      connectionState: 'lost',
      agentState: 'working',
    })
    expect(reconcileSnapshot(input)).toBe(input)
  })

  test('absent process is not a contradiction', () => {
    // Adopted HTTP agents legitimately have no local pid.
    const input = snapshot({ processState: 'absent', agentState: 'working' })
    expect(reconcileSnapshot(input)).toBe(input)
  })

  test('preserves a recorded failure instead of flattening it to dead', () => {
    const out = reconcileSnapshot(
      snapshot({ processState: 'exited', agentState: 'failed' }),
    )
    expect(out.agentState).toBe('failed')
  })

  test('clears a stale active turn even on an already-terminal state', () => {
    const out = reconcileSnapshot(
      snapshot({
        processState: 'exited',
        agentState: 'failed',
        activeTurn: { id: 't9', kind: 'regular' },
      }),
    )
    expect(out.agentState).toBe('failed')
    expect(out.activeTurn).toBeUndefined()
  })

  test('is idempotent', () => {
    for (const processState of ALL_PROCESS_STATES) {
      for (const agentState of ALL_AGENT_STATES) {
        const once = reconcileSnapshot(snapshot({ processState, agentState }))
        expect(reconcileSnapshot(once)).toEqual(once)
      }
    }
  })

  test('returns the same object when nothing needs resolving', () => {
    const input = snapshot()
    expect(reconcileSnapshot(input)).toBe(input)
  })
})

// ---------------------------------------------------------------------------
// Admission control — capability layer
// ---------------------------------------------------------------------------

describe('admission control: capability layer', () => {
  test('rejects send when the agent cannot receive messages', () => {
    const decision = resolveAdmission(snapshot(), noCapabilities(), {
      intent: 'send',
    })
    expect(decision.action).toBe('reject')
    expect(decision.reason).toContain('cannot receive messages')
  })

  test('capability rejection wins over state, even for a healthy agent', () => {
    // Ordering matters: an actionable "this agent cannot be interrupted" beats a
    // protocol error thirty seconds later.
    const decision = resolveAdmission(
      snapshot({ agentState: 'working' }),
      caps({ messages: 'message' }),
      { intent: 'interrupt' },
    )
    expect(decision.action).toBe('reject')
    expect(decision.reason).toContain('cannot be interrupted')
  })

  test('rejects stop with a pointer to the agent’s own terminal', () => {
    const decision = resolveAdmission(
      snapshot({ agentState: 'working' }),
      caps({ messages: 'message', process: 'message' }),
      { intent: 'stop' },
    )
    expect(decision.action).toBe('reject')
    expect(decision.reason).toContain('its own terminal')
  })

  test('an observe-only agent is rejected for every intent', () => {
    const observeOnly = caps({ terminal: 'observe' })
    for (const intent of ['send', 'interrupt', 'stop'] as const) {
      expect(resolveAdmission(snapshot(), observeOnly, { intent }).action).toBe(
        'reject',
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Admission control — reachability layer
// ---------------------------------------------------------------------------

describe('admission control: reachability layer', () => {
  test('a dead agent relaunches and resumes', () => {
    const decision = resolveAdmission(
      snapshot({ processState: 'exited', agentState: 'dead' }),
      FULL_CAPS,
      { intent: 'send' },
    )
    expect(decision.action).toBe('relaunch')
    expect(decision.reason).toContain('resume')
  })

  test('a previously failed agent relaunches', () => {
    expect(
      resolveAdmission(snapshot({ agentState: 'failed' }), FULL_CAPS, {
        intent: 'send',
      }).action,
    ).toBe('relaunch')
  })

  test('alive but disconnected resumes rather than relaunching', () => {
    // The distinction this whole layer exists for.
    for (const connectionState of ['lost', 'disconnected'] as const) {
      const decision = resolveAdmission(
        snapshot({ processState: 'running', connectionState, agentState: 'idle' }),
        FULL_CAPS,
        { intent: 'send' },
      )
      expect(decision.action).toBe('resume')
      expect(decision.reason).toContain('alive')
    }
  })

  test('an agent still coming up queues', () => {
    for (const agentState of ['starting', 'connecting'] as const) {
      expect(
        resolveAdmission(
          snapshot({ agentState, connectionState: 'connecting' }),
          FULL_CAPS,
          { intent: 'send' },
        ).action,
      ).toBe('queue')
    }
  })

  test('a degraded connection still dispatches', () => {
    // Degraded means slow or lossy, not gone; holding work would be worse.
    expect(
      resolveAdmission(
        snapshot({ connectionState: 'degraded', agentState: 'idle' }),
        FULL_CAPS,
        { intent: 'send' },
      ).action,
    ).toBe('dispatch')
  })
})

// ---------------------------------------------------------------------------
// Admission control — send intent
// ---------------------------------------------------------------------------

describe('admission control: send intent', () => {
  test.each(['ready', 'idle'] as const)('%s dispatches immediately', state => {
    expect(
      resolveAdmission(snapshot({ agentState: state }), FULL_CAPS, {
        intent: 'send',
      }).action,
    ).toBe('dispatch')
  })

  test('working queues by default so in-flight work is not disturbed', () => {
    const decision = resolveAdmission(
      snapshot({
        agentState: 'working',
        activeTurn: { id: 't1', kind: 'regular' },
      }),
      FULL_CAPS,
      { intent: 'send' },
    )
    expect(decision.action).toBe('queue')
    expect(decision.reason).toContain('in-flight')
  })

  test('preferSteer steers a regular turn', () => {
    const decision = resolveAdmission(
      snapshot({
        agentState: 'working',
        activeTurn: { id: 'turn_7', kind: 'regular' },
      }),
      FULL_CAPS,
      { intent: 'send', preferSteer: true },
    )
    expect(decision.action).toBe('steer')
    expect(decision.reason).toContain('turn_7')
  })

  test.each(['review', 'compaction', 'shell', 'unknown'] as const)(
    'preferSteer degrades to queue on a %s turn',
    kind => {
      // Codex rejects turn/steer on these with ActiveTurnNotSteerable, so
      // erroring here would just move a guaranteed failure earlier.
      const decision = resolveAdmission(
        snapshot({ agentState: 'working', activeTurn: { id: 't', kind } }),
        FULL_CAPS,
        { intent: 'send', preferSteer: true },
      )
      expect(decision.action).toBe('queue')
      expect(decision.reason).toContain(kind)
    },
  )

  test('preferSteer degrades to queue when the agent cannot steer', () => {
    const decision = resolveAdmission(
      snapshot({
        agentState: 'working',
        activeTurn: { id: 't', kind: 'regular' },
      }),
      caps({ messages: 'message', process: 'full' }),
      { intent: 'send', preferSteer: true },
    )
    expect(decision.action).toBe('queue')
    expect(decision.reason).toContain('does not support steering')
  })

  test('preferSteer queues rather than guessing a turn id', () => {
    const decision = resolveAdmission(
      snapshot({ agentState: 'working' }),
      FULL_CAPS,
      { intent: 'send', preferSteer: true },
    )
    expect(decision.action).toBe('queue')
    expect(decision.reason).toContain('guessing')
  })

  test('interrupted resumes so the new input continues that conversation', () => {
    const decision = resolveAdmission(
      snapshot({ agentState: 'interrupted' }),
      FULL_CAPS,
      { intent: 'send' },
    )
    expect(decision.action).toBe('resume')
  })

  test('waiting resumes and names the blocker', () => {
    const decision = resolveAdmission(
      snapshot({ agentState: 'waiting' }),
      FULL_CAPS,
      { intent: 'send' },
    )
    expect(decision.action).toBe('resume')
    expect(decision.reason).toContain('approval')
  })
})

// ---------------------------------------------------------------------------
// Admission control — control intents
// ---------------------------------------------------------------------------

describe('admission control: interrupt and stop', () => {
  test('interrupt only proceeds against a working agent', () => {
    expect(
      resolveAdmission(snapshot({ agentState: 'working' }), FULL_CAPS, {
        intent: 'interrupt',
      }).action,
    ).toBe('dispatch')
  })

  test('interrupt is rejected when no turn is running', () => {
    for (const state of ['idle', 'ready', 'waiting', 'interrupted'] as const) {
      const decision = resolveAdmission(
        snapshot({ agentState: state }),
        FULL_CAPS,
        { intent: 'interrupt' },
      )
      expect(decision.action).toBe('reject')
      expect(decision.reason).toContain('no turn to interrupt')
    }
  })

  test('stop proceeds against any live state', () => {
    for (const state of ['working', 'idle', 'ready', 'waiting'] as const) {
      expect(
        resolveAdmission(snapshot({ agentState: state }), FULL_CAPS, {
          intent: 'stop',
        }).action,
      ).toBe('dispatch')
    }
  })

  test.each(['dead', 'stopped'] as const)(
    'control intents are rejected against an already-%s agent',
    state => {
      for (const intent of ['interrupt', 'stop'] as const) {
        const decision = resolveAdmission(
          snapshot({ agentState: state }),
          FULL_CAPS,
          { intent },
        )
        expect(decision.action).toBe('reject')
        expect(decision.reason).toContain('nothing to')
      }
    },
  )

  test('control intents never relaunch', () => {
    // Relaunching to serve a stop request would start a process in order to
    // kill it.
    for (const state of ALL_AGENT_STATES) {
      for (const intent of ['interrupt', 'stop'] as const) {
        const decision = resolveAdmission(
          snapshot({ processState: 'exited', agentState: state }),
          FULL_CAPS,
          { intent },
        )
        expect(decision.action).not.toBe('relaunch');
        expect(decision.action).not.toBe('resume')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Exhaustive sweep
// ---------------------------------------------------------------------------

describe('admission control: exhaustive sweep', () => {
  const VALID_ACTIONS: AdmissionAction[] = [
    'dispatch',
    'steer',
    'queue',
    'resume',
    'relaunch',
    'reject',
  ]

  test('every state × capability × intent combination yields a decision', () => {
    const capabilityMatrix: AgentCapabilities[] = [
      noCapabilities(),
      FULL_CAPS,
      caps({ messages: 'message', process: 'message' }),
      caps({ messages: 'full', process: 'full' }),
      caps({ terminal: 'observe' }),
    ]
    const seen = new Set<AdmissionAction>()
    let combos = 0

    for (const processState of ALL_PROCESS_STATES) {
      for (const connectionState of ALL_CONNECTION_STATES) {
        for (const agentState of ALL_AGENT_STATES) {
          for (const capabilities of capabilityMatrix) {
            for (const intent of ['send', 'interrupt', 'stop'] as const) {
              for (const preferSteer of [false, true]) {
                combos++
                const decision = resolveAdmission(
                  {
                    processState,
                    connectionState,
                    agentState,
                    activeTurn:
                      agentState === 'working'
                        ? { id: 't', kind: 'regular' }
                        : undefined,
                  },
                  capabilities,
                  { intent, preferSteer },
                )
                expect(VALID_ACTIONS).toContain(decision.action)
                expect(decision.reason.length).toBeGreaterThan(0)
                seen.add(decision.action)
              }
            }
          }
        }
      }
    }

    expect(combos).toBe(
      ALL_PROCESS_STATES.length *
        ALL_CONNECTION_STATES.length *
        ALL_AGENT_STATES.length *
        capabilityMatrix.length *
        3 *
        2,
    )
    // Every action must be reachable; an unreachable one is dead code in a
    // decision table that callers switch on exhaustively.
    expect([...seen].sort()).toEqual([...VALID_ACTIONS].sort())
  })

  test('a fully capable agent is never rejected for send', () => {
    for (const processState of ALL_PROCESS_STATES) {
      for (const connectionState of ALL_CONNECTION_STATES) {
        for (const agentState of ALL_AGENT_STATES) {
          const decision = resolveAdmission(
            { processState, connectionState, agentState },
            FULL_CAPS,
            { intent: 'send' },
          )
          expect(decision.action).not.toBe('reject')
        }
      }
    }
  })

  test('reject reasons never leak an internal state name alone', () => {
    // Reasons are surfaced verbatim by /agent and by the tool, so they must read
    // as sentences.
    for (const agentState of ALL_AGENT_STATES) {
      const decision = resolveAdmission(
        snapshot({ agentState }),
        noCapabilities(),
        { intent: 'send' },
      )
      expect(decision.reason).toMatch(/[a-z] [a-z]/)
      expect(decision.reason.endsWith('.')).toBe(true)
    }
  })
})
