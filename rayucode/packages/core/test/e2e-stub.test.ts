import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SessionManager,
  PROTOCOL_VERSION,
} from "../src/index.js";
import type {
  AgentPanelHandle,
  ApplyResult,
  CliResolution,
  ContextOptions,
  Disposable,
  EditorAdapter,
  FileSnapshot,
  PanelOutboundMessage,
  WorkspaceContext,
} from "../src/index.js";

// ===========================================================================
// End-to-end smoke test (task 15.1 — Requirements 3.2, 3.3, 4.1, 4.2, 5.1, 5.2).
//
// This is a GENUINE end-to-end test: it spawns a REAL stub `rayu` subprocess
// (test/fixtures/stub-rayu.mjs) and drives it through the REAL core stack —
// the default `AgentProcessFactory` builds a real `AgentProcess` that spawns the
// stub, its stdout is decoded by the real `NdjsonCodec`, dispatched by the real
// `ControlProtocolClient`, and composed by the real `SessionManager`
// (`AgentProcess` + `ControlProtocolClient` + `PermissionCoordinator` +
// `SessionStore`). Only the editor is faked: an in-memory `EditorAdapter`
// records every host→panel message (the real `VSCodeAdapter` needs a live
// extension host and cannot run headless, but the subprocess + protocol +
// session path CAN and is the meaningful integration here).
//
// The test verifies, against the actual process boundary:
//   * streamed assistant text is assembled and surfaced (addMessage +
//     appendPartial), R3.3/R4.1,
//   * a permission request is surfaced with the exact bash command, R5.1/R5.6,
//   * approving it writes an `allow` control_response that genuinely reaches the
//     stub over stdin (proven because the stub only emits "[tool approved]" and
//     the terminal `result` AFTER it receives that response), R5.2,
//   * the terminal `result` completes the turn and surfaces usage/cost,
//     R4.2/R4.4.
// ===========================================================================

const STUB_PATH = fileURLToPath(
  new URL("./fixtures/stub-rayu.mjs", import.meta.url),
);
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const KEY = "e2e-ws";

// ---------------------------------------------------------------------------
// In-memory fake editor (records every host → panel message; no `vscode`).
// ---------------------------------------------------------------------------

/** A panel that just records the messages the host posts to it. */
class CapturingPanel implements AgentPanelHandle {
  readonly sessionKey: string;
  readonly posted: PanelOutboundMessage[] = [];
  disposed = false;

