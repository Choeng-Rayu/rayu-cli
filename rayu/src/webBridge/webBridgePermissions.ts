/**
 * BridgePermissionCallbacks over the Web Bridge.
 *
 * This is the whole reason permission prompts can be answered from a browser: the
 * interface is already the right shape. `BridgePermissionCallbacks` was written for
 * claude.ai's remote bridge and is fire-request-then-await-callback, which is exactly
 * what a socket provides — so no new plumbing is needed in the permission system, only
 * a second implementation of a contract that already exists.
 *
 * THE BRIDGE IS A RACER, NOT A REPLACEMENT. `handleInteractivePermission` pushes the
 * local terminal dialog and races it against these callbacks, the MCP channels, the
 * permission hooks and the bash classifier; `claim()` picks exactly one winner. Two
 * consequences follow and both are load-bearing:
 *
 *  • `cancelRequest` is called on EVERY local-win path, so it must reliably dismiss
 *    the browser card. A card left offering Allow/Deny for a decision nobody is
 *    waiting on is a control that does nothing when pressed, and this is the one
 *    control that has to be trustworthy.
 *
 *  • Losing the socket must NOT deny anything. The terminal dialog is still on screen
 *    and still authoritative. Fabricating a denial when the network blinked would
 *    reject a tool the user was in the middle of approving, and would look exactly
 *    like the model deciding to give up.
 */

import type {
  BridgePermissionCallbacks,
  BridgePermissionResponse,
} from '../bridge/bridgePermissionCallbacks.js'
import type { PermissionUpdate } from '../utils/permissions/PermissionUpdateSchema.js'
import type { WebBridgePermissionRelay } from '@rayu-dev/web-bridge-client'
import { logForDebugging } from '../utils/debug.js'

/**
 * Build callbacks that relay permission prompts to the browser.
 *
 * `relay` owns requestId ↔ callId correlation and the de-duplication of the backend's
 * deliberately-doubled decision frames, so nothing here has to think about either.
 */
export function createWebBridgePermissionCallbacks(
  relay: WebBridgePermissionRelay,
): BridgePermissionCallbacks {
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
      const sent = relay.requestTool(requestId, {
        toolName,
        toolInput: input,
        ...(description ? { description } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        ...(permissionSuggestions?.length
          ? { permissionSuggestions }
          : {}),
        ...(blockedPath ? { blockedPath } : {}),
      })
      if (!sent) {
        // Not an error worth surfacing to the user: the terminal dialog is already up
        // and the decision will simply be made there. Logged because "my approvals
        // stopped appearing in the browser" is otherwise undiagnosable.
        logForDebugging(
          `[web-bridge] permission ${requestId} not relayed (no live connection)`,
        )
      }
    },

    /**
     * Tell the browser what was decided locally.
     *
     * Implemented as a cancel, not as a second decision channel. The backend has no
     * "the CLI answered it itself" event, and `cancel_request` already means exactly
     * that to the browser: this approval is no longer answerable, remove the card.
     * The outcome itself reaches the browser the same way every other outcome does —
     * as the resulting tool activity in the stream.
     */
    sendResponse(requestId: string, _response: BridgePermissionResponse): void {
      relay.cancel(requestId)
    },

    cancelRequest(requestId: string): void {
      relay.cancel(requestId)
    },

    onResponse(
      requestId: string,
      handler: (response: BridgePermissionResponse) => void,
    ): () => void {
      return relay.onResponse(requestId, decision => {
        handler({
          behavior: decision.behavior,
          ...(decision.message ? { message: decision.message } : {}),
          ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
          // Cast, not validation. `PermissionUpdate` is rayu-cli's own schema and the
          // relay carries it as `unknown[]` because neither the backend nor the
          // browser has any business interpreting it. The value is validated where it
          // is APPLIED — ctx.persistPermissions — which is the only place that knows
          // the schema, and where an invalid rule is already handled.
          ...(decision.updatedPermissions?.length
            ? { updatedPermissions: decision.updatedPermissions as PermissionUpdate[] }
            : {}),
        })
      })
    },
  }
}
