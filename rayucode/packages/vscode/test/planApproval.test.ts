/**
 * Plan mode approval — UI_PARITY flow 16.
 *
 * WHY THIS ONLY WORKS NOW
 * Plan approval in the CLI is a permission request for the `ExitPlanMode` tool. The
 * panel never showed one because the engine was spawned without
 * `--permission-prompt-tool`, so `getCanUseToolFn` took its "decide locally" branch
 * and no `can_use_tool` request was ever sent. With the host now passing
 * `--permission-prompt-tool=stdio`, and both `EnterPlanMode` and `ExitPlanMode`
 * present in the host's 56 tools, these arrive like any other approval.
 *
 * What is pinned here is that a plan reads as a PLAN. "ExitPlanMode needs your
 * approval" is accurate and useless at the moment a user is asked to review one.
 */
import { describe, expect, it } from "vitest";

import {
  isPlanApproval,
  permissionTitle,
  planApprovalText,
} from "../src/webview/components.js";

/** A permission request as the view model holds it. */
function request(toolName: string, input: Record<string, unknown> = {}) {
  return {
    kind: "permission" as const,
    requestId: "r1",
    toolName,
    input,
  } as unknown as Parameters<typeof planApprovalText>[0];
}

describe("a plan approval is recognised", () => {
  it("matches both plan tools", () => {
    // EXIT_PLAN_MODE_TOOL_NAME and EXIT_PLAN_MODE_V2_TOOL_NAME are both
    // 'ExitPlanMode' in rayu/src/tools/ExitPlanModeTool/constants.ts.
    expect(isPlanApproval("ExitPlanMode")).toBe(true);
    expect(isPlanApproval("EnterPlanMode")).toBe(true);
  });

  it("does not claim ordinary tools are plans", () => {
    for (const tool of ["Edit", "Bash", "Read", "Write", "Plan", "PlanTool"]) {
      expect(isPlanApproval(tool), tool).toBe(false);
    }
  });
});

describe("the plan text is surfaced for review", () => {
  it("reads the plan field the CLI uses", () => {
    const plan = "## Plan\n1. Add the flag\n2. Test it";
    expect(planApprovalText(request("ExitPlanMode", { plan }))).toBe(plan);
  });

  it("falls back to other carriers rather than showing an empty review", () => {
    expect(planApprovalText(request("ExitPlanMode", { content: "do the thing" }))).toBe(
      "do the thing",
    );
    expect(planApprovalText(request("ExitPlanMode", { text: "do it" }))).toBe("do it");
  });

  it("ignores a blank plan, so the UI can fall back to a generic prompt", () => {
    expect(planApprovalText(request("ExitPlanMode", { plan: "   " }))).toBeNull();
    expect(planApprovalText(request("ExitPlanMode", {}))).toBeNull();
  });

  it("returns null for a tool that is not a plan", () => {
    expect(planApprovalText(request("Edit", { plan: "not a plan tool" }))).toBeNull();
  });
});

describe("the approval title is human", () => {
  it("asks for a plan review rather than naming the tool", () => {
    expect(permissionTitle("ExitPlanMode")).toBe("Review the plan");
  });

  it("still names an ordinary tool, which is the useful thing there", () => {
    expect(permissionTitle("Bash")).toBe("Bash needs your approval");
  });
});
