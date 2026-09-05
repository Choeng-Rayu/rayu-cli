// The `@rayucode` chat participant (Copilot Chat integration).
//
// Surfaces the REAL rayu agent inside VS Code's chat view. The participant does
// not talk to a language model itself — `request.model` is deliberately ignored.
// Every prompt is forwarded to a `SessionManager` session, which spawns/drives the
// actual `rayu` CLI, and the agent's streamed text is relayed back into the chat
// response. So `@rayucode` and the Activity Bar panel are two views onto the same
// engine, with the same provider/model/permission configuration.
//
// ── How streaming is bridged ────────────────────────────────────────────────
// The core's only outbound sink is an `AgentPanelHandle`. Rather than add a second
// output path to the core, this module registers a HEADLESS handle — a
// `ChatPanelSink` that satisfies the same interface but forwards
// `PanelOutboundMessage`s to the active chat turn instead of a webview. The
// adapter's resolver chain (`registerAgentPanelResolver`) hands it out for the
// chat session key, so the core is entirely unaware it is not driving a webview.
//
// Messages consumed per turn:
//   `addMessage`      (assistant) → remember the item id; text is authoritative
//   `appendPartial`                → `stream.markdown(delta)` — the live stream
//   `showToolAction` / `updateToolStatus` → a one-line progress note
//   `showError`                    → surfaced as a warning line
//   `setGenerating: false`         → the turn is complete
//
// ── Session isolation ───────────────────────────────────────────────────────
// The chat participant uses its OWN session key (`chat:<workspace>`), separate
// from the panel's. Sharing one session would interleave two independent
// conversations into a single history and fight over the in-progress assistant
// item id. Costs one extra `rayu` process while chat is in use; correctness wins.
//
// ── Availability ────────────────────────────────────────────────────────────
// `vscode.chat` requires a host that ships the chat view. Registration is feature
// detected and failure is non-fatal: without it the Activity Bar panel is
// completely unaffected.

import * as vscode from "vscode";

import type { AgentPanelHandle, Disposable, SessionManager } from "@rayucode/core";

/** Participant id — must match `contributes.chatParticipants[].id`. */
export const CHAT_PARTICIPANT_ID = "rayucode.agent";

/** Prefix distinguishing the chat participant's session keys from the panel's. */
export const CHAT_SESSION_PREFIX = "chat:";

/**
 * Instructions prepended for each contributed slash command. The agent receives
 * a normal prompt — the command only frames the request, so `/fix` and "please
 * fix this" behave identically from the CLI's point of view.
 */
const SLASH_COMMAND_INSTRUCTIONS: Record<string, string> = {
  explain:
    "Explain the following code: what it does, how it works, and anything surprising about it. Do not modify any files.",
  fix: "Find and fix the bugs in the following code. Explain each fix you make.",
  review:
    "Review the following code for correctness, security, performance, and readability issues. Report findings; do not modify files unless asked.",
  test: "Write tests for the following code using the test framework already used in this project.",
};

/** The `SessionManager` surface the participant drives. */
export type ChatSessionManager = Pick<
  SessionManager,
  "openSession" | "submitPrompt" | "interrupt" | "closeSession"
>;

/** The adapter surface the participant needs. */
export interface ChatParticipantAdapter {
  registerAgentPanelResolver(
    resolver: (sessionKey: string) => Promise<AgentPanelHandle | null> | AgentPanelHandle | null,
  ): Disposable;
  log(channel: "protocol" | "lifecycle" | "error", message: string): void;
}

/** Construction options for {@link registerChatParticipant}. */
export interface ChatParticipantOptions {
  context: vscode.ExtensionContext;
  sessionManager: ChatSessionManager;
  adapter: ChatParticipantAdapter;
  /** Workspace-derived key the PANEL uses; the chat key is derived from it. */
  workspaceSessionKey: () => string;
}

/**
 * Register the `@rayucode` chat participant. Returns the participant, or `null`
 * when the host does not expose the chat API (in which case the panel remains
 * fully functional). Never throws.
 */
