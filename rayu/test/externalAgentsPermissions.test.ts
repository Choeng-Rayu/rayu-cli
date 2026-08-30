/**
 * Permission Broker — routing a foreign agent's approval prompt into RAYU's own
 * dialog queue and echoing the decision back.
 *
 * Four honesty rules are enforced here and each has a test:
 *
 *   1. A dialog is shown only when the agent can ACTUALLY be answered. Showing
 *      buttons that do nothing would be faking centralized control.
 *   2. Nothing is written into RAYU's own permission rules — "don't ask again"
 *      becomes `accept-for-session` forwarded to the agent.
 *   3. `updatedInput` is ignored, because RAYU cannot rewrite a foreign agent's
 *      pending action.
 *   4. With no interactive UI the request is DECLINED, never auto-accepted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  brokerPermissionRequest,
  cancelPendingForAgent,
  EXTERNAL_AGENT_APPROVAL_TOOL_NAME,
  findPendingApproval,
  listPendingApprovals,
  resetPermissionBroker,
  resurfacePendingApprovals,
  type BrokerDeps,
  type BrokerOutcome,
} from '../src/externalAgents/permissions/permissionBroker.ts'
import {
  installPermissionBroker,
  uninstallPermissionBroker,
} from '../src/externalAgents/permissions/install.ts'
import {
  registerLeaderToolUseConfirmQueue,
  unregisterLeaderToolUseConfirmQueue,
} from '../src/utils/swarm/leaderPermissionBridge.ts'
import {
  registerAdapter,
  resetAdapterRegistry,
} from '../src/externalAgents/core/adapterRegistry.ts'
import {
  createStubAdapter,
  type StubHandle,
} from '../src/externalAgents/adapters/stub/StubAdapter.ts'
import {
  resetAgentManager,
  startAgent,
} from '../src/externalAgents/core/AgentManager.ts'
import { resetEventBus } from '../src/externalAgents/core/eventBus.ts'
import { emitEvent } from '../src/externalAgents/core/normalizer.ts'
import {
  asProviderId,
  asTaskRef,
  type AgentInstanceId,
  type ExternalAgentEvent,
  type PermissionRequestedEvent,
} from '../src/externalAgents/core/types.ts'
import type { ToolUseConfirm } from '../src/components/permissions/PermissionRequest.ts'

const AGENT = 'codex:agent_01' as AgentInstanceId
const STUB = asProviderId('stub')
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

/** Stand-in for the REPL's real ToolUseConfirm queue. */
function installQueue() {
  let queue: ToolUseConfirm[] = []
  registerLeaderToolUseConfirmQueue(updater => {
    queue = typeof updater === 'function' ? updater(queue) : updater
  })
  return {
    all: () => queue,
    latest: () => queue[queue.length - 1],
    size: () => queue.length,
  }
}

function request(
  overrides: Partial<PermissionRequestedEvent> = {},
): PermissionRequestedEvent {
  return {
    type: 'permission_requested',
    agentId: AGENT,
    requestId: 'req_1',
    kind: 'command',
    description: 'run rm -rf build',
    at: Date.now(),
    seq: 1,
    ...overrides,
  }
}

