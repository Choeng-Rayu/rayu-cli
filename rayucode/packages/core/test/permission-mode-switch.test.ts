// Runtime permission-mode switching, driven from the panel.
//
// The mode decides whether the agent asks before writing a file or running a
// command, so this is the highest-consequence control the panel exposes. Three
// properties are pinned here:
//
//   1. The value is VALIDATED. It arrives from the webview, which is a separate
//      JS context; an unrecognised mode must be dropped rather than handed to the
//      policy, which would otherwise fall through its checks.
//   2. The ENGINE is told first. The engine, not the extension, decides whether it
//      prompts. Local state that ran ahead of a failed request would misreport the
//      mode — and in the dangerous direction it would show a restrictive mode
//      while the engine auto-approved.
//   3. The coordinator is updated too, not just the session record, since it is
//      what the auto-approve policy actually consults.

import { describe, expect, it } from "vitest";

import { SessionManager, PROTOCOL_VERSION } from "../src/index.js";
import type {
  AgentExitInfo,
  AgentPanelHandle,
  AgentProcessFactory,
  AgentProcessLike,
  ApplyResult,
  ContextOptions,
  Disposable,
  EditorAdapter,
  EngineResolution,
  EngineResolverLike,
  FileEditPlan,
  FileSnapshot,
  PanelOutboundMessage,
  StdinMessage,
  StdoutMessage,
  TimerProvider,
  WorkspaceContext,
  WorkspaceSelection,
} from "../src/index.js";

const KEY = "ws-1";

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

class FakeProc implements AgentProcessLike {
  pid: number | undefined = 1;
  readonly writes: StdinMessage[] = [];
  private readonly stdoutListeners: ((m: StdoutMessage) => void)[] = [];
  private readonly exitListeners: ((i: AgentExitInfo) => void)[] = [];

  async start(): Promise<void> {}
  writeLine(message: StdinMessage): void {
    this.writes.push(message);
  }
  onStdoutMessage(cb: (m: StdoutMessage) => void): void {
    this.stdoutListeners.push(cb);
  }
  onExit(cb: (i: AgentExitInfo) => void): void {
    this.exitListeners.push(cb);
  }
  async terminate(): Promise<void> {}

  /** Deliver a stdout message as the engine would. */
  emit(message: StdoutMessage): void {
    for (const cb of [...this.stdoutListeners]) cb(message);
  }

  /** Ids of the control requests written so far for `subtype`, in order. */
  requestIds(subtype: string): string[] {
    const ids: string[] = [];
    for (const message of this.writes) {
      const envelope = message as {
        type?: string;
        request_id?: unknown;
        request?: { subtype?: unknown };
      };
      if (
        envelope.type === "control_request" &&
        envelope.request?.subtype === subtype &&
        typeof envelope.request_id === "string"
      ) {
        ids.push(envelope.request_id);
      }
    }
    return ids;
  }
}

/** Captures everything pushed to the panel so mode echoes can be asserted. */
class FakePanel implements AgentPanelHandle {
  readonly sessionKey = KEY;
  readonly posted: PanelOutboundMessage[] = [];
  /** The host's inbound handler, so a test can post as the webview would. */
  private listener: ((raw: unknown) => void) | null = null;

  postMessage(message: unknown): boolean {
    this.posted.push(message as PanelOutboundMessage);
    return true;
  }
  onDidReceiveMessage(listener: (raw: unknown) => void): Disposable {
    this.listener = listener;
    return {
      dispose: () => {
        this.listener = null;
      },
    };
  }
  onDidDispose(): Disposable {
    return { dispose: () => {} };
  }
  reveal(): void {}
  dispose(): void {}

  /** Deliver a raw message exactly as the webview's `postMessage` would. */
  send(raw: unknown): void {
    if (this.listener === null) {
      throw new Error("the host has not subscribed to panel messages");
    }
    this.listener(raw);
  }
}

class FakeAdapter implements EditorAdapter {
  readonly logs: { channel: string; message: string }[] = [];
  readonly panel = new FakePanel();

  getWorkspaceContext(): WorkspaceContext {
    return { workspaceRoot: "/proj", openFiles: [] };
  }
  getActiveSelection(): WorkspaceSelection | null {
    return null;
  }
  async showAgentPanel(): Promise<AgentPanelHandle> {
    return this.panel;
  }
  async applyFileEdits(): Promise<ApplyResult> {
    return { applied: [], failed: [], conflicts: [] };
  }
  async readFileSnapshot(): Promise<FileSnapshot | null> {
    return null;
  }
  async getSecret(): Promise<string | undefined> {
    return undefined;
  }
  async storeSecret(): Promise<void> {}
  log(channel: "protocol" | "lifecycle" | "error", message: string): void {
    this.logs.push({ channel, message });
  }
  async showActionableMessage(): Promise<string | undefined> {
    return undefined;
  }
  getSetting<T>(_key: string, fallback: T): T {
    return fallback;
  }
  async prepareFileEdits(_plan: FileEditPlan): Promise<void> {}
  getContextOptions?(): ContextOptions {
    return {} as ContextOptions;
  }
}

const noopTimers: TimerProvider = { set: () => 0, clear: () => {} };

