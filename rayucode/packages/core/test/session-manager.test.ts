import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Redactor, SessionManager } from "../src/index.js";
import type {
  AgentExitInfo,
  AgentPanelHandle,
  AgentProcessFactory,
  AgentProcessLike,
  ApplyResult,
  CliLocatorLike,
  CliResolution,
  ContextOptions,
  Disposable,
  EditorAdapter,
  FileEditPlan,
  FileSnapshot,
  PermissionToolOutput,
  StdinMessage,
  StdinUserMessage,
  StdoutMessage,
  TimerProvider,
  WorkspaceContext,
  WorkspaceSelection,
} from "../src/index.js";

// ===========================================================================
// Fakes — a fake EditorAdapter and a stub AgentProcess so the SessionManager
// is exercised with NO real subprocess and NO editor (task 10.4). Everything
// the manager touches is observable here.
// ===========================================================================

/** A recorded outbound write or a process termination, in call order. */
type ProcEvent =
  | { kind: "write"; message: StdinMessage }
  | { kind: "terminate" };

/** A stub AgentProcess: records writes/terminate order; replays stdout/exit. */
class FakeAgentProcess implements AgentProcessLike {
  pid: number | undefined = 123;
  started = false;
  readonly events: ProcEvent[] = [];
  private readonly stdoutListeners: ((m: StdoutMessage) => void)[] = [];
  private readonly exitListeners: ((info: AgentExitInfo) => void)[] = [];
  /** Override to make start() reject (spawn-failure path, R15.1). */
  startImpl: () => Promise<void> = () => Promise.resolve();

  async start(): Promise<void> {
    this.started = true;
    await this.startImpl();
  }

  writeLine(message: StdinMessage): void {
    this.events.push({ kind: "write", message });
  }

  onStdoutMessage(cb: (m: StdoutMessage) => void): void {
    this.stdoutListeners.push(cb);
  }

  onExit(cb: (info: AgentExitInfo) => void): void {
    this.exitListeners.push(cb);
  }

  async terminate(): Promise<void> {
    this.events.push({ kind: "terminate" });
    for (const listener of [...this.exitListeners]) {
      listener({ code: 0, signal: "SIGTERM" });
    }
  }

  /** Drive an inbound stdout protocol message (as the real child would). */
  emit(message: StdoutMessage): void {
    for (const listener of [...this.stdoutListeners]) {
      listener(message);
    }
  }

  /** Every StdinMessage written, in order. */
  get writes(): StdinMessage[] {
    return this.events
      .filter((e): e is { kind: "write"; message: StdinMessage } => e.kind === "write")
      .map((e) => e.message);
  }
}

class FakePanel implements AgentPanelHandle {
  readonly sessionKey: string;
  readonly posted: unknown[] = [];
  disposed = false;
  private readonly receiveListeners: ((m: unknown) => void)[] = [];
  private readonly disposeListeners: (() => void)[] = [];

  constructor(sessionKey: string) {
    this.sessionKey = sessionKey;
  }
  reveal(): void {}
  postMessage(message: unknown): boolean {
    this.posted.push(message);
    return true;
  }
  onDidReceiveMessage(listener: (m: unknown) => void): Disposable {
    this.receiveListeners.push(listener);
    return { dispose: () => {} };
  }
  onDidDispose(listener: () => void): Disposable {
    this.disposeListeners.push(listener);
    return { dispose: () => {} };
  }
  dispose(): void {
    this.disposed = true;
  }
  /** Simulate a webview → host message. */
  receive(message: unknown): void {
    for (const listener of [...this.receiveListeners]) {
      listener(message);
    }
  }
}

interface ActionableCall {
  level: "info" | "warn" | "error";
  text: string;
  actions: string[];
}

interface AdapterConfig {
  workspaceRoot?: string | null;
  activeFilePath?: string;
  selection?: WorkspaceSelection;
  ignored?: string[];
  settings?: Record<string, unknown>;
}

