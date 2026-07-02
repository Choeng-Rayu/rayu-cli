import { describe, expect, it } from "vitest";

import type {
  ConversationItem,
  ModelInfo,
  ModelUsage,
  PanelOutboundMessage,
  Usage,
} from "@rayucode/core";

import {
  HOST_MESSAGE_TYPES,
  approveEdit,
  approvePermission,
  confirmConflict,
  denyPermission,
  interrupt,
  isEditToolName,
  isHostMessage,
  newSession,
  openModelList,
  selectModel,
  submitPrompt,
} from "../src/webview/protocol.js";
import { PanelViewModel } from "../src/webview/viewModel.js";
import type { RenderItem } from "../src/webview/viewModel.js";
import {
  escapeHtml,
  isSafeHref,
  renderMarkdown,
} from "../src/webview/markdown.js";

// Unit tests for the Agent_Panel webview message contract (task 13.2). These
// exercise the PURE modules (no DOM, no `vscode`) that back the webview, so they
// run under vitest in plain Node:
//   - the WEBVIEW → HOST builders produce exactly the shape the core's
//     `handlePanelMessage` accepts (R5.1, R7.2),
//   - the HOST → WEBVIEW dispatch handles every `PanelOutboundMessage` type,
//   - render order follows the host-assigned `seq` (R3.4),
//   - and the Markdown renderer is escape-first / sanitizing (R3.7).
//
// The DOM glue (dom.ts / main.ts) is intentionally not imported here; it is the
// thin view over these modules and is covered by the extension-host path.

// ----------------------------------------------------------------------------
// Test factories (typed against the core's exported shapes)
// ----------------------------------------------------------------------------

function userItem(seq: number, id = `u${seq}`, text = "hi"): ConversationItem {
  return { kind: "user", id, seq, text };
}

function assistantItem(
  seq: number,
  id = `a${seq}`,
  text = "",
  streaming = true,
): ConversationItem {
  return { kind: "assistant", id, seq, text, streaming };
}

function toolItem(
  seq: number,
  id = `t${seq}`,
  status: "pending" | "running" | "complete" | "failed" = "pending",
): ConversationItem {
  return {
    kind: "tool_action",
    id,
    seq,
    toolUseId: `tu${seq}`,
    toolName: "Bash",
    input: { command: "ls" },
    command: "ls",
    status,
  };
}

function permissionItem(seq: number, requestId = `r${seq}`): ConversationItem {
  return {
    kind: "permission_request",
    id: `p${seq}`,
    seq,
    requestId,
    toolName: "Bash",
    input: { command: "rm -rf x" },
    command: "rm -rf x",
  };
}

