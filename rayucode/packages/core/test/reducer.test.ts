import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  appendUserPrompt,
  ConversationReducer,
  createConversationState,
  reduceConversation,
} from "../src/index.js";
import type {
  AssistantConversationItem,
  AssistantError,
  PermissionMode,
  StdoutMessage,
  UsageConversationItem,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Message builders — minimal well-formed inbound envelopes. The reducer derives
// item ids from the receive-sequence (not `uuid`), so a constant uuid is fine.
// ---------------------------------------------------------------------------

const SESSION = "s-1";

function mkInit(model: string, mode: PermissionMode): StdoutMessage {
  return {
    type: "system",
    subtype: "init",
    model,
    permissionMode: mode,
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    apiKeySource: "user",
    cwd: "/workspace",
    claude_code_version: "1.0.0",
    uuid: "u-init",
    session_id: SESSION,
  };
}

function mkMessageStart(): StdoutMessage {
  return {
    type: "stream_event",
    event: { type: "message_start", message: { role: "assistant", content: [] } },
    parent_tool_use_id: null,
    uuid: "u-s",
    session_id: SESSION,
  };
}

function mkTextDelta(text: string): StdoutMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    parent_tool_use_id: null,
    uuid: "u-s",
    session_id: SESSION,
  };
}

function mkThinkingDelta(thinking: string): StdoutMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking },
    },
    parent_tool_use_id: null,
    uuid: "u-s",
    session_id: SESSION,
  };
}

function mkAssistant(text: string, error?: AssistantError): StdoutMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: text.length > 0 ? [{ type: "text", text }] : [],
    },
    parent_tool_use_id: null,
    ...(error ? { error } : {}),
    uuid: "u-a",
    session_id: SESSION,
  };
}

function mkResult(
  overrides: Partial<{
    cost: number;
    inputTokens: number;
    outputTokens: number;
    modelUsage: Record<string, never>;
    sessionId: string;
  }> = {},
): StdoutMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    total_cost_usd: overrides.cost ?? 0,
    usage: {
      input_tokens: overrides.inputTokens ?? 1,
      output_tokens: overrides.outputTokens ?? 1,
    },
    modelUsage: overrides.modelUsage ?? {},
    permission_denials: [],
    uuid: "u-r",
    session_id: overrides.sessionId ?? SESSION,
  };
}

/** A small "rich" text arbitrary that exercises newlines, unicode, and emoji. */
const richText = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 3 }),
      fc.constantFrom("\n", "\t", '"', "\\", "é", "中", "😀", " "),
    ),
    { maxLength: 6 },
  )
  .map((parts) => parts.join(""));

const permissionMode = fc.constantFrom<PermissionMode>(
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
);

// ---------------------------------------------------------------------------
// Property 4 — message ordering preservation (task 4.2)
// ---------------------------------------------------------------------------

// A "turn" bundles the inbound messages that comprise it together with the
// conversation-item kinds it is expected to render, in order. The expected
// kinds are computed from the turn's *shape* (independently of the reducer's
// internals), so comparing them to the produced history is a genuine ordering
// check rather than a restatement of the implementation.
interface Turn {
  messages: StdoutMessage[];
  itemKinds: string[];
}

// A streaming turn: message_start, zero-or-more text deltas, then the terminal
// result. Always yields exactly an assistant item followed by a usage item.
const streamingTurn: fc.Arbitrary<Turn> = fc
  .array(richText, { maxLength: 5 })
  .map((deltas) => ({
    messages: [mkMessageStart(), ...deltas.map(mkTextDelta), mkResult()],
    itemKinds: ["assistant", "usage"],
  }));

// A non-streaming turn: a complete assistant block then the terminal result.
const completeTurn: fc.Arbitrary<Turn> = richText.map((text) => ({
  messages: [mkAssistant(text), mkResult()],
  itemKinds: ["assistant", "usage"],
}));

// A bare result with no preceding assistant content: yields only a usage item.
const bareResultTurn: fc.Arbitrary<Turn> = fc.constant({
  messages: [mkResult()],
  itemKinds: ["usage"],
});

