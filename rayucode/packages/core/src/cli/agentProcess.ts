// AgentProcess (R2, R8.1, R8.2, R11.1, R11.3).
//
// Wraps a single spawned `rayu` child process and presents the editor-agnostic
// surface the SessionManager drives. One Session ⇒ one AgentProcess ⇒ one child
// (design "Process model"). Responsibilities:
//
//   - Spawn the child headless in streaming mode with the mandatory flags
//     `--print --input-format=stream-json --output-format=stream-json --verbose`
//     (`--verbose` is required for `stream-json` output) and `cwd` set to the
//     session workspace root (R2.2, R2.3).
//   - Inherit the process environment unchanged so the CLI resolves its default
//     `~/.rayu` config dir and the MCP servers configured there — the config dir
//     is NEVER overridden (R8.1, R8.2, R11.1, R11.3).
//   - Pipe `stdout` through {@link NdjsonCodec} and surface each decoded
//     `StdoutMessage` via {@link AgentProcess.onStdoutMessage} (R4.1).
//   - Pipe `stderr` line-buffered into the diagnostic log channel ONLY — never
//     into the conversation (R2.6).
//   - Emit `{ code, signal }` on exit (R2.5).
//   - {@link AgentProcess.terminate} sends SIGTERM, waits a bounded grace
//     period, escalates to SIGKILL, and resolves ONLY after the OS confirms the
//     child has exited (R2.4).
//
// The spawn primitive is injected (`spawn`), so the lifecycle is unit-testable
// with a fake {@link ChildProcessLike} and no real subprocess. The default
// spawn uses `node:child_process`; `node:*` builtins are permitted in the core
// (they are not an editor dependency), so there is no `vscode` import here
// (R13.1, R13.5).

import { spawn as nodeSpawn } from "node:child_process";

import type { EditorAdapter } from "../editor/adapter.js";
import { NdjsonCodec } from "../protocol/ndjson.js";
import type { StdinMessage, StdoutMessage } from "../protocol/messages.js";

// ----------------------------------------------------------------------------
// Spawn contract — the minimal child-process surface the AgentProcess needs.
// ----------------------------------------------------------------------------

/** A minimal writable surface: NDJSON records are written to the child stdin. */
export interface ChildStdinLike {
  /** Write a chunk; the return value is ignored (back-pressure is not modelled). */
  write(chunk: string): boolean;
  /** Close the stream (best-effort; never required for correctness). */
  end(): void;
}

/**
 * A minimal readable surface — an `EventEmitter` producing utf8 `data` chunks
 * and a terminal `end`. Declared with overloaded method syntax so Node's
 * `Readable` satisfies it structurally.
 */
export interface ChildReadableLike {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

/**
 * The minimal child-process surface required by {@link AgentProcess}. Both a
 * test stub and Node's `ChildProcessWithoutNullStreams` satisfy it: piped
 * stdio (non-null streams), a `kill(signal)` method, exit/error events, and an
 * optional `pid`.
 */
export interface ChildProcessLike {
  readonly pid?: number | undefined;
  readonly stdin: ChildStdinLike;
  readonly stdout: ChildReadableLike;
  readonly stderr: ChildReadableLike;
  /** Send a signal to the child; returns whether it was delivered. */
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** The spawn options forwarded to the injected {@link SpawnFn}. */
export interface AgentSpawnOptions {
  /** Working directory for the child (session workspace root, R2.3). */
  cwd?: string | undefined;
  /** Environment for the child (inherited unchanged by default, R8.1). */
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Injectable process spawner. The default ({@link defaultSpawn}) uses
 * `node:child_process`; tests pass a fake that returns a {@link ChildProcessLike}
 * stub.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: AgentSpawnOptions,
) => ChildProcessLike;

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/**
 * The mandatory headless streaming flags every Rayu agent process is launched
 * with (R2.2). `--verbose` is required: the CLI rejects `stream-json` output
 * without it.
 */
export const AGENT_STREAMING_ARGS: readonly string[] = [
  "--print",
  "--input-format=stream-json",
  "--output-format=stream-json",
  "--verbose",
];

/**
 * Default grace period (ms) between SIGTERM and the SIGKILL escalation in
 * {@link AgentProcess.terminate} (R2.4).
 */
export const DEFAULT_TERMINATE_GRACE_MS = 5_000;

// ----------------------------------------------------------------------------
// Public event payloads / options
// ----------------------------------------------------------------------------

/** Exit status emitted when the child terminates (R2.5). */
export interface AgentExitInfo {
  code: number | null;
  signal: string | null;
}

/** A decoded inbound message listener. */
export type StdoutMessageListener = (message: StdoutMessage) => void;

/** A process-exit listener. */
export type ExitListener = (info: AgentExitInfo) => void;

/** Construction options for an {@link AgentProcess}. */
export interface AgentProcessOptions {
  /** Resolved path to the Rayu CLI executable (from `CliLocator`). */
  cliPath: string;
  /**
   * Working directory for the child = the session workspace root (R2.3). When
   * omitted the child inherits the host process working directory.
   */
  cwd?: string | undefined;
  /** Diagnostic sink for stderr and lifecycle/error events (R2.6). */
  adapter: Pick<EditorAdapter, "log">;
  /**
   * Environment for the child. Defaults to the host `process.env`, inherited
   * UNCHANGED so the CLI's default `~/.rayu` config-dir and MCP resolution is
   * preserved (R8.1, R8.2, R11.1, R11.3). The config dir is never overridden
   * by this class.
   */
  env?: NodeJS.ProcessEnv | undefined;
  /** Override the spawner (defaults to a `node:child_process` spawn). */
  spawn?: SpawnFn;
  /** Extra args appended after {@link AGENT_STREAMING_ARGS} (rarely needed). */
  extraArgs?: readonly string[];
  /** SIGTERM→SIGKILL grace period in ms (defaults to {@link DEFAULT_TERMINATE_GRACE_MS}). */
  terminateGraceMs?: number;
}

// ----------------------------------------------------------------------------
// Default (Node-backed) spawner
// ----------------------------------------------------------------------------

/**
 * Default spawner: launch the child with piped stdio. No `stdio` option is
 * passed, so Node defaults all three streams to pipes and returns a
 * `ChildProcessWithoutNullStreams`, whose non-null streams satisfy
 * {@link ChildProcessLike}.
 */
const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, { cwd: options.cwd, env: options.env });

// ----------------------------------------------------------------------------
// AgentProcess
// ----------------------------------------------------------------------------

/**
 * Supervises one `rayu` child process for a session. Construct, register
 * listeners, then {@link start}. Drive the agent with {@link writeLine}, observe
 * decoded output via {@link onStdoutMessage}, observe termination via
 * {@link onExit}, and tear it down with {@link terminate}.
 */
export class AgentProcess {
  private readonly cliPath: string;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly adapter: Pick<EditorAdapter, "log">;
  private readonly spawnFn: SpawnFn;
  private readonly extraArgs: readonly string[];
  private readonly terminateGraceMs: number;

