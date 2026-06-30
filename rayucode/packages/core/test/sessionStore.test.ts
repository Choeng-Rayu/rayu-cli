import { describe, expect, it } from "vitest";

import { SessionStore } from "../src/index.js";
import type { PermissionMode, StdoutMessage } from "../src/index.js";

// ---------------------------------------------------------------------------
// Minimal inbound-message builders. The store records the latest `session_id`
// seen on any message as the resumable identifier (R12.5), so each builder
// takes the session id it should carry.
// ---------------------------------------------------------------------------

function mkInit(sessionId: string, mode: PermissionMode = "default"): StdoutMessage {
  return {
    type: "system",
    subtype: "init",
    model: "rayu-default",
    permissionMode: mode,
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    apiKeySource: "user",
    cwd: "/workspace",
    claude_code_version: "1.0.0",
    uuid: "u-init",
    session_id: sessionId,
  };
}

function mkAssistant(text: string, sessionId: string): StdoutMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: text.length > 0 ? [{ type: "text", text }] : [],
    },
    parent_tool_use_id: null,
    uuid: "u-a",
    session_id: sessionId,
  };
}

function mkResult(sessionId: string): StdoutMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    uuid: "u-r",
    session_id: sessionId,
  };
}

const SESSION = "s-1";

// ---------------------------------------------------------------------------
// History retention across panel close/reopen (R12.1, R12.2)
// ---------------------------------------------------------------------------

describe("SessionStore history retention", () => {
  it("retains the ordered history across a simulated panel close/reopen", () => {
    const store = new SessionStore();
    const entry = store.getOrCreate("ws-1");

    // A turn happens while the panel is open.
    entry.submitUserPrompt("hello");
    entry.accept(mkAssistant("hi there", SESSION));
    entry.accept(mkResult(SESSION));

    const expectedKinds = ["user", "assistant", "usage"];
    expect(entry.history.map((i) => i.kind)).toEqual(expectedKinds);

    // The panel closes. The store lives in the host, untouched by panel
    // lifecycle, so the history is still there when the panel reopens and asks
    // for it (R12.2).
    expect(store.restoreHistory("ws-1").map((i) => i.kind)).toEqual(expectedKinds);
    // ...and the retained history itself is unchanged (R12.1).
    expect(store.getHistory("ws-1").map((i) => i.kind)).toEqual(expectedKinds);

    // getOrCreate is idempotent: reopening returns the SAME accumulating entry.
    expect(store.getOrCreate("ws-1")).toBe(entry);
  });

  it("returns a detached snapshot that later reductions do not mutate", () => {
    const store = new SessionStore();
    store.submitUserPrompt("ws-1", "first");

    // Snapshot taken at reopen #1.
    const firstReopen = store.restoreHistory("ws-1");
    expect(firstReopen.map((i) => i.kind)).toEqual(["user"]);

    // More activity happens after the snapshot was taken.
    store.accept("ws-1", mkAssistant("answer", SESSION));
    store.accept("ws-1", mkResult(SESSION));

    // The earlier snapshot is a point-in-time deep copy and is unaffected...
    expect(firstReopen.map((i) => i.kind)).toEqual(["user"]);
    // ...while a fresh snapshot reflects the newer state (retention, R12.1).
    expect(store.restoreHistory("ws-1").map((i) => i.kind)).toEqual([
      "user",
      "assistant",
      "usage",
    ]);
  });

  it("restores an empty history for a key that has no entry", () => {
    const store = new SessionStore();
    expect(store.restoreHistory("never-opened")).toEqual([]);
    expect(store.getHistory("never-opened")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// New-session independence (R12.4)
// ---------------------------------------------------------------------------

describe("SessionStore new-session independence", () => {
  it("allocates a fresh, independent history without mutating the prior session", () => {
    const store = new SessionStore();

    const prior = store.getOrCreate("ws-1");
    prior.submitUserPrompt("old prompt");
    prior.accept(mkAssistant("old answer", "old-session"));
    prior.accept(mkResult("old-session"));
    expect(prior.history).toHaveLength(3);

    // Starting a new session yields an empty, independent history (R12.4).
    const fresh = store.startNewSession("ws-1");
    expect(fresh).not.toBe(prior);
    expect(fresh.history).toEqual([]);
    expect(fresh.resumableSessionId).toBeNull();

    // The store now resolves the key to the fresh session.
    expect(store.getOrCreate("ws-1")).toBe(fresh);
    expect(store.getHistory("ws-1")).toEqual([]);

    // Reducing into the new session does NOT mutate the prior one.
    fresh.submitUserPrompt("new prompt");
    fresh.accept(mkResult("new-session"));
    expect(prior.history.map((i) => i.kind)).toEqual(["user", "assistant", "usage"]);
    expect(prior.resumableSessionId).toBe("old-session");
  });

  it("keeps histories independent across different keys", () => {
    const store = new SessionStore();
    store.submitUserPrompt("ws-a", "a");
    store.submitUserPrompt("ws-b", "b1");
    store.submitUserPrompt("ws-b", "b2");

    expect(store.getHistory("ws-a")).toHaveLength(1);
    expect(store.getHistory("ws-b")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Resumable session-id capture (R12.5)
// ---------------------------------------------------------------------------

describe("SessionStore resumable session id", () => {
  it("records and exposes the latest session_id seen on any message", () => {
    const store = new SessionStore();
    const entry = store.getOrCreate("ws-1");
    expect(entry.resumableSessionId).toBeNull();

    entry.accept(mkInit("session-A"));
    expect(entry.resumableSessionId).toBe("session-A");
    expect(store.getResumableSessionId("ws-1")).toBe("session-A");

    // A later message carrying a new session id overrides the recorded value.
    entry.accept(mkResult("session-B"));
    expect(entry.resumableSessionId).toBe("session-B");
    expect(store.getResumableSessionId("ws-1")).toBe("session-B");
  });

  it("reports a null resumable id for a key with no entry", () => {
    const store = new SessionStore();
    expect(store.getResumableSessionId("ws-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty-on-failure restore (R12.3)
// ---------------------------------------------------------------------------

describe("SessionStore restore failure handling", () => {
  it("returns an empty history when snapshot reconstruction throws", () => {
    // Deterministically force the failure by injecting a snapshot builder that
    // throws, rather than relying on randomness.
    const store = new SessionStore({
      snapshotBuilder: () => {
        throw new Error("snapshot reconstruction failed");
      },
    });

    const entry = store.getOrCreate("ws-1");
    entry.submitUserPrompt("hello");
    entry.accept(mkResult(SESSION));

    // The history IS retained (non-empty)...
    expect(store.getHistory("ws-1")).toHaveLength(2);
    // ...but restore swallows the reconstruction error and opens empty (R12.3).
    expect(store.restoreHistory("ws-1")).toEqual([]);
  });
});
