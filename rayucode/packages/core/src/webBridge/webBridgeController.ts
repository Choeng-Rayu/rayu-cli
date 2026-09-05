// Web Bridge controller — lets a rayucode session be driven from the rayu-web studio.
//
// This is the extension's half of the same feature the rayu CLI REPL has: the studio
// lists every signed-in worker, and a prompt typed in the browser reaches whichever
// one the user picked. Both workers speak the identical protocol through
// `@rayu-dev/web-bridge-client`, which is why a browser tab cannot tell them apart
// and does not have to.
//
// EDITOR-AGNOSTIC (R13.1, R13.5). No `vscode` import. Everything editor-shaped comes
// through injected functions, so this file is unit-testable with a fake client and no
// extension host. The VS Code host supplies the token and the activation lifecycle.
//
// TWO TRANSLATIONS, IN OPPOSITE DIRECTIONS.
//
//   panel → bridge   `PanelOutboundMessage` is already the complete description of
//                    what the local UI is showing, so it is also the complete
//                    description of what a remote viewer should see. Observing it
//                    means the mirror cannot fall behind the panel by construction,
//                    and it arrives already redacted (see SessionManager.postToPanel).
//
//   bridge → panel   Inbound commands are mapped onto the SAME public SessionManager
//                    methods the webview's own messages are mapped onto. A browser
//                    approval therefore takes the identical code path as a click in
//                    the panel, which is what makes "answered in two places at once"
//                    safe: `PermissionCoordinator.approve|deny` returns false when
//                    the request is no longer pending, so the loser of the race is a
//                    no-op rather than a second decision applied to a stale gate.
//
// WHAT THIS DOES NOT DO: it never approves anything on its own, and it never denies on
// disconnect. The local panel is still open and still authoritative; losing the
// browser must leave the local gate exactly as it was.

import type {
  PromptCommand,
  WebBridgeClientOptions,
  WebBridgeConnectionState,
} from "@rayu-dev/web-bridge-client";
import {
  WebBridgeClient,
  WebBridgePermissionRelay,
} from "@rayu-dev/web-bridge-client";

import type { ConversationItem } from "../session/state.js";
import type { PanelOutboundMessage } from "../session/sessionManager.js";

/**
 * The SessionManager surface this controller drives.
 *
 * Structural, not the concrete class: it names only the five methods used, so the
 * controller can be tested against a stub and cannot accidentally reach for more of
 * the manager than it needs.
 */
export interface WebBridgeSessionHost {
  openSession(sessionKey: string): Promise<void>;
  submitPrompt(sessionKey: string, text: string): Promise<void>;
  interrupt(sessionKey: string): Promise<void>;
  approvePermission(
    sessionKey: string,
    requestId: string,
    updatedInput?: Record<string, unknown>,
  ): void;
  denyPermission(sessionKey: string, requestId: string, message?: string): void;
}

export interface WebBridgeControllerOptions {
  /**
   * Everything the client needs EXCEPT its handlers, which this controller supplies.
   *
   * The handlers are excluded rather than accepted-and-overridden because the
   * controller and the client are mutually dependent — the client routes inbound
   * frames to the controller, and the controller emits outbound frames through the
   * client. Letting the controller construct the client is what breaks that cycle
   * without asking the host to assemble a two-phase initialisation by hand.
   */
  client: Omit<WebBridgeClientOptions, "handlers">;
  host: WebBridgeSessionHost;
  /**
   * The session a browser prompt is routed to.
   *
   * A function rather than a value because the extension's active session changes as
   * the user switches workspace folders, while the bridge announces ONE machine — so
   * "which session" is a question that has to be answered per prompt, not once at
   * construction.
   */
  activeSessionKey: () => string | null;
  /** Notified when the socket's state changes, for a status bar item. */
  onConnectionChange?: (state: WebBridgeConnectionState) => void;
  /** Diagnostic sink. Receives no prompt text and no token. */
  log?: (message: string) => void;
}

/**
 * Bridges one extension host to the studio.
 *
 * Construct it, hand {@link observePanelMessage} to `SessionManager`'s
 * `onPanelMessage`, and call {@link attach} once. {@link dispose} detaches without
 * touching session state.
 */
export class WebBridgeController {
  private readonly client: WebBridgeClient;
  private readonly relay: WebBridgePermissionRelay;

  /**
   * requestIds already relayed to the browser.
   *
   * Needed because `showPermissionRequest` is not the only message carrying a
   * permission item: `addMessage` and `restoreHistory` carry them too when history is
   * re-rendered. Without this, reopening the panel would re-send every approval the
   * session had ever surfaced, and the browser would show a stack of cards for
   * decisions made long ago.
   */
  private readonly relayedRequests = new Set<string>();

