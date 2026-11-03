/**
 * requestId ↔ callId correlation for approval requests.
 *
 * Both workers need the same bookkeeping and neither should own it: the rayu CLI
 * speaks `BridgePermissionCallbacks` (sendRequest / onResponse / cancelRequest) and
 * the rayucode extension speaks `PermissionCoordinator.approve|deny(requestId)`, but
 * underneath both are "I asked the browser something, route the answer back to the
 * right waiter".
 *
 * TWO ID SPACES, AND WHY. A host mints request ids in whatever shape it likes —
 * rayu-cli uses `randomUUID()`, the extension uses its control-protocol request id —
 * while the backend requires `callId` to match `[A-Za-z0-9_:.-]{1,128}`. A host id
 * that fails that pattern is rejected at the gateway, which would mean a permission
 * prompt that never reaches the browser while the host blocks waiting for it. So ids
 * are mapped through {@link toCallId} and the reverse mapping is REMEMBERED here,
 * because the mapping is lossy and cannot be inverted by computation.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it never synthesises a denial. When the socket
 * drops, pending entries are discarded and the waiters are simply never called.
 *
 * That is correct and it is the most important decision in this file. On both workers
 * the browser is an ADDITIONAL approver racing the local one, not a replacement — the
 * terminal dialog and the VS Code panel are still on screen, still awaiting input,
 * and the first responder wins. Fabricating a `deny` when the network blinked would
 * reject a tool the user was in the middle of approving locally, and would look
 * exactly like the model deciding to give up. Losing the remote racer must leave the
 * local gate untouched.
 */

import type { WebBridgeClient } from "./client.js";
import type {
  BridgeDecision,
  PlanRequest,
  QuestionRequest,
  ToolCallRequest,
} from "./protocol.js";
import { toCallId } from "./protocol.js";

/** A waiter for one approval. */
type DecisionHandler = (decision: BridgeDecision) => void;

interface PendingApproval {
  requestId: string;
  callId: string;
  handlers: Set<DecisionHandler>;
}

/**
 * Correlates approval requests sent over a {@link WebBridgeClient} with the answers
 * that come back.
 *
 * One instance per client. Not thread-safe and does not need to be: Node runs the
 * socket handlers and the host's permission code on the same loop.
 */
export class WebBridgePermissionRelay {
  private readonly byRequestId = new Map<string, PendingApproval>();
  private readonly byCallId = new Map<string, PendingApproval>();

  constructor(private readonly client: WebBridgeClient) {}

  /** Approvals currently awaiting a browser answer. */
  get pendingCount(): number {
    return this.byRequestId.size;
  }

  /** The host request ids currently awaiting an answer. */
  pendingRequestIds(): string[] {
    return [...this.byRequestId.keys()];
  }

  // --- Sending ---------------------------------------------------------------

  /**
   * Ask the browser to approve a tool call.
   *
   * Returns false when the request could not be sent — no live socket, or a payload
   * the backend would reject. A false return means "the browser will never answer
   * this", and the caller must not wait on it.
   */
  requestTool(
    requestId: string,
    request: Omit<ToolCallRequest, "callId">,
  ): boolean {
    const { callId } = this.track(requestId);
    const sent = this.client.toolCall({ ...request, callId });
    if (!sent) this.forget(requestId);
    return sent;
  }

  /** Ask the browser to approve a plan. Same false-means-unanswerable contract. */
  requestPlan(requestId: string, request: Omit<PlanRequest, "callId">): boolean {
    const { callId } = this.track(requestId);
    const sent = this.client.planRequest({ ...request, callId });
    if (!sent) this.forget(requestId);
    return sent;
  }

  /** Ask the browser to answer an `AskUserQuestion` interview. */
  requestQuestions(
    requestId: string,
    request: Omit<QuestionRequest, "callId">,
  ): boolean {
    const { callId } = this.track(requestId);
    const sent = this.client.questionRequest({ ...request, callId });
    if (!sent) this.forget(requestId);
    return sent;
  }

  // --- Receiving -------------------------------------------------------------

  /**
   * Register a waiter for one request. Returns an unsubscribe function.
   *
   * Registering for an unknown requestId is allowed and is not a bug: the host may
   * subscribe before or after it sends, and the CLI's `BridgePermissionCallbacks`
   * contract does both. The handler is held against the id either way.
   */
  onResponse(requestId: string, handler: DecisionHandler): () => void {
    const entry = this.track(requestId);
    entry.handlers.add(handler);
    return () => {
      entry.handlers.delete(handler);
    };
  }

  /**
   * Route a decision from the socket to its waiters.
   *
   * The client already guarantees at most one delivery per callId, so this does not
   * de-duplicate again; it resolves and forgets. An unknown callId is dropped
   * silently — it belongs to a request that was already answered locally, which is
   * the normal outcome of the race, not an error.
   */
  handleDecision(decision: BridgeDecision): void {
    const entry = this.byCallId.get(decision.callId);
    if (!entry) return;
    this.forget(entry.requestId);
    // Snapshot: a handler may unsubscribe others while running.
    for (const handler of [...entry.handlers]) {
      try {
        handler({ ...decision, callId: entry.requestId });
      } catch {
        // A waiter that throws must not stop the others from being told.
      }
    }
  }

  /**
   * The local side answered first — tell the browser to dismiss its card.
   *
   * Called from every local-win path. Without it the card stays on screen offering
   * Allow/Deny for a decision nobody is waiting on, and pressing it does nothing,
   * which trains the user to distrust the one control that has to be trustworthy.
   */
  cancel(requestId: string): void {
    const entry = this.byRequestId.get(requestId);
    if (!entry) return;
    this.forget(requestId);
    this.client.cancelRequest(entry.callId);
  }

  /**
   * Forget everything, without answering.
   *
   * For socket teardown. See the file header: no synthetic denials, because the
   * local approver is still live and still authoritative.
   */
  clear(): void {
    for (const entry of [...this.byRequestId.values()]) {
      this.forget(entry.requestId);
    }
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Find or create the entry for a request id.
   *
   * Idempotent: an existing entry is returned as-is rather than re-minted, so the
   * callId a request was sent under stays stable for its whole lifetime. Re-minting
   * would orphan the in-flight frame the browser is already showing.
   */
  private track(requestId: string): PendingApproval {
    const existing = this.byRequestId.get(requestId);
    if (existing) return existing;
    const entry: PendingApproval = {
      requestId,
      callId: toCallId(requestId),
      handlers: new Set(),
    };
    this.byRequestId.set(requestId, entry);
    this.byCallId.set(entry.callId, entry);
    return entry;
  }

  private forget(requestId: string): void {
    const entry = this.byRequestId.get(requestId);
    if (!entry) return;
    this.byRequestId.delete(requestId);
    this.byCallId.delete(entry.callId);
  }
}