/** A fully in-memory EditorAdapter that records everything (no `vscode`). */
class FakeEditorAdapter implements EditorAdapter {
  readonly panels: FakePanel[] = [];
  readonly logs: { channel: string; message: string }[] = [];
  readonly actionable: ActionableCall[] = [];
  readonly contextOptionCalls: ContextOptions[] = [];
  readonly applied: FileEditPlan[] = [];
  /** Successive responses returned by showActionableMessage. */
  actionableResponses: (string | undefined)[] = [];
  snapshots: Record<string, FileSnapshot> = {};
  applyResult: ApplyResult = { applied: [], failed: [], conflicts: [] };

  private workspaceRoot: string | null;
  private readonly activeFilePath: string | undefined;
  private readonly selection: WorkspaceSelection | undefined;
  private readonly ignored: Set<string>;
  private readonly settings: Record<string, unknown>;

  constructor(config: AdapterConfig = {}) {
    this.workspaceRoot =
      config.workspaceRoot === undefined ? "/home/proj" : config.workspaceRoot;
    this.activeFilePath = config.activeFilePath;
    this.selection = config.selection;
    this.ignored = new Set(config.ignored ?? []);
    this.settings = config.settings ?? {};
  }

  async showAgentPanel(sessionKey: string): Promise<AgentPanelHandle> {
    const panel = new FakePanel(sessionKey);
    this.panels.push(panel);
    return panel;
  }

  async applyFileEdits(edits: FileEditPlan): Promise<ApplyResult> {
    this.applied.push(edits);
    return this.applyResult;
  }

  async readFileSnapshot(path: string): Promise<FileSnapshot | null> {
    return this.snapshots[path] ?? null;
  }

  async getWorkspaceContext(options: ContextOptions): Promise<WorkspaceContext> {
    this.contextOptionCalls.push(options);
    const context: WorkspaceContext = { workspaceRoot: this.workspaceRoot };
    if (options.includeActiveFile && this.activeFilePath !== undefined) {
      context.activeFilePath = this.activeFilePath;
    }
    if (options.includeSelection && this.selection !== undefined) {
      context.selection = this.selection;
    }
    return context;
  }

  async isPathIgnored(path: string): Promise<boolean> {
    return this.ignored.has(path);
  }

  registerCommand(): Disposable {
    return { dispose: () => {} };
  }

  async getSecret(): Promise<string | undefined> {
    return undefined;
  }

  async storeSecret(): Promise<void> {}

  log(channel: "protocol" | "lifecycle" | "error", message: string): void {
    this.logs.push({ channel, message });
  }

  async showActionableMessage(
    level: "info" | "warn" | "error",
    text: string,
    actions: string[],
  ): Promise<string | undefined> {
    this.actionable.push({ level, text, actions });
    return this.actionableResponses.shift();
  }

  getSetting<T>(key: string, fallback: T): T {
    return (key in this.settings ? this.settings[key] : fallback) as T;
  }
}

/** A no-op timer provider so the unresponsiveness timer never fires in tests. */
const noopTimers: TimerProvider = {
  set: () => 0,
  clear: () => {},
};

function fakeResolution(
  overrides: Partial<CliResolution> = {},
): CliResolution {
  return {
    path: "/opt/rayu/bin/rayu",
    version: "1.2.3",
    belowMinimum: false,
    ...overrides,
  };
}

interface Harness {
  manager: SessionManager;
  adapter: FakeEditorAdapter;
  processes: FakeAgentProcess[];
  /** The most recently created stub process. */
  current(): FakeAgentProcess;
}

function makeHarness(
  adapter: FakeEditorAdapter,
  resolution: CliResolution = fakeResolution(),
): Harness {
  const processes: FakeAgentProcess[] = [];
  const agentProcessFactory: AgentProcessFactory = () => {
    const proc = new FakeAgentProcess();
    processes.push(proc);
    return proc;
  };
  const cliLocator: CliLocatorLike = { resolve: async () => resolution };
  const manager = new SessionManager({
    adapter,
    agentProcessFactory,
    cliLocator,
    timers: noopTimers,
    generateRequestId: (() => {
      let n = 0;
      return () => `req-${(n += 1)}`;
    })(),
  });
  return {
    manager,
    adapter,
    processes,
    current: () => processes[processes.length - 1]!,
  };
}