const sampleUsage: Usage = { input_tokens: 10, output_tokens: 20 };
const sampleModelUsage: Record<string, ModelUsage> = {
  "model-x": {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.01,
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
};
const sampleModels: ModelInfo[] = [
  { value: "model-x", displayName: "Model X", description: "x" },
  { value: "model-y", displayName: "Model Y", description: "y" },
];

// ----------------------------------------------------------------------------
// WEBVIEW → HOST builders
// ----------------------------------------------------------------------------

describe("webview → host message builders", () => {
  it("builds submitPrompt with the prompt text", () => {
    expect(submitPrompt("hello")).toEqual({
      type: "submitPrompt",
      text: "hello",
    });
  });

  it("builds interrupt with no payload", () => {
    expect(interrupt()).toEqual({ type: "interrupt" });
  });

  it("builds approvePermission, omitting updatedInput when absent", () => {
    expect(approvePermission("req-1")).toEqual({
      type: "approvePermission",
      requestId: "req-1",
    });
    expect(approvePermission("req-1")).not.toHaveProperty("updatedInput");
  });

  it("builds approvePermission carrying the approved input", () => {
    const input = { command: "ls -a" };
    expect(approvePermission("req-1", input)).toEqual({
      type: "approvePermission",
      requestId: "req-1",
      updatedInput: input,
    });
  });

  it("builds denyPermission, omitting message when absent", () => {
    expect(denyPermission("req-2")).toEqual({
      type: "denyPermission",
      requestId: "req-2",
    });
    expect(denyPermission("req-2")).not.toHaveProperty("message");
  });

  it("builds denyPermission with a reason when given", () => {
    expect(denyPermission("req-2", "no")).toEqual({
      type: "denyPermission",
      requestId: "req-2",
      message: "no",
    });
  });

  it("builds approveEdit and confirmConflict with the requestId", () => {
    expect(approveEdit("req-3")).toEqual({
      type: "approveEdit",
      requestId: "req-3",
    });
    expect(confirmConflict("req-4")).toEqual({
      type: "confirmConflict",
      requestId: "req-4",
    });
  });

  it("builds selectModel / openModelList / newSession", () => {
    expect(selectModel("model-y")).toEqual({
      type: "selectModel",
      model: "model-y",
    });
    expect(openModelList()).toEqual({ type: "openModelList" });
    expect(newSession()).toEqual({ type: "newSession" });
  });
});

describe("isEditToolName", () => {
  it("recognizes the file-edit tools", () => {
    expect(isEditToolName("Write")).toBe(true);
    expect(isEditToolName("Edit")).toBe(true);
    expect(isEditToolName("MultiEdit")).toBe(true);
  });

  it("rejects non-edit tools", () => {
    expect(isEditToolName("Bash")).toBe(false);
    expect(isEditToolName("Read")).toBe(false);
    expect(isEditToolName("")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// HOST → WEBVIEW guard
// ----------------------------------------------------------------------------

describe("isHostMessage", () => {
  it("accepts every declared host message type", () => {
    for (const type of HOST_MESSAGE_TYPES) {
      expect(isHostMessage({ type })).toBe(true);
    }
  });

  it("rejects unknown types and non-objects", () => {
    expect(isHostMessage({ type: "bogus" })).toBe(false);
    expect(isHostMessage(null)).toBe(false);
    expect(isHostMessage("addMessage")).toBe(false);
    expect(isHostMessage({})).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// HOST → WEBVIEW dispatch — each message type is handled
// ----------------------------------------------------------------------------

describe("PanelViewModel.handle — host → webview dispatch", () => {
  it("restoreHistory replaces the flow with the given items", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "addMessage", item: userItem(99, "stale") });
    vm.handle({
      type: "restoreHistory",
      items: [userItem(0), assistantItem(1)],
    });
    expect(vm.items.map((i) => i.id)).toEqual(["u0", "a1"]);
  });

  it("addMessage appends a conversation item", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "addMessage", item: userItem(0) });
    expect(vm.items).toHaveLength(1);
    expect(vm.items[0]?.kind).toBe("user");
  });

  it("appendPartial appends streaming text to the in-progress assistant", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "addMessage", item: assistantItem(0, "a0", "") });
    vm.handle({ type: "appendPartial", itemId: "a0", delta: "Hel" });
    vm.handle({ type: "appendPartial", itemId: "a0", delta: "lo" });
    const item = vm.items[0];
    expect(item?.kind).toBe("assistant");
    expect((item as { text: string }).text).toBe("Hello");
  });

  it("completeMessage clears the streaming flag", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "addMessage", item: assistantItem(0, "a0", "done") });
    vm.handle({ type: "completeMessage", itemId: "a0" });
    expect((vm.items[0] as { streaming: boolean }).streaming).toBe(false);
  });

  it("setGenerating toggles the generating flag", () => {
    const vm = new PanelViewModel();
    expect(vm.state.generating).toBe(false);
    vm.handle({ type: "setGenerating", generating: true });
    expect(vm.state.generating).toBe(true);
    vm.handle({ type: "setGenerating", generating: false });
    expect(vm.state.generating).toBe(false);
  });

  it("showPermissionRequest adds a permission item", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "showPermissionRequest", item: permissionItem(0) });
    expect(vm.items[0]?.kind).toBe("permission_request");
  });

  it("showToolAction adds a tool action item", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "showToolAction", item: toolItem(0) });
    expect(vm.items[0]?.kind).toBe("tool_action");
  });

  it("updateToolStatus updates status and output of the tool item", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "showToolAction", item: toolItem(0, "t0", "pending") });
    vm.handle({
      type: "updateToolStatus",
      itemId: "t0",
      status: "running",
      output: "partial",
    });
    const item = vm.items[0] as { status: string; output?: string };
    expect(item.status).toBe("running");
    expect(item.output).toBe("partial");
  });

  it("showUsage records the usage summary and an ordered usage item", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "showUsage",
      usage: sampleUsage,
      totalCostUsd: 0.42,
      modelUsage: sampleModelUsage,
    });
    expect(vm.state.usage?.totalCostUsd).toBe(0.42);
    expect(vm.items.some((i) => i.kind === "usage")).toBe(true);
  });

  it("setModelInfo records model and permission mode (R7.1)", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "setModelInfo",
      model: "model-x",
      permissionMode: "default",
    });
    expect(vm.state.model).toBe("model-x");
    expect(vm.state.permissionMode).toBe("default");
  });

  it("setModelList records the available models (R7.2)", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "setModelList", models: sampleModels });
    expect(vm.state.models).toHaveLength(2);
    expect(vm.state.models[0]?.value).toBe("model-x");
  });

  it("setMcpStatus records server statuses incl. failures (R11.2, R11.5)", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "setMcpStatus",
      servers: [
        { name: "fs", status: "connected" },
        { name: "db", status: "failed" },
      ],
    });
    expect(vm.state.mcpServers).toHaveLength(2);
    expect(vm.state.mcpServers[1]).toEqual({ name: "db", status: "failed" });
  });

  it("showError surfaces an error notice (R15.2)", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "showError", message: "boom" });
    const item = vm.items[0] as { kind: string; message: string };
    expect(item.kind).toBe("notice");
    expect(item.message).toBe("boom");
  });

  it("editApplied surfaces an info notice with the path (R6.2)", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "editApplied", path: "src/a.ts" });
    const item = vm.items[0] as { message: string };
    expect(item.message).toContain("src/a.ts");
  });

  it("editConflict surfaces a conflict notice carrying the requestId (R6.3)", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "editConflict",
      paths: ["src/a.ts", "src/b.ts"],
      requestId: "req-9",
    });
    const item = vm.items[0] as { requestId?: string; message: string };
    expect(item.requestId).toBe("req-9");
    expect(item.message).toContain("src/a.ts");
  });

  it("insertPrompt buffers one-shot pending input, drained on consume (R9.5)", () => {
    const vm = new PanelViewModel();
    expect(vm.state.pendingInput).toBe(null);

    vm.handle({ type: "insertPrompt", text: "ref-A" });
    expect(vm.state.pendingInput).toBe("ref-A");

    // Multiple inserts before a drain concatenate (newline-separated) so none
    // is lost.
    vm.handle({ type: "insertPrompt", text: "ref-B" });
    expect(vm.state.pendingInput).toBe("ref-A\nref-B");

    // Consume drains it (one-shot) and returns the buffer.
    expect(vm.consumePendingInput()).toBe("ref-A\nref-B");
    expect(vm.state.pendingInput).toBe(null);
    expect(vm.consumePendingInput()).toBe(null);
  });

  it("insertPrompt does not add a conversation item (R9.5)", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "insertPrompt", text: "ref" });
    expect(vm.items).toHaveLength(0);
  });

  it("handles every declared host→webview message type without throwing", () => {
    // One representative message per declared type — proves the dispatch is
    // total over the contract (the union's exhaustiveness is also enforced at
    // compile time by the view model's `never` default).
    const messages: PanelOutboundMessage[] = [
      { type: "restoreHistory", items: [] },
      { type: "addMessage", item: userItem(0) },
      { type: "appendPartial", itemId: "a0", delta: "x" },
      { type: "completeMessage", itemId: "a0" },
      { type: "setGenerating", generating: true },
      { type: "showPermissionRequest", item: permissionItem(1) },
      { type: "showToolAction", item: toolItem(2) },
      { type: "updateToolStatus", itemId: "t2", status: "complete" },
      {
        type: "showUsage",
        usage: sampleUsage,
        totalCostUsd: 0,
        modelUsage: {},
      },
      { type: "setModelInfo", model: null, permissionMode: "default" },
      { type: "setModelList", models: [] },
      { type: "setMcpStatus", servers: [] },
      { type: "showError", message: "e" },
      { type: "editApplied", path: "p" },
      { type: "editConflict", paths: ["p"], requestId: "r" },
      { type: "insertPrompt", text: "x" },
    ];
    const handled = new Set(messages.map((m) => m.type));
    // Guard: the scripted set covers exactly the declared contract.
    expect(handled).toEqual(HOST_MESSAGE_TYPES);

    const vm = new PanelViewModel();
    for (const message of messages) {
      expect(() => vm.handle(message)).not.toThrow();
    }
  });
});

