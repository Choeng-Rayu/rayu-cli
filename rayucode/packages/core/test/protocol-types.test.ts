import { describe, expect, it } from "vitest";

import {
  shouldAutoApprove,
  PERMISSION_MODES,
  isAssistantMessage,
  isControlCancelRequest,
  isControlRequest,
  isControlResponse,
  isPermissionMode,
  isResultMessage,
  isStreamEvent,
  isSystemInit,
} from "../src/index.js";
import type {
  ConversationItem,
  EditorAdapter,
  FileEditPlan,
  PermissionToolOutput,
  SessionState,
  StdinMessage,
  StdoutMessage,
} from "../src/index.js";

// Representative valid instances used to exercise the discriminated unions and
// the runtime guards. These also serve as compile-time usage examples
// (validated by `npm run typecheck`).
const systemInit: StdoutMessage = {
  type: "system",
  subtype: "init",
  model: "rayu-default",
  permissionMode: "default",
  tools: [],
  mcp_servers: [],
  slash_commands: [],
  skills: [],
  apiKeySource: "user",
  cwd: "/workspace",
  claude_code_version: "1.0.0",
  uuid: "u-init",
  session_id: "s-1",
};

const assistant: StdoutMessage = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  parent_tool_use_id: null,
  uuid: "u-a",
  session_id: "s-1",
};

const streamEvent: StdoutMessage = {
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  parent_tool_use_id: null,
  uuid: "u-s",
  session_id: "s-1",
};

const result: StdoutMessage = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 10, output_tokens: 20 },
  modelUsage: {},
  permission_denials: [],
  uuid: "u-r",
  session_id: "s-1",
};

const controlRequest: StdoutMessage = {
  type: "control_request",
  request_id: "req-1",
  request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t-1" },
};

const controlResponse: StdoutMessage = {
  type: "control_response",
  response: { subtype: "success", request_id: "req-1" },
};

const controlCancel: StdoutMessage = {
  type: "control_cancel_request",
  request_id: "req-1",
};

describe("StdoutMessage type guards", () => {
  it("narrows each message variant by its discriminant", () => {
    expect(isSystemInit(systemInit)).toBe(true);
    expect(isAssistantMessage(assistant)).toBe(true);
    expect(isStreamEvent(streamEvent)).toBe(true);
    expect(isResultMessage(result)).toBe(true);
    expect(isControlRequest(controlRequest)).toBe(true);
    expect(isControlResponse(controlResponse)).toBe(true);
    expect(isControlCancelRequest(controlCancel)).toBe(true);
  });

  it("does not cross-match unrelated variants", () => {
    expect(isControlRequest(controlResponse)).toBe(false);
    expect(isResultMessage(assistant)).toBe(false);
    expect(isSystemInit(controlRequest)).toBe(false);
  });

  it("narrows the inner control request after guarding", () => {
    if (isControlRequest(controlRequest)) {
      expect(controlRequest.request.subtype).toBe("can_use_tool");
    }
  });
});

describe("PermissionMode", () => {
  it("exposes every mode the engine can put on the wire", () => {
    // The five EXTERNAL modes plus the three INTERNAL ones. The internal modes
    // are included because rayu/src/cli/print.ts puts the engine's internal
    // PermissionMode straight onto a `system/status` frame — so omitting them
    // meant a user in `fullManage` produced a frame the schema rejected, tripping
    // the fail-safe on a perfectly healthy session (TRIAGE.md D10.2).
    //
    // Derived from the schema rather than re-listed here, so this cannot drift.
    expect([...PERMISSION_MODES].sort()).toEqual(
      [
        "acceptEdits",
        "auto",
        "bubble",
        "bypassPermissions",
        "default",
        "dontAsk",
        "fullManage",
        "plan",
      ].sort(),
    );
  });

  it("never treats an internal mode as auto-approving a mutating action", () => {
    // A consumer that does not implement an internal mode must fall back to
    // PROMPTING, never to auto-approval. `shouldAutoApprove` compares against
    // the two explicit auto modes, so anything else is safe by construction.
    //
    // Only the MUTATING categories are asserted: `read-only` is auto-approved
    // under every mode by design, because reading cannot damage the workspace.
    for (const mode of ["auto", "bubble", "fullManage"] as const) {
      expect(shouldAutoApprove(mode, "edit")).toBe(false);
      expect(shouldAutoApprove(mode, "bash")).toBe(false);
    }
  });

  it("validates mode strings", () => {
    expect(isPermissionMode("acceptEdits")).toBe(true);
    expect(isPermissionMode("plan")).toBe(true);
    expect(isPermissionMode("nope")).toBe(false);
    expect(isPermissionMode(42)).toBe(false);
  });
});

describe("supporting shapes compile and are usable", () => {
  it("constructs a stdin user message", () => {
    const userMessage: StdinMessage = {
      type: "user",
      message: { role: "user", content: "do the thing" },
      parent_tool_use_id: null,
    };
    expect(userMessage.type).toBe("user");
  });

  it("constructs allow/deny permission outputs", () => {
    const allow: PermissionToolOutput = { behavior: "allow", updatedInput: { command: "ls" } };
    const deny: PermissionToolOutput = { behavior: "deny", message: "not allowed" };
    expect(allow.behavior).toBe("allow");
    expect(deny.behavior).toBe("deny");
  });

  it("constructs a session state with ordered history", () => {
    const item: ConversationItem = {
      kind: "assistant",
      id: "a-1",
      seq: 1,
      text: "hi",
      streaming: false,
    };
    const state: SessionState = {
      key: "ws-key",
      resumableSessionId: null,
      history: [item],
      model: null,
      permissionMode: "default",
      pendingPermissions: new Map(),
      status: "idle",
    };
    expect(state.history[0]?.kind).toBe("assistant");
    expect(state.pendingPermissions.size).toBe(0);
  });

  it("constructs a file-edit plan", () => {
    const plan: FileEditPlan = {
      changes: [{ path: "src/new.ts", kind: "create", newContent: "export const x = 1;\n" }],
    };
    expect(plan.changes).toHaveLength(1);
  });

  it("allows a structurally typed EditorAdapter reference", () => {
    // Compile-time check only: a partial fake typed as the interface members
    // we touch here. Full implementation lives in the VS Code host.
    const log: EditorAdapter["log"] = (_channel, _message) => {
      /* no-op */
    };
    log("protocol", "ping");
    expect(typeof log).toBe("function");
  });
});
