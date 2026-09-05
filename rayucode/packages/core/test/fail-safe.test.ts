// The fail-safe sequence (PROTOCOL.md §7).
//
// When a stdout frame cannot be decoded, or the engine's protocol version does
// not match, the session must NOT limp on. All five steps must happen:
//
//   1. log the frame, redacted and truncated, with the schema issue paths
//   2. mark the session failed with a machine-readable reason
//   3. terminate the child
//   4. default-deny every pending permission request
//   5. surface an actionable error in the panel
//
// Ordering matters: step 4 must precede step 3, so no approval prompt can outlive
// the session, and no permission promise is ever left unsettled.
//
// Why this is not "nice to have": the control protocol is request/response
// correlated by `request_id`. Skipping a bad frame can drop the very response the
// UI is awaiting, leaving the panel spinning with no error and no way to recover.
// That was the live behaviour before this change (rayucode/TRIAGE.md D4, D7).

import { describe, expect, it, vi } from "vitest";

import {
  PROTOCOL_VERSION,
  SessionManager,
  type AgentExitInfo,
  type AgentProcessLike,
  type DecodeFailure,
  type EngineResolution,
  type PanelOutboundMessage,
  type StdinMessage,
  type StdoutMessage,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A fake agent process that lets a test drive stdout and protocol failures. */
class FakeProcess implements AgentProcessLike {
  readonly pid = 4242;
  readonly writes: StdinMessage[] = [];
  terminated = false;
  /** Order in which lifecycle events happened, for ordering assertions. */
  readonly trace: string[];

  private stdoutListeners: ((m: StdoutMessage) => void)[] = [];
  private exitListeners: ((i: AgentExitInfo) => void)[] = [];
  private failureListeners: ((f: DecodeFailure) => void)[] = [];

  constructor(trace: string[]) {
    this.trace = trace;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }
  writeLine(message: StdinMessage): void {
    this.writes.push(message);
  }
  onStdoutMessage(cb: (m: StdoutMessage) => void): void {
    this.stdoutListeners.push(cb);
  }
  onExit(cb: (i: AgentExitInfo) => void): void {
    this.exitListeners.push(cb);
  }
  onProtocolFailure(cb: (f: DecodeFailure) => void): void {
    this.failureListeners.push(cb);
  }
  terminate(): Promise<void> {
    this.terminated = true;
    this.trace.push("terminate");
    return Promise.resolve();
  }

  /** Drive a decoded message into the manager. */
  emit(message: StdoutMessage): void {
    for (const cb of [...this.stdoutListeners]) cb(message);
  }
  /** Drive a session-fatal decode failure into the manager. */
  fail(failure: DecodeFailure): void {
    for (const cb of [...this.failureListeners]) cb(failure);
  }
}

interface Harness {
  manager: SessionManager;
  process: FakeProcess;
  posted: PanelOutboundMessage[];
  trace: string[];
  logs: { channel: string; message: string }[];
}

const WORKSPACE = "/workspace";

function makeHarness(): Harness {
  const trace: string[] = [];
  const posted: PanelOutboundMessage[] = [];
  const logs: { channel: string; message: string }[] = [];
  const process = new FakeProcess(trace);

  const panel = {
    sessionKey: WORKSPACE,
    reveal: () => {},
    postMessage: (message: unknown) => {
      posted.push(message as PanelOutboundMessage);
      return true;
    },
    onDidReceiveMessage: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
    dispose: () => {},
  };

  const adapter = {
    log: (channel: string, message: string) => {
      logs.push({ channel, message });
    },
    getWorkspaceContext: () =>
      Promise.resolve({ workspaceRoot: WORKSPACE, activeFile: null, selection: null }),
    getSetting: <T,>(_key: string, fallback: T): T => fallback,
    showAgentPanel: () => panel,
    showActionableMessage: () => Promise.resolve(undefined),
    applyEdits: () => Promise.resolve({ applied: [], conflicts: [], failures: [] }),
    readFileSnapshot: () => Promise.resolve(null),
    isIgnored: () => Promise.resolve(false),
    getSecret: () => Promise.resolve(undefined),
    setSecret: () => Promise.resolve(),
  } as unknown as ConstructorParameters<typeof SessionManager>[0]["adapter"];

  const resolution: EngineResolution = {
    enginePath: "/ext/dist/rayu.js",
    buildInfo: {
      engineVersion: "1.6.13",
      engineFile: "rayu.js",
      engineSha256: "a".repeat(64),
      protocolVersion: PROTOCOL_VERSION,
      gitCommit: "b".repeat(40),
      extensionVersion: "0.2.0",
      builtAt: "2026-01-01T00:00:00.000Z",
    },
  };

  const manager = new SessionManager({
    adapter,
    engineResolver: { resolve: () => resolution },
    agentProcessFactory: () => process,
    timers: {
      setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => {},
    },
  });

  return { manager, process, posted, trace, logs };
}

/**
 * Wait until the fail-safe has fully completed.
 *
 * The terminal error is posted AFTER the awaited teardown, so waiting only for
 * `terminated` returns while the sequence is still mid-flight.
 */
async function waitForFailSafe(h: Harness): Promise<string> {
  await vi.waitFor(() => {
    expect(h.process.terminated).toBe(true);
    expect(h.posted.some((m) => m.type === "showError")).toBe(true);
  });
  return h.posted
    .filter((m) => m.type === "showError")
    .map((m) => (m as { message: string }).message)
    .join(" ");
}

/** A valid `system/init` frame, so a session can reach a normal state first. */
function systemInit(overrides: Record<string, unknown> = {}): StdoutMessage {
  return {
    type: "system",
    subtype: "init",
    protocolVersion: PROTOCOL_VERSION,
    apiKeySource: "none",
    claude_code_version: "1.6.13",
    cwd: WORKSPACE,
    tools: ["Bash"],
    mcp_servers: [],
    model: "test-model",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "s-1",
    ...overrides,
  } as unknown as StdoutMessage;
}

// ---------------------------------------------------------------------------
// Decode failure
// ---------------------------------------------------------------------------

describe("fail-safe on a protocol decode failure", () => {
  it("terminates the child and surfaces an actionable error", async () => {
    const h = makeHarness();
    await h.manager.openSession(WORKSPACE);
    h.process.emit(systemInit());

    h.process.fail({ kind: "json", frame: "not json" });
    const text = await waitForFailSafe(h);

    // Step 5: a terminal, actionable error in the panel — not a transient toast
    // the user can miss while the panel merely looks idle.
    expect(text).toMatch(/not valid JSON/i);
    expect(text).toMatch(/new session/i);
  });

  it("stops the generating indicator so the panel does not spin forever", async () => {
    const h = makeHarness();
    await h.manager.openSession(WORKSPACE);
    h.process.emit(systemInit());

    h.process.fail({ kind: "schema", frame: "{}", issues: [] });
    await vi.waitFor(() => {
      expect(h.process.terminated).toBe(true);
    });

    // The precise symptom the fail-safe exists to prevent.
    const lastGenerating = [...h.posted]
      .reverse()
      .find((m) => m.type === "setGenerating");
    expect(lastGenerating).toBeDefined();
    expect((lastGenerating as { generating: boolean }).generating).toBe(false);
  });

  it("runs the sequence exactly once even if the failure is reported again", async () => {
    const h = makeHarness();
    await h.manager.openSession(WORKSPACE);
    h.process.emit(systemInit());

    h.process.fail({ kind: "json", frame: "bad" });
    h.process.fail({ kind: "json", frame: "bad again" });
    await vi.waitFor(() => {
      expect(h.process.terminated).toBe(true);
    });

    // Latched: one teardown, not two.
    expect(h.trace.filter((t) => t === "terminate")).toHaveLength(1);
  });

  it("distinguishes a JSON failure from a schema failure in the message", async () => {
    const jsonCase = makeHarness();
    await jsonCase.manager.openSession(WORKSPACE);
    jsonCase.process.emit(systemInit());
    jsonCase.process.fail({ kind: "json", frame: "x" });
    const jsonText = await waitForFailSafe(jsonCase);

    const schemaCase = makeHarness();
    await schemaCase.manager.openSession(WORKSPACE);
    schemaCase.process.emit(systemInit());
    schemaCase.process.fail({ kind: "schema", frame: "{}", issues: [] });
    const schemaText = await waitForFailSafe(schemaCase);

    expect(jsonText).toMatch(/not valid JSON/i);
    expect(schemaText).toMatch(/does not match the expected protocol/i);
  });
});

// ---------------------------------------------------------------------------
// Protocol version mismatch
// ---------------------------------------------------------------------------

describe("fail-safe on a protocol version mismatch", () => {
  it("refuses an engine reporting a different version", async () => {
    const h = makeHarness();
    await h.manager.openSession(WORKSPACE);

    h.process.emit(systemInit({ protocolVersion: PROTOCOL_VERSION + 1 }));
    const text = await waitForFailSafe(h);

    expect(text).toMatch(/not compatible/i);
    expect(text).toMatch(/reinstall/i);
  });

  it("refuses an engine that omits protocolVersion entirely", async () => {
    // Treated as the legacy version rather than given the benefit of the doubt:
    // a pre-contract engine is exactly the case where silent drift produced the
    // original bug class (PROTOCOL.md §4).
    const h = makeHarness();
    await h.manager.openSession(WORKSPACE);

    const init = systemInit() as unknown as Record<string, unknown>;
    delete init["protocolVersion"];
    h.process.emit(init as unknown as StdoutMessage);
    const text = await waitForFailSafe(h);

    expect(text).toMatch(/did not report a protocol version/i);
  });

  it("does NOT apply model or permission mode from an incompatible frame", async () => {
    // Applying state from a frame whose meaning we do not trust is precisely the
    // mistake the version check exists to prevent.
    const h = makeHarness();
    await h.manager.openSession(WORKSPACE);

    h.process.emit(
      systemInit({
        protocolVersion: PROTOCOL_VERSION + 1,
        model: "should-not-be-applied",
      }),
    );
    await vi.waitFor(() => {
      expect(h.process.terminated).toBe(true);
    });

    const applied = h.posted.filter((m) => m.type === "setModelInfo");
    expect(applied).toHaveLength(0);
  });

  it("accepts the matching version and applies the session state", async () => {
    const h = makeHarness();
    await h.manager.openSession(WORKSPACE);

    h.process.emit(systemInit());

    const applied = h.posted.find((m) => m.type === "setModelInfo");
    expect(applied).toBeDefined();
    expect((applied as { model: string }).model).toBe("test-model");
    expect(h.process.terminated).toBe(false);
  });
});
