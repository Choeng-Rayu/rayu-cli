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
import type { WebBridgePermissionRelay } from './client/index.js'
import { logForDebugging } from '../utils/debug.js'
import {
  approvalKind,
  resolveApprovalDecision,
  sendApproval,
  type WebBridgeApprovalKind,
  type WebBridgeApprovalRequest,
} from './webBridgeApprovals.js'

/**
 * Build callbacks that relay permission prompts to the browser.
 *
 * `relay` owns requestId ↔ callId correlation and the de-duplication of the backend's
 * deliberately-doubled decision frames; `webBridgeApprovals` owns which card a request
 * becomes and how its answer is applied. Both are shared with the VS Code worker.
 */
export function createWebBridgePermissionCallbacks(
  relay: WebBridgePermissionRelay,
): BridgePermissionCallbacks {
  /*
   * What THIS host asked, per request. `onResponse` is a separate call from
   * `sendRequest`, and the answer has to be applied against the host's own input —
   * the browser only saw a clamped copy. Entries go on every exit: the decision, a
   * local win (`sendResponse` / `cancelRequest` are called on every local-win path),
   * or a send that never left.
   */
  const asked = new Map<
    string,
    { kind: WebBridgeApprovalKind; request: WebBridgeApprovalRequest }
  >()

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
      const request: WebBridgeApprovalRequest = {
        requestId,
        toolName,
        input,
        ...(description ? { description } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        ...(permissionSuggestions?.length ? { permissionSuggestions } : {}),
        ...(blockedPath ? { blockedPath } : {}),
      }
      const kind = approvalKind(request)
      if (!sendApproval(relay, kind, request)) {
        // Not an error worth surfacing to the user: the terminal dialog is already up
        // and the decision will simply be made there. Logged because "my approvals
        // stopped appearing in the browser" is otherwise undiagnosable.
        logForDebugging(
          `[web-bridge] permission ${requestId} not relayed (no live connection)`,
        )
        return
      }
      asked.set(requestId, { kind, request })
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
      asked.delete(requestId)
      relay.cancel(requestId)
    },

    cancelRequest(requestId: string): void {
      asked.delete(requestId)
      relay.cancel(requestId)
    },

    onResponse(
      requestId: string,
      handler: (response: BridgePermissionResponse) => void,
    ): () => void {
      const unsubscribe = relay.onResponse(requestId, decision => {
        const entry = asked.get(requestId)
        asked.delete(requestId)
        if (!entry) return
        const response = resolveApprovalDecision(entry.kind, entry.request, decision)
        if (!response) {
          logForDebugging(
            `[web-bridge] answer for ${requestId} did not fit its questions; the terminal dialog stays authoritative`,
          )
          return
        }
        handler({
          behavior: response.behavior,
          ...(response.message ? { message: response.message } : {}),
          ...(response.updatedInput ? { updatedInput: response.updatedInput } : {}),
          // Cast, not validation. `PermissionUpdate` is rayu-cli's own schema and the
          // relay carries it as `unknown[]` because neither the backend nor the
          // browser has any business interpreting it. The value is validated where it
          // is APPLIED — ctx.persistPermissions — which is the only place that knows
          // the schema, and where an invalid rule is already handled.
          ...(response.updatedPermissions?.length
            ? { updatedPermissions: response.updatedPermissions as PermissionUpdate[] }
            : {}),
        })
      })

      return () => {
        unsubscribe()
        /*
         * Unsubscribing a request that is still pending means nothing will apply an
         * answer to it: its turn was aborted, and only the head of the terminal's
         * permission queue gets an explicit cancel. Withdraw the Studio card too —
         * otherwise it stays up with buttons that do nothing.
         */
        if (asked.delete(requestId)) relay.cancel(requestId)
      }
    },
  }
}
