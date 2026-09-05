import { beforeEach, describe, expect, it } from "vitest";

import {
  CHAT_PARTICIPANT_ID,
  CHAT_SESSION_PREFIX,
  ChatPanelSink,
  ChatTurn,
  buildPrompt,
  registerChatParticipant,
} from "../src/chatParticipant.js";
import { Uri, recorder, resetVscodeStub } from "./stubs/vscode.js";

// The `@rayucode` chat participant.
//
// The participant is a BRIDGE: chat request → SessionManager prompt → agent
// stream → chat response. These tests cover the three seams that carry all the
// risk:
//   • buildPrompt   — slash commands + attached references → one prompt string
//   • ChatTurn      — panel messages → chat stream, with no duplicated text
//   • ChatPanelSink — a headless AgentPanelHandle routed to the active turn
// plus registration behavior (own session key, feature detection).

/** A recording stand-in for `vscode.ChatResponseStream`. */
function makeStream() {
  const markdown: string[] = [];
  const progress: string[] = [];
  return {
    markdown: (value: string | { value: string }) => {
      markdown.push(typeof value === "string" ? value : value.value);
    },
    progress: (value: string) => {
      progress.push(value);
    },
    /** Everything written as markdown, concatenated. */
    get text() {
      return markdown.join("");
    },
    markdownCalls: markdown,
    progressCalls: progress,
  };
}

