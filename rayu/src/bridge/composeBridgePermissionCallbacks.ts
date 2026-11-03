/**
 * Combine several remote permission surfaces into one racer.
 *
 * WHY THIS EXISTS. `handleInteractivePermission` accepts exactly ONE
 * `bridgeCallbacks`, and the selection used to be a `??` chain — so with both the
 * Telegram bridge and the Web Bridge connected, whichever came first in the chain won
 * and the other never saw the request at all. Not as a deliberate policy: the prompt
 * simply never arrived, and the user watching the studio saw a session that had
 * stopped for no visible reason while a card sat waiting in Telegram.
 *
 * Fanning out is the honest behaviour. Every connected remote is offered the decision,
 * exactly as the local terminal dialog is, and the first answer wins.
 *
 * FIRST ANSWER WINS, AND THE LOSERS ARE TOLD. On the first response this cancels the
 * request on every other member, which is what removes their now-meaningless cards.
 * Without that, answering in the browser would leave a live-looking Allow/Deny in
 * Telegram for a tool that had already run.
 *
 * The local dialog is unaffected and remains the floor: `claim()` in
 * `handleInteractivePermission` still arbitrates between this composite and every
 * other racer, so at most one decision is ever applied.
 */

import type {
  BridgePermissionCallbacks,
  BridgePermissionResponse,
} from '../bridge/bridgePermissionCallbacks.js'
import type { PermissionUpdate } from '../utils/permissions/PermissionUpdateSchema.js'

/**
 * Build one callbacks object that fans out to all of `members`.
 *
 * Returns the single member unwrapped when there is only one — the overwhelmingly
 * common case — so the composite adds no indirection to it. Returns undefined when
 * there are none, which is what `handleInteractivePermission` expects for "no remote".
 */
export function composeBridgePermissionCallbacks(
  ...members: (BridgePermissionCallbacks | undefined)[]
): BridgePermissionCallbacks | undefined {
  const active = members.filter(
    (m): m is BridgePermissionCallbacks => m !== undefined,
  )
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]

  /**
   * requestIds already answered by some member.
   *
   * Guards against two remotes answering in the same tick. Without it, both handlers
   * would run and the second would be applied to a gate the first had already
   * resolved.
   */
  const answered = new Set<string>()

  return {
    sendRequest(
      requestId: string,
      toolName: string,
      input: Record<string, unknown>,
      toolUseId: string,
      description: string,
      permissionSuggestions?: PermissionUpdate[],
      blockedPath?: string,
    ): void {
      for (const member of active) {
        // Isolated per member: one remote being unreachable must not stop the others
        // from being asked.
        try {
          member.sendRequest(
            requestId,
            toolName,
            input,
            toolUseId,
            description,
            permissionSuggestions,
            blockedPath,
          )
        } catch {
          // Deliberately swallowed — see above.
        }
      }
    },

    sendResponse(requestId: string, response: BridgePermissionResponse): void {
      answered.add(requestId)
      for (const member of active) {
        try {
          member.sendResponse(requestId, response)
        } catch {
          // ignore
        }
      }
    },

    cancelRequest(requestId: string): void {
      answered.add(requestId)
      for (const member of active) {
        try {
          member.cancelRequest(requestId)
        } catch {
          // ignore
        }
      }
    },

    onResponse(
      requestId: string,
      handler: (response: BridgePermissionResponse) => void,
    ): () => void {
      const unsubscribes: (() => void)[] = []

      for (const member of active) {
        try {
          unsubscribes.push(
            member.onResponse(requestId, response => {
              if (answered.has(requestId)) return
              answered.add(requestId)

              // Detach from every member first, so a second remote answering while
              // this handler runs cannot re-enter.
              for (const off of unsubscribes) {
                try {
                  off()
                } catch {
                  // ignore
                }
              }

              // Then dismiss the losers' cards. The winner is skipped: it has already
              // resolved and telling it to cancel would be a contradictory instruction.
              for (const other of active) {
                if (other === member) continue
                try {
                  other.cancelRequest(requestId)
                } catch {
                  // ignore
                }
              }

              handler(response)
            }),
          )
        } catch {
          // A member that cannot be subscribed to simply does not participate.
        }
      }

      return () => {
        for (const off of unsubscribes) {
          try {
            off()
          } catch {
            // ignore
          }
        }
      }
    },
  }
}