  /** True between the first delta of a turn and its end, to bound `stream_end`. */
  private inTurn = false;

  private disposed = false;

  constructor(private readonly options: WebBridgeControllerOptions) {
    this.client = new WebBridgeClient({
      ...options.client,
      handlers: {
        onPrompt: (prompt) => this.onPrompt(prompt),
        onInterrupt: () => this.onInterrupt(),
        onDecision: (decision) => this.relay.handleDecision(decision),
        onBridgeError: ({ message }) =>
          this.log(`backend refused a frame: ${message}`),
        onConnectionChange: (state) => {
          // Drop every correlation on a lost connection. The pending approvals stay
          // on screen in the panel and remain answerable there; what must not survive
          // is the belief that a browser is still going to answer them.
          if (state === "reconnecting" || state === "error") this.relay.clear();
          this.options.onConnectionChange?.(state);
        },
      },
    });
    this.relay = new WebBridgePermissionRelay(this.client);
  }

  /** The backend-assigned session id, once the handshake has completed. */
  get sessionId(): string | null {
    return this.client.sessionId;
  }

  get connectionState(): WebBridgeConnectionState {
    return this.client.connectionState;
  }

  /**
   * Open the connection.
   *
   * Returns false when the user is not signed in to Rayu — a normal outcome the host
   * surfaces as an actionable message, not an error to throw.
   */
  async attach(): Promise<boolean> {
    return this.client.connect();
  }

  /** Detach from the studio. Leaves every local session running and untouched. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Discard pending correlations WITHOUT answering them: the panel still has those
    // approvals on screen and the user can still decide there.
    this.relay.clear();
    this.client.stop();
  }

  // --- panel → bridge --------------------------------------------------------

  /**
   * Observe one host → panel message and mirror it to the studio.
   *
   * Hand this to `SessionManagerOptions.onPanelMessage`. Unhandled message kinds are
   * ignored on purpose rather than forwarded as an unknown blob: the browser renders
   * a fixed set of events, and a message it does not understand would be dead weight
   * on the wire.
   */
  readonly observePanelMessage = (
    sessionKey: string,
    message: PanelOutboundMessage,
  ): void => {
    if (this.disposed) return;

    switch (message.type) {
      case "appendPartial":
        this.inTurn = true;
        this.client.streamDelta(message.delta, "text");
        return;

      case "setGenerating":
        // The authoritative end of a turn. `completeMessage` fires per assistant
        // item and a turn can contain several, so ending on it would close the
        // stream while the agent was still working.
        if (!message.generating && this.inTurn) {
          this.inTurn = false;
          this.client.streamEnd({});
        }
        return;

      case "addMessage":
      case "showPermissionRequest":
      case "showToolAction":
        this.relayItem(sessionKey, message.item);
        return;

      case "restoreHistory":
        // History replay: relay only unanswered approvals, so reopening a panel does
        // not resurrect resolved cards. The backend keeps its own replay buffer for
        // the conversation text, so nothing else here needs re-sending.
        for (const item of message.items) {
          if (item.kind === "permission_request") this.relayItem(sessionKey, item);
        }
        return;

      case "updateToolStatus":
        this.client.activity({
          kind: "tool_status",
          summary: `${message.status}${message.output ? `: ${message.output}` : ""}`,
        });
        return;

      case "showError":
        this.client.activity({ kind: "error", summary: message.message });
        return;

      case "editApplied":
        this.client.activity({
          kind: "edit_applied",
          summary: message.path,
        });
        return;

      case "editConflict":
        // Surfaced but NOT made answerable remotely. Conflict confirmation needs the
        // diff the editor is showing, and approving a write over a changed file from
        // a browser that cannot display what changed is consent without information.
        this.client.activity({
          kind: "edit_conflict",
          summary: `${message.paths.join(", ")} — confirm in the editor`,
        });
        return;

      case "rateLimit":
        this.client.activity({
          kind: "rate_limit",
          summary: message.rateLimitType
            ? `${message.status} (${message.rateLimitType})`
            : message.status,
        });
        return;

      default:
        // setModelInfo, setModelList, setMcpStatus, showUsage, insertPrompt,
        // toolProgress, completeMessage — local UI concerns with no remote rendering.
        return;
    }
  };

