import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentProcess,
  AGENT_STREAMING_ARGS,
  NdjsonCodec,
} from "../src/index.js";
import type {
  AgentExitInfo,
  AgentProcessOptions,
  AgentSpawnOptions,
  ChildProcessLike,
  ChildReadableLike,
  ChildStdinLike,
  EditorAdapter,
  SpawnFn,
  StdinMessage,
  StdoutMessage,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fakes — an EventEmitter-style ChildProcessLike with NO real subprocess, so
// the lifecycle is exercised deterministically (9.4). Both the fakes below and
// Node's ChildProcess satisfy the ChildProcessLike contract.
// ---------------------------------------------------------------------------

/** Captures every NDJSON record written to the child's stdin. */
class FakeStdin implements ChildStdinLike {
  readonly writes: string[] = [];
  ended = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

/** A minimal readable EventEmitter the test drives via {@link emitData}/{@link emitEnd}. */
class FakeReadable implements ChildReadableLike {
  encoding: string | null = null;
  private readonly dataListeners: ((chunk: string | Buffer) => void)[] = [];
  private readonly endListeners: (() => void)[] = [];

  setEncoding(encoding: string): this {
    this.encoding = encoding;
    return this;
  }

  on(event: "data" | "end", listener: (...args: never[]) => void): this {
    if (event === "data") {
      this.dataListeners.push(listener as (chunk: string | Buffer) => void);
    } else {
      this.endListeners.push(listener as () => void);
    }
    return this;
  }

  emitData(chunk: string): void {
    for (const listener of [...this.dataListeners]) {
      listener(chunk);
    }
  }

  emitEnd(): void {
    for (const listener of [...this.endListeners]) {
      listener();
    }
  }
}

/** An EventEmitter-style fake child satisfying {@link ChildProcessLike}. */
class FakeChild implements ChildProcessLike {
  readonly pid: number | undefined;
  readonly stdin = new FakeStdin();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  /** Every signal passed to {@link kill}, in order (SIGTERM → SIGKILL etc.). */
  readonly killSignals: (NodeJS.Signals | number)[] = [];

  private readonly exitListeners: ((
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];

  constructor(pid: number | undefined = 4242) {
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal ?? "SIGTERM");
    return true;
  }

  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit" | "error", listener: (...args: never[]) => void): this {
    if (event === "exit") {
      this.exitListeners.push(
        listener as unknown as (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => void,
      );
    } else {
      this.errorListeners.push(listener as unknown as (error: Error) => void);
    }
    return this;
  }

  /** Fire the child's `exit` event. */
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of [...this.exitListeners]) {
      listener(code, signal);
    }
  }

  /** Fire the child's `error` event (e.g. spawn ENOENT). */
  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) {
      listener(error);
    }
  }
}

interface LogEntry {
  channel: "protocol" | "lifecycle" | "error";
  message: string;
}

interface FakeAdapter extends Pick<EditorAdapter, "log"> {
  logs: LogEntry[];
}

function makeAdapter(): FakeAdapter {
  const logs: LogEntry[] = [];
  return {
    logs,
    log: (channel, message) => {
      logs.push({ channel, message });
    },
  };
}

interface SpawnCall {
  command: string;
  args: string[];
  options: AgentSpawnOptions;
}

interface Harness {
  proc: AgentProcess;
  child: FakeChild;
  adapter: FakeAdapter;
  calls: SpawnCall[];
}

const CLI_PATH = "/opt/rayu/bin/rayu";
const WORKSPACE_ROOT = "/home/dev/project";