function resolution(): EngineResolution {
  return {
    enginePath: "/ext/dist/rayu.js",
    buildInfo: {
      engineVersion: "1.6.13",
      engineFile: "rayu.js",
      engineSha256: "0".repeat(64),
      protocolVersion: PROTOCOL_VERSION,
      gitCommit: "0".repeat(40),
      extensionVersion: "0.0.0-test",
      builtAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function harness() {
  const adapter = new FakeAdapter();
  const procs: FakeProc[] = [];
  const agentProcessFactory: AgentProcessFactory = () => {
    const p = new FakeProc();
    procs.push(p);
    return p;
  };
  const engineResolver: EngineResolverLike = { resolve: () => resolution() };
  let n = 0;
  const manager = new SessionManager({
    adapter,
    agentProcessFactory,
    engineResolver,
    timers: noopTimers,
    generateRequestId: () => `req-${(n += 1)}`,
  });
  return {
    manager,
    adapter,
    current: () => procs[procs.length - 1]!,
  };
}

/** Resolve the pending `set_permission_mode` request with a success response. */
function answerModeRequest(proc: FakeProc, ok = true): void {
  const ids = proc.requestIds("set_permission_mode");
  const requestId = ids[ids.length - 1];
  if (requestId === undefined) {
    throw new Error("no set_permission_mode request was written");
  }
  proc.emit(
    ok
      ? {
          type: "control_response",
          response: { subtype: "success", request_id: requestId, response: {} },
        }
      : {
          type: "control_response",
          response: {
            subtype: "error",
            request_id: requestId,
            error: "engine refused",
          },
        },
  );
}

/** The permission mode from the most recent `setModelInfo` pushed to the panel. */
function lastAnnouncedMode(adapter: FakeAdapter): string | undefined {
  const infos = adapter.panel.posted.filter(
    (m): m is PanelOutboundMessage & { permissionMode: string } =>
      m.type === "setModelInfo",
  );
  return infos[infos.length - 1]?.permissionMode;
}

// ---------------------------------------------------------------------------

describe("selectPermissionMode", () => {
  it("applies a recognised mode and tells the engine", async () => {
    const h = harness();
    await h.manager.openSession(KEY);
    const proc = h.current();

    const done = h.manager.selectPermissionMode(KEY, "acceptEdits");
    // The engine is told BEFORE local state changes.
    expect(proc.requestIds("set_permission_mode")).toHaveLength(1);
    answerModeRequest(proc);
    await done;

    expect(lastAnnouncedMode(h.adapter)).toBe("acceptEdits");
  });

  it("rejects a mode that is not in the wire schema", async () => {
    const h = harness();
    await h.manager.openSession(KEY);
    const proc = h.current();

    await h.manager.selectPermissionMode(KEY, "yolo");

    // Nothing was sent, and nothing was announced.
    expect(proc.requestIds("set_permission_mode")).toHaveLength(0);
    expect(
      h.adapter.logs.some((l) => l.message.includes("unrecognised permission mode")),
    ).toBe(true);
  });

  it("rejects a non-string mode without throwing", async () => {
    const h = harness();
    await h.manager.openSession(KEY);
    const proc = h.current();

    for (const bad of [null, undefined, 42, {}, [], true]) {
      await h.manager.selectPermissionMode(KEY, bad);
    }

    expect(proc.requestIds("set_permission_mode")).toHaveLength(0);
  });

  it("keeps the previous mode when the engine refuses, and re-announces it", async () => {
    const h = harness();
    await h.manager.openSession(KEY);
    const proc = h.current();

    const done = h.manager.selectPermissionMode(KEY, "bypassPermissions");
    answerModeRequest(proc, false);
    await done;

    // The panel is corrected back to the mode still in force, so its picker
    // cannot sit showing a mode that was never applied.
    expect(lastAnnouncedMode(h.adapter)).toBe("default");
    expect(
      h.adapter.logs.some((l) => l.message.includes("Permission mode change")),
    ).toBe(true);
  });

  it("is a no-op when the mode is already in force", async () => {
    const h = harness();
    await h.manager.openSession(KEY);
    const proc = h.current();

    await h.manager.selectPermissionMode(KEY, "default");

    expect(proc.requestIds("set_permission_mode")).toHaveLength(0);
  });

  it("routes through handlePanelMessage from the webview", async () => {
    const h = harness();
    await h.manager.openSession(KEY);
    const proc = h.current();

    // The real path: exactly the object the webview's builder produces, delivered
    // through the panel's inbound listener.
    h.adapter.panel.send({ type: "selectPermissionMode", mode: "plan" });
    answerModeRequest(proc);
    await new Promise((r) => setImmediate(r));

    expect(proc.requestIds("set_permission_mode")).toHaveLength(1);
    expect(lastAnnouncedMode(h.adapter)).toBe("plan");
  });

  it("ignores a hostile or malformed message on the same channel", async () => {
    const h = harness();
    await h.manager.openSession(KEY);
    const proc = h.current();

    for (const raw of [
      { type: "selectPermissionMode" },
      { type: "selectPermissionMode", mode: null },
      { type: "selectPermissionMode", mode: ["bypassPermissions"] },
      { type: "selectPermissionMode", mode: "bypassPermissions\u0000" },
      { type: "selectPermissionMode", mode: "BYPASSPERMISSIONS" },
      { type: "selectPermissionMode", mode: { toString: () => "bypassPermissions" } },
    ]) {
      h.adapter.panel.send(raw);
    }
    await new Promise((r) => setImmediate(r));

    // Not one of these reaches the engine. In particular the mode comparison is
    // case-sensitive and does not coerce, so neither a differently-cased string
    // nor an object with a matching `toString` can escalate.
    expect(proc.requestIds("set_permission_mode")).toHaveLength(0);
  });
});
