/**
 * Permission Broker — routes an external agent's approval prompt into RAYU's
 * own permission dialog, then echoes the user's decision back to that agent.
 *
 * Why this reuses the existing dialog instead of adding a new one
 * ---------------------------------------------------------------
 * `ToolUseConfirm` + `FallbackPermissionRequest` already implement the
 * approval UX the user knows: keyboard handling, feedback capture, the
 * "don't ask again" option, and the worker badge that attributes a prompt to
 * something other than the main agent. A foreign agent's approval is the same
 * interaction with a different answer channel, so it goes through the same
 * queue via `leaderPermissionBridge`. The synthetic tool + assistant message
 * are built with the helpers `src/remote/remotePermissionBridge.ts` already
 * ships for exactly this situation (remote tools RAYU does not have locally).
 *
 * Honesty rules this module enforces
 * ----------------------------------
 * 1. A dialog is only shown when the agent can actually be answered
 *    (`permissions >= 'message'` AND the adapter really implements
 *    `respondToPermission`). An `observe`-class agent may *emit*
 *    `permission_requested` because its stdout mentioned an approval, but
 *    RAYU has no reply channel; showing buttons that do nothing would be
 *    faking centralized control. Those surface as `not-brokerable` and are
 *    reported, not prompted.
 * 2. Nothing is written into RAYU's own permission rules. The fallback dialog
 *    hands back an `addRules` update for "don't ask again"; that rule would be
 *    named after a synthetic tool and could never match a real RAYU tool, so
 *    persisting it would only grow settings with dead entries. The update is
 *    instead interpreted as `accept-for-session` and forwarded to the agent,
 *    which scopes it where it belongs — that agent's session.
 * 3. `updatedInput` is ignored. RAYU cannot rewrite a foreign agent's pending
 *    action; pretending to would silently drop the user's edit.
 * 4. With no interactive UI attached the request is DECLINED, never
 *    auto-accepted. An unanswerable prompt must fail closed.
 */

import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../../remote/remotePermissionBridge.js'
import { getAgentColor } from '../../tools/AgentTool/agentColorManager.js'
import type { Tool } from '../../Tool.js'
import type { PermissionAskDecision } from '../../types/permissions.js'
import { getLeaderToolUseConfirmQueue } from '../../utils/swarm/leaderPermissionBridge.js'
import type { PermissionDecision } from '../core/adapter.js'
import type {
  AgentInstanceId,
  PermissionRequestedEvent,
  ProviderId,
} from '../core/types.js'

/**
 * `tool.name` reported to analytics and to the dialog's rule builder. Held
 * constant across every provider so analytics cardinality stays bounded and so
 * the name can never collide with a real tool. The *display* name is separate
 * and carries the provider + action.
 */
export const EXTERNAL_AGENT_APPROVAL_TOOL_NAME = 'ExternalAgentApproval'

/** Fallback badge colour when the shared agent palette declines to assign one. */
const DEFAULT_BADGE_COLOR = 'cyan_FOR_SUBAGENTS_ONLY'

const KIND_LABEL: Record<PermissionRequestedEvent['kind'], string> = {
  command: 'command',
  file_change: 'file change',
  network: 'network access',
  tool: 'tool call',
  other: 'action',
}

export type BrokerOutcome =
  /** The user answered; `decision` was forwarded to the agent. */
  | { readonly status: 'answered'; readonly decision: PermissionDecision }
  /** RAYU has no reply channel for this agent — reported, not prompted. */
  | { readonly status: 'not-brokerable'; readonly reason: string }
  /** No interactive dialog available; declined fail-closed. */
  | { readonly status: 'no-ui'; readonly reason: string }
  /** Same (agentId, requestId) already pending; the first prompt stands. */
  | { readonly status: 'duplicate' }
  /** Withdrawn before the user answered (agent stopped, died, or turn ended). */
  | { readonly status: 'cancelled'; readonly reason: string }

/**
 * Everything the broker needs about one agent, injected rather than imported.
 *
 * `AgentManager` is deliberately NOT imported here: the installer in
 * `./install.ts` subscribes to the event bus and supplies these, so the
 * dependency runs one way (installer -> manager, installer -> broker) and no
 * import cycle exists.
 */
export type BrokerDeps = {
  readonly provider: ProviderId
  /** `canPerform(handle, 'brokerPermissions')` — checked by the caller. */
  readonly canBroker: boolean
  readonly respond: (
    requestId: string,
    decision: PermissionDecision,
  ) => Promise<void>
}