  constructor(sessionKey: string) {
    this.sessionKey = sessionKey;
  }
  reveal(): void {}
  postMessage(message: unknown): boolean {
    this.posted.push(message as PanelOutboundMessage);
    return true;
  }
  onDidReceiveMessage(): Disposable {
    return { dispose: () => {} };
  }
  onDidDispose(): Disposable {
    return { dispose: () => {} };
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A fully in-memory `EditorAdapter` — no editor, no `vscode` (R13.1). */
class FakeEditorAdapter implements EditorAdapter {
  readonly panels: CapturingPanel[] = [];
  private readonly settings: Record<string, unknown>;

  constructor(settings: Record<string, unknown> = {}) {
    this.settings = settings;
  }

  async showAgentPanel(sessionKey: string): Promise<AgentPanelHandle> {
    const panel = new CapturingPanel(sessionKey);
    this.panels.push(panel);
    return panel;
  }
  async applyFileEdits(): Promise<ApplyResult> {
    return { applied: [], failed: [], conflicts: [] };
  }
  async readFileSnapshot(): Promise<FileSnapshot | null> {
    return null;
  }
  async getWorkspaceContext(_options: ContextOptions): Promise<WorkspaceContext> {
    // A stable, real directory so the spawned child gets a valid cwd (R2.3).
    return { workspaceRoot: FIXTURES_DIR };
  }
  async isPathIgnored(): Promise<boolean> {
    return false;
  }
  registerCommand(): Disposable {
    return { dispose: () => {} };
  }
  async getSecret(): Promise<string | undefined> {
    return undefined;
  }
  async storeSecret(): Promise<void> {}
  log(): void {}
  async showActionableMessage(): Promise<string | undefined> {
    return undefined;
  }
  getSetting<T>(key: string, fallback: T): T {
    return (key in this.settings ? this.settings[key] : fallback) as T;
  }
}

/**
 * Point the engine resolver straight at the stub script, skipping the SHA-256
 * integrity check (there is no build-info.json in a test tree).
 */
const stubEngineResolver = {
  resolve: (): EngineResolution => ({
    enginePath: STUB_PATH,
    buildInfo: {
    engineVersion: "1.6.13",
    engineFile: "rayu.js",
    engineSha256: "0".repeat(64),
    protocolVersion: PROTOCOL_VERSION,
    gitCommit: "0".repeat(40),
    extensionVersion: "0.0.0-test",
    builtAt: "2026-01-01T00:00:00.000Z",
  },
  }),
};

function makeManager(): { manager: SessionManager; adapter: FakeEditorAdapter } {
  const adapter = new FakeEditorAdapter({
    "rayucode.permissionMode": "default", // Bash prompts (not auto-approved)
    "rayucode.includeActiveFile": false,
    "rayucode.includeSelection": false,
    // Disable the unresponsiveness timer so it can never interfere with the
    // real-subprocess timing in this test (R15.4).
    "rayucode.unresponsiveTimeoutMs": 0,
  });
  // NOTE: no `agentProcessFactory` override → the DEFAULT factory builds a real
  // `AgentProcess` that actually spawns the stub subprocess.
  const manager = new SessionManager({ adapter, engineResolver: stubEngineResolver });
  return { manager, adapter };
}

/** Reassemble the assistant text from the messages posted to the panel. */
function assistantText(posted: PanelOutboundMessage[]): string {
  let text = "";
  for (const message of posted) {
    if (message.type === "addMessage" && message.item.kind === "assistant") {
      text += message.item.text;
    } else if (message.type === "appendPartial") {
      text += message.delta;
    }
  }
  return text;
}

// ---------------------------------------------------------------------------

describe("end-to-end: real stub `rayu` subprocess through the core stack", () => {
  beforeAll(() => {
    // Guarantee the shebang script is executable regardless of how it was
    // checked out, so the real `AgentProcess` can spawn it directly.
    chmodSync(STUB_PATH, 0o755);
  });

  let active: SessionManager | null = null;
  afterEach(async () => {
    // Always terminate the spawned child so no subprocess leaks (R2.4).
    if (active) {
      await active.closeSession(KEY);
      active = null;
    }
  });

  it(
    "streams assistant text, round-trips a Bash permission, and surfaces usage",
    async () => {
      const { manager, adapter } = makeManager();
      active = manager;

      await manager.openSession(KEY);
      const panel = adapter.panels[0];
      expect(panel).toBeDefined();

      await manager.submitPrompt(KEY, "please run the build");

      // The stub streams two deltas then asks to run a Bash command. Wait until
      // the streamed assistant item AND the permission prompt have surfaced.
      await vi.waitFor(
        () => {
          expect(
            panel!.posted.some(
              (m) => m.type === "addMessage" && m.item.kind === "assistant",
            ),
          ).toBe(true);
          expect(
            panel!.posted.some((m) => m.type === "showPermissionRequest"),
          ).toBe(true);
        },
        { timeout: 12_000, interval: 25 },
      );

      // R3.3/R4.1: streamed text assembled from addMessage + appendPartial.
      expect(assistantText(panel!.posted)).toContain("Hello, world");

      // R5.1/R5.6: the permission request carries the exact bash command.
      const permMessage = panel!.posted.find(
        (m) => m.type === "showPermissionRequest",
      );
      expect(permMessage).toBeDefined();
      const item = (
        permMessage as Extract<
          PanelOutboundMessage,
          { type: "showPermissionRequest" }
        >
      ).item;
      expect(item.kind).toBe("permission_request");
      if (item.kind !== "permission_request") {
        throw new Error("expected a permission_request item");
      }
      expect(item.toolName).toBe("Bash");
      expect(item.command).toBe("echo hello-from-stub");

      // R5.2: the turn has NOT completed yet — the stub only emits its result
      // after it receives the approval over stdin.
      expect(panel!.posted.some((m) => m.type === "showUsage")).toBe(false);

      // Approve → an `allow` control_response is written to the child's stdin.
      manager.approvePermission(KEY, item.requestId);

      // The stub echoes the decision and ends the turn ONLY after receiving the
      // allow, so these arriving proves the response round-tripped to the real
      // subprocess (R5.2).
      await vi.waitFor(
        () => {
          expect(panel!.posted.some((m) => m.type === "completeMessage")).toBe(
            true,
          );
          expect(panel!.posted.some((m) => m.type === "showUsage")).toBe(true);
        },
        { timeout: 12_000, interval: 25 },
      );

      // Proof the `allow` reached the stub: this delta is emitted only on a
      // control_response whose payload behavior is "allow".
      expect(assistantText(panel!.posted)).toContain("[tool approved]");

      // R4.4: the terminal result's usage/cost was surfaced.
      const usageMessage = panel!.posted.find((m) => m.type === "showUsage") as
        | Extract<PanelOutboundMessage, { type: "showUsage" }>
        | undefined;
      expect(usageMessage).toBeDefined();
      expect(usageMessage!.usage.input_tokens).toBe(11);
      expect(usageMessage!.usage.output_tokens).toBe(22);
      expect(usageMessage!.totalCostUsd).toBeCloseTo(0.0025);

      // R3.2/R11: `system/init` propagated the model and MCP status too.
      expect(
        panel!.posted.some(
          (m) => m.type === "setModelInfo" && m.model === "stub-model-v1",
        ),
      ).toBe(true);
      expect(
        panel!.posted.some(
          (m) =>
            m.type === "setMcpStatus" &&
            m.servers.some((s) => s.name === "stub-mcp"),
        ),
      ).toBe(true);
    },
    30_000,
  );
});