// ----------------------------------------------------------------------------
// Render ordering (R3.4)
// ----------------------------------------------------------------------------

describe("render ordering follows host-assigned seq (R3.4)", () => {
  it("orders items by seq even when delivered out of order", () => {
    const vm = new PanelViewModel();
    // Deliver seq 2, then 0, then 1 — the model must render them by seq.
    vm.handle({ type: "addMessage", item: userItem(2, "second") });
    vm.handle({ type: "addMessage", item: userItem(0, "zeroth") });
    vm.handle({ type: "addMessage", item: assistantItem(1, "first", "x") });
    expect(vm.items.map((i) => i.id)).toEqual(["zeroth", "first", "second"]);
  });

  it("preserves in-order delivery", () => {
    const vm = new PanelViewModel();
    const seqs = [0, 1, 2, 3, 4];
    for (const seq of seqs) {
      vm.handle({ type: "addMessage", item: userItem(seq) });
    }
    expect(vm.items.map((i) => i.seq)).toEqual(seqs);
  });

  it("interleaves user, tool, permission, and assistant items by seq", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "showToolAction", item: toolItem(3, "t3") });
    vm.handle({ type: "addMessage", item: userItem(1, "u1") });
    vm.handle({ type: "showPermissionRequest", item: permissionItem(2) });
    vm.handle({ type: "addMessage", item: assistantItem(0, "a0", "x") });
    const order = vm.items.map((i) => i.seq);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(vm.items.map((i) => i.id)).toEqual(["a0", "u1", "p2", "t3"]);
  });

  it("keeps the streaming assistant in place while partials arrive", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "addMessage", item: userItem(0, "u0") });
    vm.handle({ type: "addMessage", item: assistantItem(1, "a1", "") });
    vm.handle({ type: "appendPartial", itemId: "a1", delta: "Hello " });
    vm.handle({ type: "addMessage", item: userItem(2, "u2") });
    vm.handle({ type: "appendPartial", itemId: "a1", delta: "world" });
    vm.handle({ type: "completeMessage", itemId: "a1" });
    expect(vm.items.map((i) => i.id)).toEqual(["u0", "a1", "u2"]);
    const assistant = vm.items.find((i) => i.id === "a1") as {
      text: string;
      streaming: boolean;
    };
    expect(assistant.text).toBe("Hello world");
    expect(assistant.streaming).toBe(false);
  });

  it("restoreHistory renders items in the host-provided seq order", () => {
    const vm = new PanelViewModel();
    const items: ConversationItem[] = [
      userItem(0, "u0"),
      assistantItem(1, "a1", "hi", false),
      toolItem(2, "t2", "complete"),
    ];
    vm.handle({ type: "restoreHistory", items });
    expect(vm.items.map((i: RenderItem) => i.id)).toEqual(["u0", "a1", "t2"]);
  });
});