/** A request currently sitting in the dialog queue, awaiting a human. */
export type PendingApproval = {
  readonly agentId: AgentInstanceId
  readonly requestId: string
  readonly toolUseID: string
  readonly provider: ProviderId
  readonly kind: PermissionRequestedEvent['kind']
  readonly description: string
  readonly cwd?: string
  readonly askedAtMs: number
}

type PendingEntry = {
  readonly approval: PendingApproval
  readonly confirm: ToolUseConfirm
  /** Reply channel, retained so a cancel can unblock the agent too. */
  readonly respond: (
    requestId: string,
    decision: PermissionDecision,
  ) => Promise<void>
  /** Resolve the promise handed back by `brokerPermissionRequest`. */
  readonly finish: (outcome: BrokerOutcome) => void
  /** Guards against a second settle from a racing abort/cancel/answer. */
  settled: boolean
}

/** Keyed by `toolUseID`, which is itself derived from agentId + requestId. */
const pending = new Map<string, PendingEntry>()

function makeToolUseID(agentId: AgentInstanceId, requestId: string): string {
  return `external-agent:${agentId}:${requestId}`
}

function removeFromQueue(toolUseID: string): void {
  const setQueue = getLeaderToolUseConfirmQueue()
  setQueue?.(queue => queue.filter(item => item.toolUseID !== toolUseID))
}

/**
 * Present one `permission_requested` event to the user and forward the answer.
 *
 * Resolves once the request reaches a final state. The adapter is already
 * blocked waiting for `respondToPermission`, so callers may ignore the
 * returned promise; it exists so commands, the orchestrator, and tests can
 * observe the outcome.
 */
