/**
 * Wires the event bus to the Permission Broker.
 *
 * Direction of dependencies matters here. `AgentManager` must never import the
 * broker (the broker reaches into the UI queue, the manager must stay usable
 * headless), and the broker must never import `AgentManager` (it would close a
 * cycle through `core/`). This installer is the only place that knows both:
 * it subscribes to the bus, resolves the handle, and hands the broker a plain
 * reply callback.
 *
 * That also means withdrawal is event-driven. When an agent disconnects or its
 * turn ends, the bus says so and pending approvals are dropped here — the
 * manager does not have to remember to tell the broker.
 */

import { logForDebugging } from '../../utils/debug.js'
import {
  canPerform,
  findLiveAgent,
  respondToPermission,
} from '../core/AgentManager.js'
import { subscribeToEvents } from '../core/eventBus.js'
import type { ExternalAgentEvent } from '../core/types.js'
import {
  brokerPermissionRequest,
  type BrokerOutcome,
  cancelPendingForAgent,
} from './permissionBroker.js'

/** Notified for outcomes that need to reach the user rather than a dialog. */
export type BrokerReporter = (
  event: ExternalAgentEvent,
  outcome: BrokerOutcome,
) => void

let unsubscribe: (() => void) | null = null

/**
 * Start brokering. Idempotent — a second call replaces the previous
 * subscription rather than double-prompting.
 */
export function installPermissionBroker(report?: BrokerReporter): () => void {
  uninstallPermissionBroker()

  unsubscribe = subscribeToEvents(event => {
    switch (event.type) {
      case 'permission_requested': {
        const handle = findLiveAgent(event.agentId)
        if (!handle) {
          // Adopted-but-not-connected, or already reaped. There is no reply
          // channel, so report instead of prompting.
          report?.(event, {
            status: 'not-brokerable',
            reason:
              `${event.agentId} asked for approval but is not connected to ` +
              `this session. Answer it in the agent's own terminal.`,
          })
          return
        }
        void brokerPermissionRequest(event, {
          provider: handle.provider,
          canBroker: canPerform(handle, 'brokerPermissions'),
          respond: (requestId, decision) =>
            respondToPermission(event.agentId, requestId, decision),
        }).then(outcome => {
          if (outcome.status !== 'answered') {
            logForDebugging(
              `[externalAgents] approval ${outcome.status} for ${event.agentId}`,
            )
            report?.(event, outcome)
          }
        })
        return
      }

      case 'agent_disconnected': {
        // Process gone or transport lost: replying would throw.
        cancelPendingForAgent(
          event.agentId,
          `agent disconnected (${event.reason})`,
          { notifyAgent: false },
        )
        return
      }

      case 'task_completed':
      case 'task_failed': {
        // The turn that raised the prompt is over, so the prompt is stale. The
        // agent is still alive, so tell it we are dropping the request.
        cancelPendingForAgent(event.agentId, 'turn ended', {
          notifyAgent: true,
        })
        return
      }

      default:
        return
    }
  })

  return uninstallPermissionBroker
}

export function uninstallPermissionBroker(): void {
  unsubscribe?.()
  unsubscribe = null
}