function deps(overrides: Partial<BrokerDeps> = {}) {
  const forwarded: { requestId: string; decision: string }[] = []
  return {
    forwarded,
    deps: {
      provider: asProviderId('codex'),
      canBroker: true,
      respond: async (requestId: string, decision: string) => {
        forwarded.push({ requestId, decision })
      },
      ...overrides,
    } as BrokerDeps,
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ext-perm-'))
  process.env.RAYU_CONFIG_DIR = dir
  resetPermissionBroker()
  unregisterLeaderToolUseConfirmQueue()
  resetAgentManager()
  resetAdapterRegistry()
  resetEventBus()
})
afterEach(() => {
  uninstallPermissionBroker()
  resetPermissionBroker()
  unregisterLeaderToolUseConfirmQueue()
  resetAgentManager()
  resetAdapterRegistry()
  resetEventBus()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

describe('brokering a request into RAYU’s dialog', () => {
  test('pushes onto the EXISTING confirm queue rather than a bespoke dialog', () => {
    const queue = installQueue()
    const { deps: d } = deps()
    void brokerPermissionRequest(request(), d)

    expect(queue.size()).toBe(1)
    const confirm = queue.latest()!
    expect(confirm.description).toBe('run rm -rf build')
    expect(confirm.permissionResult).toEqual({
      behavior: 'ask',
      message: 'run rm -rf build',
    })
  })

  test('badges the prompt with the agent so it is not mistaken for RAYU’s own', () => {
    const queue = installQueue()
    void brokerPermissionRequest(request(), deps().deps)
    expect(queue.latest()!.workerBadge?.name).toBe(AGENT)
    expect(queue.latest()!.workerBadge?.color).toBeTruthy()
  })

  test('the tool name is constant across providers, with the detail in the display name', () => {
    // Keeps analytics cardinality bounded and can never collide with a real tool.
    const queue = installQueue()
    void brokerPermissionRequest(
      request({ kind: 'file_change' }),
      deps({ provider: asProviderId('opencode') }).deps,
    )
    const confirm = queue.latest()!
    expect(confirm.tool.name).toBe(EXTERNAL_AGENT_APPROVAL_TOOL_NAME)
    expect(JSON.stringify(confirm.assistantMessage)).toContain(
      'opencode file change',
    )
  })

  test('a cwd is passed through as dialog input when present', () => {
    const queue = installQueue()
    void brokerPermissionRequest(request({ cwd: '/proj' }), deps().deps)
    expect(queue.latest()!.input).toEqual({
      request: 'run rm -rf build',
      cwd: '/proj',
    })
    resetPermissionBroker()
    void brokerPermissionRequest(request({ requestId: 'req_2' }), deps().deps)
    expect(queue.latest()!.input).toEqual({ request: 'run rm -rf build' })
  })

  test('a pending approval is listed with the metadata a command needs', () => {
    installQueue()
    void brokerPermissionRequest(request({ cwd: '/proj' }), deps().deps)
    const pending = listPendingApprovals()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      agentId: AGENT,
      requestId: 'req_1',
      provider: 'codex',
      kind: 'command',
      cwd: '/proj',
    })
    expect(findPendingApproval(AGENT, 'req_1')).toBeDefined()
    expect(findPendingApproval(AGENT, 'nope')).toBeUndefined()
  })

  test('pending approvals are listed oldest first', async () => {
    installQueue()
    void brokerPermissionRequest(request({ requestId: 'a' }), deps().deps)
    await tick(5)
    void brokerPermissionRequest(request({ requestId: 'b' }), deps().deps)
    expect(listPendingApprovals().map(p => p.requestId)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

describe('forwarding the user’s decision', () => {
  test('allow forwards accept', async () => {
    const queue = installQueue()
    const { deps: d, forwarded } = deps()
    const promise = brokerPermissionRequest(request(), d)
    queue.latest()!.onAllow(queue.latest()!.input, [])
    const outcome = await promise
    expect(outcome).toEqual({ status: 'answered', decision: 'accept' })
    expect(forwarded).toEqual([{ requestId: 'req_1', decision: 'accept' }])
  })

  test('"don’t ask again" becomes accept-for-session, NOT a RAYU rule', async () => {
    // A rule named after a synthetic tool could never match a real RAYU tool, so
    // persisting it would only grow settings with dead entries. Scoping it to the
    // agent's session is where it actually belongs.
    const queue = installQueue()
    const { deps: d, forwarded } = deps()
    const promise = brokerPermissionRequest(request(), d)
    queue.latest()!.onAllow(queue.latest()!.input, [
      { type: 'addRules', rules: [], behavior: 'allow', destination: 'session' },
    ] as never)
    expect(await promise).toEqual({
      status: 'answered',
      decision: 'accept-for-session',
    })
    expect(forwarded).toEqual([
      { requestId: 'req_1', decision: 'accept-for-session' },
    ])
  })

  test('reject forwards decline', async () => {
    const queue = installQueue()
    const { deps: d, forwarded } = deps()
    const promise = brokerPermissionRequest(request(), d)
    queue.latest()!.onReject()
    expect(await promise).toEqual({ status: 'answered', decision: 'decline' })
    expect(forwarded[0]!.decision).toBe('decline')
  })

  test('abort forwards cancel', async () => {
    const queue = installQueue()
    const { deps: d, forwarded } = deps()
    const promise = brokerPermissionRequest(request(), d)
    queue.latest()!.onAbort()
    expect(await promise).toEqual({ status: 'answered', decision: 'cancel' })
    expect(forwarded[0]!.decision).toBe('cancel')
  })

  test('answering removes the prompt from the queue', async () => {
    const queue = installQueue()
    const { deps: d } = deps()
    const promise = brokerPermissionRequest(request(), d)
    queue.latest()!.onAllow({}, [])
    await promise
    expect(queue.size()).toBe(0)
    expect(listPendingApprovals()).toEqual([])
  })

  test('only the FIRST answer counts', async () => {
    const queue = installQueue()
    const { deps: d, forwarded } = deps()
    const confirm = queue.latest.bind(queue)
    const promise = brokerPermissionRequest(request(), d)
    const dialog = confirm()!
    dialog.onAllow({}, [])
    dialog.onReject()
    dialog.onAbort()
    const outcome = await promise
    expect(outcome.status).toBe('answered')
    if (outcome.status === 'answered') expect(outcome.decision).toBe('accept')
    expect(forwarded).toHaveLength(1)
  })

  test('a failure delivering the decision is reported, not left dangling', async () => {
    // The agent vanished between the click and the reply.
    const queue = installQueue()
    const promise = brokerPermissionRequest(
      request(),
      deps({
        respond: async () => {
          throw new Error('agent already exited')
        },
      }).deps,
    )
    queue.latest()!.onAllow({}, [])
    const outcome = await promise
    expect(outcome.status).toBe('cancelled')
    expect((outcome as { reason: string }).reason).toContain('agent already exited')
  })

  test('recheckPermission is a no-op because RAYU’s rules do not govern the agent', async () => {
    const queue = installQueue()
    void brokerPermissionRequest(request(), deps().deps)
    await expect(queue.latest()!.recheckPermission()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('requests that must not be prompted', () => {
  test('an agent with no reply channel is REPORTED, not prompted', async () => {
    // An observe-class agent may emit permission_requested because its stdout
    // mentioned an approval, but RAYU has no way to answer.
    const queue = installQueue()
    const outcome = await brokerPermissionRequest(
      request(),
      deps({ canBroker: false }).deps,
    )
    expect(outcome.status).toBe('not-brokerable')
    expect((outcome as { reason: string }).reason).toContain(
      "agent's own terminal",
    )
    expect(queue.size()).toBe(0)
  })

  test('no interactive UI DECLINES fail-closed', async () => {
    // An unanswerable prompt must never be auto-accepted, and the agent has to
    // unblock rather than hang forever.
    unregisterLeaderToolUseConfirmQueue()
    const { deps: d, forwarded } = deps()
    const outcome = await brokerPermissionRequest(request(), d)
    expect(outcome.status).toBe('no-ui')
    expect(forwarded).toEqual([{ requestId: 'req_1', decision: 'decline' }])
  })

  test('a no-UI decline that itself fails still resolves', async () => {
    unregisterLeaderToolUseConfirmQueue()
    const outcome = await brokerPermissionRequest(
      request(),
      deps({
        respond: async () => {
          throw new Error('gone')
        },
      }).deps,
    )
    expect(outcome.status).toBe('no-ui')
  })

  test('a duplicate (agent, requestId) leaves the first prompt standing', async () => {
    const queue = installQueue()
    const { deps: d } = deps()
    void brokerPermissionRequest(request(), d)
    expect(await brokerPermissionRequest(request(), d)).toEqual({
      status: 'duplicate',
    })
    expect(queue.size()).toBe(1)
  })

  test('the same requestId from a DIFFERENT agent is not a duplicate', () => {
    const queue = installQueue()
    const { deps: d } = deps()
    void brokerPermissionRequest(request(), d)
    void brokerPermissionRequest(
      request({ agentId: 'opencode:agent_01' as AgentInstanceId }),
      d,
    )
    expect(queue.size()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

describe('withdrawing approvals', () => {
  test('cancelling for an agent notifies it so it can unblock', async () => {
    const queue = installQueue()
    const { deps: d, forwarded } = deps()
    const promise = brokerPermissionRequest(request(), d)
    expect(
      cancelPendingForAgent(AGENT, 'turn ended', { notifyAgent: true }),
    ).toBe(1)
    const outcome = await promise
    expect(outcome.status).toBe('cancelled')
    expect((outcome as { reason: string }).reason).toBe('turn ended')
    expect(forwarded).toEqual([{ requestId: 'req_1', decision: 'cancel' }])
    expect(queue.size()).toBe(0)
  })

  test('cancelling a GONE agent does not try to reply', async () => {
    // Replying to an exited agent would throw inside a UI callback.
    const queue = installQueue()
    const { deps: d, forwarded } = deps()
    const promise = brokerPermissionRequest(request(), d)
    cancelPendingForAgent(AGENT, 'agent disconnected (process_exit)', {
      notifyAgent: false,
    })
    await promise
    expect(forwarded).toEqual([])
    expect(queue.size()).toBe(0)
  })

  test('cancelling only touches the named agent', () => {
    installQueue()
    const { deps: d } = deps()
    void brokerPermissionRequest(request(), d)
    void brokerPermissionRequest(
      request({ agentId: 'opencode:agent_01' as AgentInstanceId }),
      d,
    )
    expect(cancelPendingForAgent(AGENT, 'x', { notifyAgent: false })).toBe(1)
    expect(listPendingApprovals().map(p => String(p.agentId))).toEqual([
      'opencode:agent_01',
    ])
  })

  test('cancelling with nothing pending reports zero', () => {
    expect(cancelPendingForAgent(AGENT, 'x', { notifyAgent: false })).toBe(0)
  })

  test('reset settles every pending approval without touching any agent', async () => {
    installQueue()
    const { deps: d, forwarded } = deps()
    const promise = brokerPermissionRequest(request(), d)
    resetPermissionBroker()
    expect((await promise).status).toBe('cancelled')
    expect(forwarded).toEqual([])
  })
})

describe('resurfacing after RAYU’s global cancel', () => {
  test('re-pushes tracked approvals the cancel silently dropped', () => {
    // useCancelRequest empties the queue WITHOUT calling onAbort, so a foreign
    // agent would stay blocked with its prompt no longer on screen. Rather than
    // guessing with a timeout, the broker keeps the request and lets the user
    // bring it back.
    const queue = installQueue()
    void brokerPermissionRequest(request(), deps().deps)
    expect(queue.size()).toBe(1)

    registerLeaderToolUseConfirmQueue(updater => {
      // Simulate the global cancel emptying the queue.
      void updater
    })
    const q2 = installQueue()
    expect(q2.size()).toBe(0)

    expect(resurfacePendingApprovals()).toBe(1)
    expect(q2.size()).toBe(1)
    expect(q2.latest()!.description).toBe('run rm -rf build')
  })

  test('resurfacing does not duplicate an approval already on screen', () => {
    const queue = installQueue()
    void brokerPermissionRequest(request(), deps().deps)
    expect(resurfacePendingApprovals()).toBe(1)
    expect(queue.size()).toBe(1)
  })

  test('resurfacing with nothing pending is a no-op', () => {
    installQueue()
    expect(resurfacePendingApprovals()).toBe(0)
  })

  test('resurfacing with no UI attached reports zero', () => {
    unregisterLeaderToolUseConfirmQueue()
    expect(resurfacePendingApprovals()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Installer wiring
// ---------------------------------------------------------------------------

describe('broker installer', () => {
  async function launch() {
    registerAdapter(createStubAdapter({ provider: STUB }))
    return startAgent({ provider: STUB, cwd: dir })
  }

  test('a bus event reaches the dialog and the decision reaches the adapter', async () => {
    const queue = installQueue()
    const handle = await launch()
    installPermissionBroker()

    emitEvent(
      { agentId: handle.agentId },
      {
        type: 'permission_requested',
        requestId: 'req_9',
        kind: 'command',
        description: 'npm publish',
      },
    )
    await tick()
    expect(queue.size()).toBe(1)

    queue.latest()!.onAllow({}, [])
    await tick(20)
    expect((handle as unknown as StubHandle).permissionReplies).toEqual([
      { requestId: 'req_9', decision: 'accept' },
    ])
  })

  test('an agent that is not connected is reported, never prompted', async () => {
    const queue = installQueue()
    const reports: BrokerOutcome[] = []
    installPermissionBroker((_event, outcome) => reports.push(outcome))

    emitEvent(
      { agentId: 'codex:ghost' as AgentInstanceId },
      {
        type: 'permission_requested',
        requestId: 'req_1',
        kind: 'tool',
        description: 'do a thing',
      },
    )
    await tick()
    expect(queue.size()).toBe(0)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.status).toBe('not-brokerable')
    expect((reports[0] as { reason: string }).reason).toContain('not connected')
  })

  test('an agent with permissions below message is reported, not prompted', async () => {
    const queue = installQueue()
    registerAdapter(
      createStubAdapter({ provider: STUB, capabilities: { permissions: 'observe' } }),
    )
    const handle = await startAgent({ provider: STUB, cwd: dir })
    const reports: BrokerOutcome[] = []
    installPermissionBroker((_e, outcome) => reports.push(outcome))

    emitEvent(
      { agentId: handle.agentId },
      {
        type: 'permission_requested',
        requestId: 'r',
        kind: 'command',
        description: 'x',
      },
    )
    await tick()
    expect(queue.size()).toBe(0)
    expect(reports[0]!.status).toBe('not-brokerable')
  })

  test('a disconnect withdraws pending approvals WITHOUT replying', async () => {
    const queue = installQueue()
    const handle = await launch()
    installPermissionBroker()
    emitEvent(
      { agentId: handle.agentId },
      { type: 'permission_requested', requestId: 'r', kind: 'command', description: 'x' },
    )
    await tick()
    expect(queue.size()).toBe(1)

    emitEvent(
      { agentId: handle.agentId },
      { type: 'agent_disconnected', reason: 'process_exit' },
    )
    await tick()
    expect(queue.size()).toBe(0)
    expect((handle as unknown as StubHandle).permissionReplies).toEqual([])
  })

  test('a finished turn withdraws the stale prompt AND tells the agent', async () => {
    const queue = installQueue()
    const handle = await launch()
    installPermissionBroker()
    emitEvent(
      { agentId: handle.agentId, taskRef: asTaskRef('t1') },
      { type: 'permission_requested', requestId: 'r', kind: 'command', description: 'x' },
    )
    await tick()

    emitEvent(
      { agentId: handle.agentId, taskRef: asTaskRef('t1') },
      { type: 'task_completed' },
    )
    await tick(20)
    expect(queue.size()).toBe(0)
    // The agent is still alive, so it is told the request is dropped.
    expect((handle as unknown as StubHandle).permissionReplies).toEqual([
      { requestId: 'r', decision: 'cancel' },
    ])
  })

  test('installing twice does not double-prompt', async () => {
    // Idempotent: a second call replaces the previous subscription.
    const queue = installQueue()
    const handle = await launch()
    installPermissionBroker()
    installPermissionBroker()
    emitEvent(
      { agentId: handle.agentId },
      { type: 'permission_requested', requestId: 'r', kind: 'command', description: 'x' },
    )
    await tick()
    expect(queue.size()).toBe(1)
  })

  test('uninstalling stops brokering', async () => {
    const queue = installQueue()
    const handle = await launch()
    const uninstall = installPermissionBroker()
    uninstall()
    emitEvent(
      { agentId: handle.agentId },
      { type: 'permission_requested', requestId: 'r', kind: 'command', description: 'x' },
    )
    await tick()
    expect(queue.size()).toBe(0)
  })

  test('unrelated events are ignored', async () => {
    const queue = installQueue()
    const handle = await launch()
    installPermissionBroker()
    const events: ExternalAgentEvent['type'][] = [
      'agent_idle',
      'agent_message',
      'tool_started',
    ]
    for (const type of events) {
      emitEvent({ agentId: handle.agentId }, {
        type,
        text: 'x',
        delta: false,
        callId: 'c',
        toolName: 'T',
      } as never)
    }
    await tick()
    expect(queue.size()).toBe(0)
  })
})