/** Build an AgentProcess wired to a fresh fake child + capturing spawn/adapter. */
function makeHarness(
  overrides: Partial<AgentProcessOptions> = {},
  child: FakeChild = new FakeChild(),
): Harness {
  const adapter = makeAdapter();
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  const proc = new AgentProcess({
    enginePath: CLI_PATH,
    cwd: WORKSPACE_ROOT,
    adapter,
    spawn,
    ...overrides,
  });
  return { proc, child, adapter, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Spawn flags / cwd / env, config dir not overridden (R2.2, R2.3, R8.1, R11.1)
// ---------------------------------------------------------------------------

describe("AgentProcess spawn contract", () => {
  it("spawns with the mandatory streaming flags, the session cwd, and the given env (R2.2, R2.3)", async () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/dev",
      PATH: "/usr/local/bin:/usr/bin",
      RAYU_ACCOUNT: "default",
    };
    const { proc, calls } = makeHarness({ env });

    await proc.start();

    expect(calls).toHaveLength(1);

    // The COMMAND is the Node runtime hosting the extension, not the engine.
    // Running the bundled engine with `process.execPath` means nothing has to be
    // installed on the user's machine and there is no PATH lookup, so the
    // extension cannot end up executing a different build than the one shipped
    // in the VSIX. The engine is argv[1].
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args[0]).toBe(CLI_PATH);
    expect(calls[0]!.args.slice(1)).toEqual([
      "--print",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--verbose",
    ]);
    expect(calls[0]!.args).toEqual([CLI_PATH, ...AGENT_STREAMING_ARGS]);
    expect(calls[0]!.options.cwd).toBe(WORKSPACE_ROOT);
  });

  it("passes the inherited env through UNCHANGED and never overrides the config dir (R8.1, R8.2, R11.1, R11.3)", async () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/dev",
      PATH: "/usr/bin",
    };
    const { proc, calls } = makeHarness({ env });

    await proc.start();

    // Same object reference, same key set: AgentProcess neither clones-and-
    // mutates the env nor injects any config-dir override of its own.
    expect(calls[0]!.options.env).toBe(env);
    expect(Object.keys(calls[0]!.options.env ?? {})).toEqual(Object.keys(env));
  });

  it("defaults the child env to the inherited process.env when none is supplied (R8.1)", async () => {
    const { proc, calls } = makeHarness();

    await proc.start();

    expect(calls[0]!.options.env).toBe(process.env);
  });

  it("exposes the child pid and rejects a second start()", async () => {
    const { proc } = makeHarness();
    await proc.start();
    expect(proc.pid).toBe(4242);
    await expect(proc.start()).rejects.toThrow(/twice/);
  });
});

// ---------------------------------------------------------------------------
// stdout NDJSON decoded and surfaced (R4.1)
// ---------------------------------------------------------------------------

describe("AgentProcess stdout decoding", () => {
  it("decodes NDJSON from stdout and surfaces each message in order, across chunk boundaries (R4.1)", async () => {
    const { proc, child } = makeHarness();
    const received: StdoutMessage[] = [];
    proc.onStdoutMessage((message) => received.push(message));

    await proc.start();

    const m1: StdoutMessage = { type: "keep_alive" };
    // A COMPLETE result frame. The previous version of this test omitted
    // duration_ms, duration_api_ms and stop_reason, which the engine always
    // emits and the schema requires. It passed only because nothing validated
    // (rayucode/TRIAGE.md D3, D6) — now the decoder does, so the frame has to be
    // the real shape.
    const m2 = {
      type: "result",
      subtype: "success",
      duration_ms: 1234,
      duration_api_ms: 567,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: "end_turn",
      total_cost_usd: 0.01,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "s-1",
    } as unknown as StdoutMessage;

    const wire = NdjsonCodec.encode(m1) + NdjsonCodec.encode(m2);
    // Split the byte stream mid-record to prove reassembly through the codec.
    const splitAt = Math.floor(wire.length / 2);
    child.stdout.emitData(wire.slice(0, splitAt));
    child.stdout.emitData(wire.slice(splitAt));

    expect(received).toEqual([m1, m2]);
  });

  it("reports a malformed stdout line as a session-fatal protocol failure and stops", async () => {
    // REPLACES the former "logs and skips … then continues" expectation. R4.3 is
    // superseded by PROTOCOL.md §7: a stream that emits a non-JSON line is no
    // longer speaking the protocol, and because the control protocol is
    // request/response correlated, skipping a frame can drop the very response
    // the UI is awaiting (rayucode/TRIAGE.md D7).
    const { proc, child, adapter } = makeHarness();
    const received: StdoutMessage[] = [];
    const failures: DecodeFailure[] = [];
    proc.onStdoutMessage((message) => received.push(message));
    proc.onProtocolFailure((failure) => failures.push(failure));

    await proc.start();

    child.stdout.emitData('not json\n{"type":"keep_alive"}\n');

    // Nothing is yielded: the failure came first and latched the decoder.
    expect(received).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.kind).toBe("json");
    expect(
      adapter.logs.some(
        (l) =>
          l.channel === "error" && /Protocol decode failure/.test(l.message),
      ),
    ).toBe(true);
  });

  it("withholds frame CONTENT from the log when no redactor is configured", async () => {
    // A wire frame can carry file contents, tool output, or credentials. With no
    // redactor injected the frame must NOT be logged — only the schema issue
    // paths, which carry no payload values. Secure by default.
    const secret = "sk-ant-super-secret-value";
    const { proc, child, adapter } = makeHarness();
    await proc.start();

    child.stdout.emitData(`not json but contains ${secret}\n`);

    const logged = adapter.logs.map((l) => l.message).join("\n");
    expect(logged).toContain("Protocol decode failure");
    expect(logged).not.toContain(secret);
    expect(logged).toContain("Frame withheld");
  });

  it("logs the redacted frame when a redactor IS configured", async () => {
    const { proc, child, adapter } = makeHarness({
      redact: (text) => text.replace(/sk-[a-z-]+/g, "[REDACTED]"),
    });
    await proc.start();

    child.stdout.emitData("not json sk-ant-secret\n");

    const logged = adapter.logs.map((l) => l.message).join("\n");
    expect(logged).toContain("[REDACTED]");
    expect(logged).not.toContain("sk-ant-secret");
  });
});