// A system/init announcement: updates model/mode but renders no item.
const initTurn: fc.Arbitrary<Turn> = fc
  .record({ model: fc.string({ minLength: 1, maxLength: 8 }), mode: permissionMode })
  .map(({ model, mode }) => ({ messages: [mkInit(model, mode)], itemKinds: [] }));

const anyTurn = fc.oneof(streamingTurn, completeTurn, bareResultTurn, initTurn);

describe("ConversationReducer message ordering", () => {
  it("renders items in the same relative order in which messages were received", () => {
    // Feature: rayucode, Property 4: For any sequence of inbound protocol messages, the conversation reducer renders items in the same relative order in which the messages were received from the stream.
    // Validates: Requirements 3.4
    fc.assert(
      fc.property(fc.array(anyTurn, { maxLength: 12 }), (turns) => {
        const messages = turns.flatMap((t) => t.messages);
        const expectedKinds = turns.flatMap((t) => t.itemKinds);

        let state = createConversationState();
        for (const message of messages) {
          state = reduceConversation(state, message);
        }

        // Items appear in exactly the order their generating messages arrived.
        expect(state.history.map((item) => item.kind)).toEqual(expectedKinds);

        // Receive-sequence numbers are strictly increasing across the rendered
        // history — i.e. nothing is reordered relative to the receive stream.
        const seqs = state.history.map((item) => item.seq);
        for (let i = 1; i < seqs.length; i += 1) {
          expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5 — streaming assembly equals final message (task 4.3)
// ---------------------------------------------------------------------------

// One streamed event: either a text delta (contributes to the body) or a
// thinking delta (must NOT contribute to the rendered assistant text).
const streamPiece = fc.oneof(
  richText.map((s) => ({ kind: "text" as const, s })),
  richText.map((s) => ({ kind: "thinking" as const, s })),
);

describe("ConversationReducer streaming assembly", () => {
  it("assembles deltas into the final content and completes exactly at the result", () => {
    // Feature: rayucode, Property 5: For any assistant turn expressed as a sequence of `stream_event` deltas followed by a terminal `result`, the text assembled by appending the deltas equals the final assembled content, and the in-progress item is marked complete exactly when the `result` is processed.
    // Validates: Requirements 4.1, 4.2
    fc.assert(
      fc.property(fc.array(streamPiece, { maxLength: 30 }), (pieces) => {
        const expectedText = pieces
          .filter((p) => p.kind === "text")
          .map((p) => p.s)
          .join("");

        let state = createConversationState();
        state = reduceConversation(state, mkMessageStart());

        for (const piece of pieces) {
          state = reduceConversation(
            state,
            piece.kind === "text"
              ? mkTextDelta(piece.s)
              : mkThinkingDelta(piece.s),
          );

          // While streaming: exactly one assistant item, still in progress, and
          // no usage item has been surfaced yet (completion is bound to result).
          const assistants = state.history.filter(
            (i): i is AssistantConversationItem => i.kind === "assistant",
          );
          expect(assistants).toHaveLength(1);
          expect(assistants[0]!.streaming).toBe(true);
          expect(state.history.some((i) => i.kind === "usage")).toBe(false);
        }

        // The text assembled from the deltas equals the content before result…
        const beforeResult = state.history.find(
          (i): i is AssistantConversationItem => i.kind === "assistant",
        )!;
        expect(beforeResult.text).toBe(expectedText);
        expect(beforeResult.streaming).toBe(true);

        // …and the in-progress item is marked complete exactly when the result
        // is processed, with the assembled content unchanged (R4.2).
        state = reduceConversation(state, mkResult());
        const afterResult = state.history.find(
          (i): i is AssistantConversationItem => i.kind === "assistant",
        )!;
        expect(afterResult.streaming).toBe(false);
        expect(afterResult.text).toBe(expectedText);
        expect(
          state.history.filter((i) => i.kind === "usage"),
        ).toHaveLength(1);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example/unit tests — concrete behaviors and edge cases
// ---------------------------------------------------------------------------

describe("ConversationReducer examples", () => {
  it("adopts model, permission mode, and resumable session id from system/init", () => {
    let state = createConversationState();
    state = reduceConversation(state, mkInit("rayu-default", "acceptEdits"));
    expect(state.model).toBe("rayu-default");
    expect(state.permissionMode).toBe("acceptEdits");
    expect(state.resumableSessionId).toBe(SESSION);
    expect(state.history).toEqual([]);
  });

  it("creates an in-progress assistant item from the first text delta without a message_start", () => {
    let state = createConversationState();
    state = reduceConversation(state, mkTextDelta("hel"));
    state = reduceConversation(state, mkTextDelta("lo"));
    expect(state.history).toHaveLength(1);
    const item = state.history[0] as AssistantConversationItem;
    expect(item.kind).toBe("assistant");
    expect(item.text).toBe("hello");
    expect(item.streaming).toBe(true);
  });

  it("surfaces a complete assistant message and marks it complete on result", () => {
    let state = createConversationState();
    state = reduceConversation(state, mkAssistant("done"));
    let item = state.history[0] as AssistantConversationItem;
    expect(item.text).toBe("done");
    expect(item.streaming).toBe(true);

    state = reduceConversation(state, mkResult({ cost: 0.5 }));
    item = state.history.find(
      (i): i is AssistantConversationItem => i.kind === "assistant",
    )!;
    expect(item.streaming).toBe(false);
  });

  it("treats a complete assistant block as authoritative over streamed text", () => {
    let state = createConversationState();
    state = reduceConversation(state, mkTextDelta("strea"));
    state = reduceConversation(state, mkTextDelta("med"));
    // The complete block arrives with the canonical content (R3.3).
    state = reduceConversation(state, mkAssistant("streamed final"));
    const item = state.history.find(
      (i): i is AssistantConversationItem => i.kind === "assistant",
    )!;
    expect(item.text).toBe("streamed final");
    expect(item.streaming).toBe(true);
    // Still a single assistant item — the block updates the in-progress one.
    expect(state.history.filter((i) => i.kind === "assistant")).toHaveLength(1);
  });

  it("carries the assistant error field for auth-failure surfacing (R8.3)", () => {
    let state = createConversationState();
    state = reduceConversation(state, mkAssistant("", "authentication_failed"));
    const item = state.history[0] as AssistantConversationItem;
    expect(item.error).toBe("authentication_failed");
  });

  it("surfaces usage, cost, and per-model usage on result (R4.4)", () => {
    let state = createConversationState();
    state = reduceConversation(state, mkAssistant("hi"));
    state = reduceConversation(
      state,
      mkResult({ cost: 1.25, inputTokens: 100, outputTokens: 200 }),
    );
    const usage = state.history.find(
      (i): i is UsageConversationItem => i.kind === "usage",
    )!;
    expect(usage.totalCostUsd).toBe(1.25);
    expect(usage.usage).toEqual({ input_tokens: 100, output_tokens: 200 });
    expect(usage.modelUsage).toEqual({});
  });

  it("keeps independent turns ordered and self-contained", () => {
    let state = createConversationState();
    state = appendUserPrompt(state, "first question");
    state = reduceConversation(state, mkTextDelta("answer one"));
    state = reduceConversation(state, mkResult());
    state = appendUserPrompt(state, "second question");
    state = reduceConversation(state, mkAssistant("answer two"));
    state = reduceConversation(state, mkResult());

    expect(state.history.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
      "usage",
      "user",
      "assistant",
      "usage",
    ]);
    const seqs = state.history.map((i) => i.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it("ignores keep_alive and control envelopes without producing items", () => {
    let state = createConversationState();
    state = reduceConversation(state, { type: "keep_alive" });
    state = reduceConversation(state, {
      type: "control_response",
      response: { subtype: "success", request_id: "r-1" },
    });
    expect(state.history).toEqual([]);
    // The receive-sequence still advanced for both messages.
    expect(state.nextSeq).toBe(2);
  });

  it("drives the same behavior through the stateful ConversationReducer wrapper", () => {
    const reducer = new ConversationReducer();
    reducer.submitUserPrompt("hi");
    reducer.accept(mkTextDelta("hel"));
    reducer.accept(mkTextDelta("lo"));
    reducer.accept(mkResult());

    expect(reducer.history.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
      "usage",
    ]);
    const assistant = reducer.history.find(
      (i): i is AssistantConversationItem => i.kind === "assistant",
    )!;
    expect(assistant.text).toBe("hello");
    expect(assistant.streaming).toBe(false);
  });
});