  /** Relay a conversation item, if it is one the browser renders. */
  private relayItem(sessionKey: string, item: ConversationItem): void {
    switch (item.kind) {
      case "user":
        this.client.activity({ kind: "prompt", summary: item.text });
        return;

      case "assistant":
        // Only complete messages. A streaming one is already being relayed delta by
        // delta, and sending it again here would duplicate the whole turn.
        if (!item.streaming && item.text) {
          this.client.activity({ kind: "assistant", summary: item.text });
        }
        return;

      case "tool_action":
        this.client.activity({
          kind: "tool",
          summary: item.command ?? item.toolName,
        });
        return;

      case "permission_request":
        this.relayPermission(sessionKey, item);
        return;

      case "error":
        this.client.activity({ kind: "error", summary: item.message });
        return;

      default:
        return;
    }
  }

  /**
   * Relay — or withdraw — one permission request.
   *
   * A `resolution` means the request has already been answered, by the user in the
   * panel or by policy. Withdrawing the card then is the whole point: a browser
   * offering Allow/Deny for a decision nobody is waiting on is a control that does
   * nothing when pressed, and this is the one control that has to be trusted.
   */
  private relayPermission(
    sessionKey: string,
    item: Extract<ConversationItem, { kind: "permission_request" }>,
  ): void {
    if (item.resolution !== undefined) {
      if (this.relayedRequests.delete(item.requestId)) {
        this.relay.cancel(item.requestId);
      }
      return;
    }

    if (this.relayedRequests.has(item.requestId)) return;

    /*
     * Register the waiter BEFORE sending.
     *
     * A decision can come back in the same tick the request goes out — a browser tab
     * that is already open and a user who clicks immediately is not a rare case — and
     * a decision arriving before the waiter exists would be dropped by the relay as
     * belonging to an unknown callId. The CLI would then block on an approval the user
     * had already given.
     */
    this.bindPermission(sessionKey, item.requestId);

    const sent = this.relay.requestTool(item.requestId, {
      toolName: item.toolName,
      toolInput: item.input,
      ...(item.command ? { description: item.command } : {}),
    });

    // Only remember it if it actually went out. Remembering an unsent request would
    // suppress the retry when the socket comes back.
    if (sent) {
      this.relayedRequests.add(item.requestId);
      this.log(`relayed permission ${item.requestId} for ${sessionKey}`);
    }
  }

  // --- bridge → panel --------------------------------------------------------

  /** A browser tab sent a prompt. */
  private onPrompt(prompt: PromptCommand): void {
    const key = this.options.activeSessionKey();
    if (!key) {
      // No workspace session to aim at. Silence would look like the prompt was
      // accepted, so this is surfaced to the browser as an activity line.
      this.client.activity({
        kind: "error",
        summary: "No rayucode session is open in the editor.",
      });
      return;
    }
    void this.deliverPrompt(key, prompt.text);
  }

  /** A browser tab asked to stop the current turn. */
  private onInterrupt(): void {
    const key = this.options.activeSessionKey();
    if (!key) return;
    void this.options.host
      .interrupt(key)
      // Acknowledged only AFTER the interrupt was actually issued. Acking first
      // would re-enable the browser's composer for a turn that is still running.
      .then(() => {
        this.inTurn = false;
        this.client.interruptAck();
      })
      .catch((error: unknown) => this.log(`interrupt failed: ${describe(error)}`));
  }

  /**
   * Route a browser prompt into a session.
   *
   * `openSession` first, because a prompt may arrive for a session whose panel the
   * user never opened — the whole point of remote control is that nobody is sitting
   * at the editor. `submitPrompt` alone would throw for an unknown session key.
   */
  private async deliverPrompt(sessionKey: string, text: string): Promise<void> {
    try {
      await this.options.host.openSession(sessionKey);
      await this.options.host.submitPrompt(sessionKey, text);
    } catch (error) {
      const detail = describe(error);
      this.log(`prompt delivery failed: ${detail}`);
      // Reported back, never swallowed: a prompt that vanishes is indistinguishable
      // from the model being slow, which is the worst failure a remote control has.
      this.client.activity({
        kind: "error",
        summary: `Could not start that prompt: ${detail}`,
      });
    }
  }

  /**
   * Wire one pending approval to the session's permission gate.
   *
   * The decision is applied through the SAME public methods the webview's own
   * messages use, which is what makes a simultaneous answer in both places safe:
   * `PermissionCoordinator.approve|deny` returns false when the request is no longer
   * pending, so whichever surface loses the race performs a no-op instead of applying
   * a second decision to a gate that has moved on.
   */
  private bindPermission(sessionKey: string, requestId: string): () => void {
    return this.relay.onResponse(requestId, (decision) => {
      this.relayedRequests.delete(requestId);
      if (decision.behavior === "allow") {
        this.options.host.approvePermission(
          sessionKey,
          requestId,
          decision.updatedInput,
        );
      } else {
        this.options.host.denyPermission(sessionKey, requestId, decision.message);
      }
    });
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