// ---------------------------------------------------------------------------
// stderr routes only to the log channel, never the conversation (R2.6)
// ---------------------------------------------------------------------------

describe("AgentProcess stderr routing", () => {
  it("line-buffers stderr to the log channel only and never as a conversation message (R2.6)", async () => {
    const { proc, child, adapter } = makeHarness();
    const stdoutMessages: StdoutMessage[] = [];
    proc.onStdoutMessage((message) => stdoutMessages.push(message));

    await proc.start();

    // A complete line, then a line split across two chunks.
    child.stderr.emitData("first diagnostic line\nsecond ");
    child.stderr.emitData("half\n");

    const stderrLogs = adapter.logs.filter((l) =>
      l.message.includes("[rayu stderr]"),
    );
    expect(stderrLogs.map((l) => l.message)).toEqual([
      "[rayu stderr] first diagnostic line",
      "[rayu stderr] second half",
    ]);
    // Every stderr log lands on the diagnostic channel, never as protocol.
    expect(stderrLogs.every((l) => l.channel === "lifecycle")).toBe(true);
    // Crucially, NOTHING from stderr is surfaced as a conversation message.
    expect(stdoutMessages).toEqual([]);
  });

  it("flushes a trailing partial stderr line when the process exits", async () => {
    const { proc, child, adapter } = makeHarness();
    await proc.start();

    child.stderr.emitData("partial without newline");
    // No log yet — the line is still buffered.
    expect(adapter.logs.some((l) => l.message.includes("[rayu stderr]"))).toBe(
      false,
    );

    child.emitExit(0, null);

    expect(
      adapter.logs.some(
        (l) => l.message === "[rayu stderr] partial without newline",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeLine — NDJSON to stdin (R3.2)
// ---------------------------------------------------------------------------

describe("AgentProcess writeLine", () => {
  it("writes one NDJSON record per message to stdin", async () => {
    const { proc, child } = makeHarness();
    await proc.start();

    const message: StdinMessage = {
      type: "user",
      message: { role: "user", content: "hello" },
      parent_tool_use_id: null,
    };
    proc.writeLine(message);

    expect(child.stdin.writes).toEqual([JSON.stringify(message) + "\n"]);
  });

  it("throws when called before start()", () => {
    const { proc } = makeHarness();
    expect(() =>
      proc.writeLine({ type: "keep_alive" } as StdinMessage),
    ).toThrow(/before start/);
  });

  it("drops a write after exit and logs to the error channel rather than throwing", async () => {
    const { proc, child, adapter } = makeHarness();
    await proc.start();
    child.emitExit(0, null);

    expect(() =>
      proc.writeLine({ type: "keep_alive" } as StdinMessage),
    ).not.toThrow();
    expect(child.stdin.writes).toEqual([]);
    expect(adapter.logs.some((l) => l.channel === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exit emits code/signal (R2.5)
// ---------------------------------------------------------------------------

describe("AgentProcess exit notification", () => {
  it("emits the exit code and signal to onExit listeners (R2.5)", async () => {
    const { proc, child } = makeHarness();
    const exits: AgentExitInfo[] = [];
    proc.onExit((info) => exits.push(info));

    await proc.start();
    child.emitExit(0, null);

    expect(exits).toEqual([{ code: 0, signal: null }]);
  });

  it("reports a signal-driven exit", async () => {
    const { proc, child } = makeHarness();
    const exits: AgentExitInfo[] = [];
    proc.onExit((info) => exits.push(info));

    await proc.start();
    child.emitExit(null, "SIGSEGV");

    expect(exits).toEqual([{ code: null, signal: "SIGSEGV" }]);
  });

  it("emits exactly once and replays the status to a late subscriber", async () => {
    const { proc, child } = makeHarness();
    const exits: AgentExitInfo[] = [];
    proc.onExit((info) => exits.push(info));

    await proc.start();
    child.emitExit(1, null);
    child.emitExit(99, "SIGKILL"); // a duplicate exit must be ignored

    const late: AgentExitInfo[] = [];
    proc.onExit((info) => late.push(info));

    expect(exits).toEqual([{ code: 1, signal: null }]);
    expect(late).toEqual([{ code: 1, signal: null }]);
    expect(proc.hasExited).toBe(true);
  });

  it("logs the error and treats a spawn error as a terminal exit", async () => {
    const { proc, child, adapter } = makeHarness();
    const exits: AgentExitInfo[] = [];
    proc.onExit((info) => exits.push(info));

    await proc.start();
    child.emitError(new Error("spawn rayu ENOENT"));

    expect(exits).toEqual([{ code: null, signal: null }]);
    expect(
      adapter.logs.some(
        (l) => l.channel === "error" && /ENOENT/.test(l.message),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// terminate() resolves only after confirmed exit + SIGKILL escalation (R2.4)
// ---------------------------------------------------------------------------

describe("AgentProcess terminate", () => {
  it("resolves immediately when the process was never started", async () => {
    const { proc, child } = makeHarness();
    await expect(proc.terminate()).resolves.toBeUndefined();
    expect(child.killSignals).toEqual([]);
  });

  it("sends SIGTERM and resolves only after the child confirms exit, with no escalation (R2.4)", async () => {
    vi.useFakeTimers();
    const { proc, child } = makeHarness({ terminateGraceMs: 1000 });
    await proc.start();

    let resolved = false;
    const done = proc.terminate().then(() => {
      resolved = true;
    });

    // SIGTERM is sent synchronously; the promise must not resolve before exit.
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await Promise.resolve();
    expect(resolved).toBe(false);

    // The child exits within the grace window — no SIGKILL escalation.
    child.emitExit(0, "SIGTERM");
    await done;

    expect(resolved).toBe(true);
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL after the grace period and still resolves only once exit is confirmed (R2.4)", async () => {
    vi.useFakeTimers();
    const { proc, child, adapter } = makeHarness({ terminateGraceMs: 1000 });
    await proc.start();

    let resolved = false;
    const done = proc.terminate().then(() => {
      resolved = true;
    });

    expect(child.killSignals).toEqual(["SIGTERM"]);

    // Just before the grace boundary: no escalation, not resolved.
    await vi.advanceTimersByTimeAsync(999);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(resolved).toBe(false);

    // Crossing the grace boundary escalates to SIGKILL…
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    // …but the child still hasn't exited, so terminate() stays pending (R2.4).
    expect(resolved).toBe(false);

    // Only the confirmed exit resolves terminate().
    child.emitExit(null, "SIGKILL");
    await done;
    expect(resolved).toBe(true);

    expect(
      adapter.logs.some(
        (l) => l.channel === "lifecycle" && /SIGKILL/.test(l.message),
      ),
    ).toBe(true);
  });

  it("is idempotent: repeated calls share one termination and one SIGTERM", async () => {
    vi.useFakeTimers();
    const { proc, child } = makeHarness({ terminateGraceMs: 1000 });
    await proc.start();

    const first = proc.terminate();
    const second = proc.terminate();
    expect(first).toBe(second);
    expect(child.killSignals).toEqual(["SIGTERM"]);

    child.emitExit(0, null);
    await Promise.all([first, second]);
  });
});