beforeEach(() => {
  resetVscodeStub();
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe("buildPrompt", () => {
  it("passes a bare prompt through unchanged", () => {
    expect(buildPrompt({ prompt: "hello there" })).toBe("hello there");
  });

  it("prepends an instruction for each contributed slash command", () => {
    for (const command of ["explain", "fix", "review", "test"]) {
      const prompt = buildPrompt({ prompt: "this function", command });
      expect(prompt).not.toBe("this function");
      expect(prompt.endsWith("this function")).toBe(true);
    }
  });

  it("uses a command-specific instruction", () => {
    expect(buildPrompt({ prompt: "x", command: "fix" }).toLowerCase()).toContain(
      "fix",
    );
    expect(
      buildPrompt({ prompt: "x", command: "test" }).toLowerCase(),
    ).toContain("tests");
  });

  it("ignores an unknown slash command rather than inventing an instruction", () => {
    expect(buildPrompt({ prompt: "x", command: "nonsense" })).toBe("x");
  });

  it("renders a Uri reference as a file line inside an attached-context block", () => {
    const prompt = buildPrompt({
      prompt: "what is this",
      references: [{ id: "vscode.file", value: Uri.file("/w/src/a.ts") }],
    });

    expect(prompt).toContain("<attached-context>");
    expect(prompt).toContain("File: /w/src/a.ts");
  });

  it("renders a Location reference with 1-based line numbers", () => {
    const prompt = buildPrompt({
      prompt: "review this",
      references: [
        {
          id: "vscode.selection",
          value: {
            uri: Uri.file("/w/src/a.ts"),
            // 0-based in the API → 1-based for the user-facing prompt.
            range: { start: { line: 9 }, end: { line: 19 } },
          },
        },
      ],
    });

    expect(prompt).toContain("File: /w/src/a.ts:10-20");
  });

  it("collapses a single-line Location reference", () => {
    const prompt = buildPrompt({
      prompt: "p",
      references: [
        {
          id: "r",
          value: {
            uri: Uri.file("/w/a.ts"),
            range: { start: { line: 4 }, end: { line: 4 } },
          },
        },
      ],
    });

    expect(prompt).toContain("File: /w/a.ts:5");
    expect(prompt).not.toContain("5-5");
  });

  it("includes a string reference verbatim", () => {
    const prompt = buildPrompt({
      prompt: "p",
      references: [{ id: "r", value: "some pasted context" }],
    });

    expect(prompt).toContain("some pasted context");
  });

  it("skips unrecognized reference shapes rather than stringifying noise", () => {
    const prompt = buildPrompt({
      prompt: "p",
      references: [{ id: "r", value: { totally: "unknown" } }],
    });

    expect(prompt).toBe("p");
    expect(prompt).not.toContain("attached-context");
  });

  it("still produces an actionable prompt when the text is empty", () => {
    expect(buildPrompt({ prompt: "   " }).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ChatTurn
// ---------------------------------------------------------------------------

describe("ChatTurn streaming", () => {
  it("streams appendPartial deltas into the chat response in order", async () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);

    turn.handle({
      type: "addMessage",
      item: { kind: "assistant", id: "a1", text: "", seq: 1 },
    });
    turn.handle({ type: "appendPartial", itemId: "a1", delta: "Hello" });
    turn.handle({ type: "appendPartial", itemId: "a1", delta: ", world" });
    turn.handle({ type: "setGenerating", generating: false });
    await turn.completion;

    expect(stream.text).toBe("Hello, world");
  });

  it("does NOT duplicate the authoritative text when deltas already streamed", async () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);

    turn.handle({
      type: "addMessage",
      item: { kind: "assistant", id: "a1", text: "", seq: 1 },
    });
    turn.handle({ type: "appendPartial", itemId: "a1", delta: "streamed" });
    // The core upserts the complete block once the assistant message arrives.
    turn.handle({
      type: "addMessage",
      item: { kind: "assistant", id: "a1", text: "streamed", seq: 1 },
    });
    turn.handle({ type: "setGenerating", generating: false });
    await turn.completion;

    expect(stream.text).toBe("streamed");
  });

  it("falls back to the authoritative text when NO deltas arrived", async () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);

    // Non-streaming reply: one complete block, no stream events.
    turn.handle({
      type: "addMessage",
      item: { kind: "assistant", id: "a1", text: "complete answer", seq: 1 },
    });
    turn.handle({ type: "setGenerating", generating: false });
    await turn.completion;

    // The turn must never be silent.
    expect(stream.text).toBe("complete answer");
  });

  it("ignores the user's own prompt item (the chat view already shows it)", async () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);

    turn.handle({
      type: "addMessage",
      item: { kind: "user", id: "u1", text: "my question", seq: 0 },
    });
    turn.handle({ type: "setGenerating", generating: false });
    await turn.completion;

    expect(stream.text).toBe("");
  });

  it("ignores deltas addressed to a different assistant item", async () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);

    turn.handle({
      type: "addMessage",
      item: { kind: "assistant", id: "a1", text: "", seq: 1 },
    });
    turn.handle({ type: "appendPartial", itemId: "OTHER", delta: "leak" });
    turn.handle({ type: "appendPartial", itemId: "a1", delta: "ok" });
    turn.handle({ type: "setGenerating", generating: false });
    await turn.completion;

    expect(stream.text).toBe("ok");
  });

  it("reports tool actions as progress rather than response text", async () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);

    turn.handle({
      type: "showToolAction",
      item: { kind: "tool_action", id: "t1", toolName: "Read", seq: 2 },
    });
    turn.handle({ type: "setGenerating", generating: false });
    await turn.completion;

    expect(stream.progressCalls).toEqual(["Read…"]);
    expect(stream.text).toBe("");
  });

  it("surfaces an error as a quoted warning line", async () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);

    turn.handle({ type: "showError", message: "agent exited unexpectedly" });
    turn.handle({ type: "setGenerating", generating: false });
    await turn.completion;

    expect(stream.text).toContain("agent exited unexpectedly");
    expect(stream.text).toContain(">");
  });

  it("does not complete on the generating:true that STARTS the turn", () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);
    let settled = false;
    void turn.completion.then(() => {
      settled = true;
    });

    turn.handle({ type: "setGenerating", generating: true });

    expect(settled).toBe(false);
  });

  it("resolves and notes the interruption when cancelled", async () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);

    turn.cancel();
    await turn.completion;

    expect(stream.text).toContain("Interrupted");
  });

  it("ignores messages arriving after the turn settled", async () => {
    const stream = makeStream();
    const turn = new ChatTurn(stream);

    turn.handle({ type: "setGenerating", generating: false });
    await turn.completion;
    turn.handle({ type: "appendPartial", itemId: "a1", delta: "late" });

    expect(stream.text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ChatPanelSink
// ---------------------------------------------------------------------------

describe("ChatPanelSink", () => {
  it("routes posted messages to the active turn", async () => {
    const sink = new ChatPanelSink("chat:/w");
    const stream = makeStream();
    const turn = sink.beginTurn(stream);

    sink.postMessage({
      type: "addMessage",
      item: { kind: "assistant", id: "a1", text: "", seq: 1 },
    });
    sink.postMessage({ type: "appendPartial", itemId: "a1", delta: "hi" });
    sink.postMessage({ type: "setGenerating", generating: false });
    await turn.completion;

    expect(stream.text).toBe("hi");
  });

  it("discards messages between turns without throwing", () => {
    const sink = new ChatPanelSink("chat:/w");

    expect(() =>
      sink.postMessage({ type: "appendPartial", itemId: "a", delta: "x" }),
    ).not.toThrow();
    expect(sink.postMessage({ type: "setGenerating", generating: false })).toBe(
      true,
    );
  });

  it("completes the previous turn when a new one begins", async () => {
    const sink = new ChatPanelSink("chat:/w");
    const first = sink.beginTurn(makeStream());
    let firstSettled = false;
    void first.completion.then(() => {
      firstSettled = true;
    });

    sink.beginTurn(makeStream());
    await first.completion;

    expect(firstSettled).toBe(true);
  });

  it("stops routing to a turn that has ended", async () => {
    const sink = new ChatPanelSink("chat:/w");
    const stream = makeStream();
    const turn = sink.beginTurn(stream);

    sink.endTurn(turn);
    sink.postMessage({
      type: "addMessage",
      item: { kind: "assistant", id: "a1", text: "leak", seq: 1 },
    });
    sink.postMessage({ type: "setGenerating", generating: false });

    expect(stream.text).toBe("");
  });

  it("has no inbound channel (chat input arrives through the handler)", () => {
    const sink = new ChatPanelSink("chat:/w");

    const subscription = sink.onDidReceiveMessage(() => {
      throw new Error("must never fire");
    });
    sink.postMessage({ type: "setGenerating", generating: false });

    expect(() => subscription.dispose()).not.toThrow();
  });

  it("notifies dispose listeners exactly once", () => {
    const sink = new ChatPanelSink("chat:/w");
    let calls = 0;
    sink.onDidDispose(() => {
      calls += 1;
    });

    sink.dispose();
    sink.dispose();

    expect(calls).toBe(1);
  });

  it("reveal is a no-op (the chat view owns its own visibility)", () => {
    expect(() => new ChatPanelSink("chat:/w").reveal()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// registerChatParticipant
// ---------------------------------------------------------------------------

describe("registerChatParticipant", () => {
  function makeDeps() {
    const logs: { channel: string; message: string }[] = [];
    const opened: string[] = [];
    const submitted: { key: string; text: string }[] = [];
    const interrupted: string[] = [];
    const closed: string[] = [];
    const resolvers: ((key: string) => unknown)[] = [];

    return {
      logs,
      opened,
      submitted,
      interrupted,
      closed,
      resolvers,
      context: {
        subscriptions: [] as { dispose(): void }[],
        extensionUri: Uri.file("/ext"),
      } as unknown as import("vscode").ExtensionContext,
      sessionManager: {
        openSession: async (key: string) => {
          opened.push(key);
        },
        submitPrompt: async (key: string, text: string) => {
          submitted.push({ key, text });
        },
        interrupt: async (key: string) => {
          interrupted.push(key);
        },
        closeSession: async (key: string) => {
          closed.push(key);
        },
      },
      adapter: {
        registerAgentPanelResolver: (resolver: (key: string) => unknown) => {
          resolvers.push(resolver);
          return { dispose: () => {} };
        },
        log: (channel: "protocol" | "lifecycle" | "error", message: string) => {
          logs.push({ channel, message });
        },
      },
      workspaceSessionKey: () => "/w",
    };
  }

  it("registers the participant declared by the manifest", () => {
    const deps = makeDeps();

    const participant = registerChatParticipant(deps);

    expect(participant).not.toBeNull();
    expect(recorder.createdChatParticipants).toHaveLength(1);
    expect(recorder.createdChatParticipants[0]?.id).toBe(CHAT_PARTICIPANT_ID);
    expect(CHAT_PARTICIPANT_ID).toBe("rayucode.agent");
  });

  it("claims its OWN session key so chat and the panel never interleave", () => {
    const deps = makeDeps();

    registerChatParticipant(deps);

    expect(deps.resolvers).toHaveLength(1);
    const resolve = deps.resolvers[0]!;
    // Declines the panel's key…
    expect(resolve("/w")).toBeNull();
    // …and claims its own.
    expect(resolve(`${CHAT_SESSION_PREFIX}/w`)).not.toBeNull();
  });

  it("returns null (and logs) when the host has no chat API", () => {
    const deps = makeDeps();
    recorder.chatAvailable = false;

    const participant = registerChatParticipant(deps);

    expect(participant).toBeNull();
    expect(
      deps.logs.some((entry) => entry.message.includes("chat API is unavailable")),
    ).toBe(true);
  });

  it("streams an end-to-end turn through the registered handler", async () => {
    const deps = makeDeps();
    registerChatParticipant(deps);
    const handler = recorder.createdChatParticipants[0]?.handler as (
      request: unknown,
      chatContext: unknown,
      stream: unknown,
      token: unknown,
    ) => Promise<unknown>;
    const stream = makeStream();
    const sink = deps.resolvers[0]!(`${CHAT_SESSION_PREFIX}/w`) as {
      postMessage(message: unknown): boolean;
    };
    // The real `submitPrompt` posts `setGenerating: true` synchronously, before
    // it resolves. The stub must do the same, or the handler correctly concludes
    // the turn never started.
    deps.sessionManager.submitPrompt = async (key: string, text: string) => {
      deps.submitted.push({ key, text });
      sink.postMessage({ type: "setGenerating", generating: true });
    };

    // Drive the agent's output once the prompt has been submitted.
    const turnPromise = handler(
      { prompt: "hi", command: undefined, references: [] },
      {},
      stream,
      { onCancellationRequested: () => ({ dispose: () => {} }) },
    );
    await Promise.resolve();
    await Promise.resolve();
    sink.postMessage({
      type: "addMessage",
      item: { kind: "assistant", id: "a1", text: "", seq: 1 },
    });
    sink.postMessage({ type: "appendPartial", itemId: "a1", delta: "pong" });
    sink.postMessage({ type: "setGenerating", generating: false });
    await turnPromise;

    expect(deps.opened).toEqual([`${CHAT_SESSION_PREFIX}/w`]);
    expect(deps.submitted).toEqual([
      { key: `${CHAT_SESSION_PREFIX}/w`, text: "hi" },
    ]);
    expect(stream.text).toBe("pong");
  });

  it("interrupts the agent when the chat turn is cancelled (R3.6)", async () => {
    const deps = makeDeps();
    registerChatParticipant(deps);
    const handler = recorder.createdChatParticipants[0]?.handler as (
      request: unknown,
      chatContext: unknown,
      stream: unknown,
      token: unknown,
    ) => Promise<unknown>;
    const sink = deps.resolvers[0]!(`${CHAT_SESSION_PREFIX}/w`) as {
      postMessage(message: unknown): boolean;
    };
    // Mirror the real submitPrompt: the turn is genuinely in flight, so the
    // handler awaits completion and cancellation is what ends it.
    deps.sessionManager.submitPrompt = async () => {
      sink.postMessage({ type: "setGenerating", generating: true });
    };
    let fireCancel: (() => void) | undefined;

    const turnPromise = handler(
      { prompt: "long task", command: undefined, references: [] },
      {},
      makeStream(),
      {
        onCancellationRequested: (listener: () => void) => {
          fireCancel = listener;
          return { dispose: () => {} };
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    fireCancel?.();
    await turnPromise;

    expect(deps.interrupted).toEqual([`${CHAT_SESSION_PREFIX}/w`]);
  });

  it("reports a session that fails to open instead of hanging", async () => {
    const deps = makeDeps();
    deps.sessionManager.openSession = async () => {
      throw new Error("rayu not found");
    };
    registerChatParticipant(deps);
    const handler = recorder.createdChatParticipants[0]?.handler as (
      request: unknown,
      chatContext: unknown,
      stream: unknown,
      token: unknown,
    ) => Promise<unknown>;
    const stream = makeStream();

    await handler({ prompt: "hi", references: [] }, {}, stream, {
      onCancellationRequested: () => ({ dispose: () => {} }),
    });

    expect(stream.text).toContain("could not start the agent");
    expect(stream.text).toContain("rayu not found");
  });

  it("ends the turn when the prompt never starts, instead of spinning forever", async () => {
    const deps = makeDeps();
    // `SessionManager.submitPrompt` returns silently when the agent could not be
    // started (it surfaces its own actionable notification), so no panel message
    // — and therefore no completion signal — ever arrives.
    deps.sessionManager.submitPrompt = async () => {};
    registerChatParticipant(deps);
    const handler = recorder.createdChatParticipants[0]?.handler as (
      request: unknown,
      chatContext: unknown,
      stream: unknown,
      token: unknown,
    ) => Promise<unknown>;
    const stream = makeStream();

    // The assertion IS that this resolves at all: a hang here would time the
    // test out rather than fail it.
    const result = await handler({ prompt: "hi", references: [] }, {}, stream, {
      onCancellationRequested: () => ({ dispose: () => {} }),
    });

    expect(result).toEqual({});
    expect(stream.text).toContain("could not run this turn");
  });

  it("still awaits completion normally once the agent confirms the turn started", async () => {
    const deps = makeDeps();
    registerChatParticipant(deps);
    const handler = recorder.createdChatParticipants[0]?.handler as (
      request: unknown,
      chatContext: unknown,
      stream: unknown,
      token: unknown,
    ) => Promise<unknown>;
    const sink = deps.resolvers[0]!(`${CHAT_SESSION_PREFIX}/w`) as {
      postMessage(message: unknown): boolean;
    };
    // Emit the start signal as the real submitPrompt does, synchronously.
    deps.sessionManager.submitPrompt = async () => {
      sink.postMessage({ type: "setGenerating", generating: true });
    };
    const stream = makeStream();

    const turnPromise = handler(
      { prompt: "hi", references: [] },
      {},
      stream,
      { onCancellationRequested: () => ({ dispose: () => {} }) },
    );
    await Promise.resolve();
    await Promise.resolve();
    sink.postMessage({
      type: "addMessage",
      item: { kind: "assistant", id: "a1", text: "done", seq: 1 },
    });
    sink.postMessage({ type: "setGenerating", generating: false });
    await turnPromise;

    // Not aborted — the turn ran to completion on the agent's own signal.
    expect(stream.text).not.toContain("could not run this turn");
    expect(stream.text).toBe("done");
  });
});