/** The text content of the most recent user message written to the agent. */
function lastPromptContent(proc: FakeAgentProcess): string {
  const users = proc.writes.filter(
    (m): m is StdinUserMessage => m.type === "user",
  );
  const message = users[users.length - 1];
  if (!message) {
    return "";
  }
  const { content } = message.message;
  return typeof content === "string" ? content : JSON.stringify(content);
}

const KEY = "ws-1";

// ===========================================================================
// Prompt + Workspace_Context assembly (R9.1, R9.2, R9.3, R9.4, R9.6)
// ===========================================================================

describe("SessionManager prompt + context assembly", () => {
  it("includes the workspace root path in the prompt context (R9.1)", async () => {
    const adapter = new FakeEditorAdapter({ workspaceRoot: "/home/proj" });
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    await h.manager.submitPrompt(KEY, "explain this repo");

    const content = lastPromptContent(h.current());
    expect(content).toContain("Workspace root: /home/proj");
    expect(content).toContain("explain this repo");
  });

  it("sends the prompt WITHOUT a root when it cannot be determined (R9.2)", async () => {
    const adapter = new FakeEditorAdapter({ workspaceRoot: null });
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    await h.manager.submitPrompt(KEY, "no workspace here");

    const content = lastPromptContent(h.current());
    // The prompt is still sent (R9.2)...
    expect(content).toContain("no workspace here");
    // ...but carries no workspace root.
    expect(content).not.toContain("Workspace root:");
  });

  it("omits the active file when the include-active-file setting is disabled (R9.3)", async () => {
    const adapter = new FakeEditorAdapter({
      workspaceRoot: "/home/proj",
      activeFilePath: "/home/proj/src/a.ts",
      settings: { "rayucode.includeActiveFile": false },
    });
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    await h.manager.submitPrompt(KEY, "hello");

    const content = lastPromptContent(h.current());
    expect(content).not.toContain("Active file:");
    // The opt-in option the manager passed reflects the disabled setting.
    const promptCall = adapter.contextOptionCalls.at(-1)!;
    expect(promptCall.includeActiveFile).toBe(false);
  });

  it("includes the active file only when the setting is enabled (R9.3)", async () => {
    const adapter = new FakeEditorAdapter({
      workspaceRoot: "/home/proj",
      activeFilePath: "/home/proj/src/a.ts",
      settings: { "rayucode.includeActiveFile": true },
    });
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    await h.manager.submitPrompt(KEY, "hello");

    const content = lastPromptContent(h.current());
    expect(content).toContain("Active file: /home/proj/src/a.ts");
    expect(adapter.contextOptionCalls.at(-1)!.includeActiveFile).toBe(true);
  });

  it("includes the active selection and its file path only when enabled (R9.4)", async () => {
    const selection: WorkspaceSelection = {
      path: "/home/proj/src/b.ts",
      text: "const answer = 42;",
      startLine: 10,
      endLine: 10,
    };
    const adapter = new FakeEditorAdapter({
      workspaceRoot: "/home/proj",
      selection,
      settings: { "rayucode.includeSelection": true },
    });
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    await h.manager.submitPrompt(KEY, "what does this do?");

    const content = lastPromptContent(h.current());
    expect(content).toContain("Selection (/home/proj/src/b.ts:10-10):");
    expect(content).toContain("const answer = 42;");
    expect(adapter.contextOptionCalls.at(-1)!.includeSelection).toBe(true);
  });

  it("excludes an ignored active file from the context (R9.6)", async () => {
    const adapter = new FakeEditorAdapter({
      workspaceRoot: "/home/proj",
      activeFilePath: "/home/proj/.env",
      ignored: ["/home/proj/.env"],
      settings: { "rayucode.includeActiveFile": true },
    });
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    await h.manager.submitPrompt(KEY, "use my secrets file");

    const content = lastPromptContent(h.current());
    // The setting opted it in, but the ignore config excludes it (R9.6).
    expect(content).not.toContain("/home/proj/.env");
    expect(content).not.toContain("Active file:");
    expect(content).toContain("use my secrets file");
  });

  it("excludes an ignored selection's file and contents from the context (R9.6)", async () => {
    const selection: WorkspaceSelection = {
      path: "/home/proj/secrets.txt",
      text: "TOP-SECRET-VALUE",
    };
    const adapter = new FakeEditorAdapter({
      workspaceRoot: "/home/proj",
      selection,
      ignored: ["/home/proj/secrets.txt"],
      settings: { "rayucode.includeSelection": true },
    });
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    await h.manager.submitPrompt(KEY, "review selection");

    const content = lastPromptContent(h.current());
    expect(content).not.toContain("TOP-SECRET-VALUE");
    expect(content).not.toContain("/home/proj/secrets.txt");
    expect(content).toContain("review selection");
  });

  it("records the prompt in the retained history and marks the turn generating", async () => {
    const adapter = new FakeEditorAdapter();
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    await h.manager.submitPrompt(KEY, "first prompt");

    // One user message was written to the agent.
    const users = h.current().writes.filter((m) => m.type === "user");
    expect(users).toHaveLength(1);

    // The panel was told the turn is in progress (R3.5 host side).
    const panel = adapter.panels[0]!;
    expect(
      panel.posted.some(
        (m) =>
          (m as { type?: string }).type === "setGenerating" &&
          (m as { generating?: boolean }).generating === true,
      ),
    ).toBe(true);
  });
});

