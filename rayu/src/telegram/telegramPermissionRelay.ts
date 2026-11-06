/**
 * Races the Telegram permission card against the editor's permission dialog.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────────
 *
 * A headless engine resolves "ask" decisions through its permission prompt tool. In the
 * VS Code extension that is `stdio`: `StructuredIO.createCanUseTool` writes a
 * `can_use_tool` control request and blocks until the extension host answers. That is
 * correct while the user is at the keyboard — and useless when the whole point of the
 * Telegram link is to drive the conversation from a phone. The turn waits for a dialog
 * nobody is looking at.
 *
 * ── THE MECHANISM, REUSED NOT INVENTED ─────────────────────────────────────────
 *
 * `StructuredIO` already exposes exactly what is needed for a second surface:
 *
 *  - `setOnControlRequestSent` fires when a `can_use_tool` request is written (the
 *    claude.ai bridge uses it for the same purpose), so the Telegram card is raised at
 *    the same moment the editor's dialog is;
 *  - `injectControlResponse` resolves the pending request AND sends the host a
 *    `control_cancel_request`, which is what makes the editor dismiss its now-stale card.
 *
 * First answer wins, and the losing surface is told — the same contract
 * `composeBridgePermissionCallbacks` gives the REPL when several remotes are connected.
 *
 * ── CALLBACKS ARE RESOLVED PER REQUEST ────────────────────────────────────────
 *
 * `deps.callbacks()` is called for each request rather than captured once: a session may
 * be attached to another process's bridge over IPC (`getRemotePermissionCallbacks`), and
 * that attachment can change while the engine is running.
 *
 * Free of engine imports beyond types, so every state transition is unit-testable.
 */
import type {
  BridgePermissionCallbacks,
  BridgePermissionResponse,
} from '../bridge/bridgePermissionCallbacks.js'
import type { PermissionUpdate } from '../utils/permissions/PermissionUpdateSchema.js'
import type { SDKControlRequest } from '../entrypoints/sdk/controlTypes.js'

/**
 * The decision shape the SDK permission-prompt path validates.
 *
 * `updatedInput` is REQUIRED by the schema even for a one-shot allow that changes
 * nothing. Telegram's "Allow once" carries no input, so it sends `{}`, which
 * `permissionPromptToolResultToPermissionDecision` interprets as "use the original" —
 * the same convention the schema documents for mobile clients.
 */
export type PermissionDecisionPayload =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
    }
  | { behavior: 'deny'; message: string; toolUseID?: string }

export interface TelegramPermissionRelayDeps {
  /** Resolve a pending `can_use_tool` request locally and cancel it on the host. */
  injectDecision(requestId: string, decision: PermissionDecisionPayload): void
  /** The permission surfaces connected right now (local bridge and/or IPC attachment). */
  callbacks(): BridgePermissionCallbacks | undefined
}

export class TelegramPermissionRelay {
  /** requestId → detach the response handler from every surface. */
  private readonly pending = new Map<string, () => void>()

  constructor(private readonly deps: TelegramPermissionRelayDeps) {}

  /** A `can_use_tool` request was written to the extension host: offer the chat a card. */
  onControlRequestSent(request: SDKControlRequest): void {
    const req = request.request
    if (req.subtype !== 'can_use_tool') return
    const callbacks = this.deps.callbacks()
    if (!callbacks) return

    const requestId = request.request_id
    // Subscribe before sending: the question and plan flows look up a handler that
    // `onResponse` may have already parked (see telegramPermissions.recordFor).
    const detach = callbacks.onResponse(requestId, response => {
      this.forget(requestId, false)
      this.deps.injectDecision(requestId, decisionFor(response, req.tool_use_id))
    })
    this.pending.set(requestId, detach)

    callbacks.sendRequest(
      requestId,
      req.tool_name,
      req.input,
      req.tool_use_id,
      req.description ?? '',
      // Same wire shape as `PermissionUpdate`; the cast exists only because the
      // control-protocol copy is inferred from its own zod schema.
      req.permission_suggestions as PermissionUpdate[] | undefined,
      req.blocked_path,
    )
  }

  /** The host (or another surface) answered first: retire the chat card. */
  onControlRequestResolved(requestId: string): void {
    this.forget(requestId, true)
  }

  /**
   * The turn ended, or the bridge stopped: no request from it can still be answered.
   *
   * Dropping the handlers is what keeps a card tapped after an interrupt from resolving
   * a request the engine has already abandoned.
   */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.forget(requestId, true)
  }

  private forget(requestId: string, cancelCard: boolean): void {
    const detach = this.pending.get(requestId)
    if (detach === undefined) return
    this.pending.delete(requestId)
    try {
      detach()
    } catch {
      // A surface that cannot be unsubscribed from is already effectively detached.
    }
    if (cancelCard) this.deps.callbacks()?.cancelRequest(requestId)
  }
}

/** Convert a chat decision into the payload the SDK permission flow accepts. */
export function decisionFor(
  response: BridgePermissionResponse,
  toolUseId?: string,
): PermissionDecisionPayload {
  if (response.behavior === 'allow') {
    return {
      behavior: 'allow',
      updatedInput: response.updatedInput ?? {},
      ...(response.updatedPermissions?.length
        ? { updatedPermissions: response.updatedPermissions }
        : {}),
    }
  }
  return {
    behavior: 'deny',
    message: response.message ?? 'Denied from Telegram',
    ...(toolUseId ? { toolUseID: toolUseId } : {}),
  }
}