export function registerChatParticipant(
  options: ChatParticipantOptions,
): vscode.ChatParticipant | null {
  const { context, sessionManager, adapter } = options;

  // Feature detection: `vscode.chat` is absent on hosts without the chat view.
  if (typeof vscode.chat?.createChatParticipant !== "function") {
    adapter.log(
      "lifecycle",
      "The VS Code chat API is unavailable; skipping the @rayucode chat participant (the agent panel is unaffected).",
    );
    return null;
  }

  const chatSessionKey = (): string =>
    `${CHAT_SESSION_PREFIX}${options.workspaceSessionKey()}`;

  // One sink per chat session, handed to the core through the resolver chain.
  const sink = new ChatPanelSink(chatSessionKey());
  context.subscriptions.push(
    adapter.registerAgentPanelResolver((sessionKey) =>
      sessionKey === sink.sessionKey ? sink : null,
    ),
  );

  const handler: vscode.ChatRequestHandler = async (
    request,
    _chatContext,
    stream,
    token,
  ) => {
    const sessionKey = sink.sessionKey;
    try {
      // Binds the sink through `showAgentPanel` and starts the agent if needed.
      await sessionManager.openSession(sessionKey);
    } catch (error) {
      stream.markdown(
        `\n\n**Rayucode could not start the agent.** ${codeSpan(errorMessage(error))}\n`,
      );
      adapter.log(
        "error",
        `Chat participant failed to open session: ${errorMessage(error)}`,
      );
      return {};
    }

    const turn = sink.beginTurn(stream);
    // R3.6 — a cancelled chat turn interrupts the agent rather than orphaning it.
    const cancellation = token.onCancellationRequested(() => {
      turn.cancel();
      void sessionManager.interrupt(sessionKey).catch(() => {
        /* interrupt is best-effort */
      });
    });

    try {
      await sessionManager.submitPrompt(sessionKey, buildPrompt(request));
      if (!turn.hasStarted) {
        // `submitPrompt` returns silently when the agent could not be started —
        // it surfaces its own actionable notification — so no `setGenerating`
        // ever arrives. Without this the turn would await `completion` forever
        // and the chat view would spin indefinitely.
        turn.abort(
          "The Rayu agent did not start. Check the notification or the Rayucode output channel, then try again.",
        );
      }
      await turn.completion;
    } catch (error) {
      stream.markdown(`\n\n**Rayucode error:** ${codeSpan(errorMessage(error))}\n`);
      adapter.log(
        "error",
        `Chat participant turn failed: ${errorMessage(error)}`,
      );
    } finally {
      cancellation.dispose();
      sink.endTurn(turn);
    }

    return {};
  };

  let participant: vscode.ChatParticipant;
  try {
    participant = vscode.chat.createChatParticipant(
      CHAT_PARTICIPANT_ID,
      handler,
    );
  } catch (error) {
    // A duplicate id or a manifest mismatch must not abort activation.
    adapter.log(
      "error",
      `Failed to register the @rayucode chat participant: ${errorMessage(error)}`,
    );
    return null;
  }

  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "assets",
    "icon.svg",
  );
  context.subscriptions.push(participant);
  // Terminate the chat session's agent process on shutdown (R2.7).
  context.subscriptions.push({
    dispose: () => {
      void sessionManager.closeSession(sink.sessionKey).catch(() => {
        /* best-effort teardown */
      });
    },
  });

  adapter.log("lifecycle", "Registered the @rayucode chat participant.");
  return participant;
}

// ----------------------------------------------------------------------------
// Prompt assembly
// ----------------------------------------------------------------------------

/**
 * Build the prompt sent to the agent: the slash-command instruction (if any),
 * the user's text, and any `#file`/selection references they attached.
 *
 * Exported for unit testing — it is the whole of the request→prompt mapping.
 */
export function buildPrompt(request: {
  prompt: string;
  command?: string | undefined;
  references?: readonly { id: string; value: unknown; range?: readonly number[] | undefined }[];
}): string {
  const parts: string[] = [];

  const instruction = request.command
    ? SLASH_COMMAND_INSTRUCTIONS[request.command]
    : undefined;
  if (instruction) {
    parts.push(instruction);
  }

  const text = request.prompt.trim();
  if (text.length > 0) {
    parts.push(text);
  }

  const references = describeReferences(request.references ?? []);
  if (references.length > 0) {
    parts.push(`<attached-context>\n${references.join("\n")}\n</attached-context>`);
  }

  // An empty prompt with only a slash command still needs SOMETHING actionable.
  return parts.length > 0
    ? parts.join("\n\n")
    : "Describe what you can help with in this workspace.";
}