  /** Decodes the child's stdout byte stream into protocol messages (R4.1). */
  private readonly codec: NdjsonCodec<StdoutMessage>;

  private readonly stdoutListeners = new Set<StdoutMessageListener>();
  private readonly exitListeners = new Set<ExitListener>();

  /** The spawned child, or `null` before {@link start} / after construction. */
  private child: ChildProcessLike | null = null;

  /** Buffer holding the not-yet-newline-terminated trailing stderr line. */
  private stderrBuffer = "";

  /** Set once the child has been observed to exit (or fail to spawn). */
  private exited = false;
  private exitInfo: AgentExitInfo | null = null;

  /** Resolvers awaiting confirmed exit (used by {@link terminate}). */
  private readonly exitWaiters = new Set<() => void>();

  /** The in-flight {@link terminate} promise, so the call is idempotent. */
  private terminatePromise: Promise<void> | null = null;

  constructor(options: AgentProcessOptions) {
    this.cliPath = options.cliPath;
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.adapter = options.adapter;
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.extraArgs = options.extraArgs ?? [];
    this.terminateGraceMs =
      options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    this.codec = new NdjsonCodec<StdoutMessage>({
      onMalformedLine: (raw, error) => {
        // R4.3: a non-JSON stdout line is logged and skipped; decoding
        // continues with subsequent lines.
        this.adapter.log(
          "error",
          `Malformed NDJSON line on agent stdout (skipped): ${raw} — ${String(error)}`,
        );
      },
    });
  }

  /** The child's process id, or `undefined` before start / after failure. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Whether the child has exited (or failed to spawn). */
  get hasExited(): boolean {
    return this.exited;
  }

