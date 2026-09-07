/**
 * Task 16 — the engine's capability inventory reaches the panel.
 *
 * RAYU_CORE_MIGRATION_PLAN.md §2.4: `SDKSystemMessageSchema` has always carried
 * `tools`, `slash_commands` and `skills`, and the host discarded all three while
 * consuming only `model`, `permissionMode` and `mcp_servers`. No protocol change
 * was needed to fix it — a review had claimed otherwise, and the schema settled it.
 *
 * The malformed cases matter as much as the happy path: these arrays are iterated
 * during a repaint that runs BEFORE the conversation is reconciled, so one bad
 * entry would throw and freeze the panel on stale content. That is the same
 * failure mode `setModelList` and `setMcpStatus` already guard against, so the
 * guard is asserted here rather than assumed.
 */
import { describe, expect, it } from "vitest";

import { PanelViewModel } from "../src/webview/viewModel.js";

function model(): PanelViewModel {
  return new PanelViewModel();
}

describe("setCapabilities populates the inventory", () => {
  it("stores tools, slash commands and skills", () => {
    const vm = model();
    vm.handle({
      type: "setCapabilities",
      tools: ["Bash", "Read", "Edit"],
      slashCommands: ["/help", "/model", "/clear"],
      skills: ["commit", "review"],
    });
    const state = vm.state;
    expect(state.tools).toEqual(["Bash", "Read", "Edit"]);
    expect(state.slashCommands).toEqual(["/help", "/model", "/clear"]);
    expect(state.skills).toEqual(["commit", "review"]);
  });

  it("starts empty, so the panel shows nothing before the handshake", () => {
    const state = model().state;
    expect(state.tools).toEqual([]);
    expect(state.slashCommands).toEqual([]);
    expect(state.skills).toEqual([]);
  });

  it("a later init replaces the inventory rather than appending", () => {
    // An engine restart can announce a different tool set — e.g. after an MCP
    // server is added. Accumulating would show tools that no longer exist.
    const vm = model();
    vm.handle({ type: "setCapabilities", tools: ["A"], slashCommands: [], skills: [] });
    vm.handle({ type: "setCapabilities", tools: ["B"], slashCommands: [], skills: [] });
    expect(vm.state.tools).toEqual(["B"]);
  });
});

describe("a malformed setCapabilities degrades instead of throwing", () => {
  it("survives non-array fields", () => {
    const vm = model();
    expect(() =>
      vm.handle({
        type: "setCapabilities",
        // Shapes a pre-Task-16 engine could produce.
        tools: undefined as unknown as string[],
        slashCommands: null as unknown as string[],
        skills: "not-an-array" as unknown as string[],
      }),
    ).not.toThrow();
    const state = vm.state;
    expect(state.tools).toEqual([]);
    expect(state.slashCommands).toEqual([]);
    expect(state.skills).toEqual([]);
  });

  it("drops non-string entries but keeps the valid ones", () => {
    const vm = model();
    vm.handle({
      type: "setCapabilities",
      tools: ["Bash", 42, null, "Read", { name: "x" }] as unknown as string[],
      slashCommands: [],
      skills: [],
    });
    expect(vm.state.tools).toEqual(["Bash", "Read"]);
  });

  it("a bad inventory does not disturb unrelated state", () => {
    // The point of degrading rather than throwing: the rest of the panel keeps working.
    const vm = model();
    vm.handle({ type: "setModelInfo", model: "claude-x", permissionMode: "default" });
    vm.handle({
      type: "setCapabilities",
      tools: null as unknown as string[],
      slashCommands: null as unknown as string[],
      skills: null as unknown as string[],
    });
    const state = vm.state;
    expect(state.model).toBe("claude-x");
    expect(state.permissionMode).toBe("default");
  });
});