/**
 * Render the chat request's attached references as plain text lines. A reference
 * `value` is a `Uri`, a `Location`, or arbitrary text depending on what the user
 * attached, so each shape is handled explicitly and anything unrecognized is
 * skipped rather than stringified into noise.
 */
function describeReferences(
  references: readonly { id: string; value: unknown }[],
): string[] {
  const lines: string[] = [];
  for (const reference of references) {
    const value = reference.value;
    if (typeof value === "string") {
      lines.push(value);
      continue;
    }
    if (isUriLike(value)) {
      lines.push(`File: ${value.fsPath}`);
      continue;
    }
    if (isLocationLike(value)) {
      // 0-based positions in the API; report the 1-based lines the user sees.
      const start = value.range.start.line + 1;
      const end = value.range.end.line + 1;
      lines.push(
        `File: ${value.uri.fsPath}${start === end ? `:${start}` : `:${start}-${end}`}`,
      );
    }
  }
  return lines;
}

interface UriLike {
  fsPath: string;
  scheme: string;
}

interface LocationLike {
  uri: UriLike;
  range: { start: { line: number }; end: { line: number } };
}

function isUriLike(value: unknown): value is UriLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UriLike).fsPath === "string" &&
    typeof (value as UriLike).scheme === "string"
  );
}

function isLocationLike(value: unknown): value is LocationLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as LocationLike;
  return (
    isUriLike(candidate.uri) &&
    typeof candidate.range === "object" &&
    candidate.range !== null &&
    typeof candidate.range.start?.line === "number" &&
    typeof candidate.range.end?.line === "number"
  );
}

// ----------------------------------------------------------------------------
// Chat turn — one request/response exchange
// ----------------------------------------------------------------------------

/**
 * One in-flight chat turn. Accumulates the agent's output into the chat response
 * stream and resolves {@link completion} when the agent reports the turn is done.
 */
export class ChatTurn {
  /** Resolves when the agent finishes (or the turn is cancelled). */
  readonly completion: Promise<void>;

  private readonly stream: Pick<vscode.ChatResponseStream, "markdown" | "progress">;
  private finish!: () => void;
  private settled = false;
  /** True once any assistant text has been written to the stream. */
  private streamedAnything = false;
  /** True once the agent has confirmed the turn started (`setGenerating: true`). */
  private started = false;
  /** Id of the assistant item currently streaming, or `null`. */
  private assistantItemId: string | null = null;
  /** Fallback text from the authoritative `addMessage`, used if no deltas came. */
  private authoritativeText = "";

  constructor(
    stream: Pick<vscode.ChatResponseStream, "markdown" | "progress">,
  ) {
    this.stream = stream;
    this.completion = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }

  /**
   * Fold one host → panel message into the chat response. Unknown message types
   * are ignored so the core can evolve independently.
   */
  handle(message: unknown): void {
    if (this.settled) {
      return;
    }
    const type = readString(message, "type");
    switch (type) {
      case "addMessage": {
        const item = readRecord(message, "item");
        // Only assistant items produce chat output; the user's own prompt is
        // already displayed by the chat view.
        if (item && readString(item, "kind") === "assistant") {
          this.assistantItemId = readString(item, "id");
          this.authoritativeText = readString(item, "text") ?? "";
        }
        return;
      }
      case "appendPartial": {
        const itemId = readString(message, "itemId");
        if (this.assistantItemId !== null && itemId !== this.assistantItemId) {
          return;
        }
        const delta = readString(message, "delta");
        if (delta) {
          this.streamedAnything = true;
          this.stream.markdown(delta);
        }
        return;
      }
      case "showToolAction": {
        const item = readRecord(message, "item");
        const toolName = item ? readString(item, "toolName") : null;
        if (toolName) {
          this.stream.progress(`${toolName}…`);
        }
        return;
      }
      case "showError": {
        const text = readString(message, "message");
        if (text) {
          this.stream.markdown(`\n\n> ⚠️ ${text}\n`);
        }
        return;
      }
      case "setGenerating": {
        const generating = readBoolean(message, "generating");
        if (generating === true) {
          // The agent accepted the prompt; a matching `false` will end the turn.
          this.started = true;
          return;
        }
        // The turn is complete once the agent stops generating.
        if (generating === false) {
          this.complete();
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Whether the agent confirmed the turn started. `SessionManager.submitPrompt`
   * returns without emitting anything when the agent could not be started (it
   * surfaces its own actionable error instead), so the handler checks this to
   * avoid awaiting a completion that will never arrive.
   */
  get hasStarted(): boolean {
    return this.started;
  }

  /** Cancelled by the user: stop consuming and let the handler return. */
  cancel(): void {
    if (this.settled) {
      return;
    }
    this.stream.markdown("\n\n_Interrupted._\n");
    this.settle();
  }

  /**
   * The prompt never reached the agent. Explains why in the response and settles,
   * so the chat turn ends instead of spinning forever.
   */
  abort(reason: string): void {
    if (this.settled) {
      return;
    }
    this.stream.markdown(`\n\n**Rayucode could not run this turn.** ${reason}\n`);
    this.settle();
  }

  /** The agent finished the turn. */
  complete(): void {
    if (this.settled) {
      return;
    }
    // Nothing streamed (e.g. the agent replied in one non-streaming block):
    // fall back to the authoritative text so the turn is never silent.
    if (!this.streamedAnything && this.authoritativeText.length > 0) {
      this.stream.markdown(this.authoritativeText);
    }
    this.settle();
  }

  private settle(): void {
    this.settled = true;
    this.finish();
  }
}

// ----------------------------------------------------------------------------
// ChatPanelSink — an AgentPanelHandle that feeds the chat view
// ----------------------------------------------------------------------------

/**
 * A headless {@link AgentPanelHandle}: it satisfies the interface the core drives
 * but renders into the active {@link ChatTurn} instead of a webview. Between turns
 * it simply discards messages, so the session can stay warm (and its history
 * retained) without a visible surface.
 */
export class ChatPanelSink implements AgentPanelHandle {
  readonly sessionKey: string;

  private turn: ChatTurn | null = null;
  private readonly disposeListeners = new Set<() => void>();

  constructor(sessionKey: string) {
    this.sessionKey = sessionKey;
  }

  /** Start a turn bound to `stream`; the previous turn (if any) is completed. */
  beginTurn(
    stream: Pick<vscode.ChatResponseStream, "markdown" | "progress">,
  ): ChatTurn {
    this.turn?.complete();
    const turn = new ChatTurn(stream);
    this.turn = turn;
    return turn;
  }

  /** Detach `turn` if it is still the active one. */
  endTurn(turn: ChatTurn): void {
    if (this.turn === turn) {
      this.turn = null;
    }
  }

  // -- AgentPanelHandle -------------------------------------------------------

  reveal(): void {
    // The chat view owns its own visibility; nothing to reveal.
  }

  postMessage(message: unknown): boolean {
    this.turn?.handle(message);
    return true;
  }

  onDidReceiveMessage(_listener: (message: unknown) => void): Disposable {
    // Strictly one-way: chat input arrives through the participant handler, not
    // as webview messages, so there is nothing to subscribe to.
    return { dispose: () => {} };
  }

  onDidDispose(listener: () => void): Disposable {
    this.disposeListeners.add(listener);
    return {
      dispose: () => {
        this.disposeListeners.delete(listener);
      },
    };
  }

  dispose(): void {
    this.turn?.complete();
    this.turn = null;
    const listeners = [...this.disposeListeners];
    this.disposeListeners.clear();
    for (const listener of listeners) {
      listener();
    }
  }
}

// ----------------------------------------------------------------------------
// Small readers for untyped panel messages
// ----------------------------------------------------------------------------

function readRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "object" && nested !== null
    ? (nested as Record<string, unknown>)
    : null;
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}

function readBoolean(value: unknown, key: string): boolean | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wrap text in a Markdown code span, escaping any backticks it contains. */
function codeSpan(text: string): string {
  return `\`${text.replace(/`/g, "\u2018")}\``;
}