// ===========================================================================
// Close-session ordering — deny pending permissions BEFORE terminate (R5.5)
// ===========================================================================

describe("SessionManager close-session ordering", () => {
  it("denies every pending permission BEFORE terminating the process (R5.5)", async () => {
    const adapter = new FakeEditorAdapter();
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    const proc = h.current();

    // The agent asks to run a bash command — which prompts under `default`,
    // so it becomes a pending permission awaiting a decision.
    proc.emit({
      type: "control_request",
      request_id: "perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf build" },
        tool_use_id: "t-1",
      },
    });

    // No response written yet — it is genuinely pending.
    expect(
      proc.writes.some((m) => m.type === "control_response"),
    ).toBe(false);

    await h.manager.closeSession(KEY);

    // The deny response was written, and the process was terminated.
    const denyIndex = proc.events.findIndex(
      (e) =>
        e.kind === "write" &&
        e.message.type === "control_response" &&
        e.message.response.subtype === "success" &&
        (e.message.response.response as PermissionToolOutput | undefined)
          ?.behavior === "deny",
    );
    const terminateIndex = proc.events.findIndex((e) => e.kind === "terminate");

    expect(denyIndex).toBeGreaterThanOrEqual(0);
    expect(terminateIndex).toBeGreaterThanOrEqual(0);
    // R5.5 / Property 6: the deny is issued strictly before termination.
    expect(denyIndex).toBeLessThan(terminateIndex);

    // Exactly one terminate.
    expect(proc.events.filter((e) => e.kind === "terminate")).toHaveLength(1);
  });

  it("terminates cleanly when there are no pending permissions", async () => {
    const adapter = new FakeEditorAdapter();
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    const proc = h.current();

    await h.manager.closeSession(KEY);

    expect(proc.events.filter((e) => e.kind === "terminate")).toHaveLength(1);
    // No permission responses were needed.
    expect(proc.writes.some((m) => m.type === "control_response")).toBe(false);
    // The panel was disposed as part of releasing resources.
    expect(adapter.panels[0]!.disposed).toBe(true);
  });
});

// ===========================================================================
// Editor-agnosticism — the module references no `vscode` symbol (R13.1, R13.4)
// ===========================================================================