// ----------------------------------------------------------------------------
// Markdown rendering / sanitization (R3.7)
// ----------------------------------------------------------------------------

describe("renderMarkdown — sanitization and formatting (R3.7)", () => {
  it("escapes raw HTML so scripts cannot execute", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders fenced code blocks as monospaced pre/code, escaped", () => {
    const html = renderMarkdown("```\n<b>x</b> & y\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });

  it("renders bold, italic, and inline code", () => {
    expect(renderMarkdown("**b**")).toContain("<strong>b</strong>");
    expect(renderMarkdown("*i*")).toContain("<em>i</em>");
    expect(renderMarkdown("`c`")).toContain("<code>c</code>");
  });

  it("renders headings and lists", () => {
    expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
    const list = renderMarkdown("- one\n- two");
    expect(list).toContain("<ul>");
    expect(list).toContain("<li>one</li>");
  });

  it("allows safe link schemes and drops dangerous ones", () => {
    expect(renderMarkdown("[ok](https://example.com)")).toContain(
      '<a href="https://example.com"',
    );
    const danger = renderMarkdown("[x](javascript:alert(1))");
    expect(danger).not.toContain("<a");
    expect(danger).toContain("x");
  });

  it("does not treat snake_case as italic", () => {
    expect(renderMarkdown("foo_bar_baz")).not.toContain("<em>");
  });
});

describe("isSafeHref / escapeHtml", () => {
  it("accepts relative, fragment, http(s), mailto", () => {
    expect(isSafeHref("https://x.com")).toBe(true);
    expect(isSafeHref("http://x.com")).toBe(true);
    expect(isSafeHref("/relative/path")).toBe(true);
    expect(isSafeHref("#frag")).toBe(true);
    expect(isSafeHref("mailto:a@b.com")).toBe(true);
  });

  it("rejects javascript/data/vbscript, including whitespace-obfuscated", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html;base64,xx")).toBe(false);
    expect(isSafeHref("vbscript:msgbox")).toBe(false);
    expect(isSafeHref("java\tscript:alert(1)")).toBe(false);
  });

  it("escapeHtml encodes the five significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