export function brokerPermissionRequest(
  event: PermissionRequestedEvent,
  deps: BrokerDeps,
): Promise<BrokerOutcome> {
  const { agentId, requestId, kind, description, cwd } = event
  const toolUseID = makeToolUseID(agentId, requestId)

  if (pending.has(toolUseID)) {
    return Promise.resolve({ status: 'duplicate' })
  }

  if (!deps.canBroker) {
    return Promise.resolve({
      status: 'not-brokerable',
      reason:
        `${agentId} raised an approval request but RAYU has no reply ` +
        `channel for it (permissions capability too low). Answer it in the ` +
        `agent's own terminal.`,
    })
  }

  const setQueue = getLeaderToolUseConfirmQueue()
  if (!setQueue) {
    // Fail closed: decline so the agent unblocks instead of hanging forever.
    return deps
      .respond(requestId, 'decline')
      .catch(() => undefined)
      .then(() => ({
        status: 'no-ui' as const,
        reason: `${agentId} asked for approval with no interactive session attached; declined.`,
      }))
  }

  const displayName = `${deps.provider} ${KIND_LABEL[kind]}`
  const input: Record<string, unknown> = cwd
    ? { request: description, cwd }
    : { request: description }

  const tool = {
    ...createToolStub(displayName),
    name: EXTERNAL_AGENT_APPROVAL_TOOL_NAME,
  } as Tool

  const assistantMessage = createSyntheticAssistantMessage(
    { tool_use_id: toolUseID, tool_name: displayName, input },
    requestId,
  )

  const permissionResult: PermissionAskDecision = {
    behavior: 'ask',
    message: description,
  }

  const approval: PendingApproval = {
    agentId,
    requestId,
    toolUseID,
    provider: deps.provider,
    kind,
    description,
    cwd,
    askedAtMs: Date.now(),
  }

  return new Promise<BrokerOutcome>(resolve => {
    /**
     * Single settle path. `notifyAgent` is false only when the agent is
     * already gone — replying then would throw inside a UI callback.
     */
    const settle = (
      outcome: BrokerOutcome,
      decision: PermissionDecision | null,
    ): void => {
      const entry = pending.get(toolUseID)
      if (!entry || entry.settled) return
      entry.settled = true
      pending.delete(toolUseID)
      removeFromQueue(toolUseID)
      if (decision === null) {
        resolve(outcome)
        return
      }
      void deps.respond(requestId, decision).then(
        () => resolve(outcome),
        error => {
          // The agent vanished between the click and the reply. The user's
          // intent is still worth reporting; surface the failure as a cancel
          // rather than leaving the promise dangling.
          resolve({
            status: 'cancelled',
            reason: `could not deliver "${decision}" to ${agentId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        },
      )
    }

    const confirm: ToolUseConfirm = {
      assistantMessage,
      tool,
      description,
      input,
      // The fallback dialog never reads this; the remote bridge stubs it the
      // same way. A foreign agent's approval has no RAYU tool-use context.
      toolUseContext: {} as ToolUseConfirm['toolUseContext'],
      toolUseID,
      permissionResult,
      permissionPromptStartTimeMs: Date.now(),
      workerBadge: {
        name: agentId,
        color: getAgentColor(deps.provider) ?? DEFAULT_BADGE_COLOR,
      },
      onUserInteraction() {
        // No classifier auto-approval races for external agents.
      },
      onAbort() {
        settle({ status: 'answered', decision: 'cancel' }, 'cancel')
      },
      onAllow(_updatedInput, permissionUpdates) {
        // A non-empty update list is the dialog's "don't ask again". Scope it
        // to the agent's session rather than RAYU's rule store (see header).
        const decision: PermissionDecision =
          permissionUpdates.length > 0 ? 'accept-for-session' : 'accept'
        settle({ status: 'answered', decision }, decision)
      },
      onReject() {
        settle({ status: 'answered', decision: 'decline' }, 'decline')
      },
      async recheckPermission() {
        // RAYU's rules do not govern a foreign agent, so there is nothing to
        // re-evaluate when the permission mode changes.
      },
    }

    pending.set(toolUseID, {
      approval,
      confirm,
      respond: deps.respond,
      finish: resolve,
      settled: false,
    })
    setQueue(queue => [...queue, confirm])
  })
}

/** Approvals currently waiting on the user, oldest first. */
export function listPendingApprovals(): PendingApproval[] {
  return [...pending.values()]
    .map(entry => entry.approval)
    .sort((a, b) => a.askedAtMs - b.askedAtMs)
}

export function findPendingApproval(
  agentId: AgentInstanceId,
  requestId: string,
): PendingApproval | undefined {
  return pending.get(makeToolUseID(agentId, requestId))?.approval
}

/**
 * Withdraw every approval pending for one agent.
 *
 * `notifyAgent` should be true when the agent is still reachable (an explicit
 * `/agent interrupt`, where declining lets it unblock and wind down) and false
 * once it has exited or disconnected, since replying would throw.
 */
export function cancelPendingForAgent(
  agentId: AgentInstanceId,
  reason: string,
  options: { readonly notifyAgent: boolean },
): number {
  let cancelled = 0
  for (const entry of [...pending.values()]) {
    if (entry.approval.agentId !== agentId) continue
    if (entry.settled) continue
    entry.settled = true
    pending.delete(entry.approval.toolUseID)
    removeFromQueue(entry.approval.toolUseID)
    if (options.notifyAgent) {
      // Best effort: let the agent unblock. A failure here means it is already
      // gone, which is exactly the case the caller is handling.
      void entry.respond(entry.approval.requestId, 'cancel').catch(
        () => undefined,
      )
    }
    entry.finish({ status: 'cancelled', reason })
    cancelled++
  }
  return cancelled
}

/**
 * Re-push tracked approvals into the dialog queue.
 *
 * RAYU's global cancel (`useCancelRequest`) empties the queue without calling
 * `onAbort` on the dropped items. For RAYU's own tools that is harmless — the
 * surrounding query aborts too — but a foreign agent would stay blocked with
 * its prompt no longer on screen. Rather than guessing with a timeout, the
 * broker keeps the request and lets the user bring it back.
 */
export function resurfacePendingApprovals(): number {
  const setQueue = getLeaderToolUseConfirmQueue()
  if (!setQueue) return 0
  const entries = [...pending.values()].filter(entry => !entry.settled)
  if (entries.length === 0) return 0
  const ids = new Set(entries.map(entry => entry.approval.toolUseID))
  setQueue(queue => [
    ...queue.filter(item => !ids.has(item.toolUseID)),
    ...entries.map(entry => entry.confirm),
  ])
  return entries.length
}

/** Test/teardown hook: drop all tracked state without touching any agent. */
export function resetPermissionBroker(): void {
  for (const entry of [...pending.values()]) {
    removeFromQueue(entry.approval.toolUseID)
    if (!entry.settled) {
      entry.settled = true
      entry.finish({ status: 'cancelled', reason: 'broker reset' })
    }
  }
  pending.clear()
}