describe("SessionManager editor-agnosticism", () => {
  it("references no `vscode` symbol in its source (R13.1, R13.4)", () => {
    const sourcePath = fileURLToPath(
      new URL("../src/session/sessionManager.ts", import.meta.url),
    );
    const source = readFileSync(sourcePath, "utf8");

    // Strip block and line comments (which legitimately discuss the no-vscode
    // invariant) so only actual code symbols are inspected.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    expect(/\bvscode\b/i.test(code)).toBe(false);
    // And, concretely, there is no import of the `vscode` module.
    expect(/from\s+["']vscode["']/.test(source)).toBe(false);
    expect(/require\(\s*["']vscode["']\s*\)/.test(source)).toBe(false);
  });
});

// ===========================================================================
// Composition smoke — streaming + permission routing through the real stack
// ===========================================================================

describe("SessionManager composition", () => {
  it("routes streaming deltas and a result to the panel, completing the turn", async () => {
    const adapter = new FakeEditorAdapter();
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    const proc = h.current();
    const panel = adapter.panels[0]!;

    proc.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      parent_tool_use_id: null,
      uuid: "u-1",
      session_id: "s-1",
    });
    proc.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      },
      parent_tool_use_id: null,
      uuid: "u-2",
      session_id: "s-1",
    });
    proc.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { input_tokens: 5, output_tokens: 7 },
      modelUsage: {},
      permission_denials: [],
      uuid: "u-r",
      session_id: "s-1",
    });

    const types = panel.posted.map((m) => (m as { type: string }).type);
    expect(types).toContain("addMessage"); // first delta created the item
    expect(types).toContain("appendPartial"); // second delta appended
    expect(types).toContain("completeMessage"); // result completed it
    expect(types).toContain("showUsage"); // usage surfaced (R4.4)
  });

  it("dispatches a webview submitPrompt message to the agent", async () => {
    const adapter = new FakeEditorAdapter();
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    const panel = adapter.panels[0]!;

    panel.receive({ type: "submitPrompt", text: "via webview" });
    // submitPrompt is async; allow its microtasks to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(lastPromptContent(h.current())).toContain("via webview");
  });
});

// ===========================================================================
// Add-selection-to-prompt — host posts an insertPrompt to the panel (R9.5)
// ===========================================================================

describe("SessionManager addSelectionToPrompt (R9.5)", () => {
  it("opens the panel and posts an insertPrompt carrying the reference", async () => {
    const adapter = new FakeEditorAdapter();
    const h = makeHarness(adapter);

    // No panel/session yet — the method must open one ("first if needed").
    await h.manager.addSelectionToPrompt(KEY, "REFERENCE-TEXT");

    const panel = adapter.panels[0]!;
    expect(panel).toBeDefined();
    const insert = panel.posted.find(
      (m) => (m as { type?: string }).type === "insertPrompt",
    ) as { type: string; text: string } | undefined;
    expect(insert).toBeDefined();
    expect(insert?.text).toBe("REFERENCE-TEXT");
  });

  it("reuses an already-open panel rather than opening a second one", async () => {
    const adapter = new FakeEditorAdapter();
    const h = makeHarness(adapter);

    await h.manager.openSession(KEY);
    await h.manager.addSelectionToPrompt(KEY, "ref-2");

    // The same panel is reused (no second panel was created).
    expect(adapter.panels).toHaveLength(1);
    expect(
      adapter.panels[0]!.posted.some(
        (m) =>
          (m as { type?: string }).type === "insertPrompt" &&
          (m as { text?: string }).text === "ref-2",
      ),
    ).toBe(true);
  });

  it("redacts a configured credential before it reaches the panel (R15.5)", async () => {
    const adapter = new FakeEditorAdapter();
    const manager = new SessionManager({
      adapter,
      redactor: new Redactor(["sk-SECRET"]),
      agentProcessFactory: () => new FakeAgentProcess(),
      cliLocator: { resolve: async () => fakeResolution() },
      timers: noopTimers,
    });

    await manager.addSelectionToPrompt(KEY, "token is sk-SECRET here");

    const panel = adapter.panels[0]!;
    const insert = panel.posted.find(
      (m) => (m as { type?: string }).type === "insertPrompt",
    ) as { text: string } | undefined;
    expect(insert).toBeDefined();
    expect(insert?.text).not.toContain("sk-SECRET");
  });
});
