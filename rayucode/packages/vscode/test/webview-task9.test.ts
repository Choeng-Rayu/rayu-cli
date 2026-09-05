import { describe, expect, it } from "vitest";

import { extractFileDiffs, isDiffableTool } from "../src/webview/diff.js";
import { PanelViewModel } from "../src/webview/viewModel.js";

// ----------------------------------------------------------------------------
// Diff extraction (Task 9 — diff rendering)
// ----------------------------------------------------------------------------

describe("diff extraction", () => {
  it("extracts a Write as a whole-file addition", () => {
    const diffs = extractFileDiffs("Write", {
      file_path: "/test.ts",
      content: "line1\nline2",
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.wholeFile).toBe(true);
    expect(diffs[0]!.hunks[0]!.lines.every((l) => l.kind === "add")).toBe(true);
  });

  it("extracts an Edit as a line diff", () => {
    const diffs = extractFileDiffs("Edit", {
      file_path: "/test.ts",
      old_string: "a\nb\nc",
      new_string: "a\nB\nc",
    });
    const lines = diffs[0]!.hunks[0]!.lines;
    expect(lines.filter((l) => l.kind === "add")).toHaveLength(1);
    expect(lines.filter((l) => l.kind === "remove")).toHaveLength(1);
  });

  it("returns empty for a malformed payload", () => {
    expect(extractFileDiffs("Edit", { file_path: "/x" })).toHaveLength(0);
  });

  it("identifies diffable tools", () => {
    expect(isDiffableTool("Write")).toBe(true);
    expect(isDiffableTool("Edit")).toBe(true);
    expect(isDiffableTool("MultiEdit")).toBe(true);
    expect(isDiffableTool("Bash")).toBe(false);
  });

  it("extracts a MultiEdit with multiple hunks", () => {
    const diffs = extractFileDiffs("MultiEdit", {
      file_path: "/a.ts",
      edits: [
        { old_string: "foo", new_string: "FOO" },
        { old_string: "bar", new_string: "BAR" },
      ],
    });
    expect(diffs).toHaveLength(1);
    // Two separate edits → two hunks
    expect(diffs[0]!.hunks.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for a MultiEdit with no valid edits", () => {
    expect(
      extractFileDiffs("MultiEdit", { file_path: "/a.ts", edits: [] }),
    ).toHaveLength(0);
  });

  it("returns empty for an unknown tool", () => {
    expect(extractFileDiffs("Bash", { file_path: "/x", command: "ls" })).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// View model — new Task 9 message types
// ----------------------------------------------------------------------------

describe("viewModel handles new protocol messages", () => {
  it("records tool progress in place", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "toolProgress",
      toolUseId: "t1",
      toolName: "Bash",
      elapsedSeconds: 5,
    });
    expect(vm.state.toolProgress?.elapsedSeconds).toBe(5);
  });

  it("replaces tool progress in place (not duplicated)", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "toolProgress",
      toolUseId: "t1",
      toolName: "Bash",
      elapsedSeconds: 5,
    });
    vm.handle({
      type: "toolProgress",
      toolUseId: "t1",
      toolName: "Bash",
      elapsedSeconds: 10,
    });
    expect(vm.state.toolProgress?.elapsedSeconds).toBe(10);
    // Progress is NOT a conversation item.
    expect(vm.state.items.filter((i) => i.kind === "tool_action")).toHaveLength(0);
  });

  it("clears tool progress when the turn stops", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "toolProgress",
      toolUseId: "t1",
      toolName: "Bash",
      elapsedSeconds: 5,
    });
    vm.handle({ type: "setGenerating", generating: false });
    expect(vm.state.toolProgress).toBeNull();
  });

  it("ignores rateLimit 'allowed' but surfaces 'rejected'", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "rateLimit", status: "allowed" });
    expect(vm.state.rateLimit).toBeNull();

    vm.handle({ type: "rateLimit", status: "rejected" });
    expect(vm.state.rateLimit?.status).toBe("rejected");
  });

  it("surfaces rateLimit 'allowed_warning'", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "rateLimit", status: "allowed_warning", utilization: 0.9 });
    expect(vm.state.rateLimit?.status).toBe("allowed_warning");
    expect(vm.state.rateLimit?.utilization).toBe(0.9);
  });

  it("appends a notice on compact boundary", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "compactBoundary", trigger: "auto", preTokens: 50000 });
    const notices = vm.state.items.filter((i) => i.kind === "notice");
    expect(notices.length).toBeGreaterThan(0);
  });

  it("records auth status and surfaces an error notice when present", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "authStatus", authenticating: true });
    expect(vm.state.authenticating).toBe(true);

    vm.handle({ type: "authStatus", authenticating: false, error: "token expired" });
    expect(vm.state.authenticating).toBe(false);
    const notices = vm.state.items.filter((i) => i.kind === "notice");
    expect(notices.length).toBeGreaterThan(0);
  });
});