  /**
   * Spawn the child and wire its stdio. Resolves once the child handle exists;
   * a synchronous spawn failure rejects. Asynchronous spawn failures surface
   * via the `error` event (logged, and treated as a terminal exit).
   *
   * @throws if called more than once.
   */
  start(): Promise<void> {
    if (this.child !== null) {
      return Promise.reject(new Error("AgentProcess: start() called twice"));
    }

    const args = [...AGENT_STREAMING_ARGS, ...this.extraArgs];
    this.adapter.log(
      "lifecycle",
      `Spawning Rayu agent: ${this.cliPath} ${args.join(" ")} (cwd: ${this.cwd ?? "<inherited>"})`,
    );

    let child: ChildProcessLike;
    try {
      child = this.spawnFn(this.cliPath, args, {
        cwd: this.cwd,
        env: this.env,
      });
    } catch (error) {
      // A synchronous spawn failure: surface it and reject.
      this.adapter.log(
        "error",
        `Failed to spawn Rayu agent: ${String((error as Error)?.message ?? error)}`,
      );
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    this.child = child;
    this.wireStdout(child);
    this.wireStderr(child);
    this.wireLifecycle(child);
    return Promise.resolve();
  }

  /**
   * Write one outbound message to the child's stdin as a single NDJSON record
   * (R3.2). A write after exit is logged and dropped rather than throwing on a
   * dead pipe; a write before {@link start} is a programming error.
   */
  writeLine(message: StdinMessage): void {
    if (this.child === null) {
      throw new Error("AgentProcess: writeLine() called before start()");
    }
    if (this.exited) {
      this.adapter.log(
        "error",
        "AgentProcess: dropping stdin write after process exit.",
      );
      return;
    }
    this.child.stdin.write(NdjsonCodec.encode(message));
  }

  /** Register a listener for each decoded inbound `StdoutMessage` (R4.1). */
  onStdoutMessage(listener: StdoutMessageListener): void {
    this.stdoutListeners.add(listener);
  }

  /** Register a listener for the child's exit `{ code, signal }` (R2.5). */
  onExit(listener: ExitListener): void {
    // If the child has already exited, replay the terminal status so a late
    // subscriber is not silently starved.
    if (this.exited && this.exitInfo !== null) {
      listener(this.exitInfo);
      return;
    }
    this.exitListeners.add(listener);
  }

  /**
   * Terminate the child and resolve ONLY after the OS confirms it has exited
   * (R2.4): send SIGTERM, await exit for a bounded grace period, and if the
   * child is still alive escalate to SIGKILL, then await the confirmed exit.
   * Idempotent: concurrent / repeated calls share one termination.
   */
  terminate(): Promise<void> {
    if (this.terminatePromise === null) {
      this.terminatePromise = this.runTermination();
    }
    return this.terminatePromise;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async runTermination(): Promise<void> {
    const child = this.child;
    // Never started, or already exited: nothing to confirm.
    if (child === null || this.exited) {
      return;
    }

    const confirmedExit = this.waitForExit();
    child.kill("SIGTERM");

    const exitedInGrace = await this.raceExitAgainstGrace(confirmedExit);
    if (exitedInGrace) {
      return;
    }

    // Grace elapsed and the child ignored SIGTERM: escalate (R2.4).
    if (!this.exited) {
      this.adapter.log(
        "lifecycle",
        `Rayu agent did not exit ${this.terminateGraceMs}ms after SIGTERM; escalating to SIGKILL.`,
      );
      child.kill("SIGKILL");
    }

    // Resolve only after the exit is actually confirmed.
    await confirmedExit;
  }

  /**
   * Resolve to `true` if the confirmed-exit promise settles within the grace
   * period, or `false` if the grace timer fires first. Uses the global timer so
   * test fake-timers intercept it.
   */
  private raceExitAgainstGrace(confirmedExit: Promise<void>): Promise<boolean> {
    if (this.exited) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(false);
      }, this.terminateGraceMs);
      // Do not keep the event loop alive solely for this timer in production.
      timer.unref?.();
      void confirmedExit.then(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** A promise that resolves when the child exit is confirmed. */
  private waitForExit(): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.exitWaiters.add(resolve);
    });
  }

  private wireStdout(child: ChildProcessLike): void {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const message of this.codec.push(text)) {
        this.emitStdoutMessage(message);
      }
    });
    child.stdout.on("end", () => {
      for (const message of this.codec.flush()) {
        this.emitStdoutMessage(message);
      }
    });
  }

  private wireStderr(child: ChildProcessLike): void {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.consumeStderr(text);
    });
    child.stderr.on("end", () => {
      this.flushStderr();
    });
  }

  private wireLifecycle(child: ChildProcessLike): void {
    child.on("exit", (code, signal) => {
      this.settleExit({ code, signal });
    });
    // An `error` listener is mandatory: an unhandled child `error` event throws.
    // A spawn failure (e.g. ENOENT) emits `error` and never `exit`, so treat it
    // as a terminal condition too, unblocking any pending terminate().
    child.on("error", (error) => {
      this.adapter.log(
        "error",
        `Rayu agent process error: ${String(error?.message ?? error)}`,
      );
      this.settleExit({ code: null, signal: null });
    });
  }

  /**
   * Line-buffer stderr and route each complete line to the diagnostic log
   * channel ONLY (R2.6) — stderr never reaches the conversation. The trailing
   * partial line is held until more data or {@link flushStderr}.
   */
  private consumeStderr(text: string): void {
    this.stderrBuffer += text;
    for (;;) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = this.stderrBuffer.slice(0, newline);
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      this.logStderrLine(line);
    }
  }

  /** Flush any buffered trailing stderr line (at stream end / exit). */
  private flushStderr(): void {
    if (this.stderrBuffer.length > 0) {
      const line = this.stderrBuffer;
      this.stderrBuffer = "";
      this.logStderrLine(line);
    }
  }

  private logStderrLine(line: string): void {
    // Strip a trailing CR (CRLF streams) and skip blank lines.
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.length === 0) {
      return;
    }
    this.adapter.log("lifecycle", `[rayu stderr] ${trimmed}`);
  }

  private emitStdoutMessage(message: StdoutMessage): void {
    for (const listener of [...this.stdoutListeners]) {
      listener(message);
    }
  }

  /**
   * Record the terminal exit exactly once, flush trailing stderr, notify exit
   * listeners, and release every {@link terminate} waiter.
   */
  private settleExit(info: AgentExitInfo): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitInfo = info;
    this.flushStderr();

    for (const listener of [...this.exitListeners]) {
      listener(info);
    }
    const waiters = [...this.exitWaiters];
    this.exitWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
}
