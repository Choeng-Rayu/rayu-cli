import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  categorizeTool,
  decidePermission,
  PermissionCoordinator,
  shouldAutoApprove,
} from "../src/index.js";
import type {
  PermissionMode,
  PermissionRequestConversationItem,
  PermissionRequestEvent,
  PermissionToolOutput,
  StdinMessage,
  ToolActionConversationItem,
  ToolCategory,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test harness — captures the permission control_responses the coordinator
// writes, plus the order of responses relative to process termination.
// ---------------------------------------------------------------------------

interface CapturedResponse {
  requestId: string;
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

type OrderEntry =
  | { kind: "response"; requestId: string; behavior: "allow" | "deny" }
  | { kind: "terminate" };

function makeHarness(initialMode: PermissionMode = "default") {
  const responses: CapturedResponse[] = [];
  const order: OrderEntry[] = [];

  const send = (message: StdinMessage): void => {
    if (
      message.type === "control_response" &&
      message.response.subtype === "success"
    ) {
      const payload = message.response.response as
        | PermissionToolOutput
        | undefined;
      if (payload && (payload.behavior === "allow" || payload.behavior === "deny")) {
        const entry: CapturedResponse = {
          requestId: message.response.request_id,
          behavior: payload.behavior,
        };
        if (payload.behavior === "allow") {
          entry.updatedInput = payload.updatedInput;
        } else {
          entry.message = payload.message;
        }
        responses.push(entry);
        order.push({
          kind: "response",
          requestId: message.response.request_id,
          behavior: payload.behavior,
        });
      }
    }
  };

  const coordinator = new PermissionCoordinator({ send, initialMode });
  const terminate = (): void => {
    order.push({ kind: "terminate" });
  };

  return { coordinator, responses, order, terminate };
}

function mkEvent(
  requestId: string,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId = `t-${requestId}`,
): PermissionRequestEvent {
  return {
    requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      input,
      tool_use_id: toolUseId,
    },
  };
}

const permissionMode = fc.constantFrom<PermissionMode>(
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
);

const toolCategory = fc.constantFrom<ToolCategory>("edit", "bash", "read-only");

/** A representative tool name for each category (round-trips via categorizeTool). */
const REP_TOOL: Record<ToolCategory, string> = {
  edit: "Write",
  bash: "Bash",
  "read-only": "Read",
};

const jsonInput = fc.dictionary(
  fc.constantFrom("command", "path", "content", "a", "b", "c", "x"),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
  { maxKeys: 5 },
);

// ---------------------------------------------------------------------------
// Property 7 — auto-approval policy matches mode (task 5.4)
// ---------------------------------------------------------------------------

describe("PermissionCoordinator auto-approval policy", () => {
  it("auto-approves iff shouldAutoApprove is true; otherwise prompts (or denies under dontAsk)", () => {
    // Feature: rayucode, Property 7: For any permission mode and any tool-action category, the coordinator auto-approves without prompting if and only if `shouldAutoApprove(mode, category)` is true; otherwise it surfaces a prompt (or denies under `dontAsk`).
    // Validates: Requirements 5.4, 10.4
    fc.assert(
      fc.property(permissionMode, toolCategory, (mode, category) => {
        const { coordinator, responses } = makeHarness(mode);
        const toolName = REP_TOOL[category];
        // Sanity: the representative tool maps back to the intended category.
        expect(categorizeTool(toolName)).toBe(category);

        coordinator.handlePermissionRequest(
          mkEvent("r-1", toolName, { command: "ls -la", path: "/x" }),
        );

        const auto = shouldAutoApprove(mode, category);
        if (auto) {
          // Auto-approved without prompting: exactly one allow, nothing pending.
          expect(responses).toHaveLength(1);
          expect(responses[0]!.behavior).toBe("allow");
          expect(coordinator.pendingCount).toBe(0);
        } else if (mode === "dontAsk") {
          // Denied without prompting.
          expect(responses).toHaveLength(1);
          expect(responses[0]!.behavior).toBe("deny");
          expect(coordinator.pendingCount).toBe(0);
        } else {
          // Surfaced for an explicit decision: no response yet, one pending,
          // one unresolved permission_request item.
          expect(responses).toHaveLength(0);
          expect(coordinator.pendingCount).toBe(1);
          const surfaced = coordinator.conversationItems.filter(
            (i): i is PermissionRequestConversationItem =>
              i.kind === "permission_request" && i.resolution === undefined,
          );
          expect(surfaced).toHaveLength(1);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8 — allow response carries the approved input (task 5.5)
// ---------------------------------------------------------------------------

describe("PermissionCoordinator allow response", () => {
  it("emits behavior:'allow' with updatedInput equal to the input the user approved", () => {
    // Feature: rayucode, Property 8: For any approved permission request, the emitted `control_response` has `behavior: 'allow'` and its `updatedInput` equals the input the user approved.
    // Validates: Requirements 5.2
    fc.assert(
      fc.property(
        jsonInput,
        fc.option(jsonInput, { nil: undefined }),
        fc.boolean(),
        (requested, edited, passEdited) => {
          // `default` mode prompts for a Bash action, so it becomes pending.
          const { coordinator, responses } = makeHarness("default");
          coordinator.handlePermissionRequest(mkEvent("r-1", "Bash", requested));
          expect(coordinator.pendingCount).toBe(1);
          expect(responses).toHaveLength(0);

          const approvedInput = passEdited ? edited : undefined;
          const accepted = coordinator.approve("r-1", approvedInput);
          expect(accepted).toBe(true);

          expect(responses).toHaveLength(1);
          expect(responses[0]!.behavior).toBe("allow");
          // The approved input is the edited input when provided, else the
          // input as originally requested.
          const expectedInput = approvedInput ?? requested;
          expect(responses[0]!.updatedInput).toEqual(expectedInput);
          expect(coordinator.pendingCount).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6 — permission default-deny on session close (task 5.3)
// ---------------------------------------------------------------------------

// Each request uses a tool that prompts under `default` (so it becomes
// pending), paired with how it is answered before the session closes.
const requestSpec = fc.record({
  tool: fc.constantFrom("Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"),
  answer: fc.constantFrom("none", "approve", "deny"),
});

describe("PermissionCoordinator default-deny on session close", () => {
  it("denies every still-pending request exactly once, all before the process is terminated", async () => {
    // Feature: rayucode, Property 6: For any set of pending permission requests at the moment a session is closed, every pending request receives exactly one `deny` response, and all deny responses are issued before the agent process is terminated.
    // Validates: Requirements 5.5
    await fc.assert(
      fc.asyncProperty(
        fc.array(requestSpec, { maxLength: 16 }),
        async (specs) => {
          const { coordinator, responses, order, terminate } =
            makeHarness("default");
          const ids = specs.map((_, i) => `r-${i}`);

          // Surface every request — each prompts under `default`.
          specs.forEach((spec, i) => {
            coordinator.handlePermissionRequest(
              mkEvent(ids[i]!, spec.tool, { command: "c", idx: i }, `t-${i}`),
            );
          });
          expect(coordinator.pendingCount).toBe(specs.length);

          // Answer a subset before close.
          const answered = new Map<string, "approve" | "deny">();
          specs.forEach((spec, i) => {
            if (spec.answer === "approve") {
              coordinator.approve(ids[i]!);
              answered.set(ids[i]!, "approve");
            } else if (spec.answer === "deny") {
              coordinator.deny(ids[i]!, "user-deny");
              answered.set(ids[i]!, "deny");
            }
          });

          const pendingAtClose = ids.filter((id) => !answered.has(id));
          expect(coordinator.pendingCount).toBe(pendingAtClose.length);

          // Close: default-deny every still-pending request, then terminate.
          await coordinator.close(terminate);
          expect(coordinator.pendingCount).toBe(0);

          // Every request id received exactly one response overall.
          const countById = new Map<string, number>();
          for (const r of responses) {
            countById.set(r.requestId, (countById.get(r.requestId) ?? 0) + 1);
          }
          for (const id of ids) {
            expect(countById.get(id)).toBe(1);
          }

          // Each still-pending-at-close request got exactly one deny.
          for (const id of pendingAtClose) {
            const forId = responses.filter((r) => r.requestId === id);
            expect(forId).toHaveLength(1);
            expect(forId[0]!.behavior).toBe("deny");
          }

          // Answered requests kept their user-chosen behavior (not re-denied).
          for (const [id, answer] of answered) {
            const forId = responses.filter((r) => r.requestId === id);
            expect(forId).toHaveLength(1);
            expect(forId[0]!.behavior).toBe(answer === "approve" ? "allow" : "deny");
          }

          // Exactly one terminate, and it follows every response (all deny
          // responses are issued before the process is terminated).
          const terminates = order.filter((e) => e.kind === "terminate");
          expect(terminates).toHaveLength(1);
          const terminateIndex = order.findIndex((e) => e.kind === "terminate");
          expect(terminateIndex).toBe(order.length - 1);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — the policy table and concrete coordinator behaviors
// ---------------------------------------------------------------------------

describe("permission policy table", () => {
  // The design's Permission Mode table, encoded exactly.
  const autoApprove: Record<PermissionMode, Record<ToolCategory, boolean>> = {
    default: { edit: false, bash: false, "read-only": true },
    acceptEdits: { edit: true, bash: false, "read-only": true },
    bypassPermissions: { edit: true, bash: true, "read-only": true },
    plan: { edit: false, bash: false, "read-only": true },
    dontAsk: { edit: false, bash: false, "read-only": true },
  };
  const decision: Record<PermissionMode, Record<ToolCategory, string>> = {
    default: { edit: "prompt", bash: "prompt", "read-only": "allow" },
    acceptEdits: { edit: "allow", bash: "prompt", "read-only": "allow" },
    bypassPermissions: { edit: "allow", bash: "allow", "read-only": "allow" },
    plan: { edit: "prompt", bash: "prompt", "read-only": "allow" },
    dontAsk: { edit: "deny", bash: "deny", "read-only": "allow" },
  };
  const modes: PermissionMode[] = [
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
  ];
  const categories: ToolCategory[] = ["edit", "bash", "read-only"];

  it("shouldAutoApprove matches the design table exactly", () => {
    for (const mode of modes) {
      for (const category of categories) {
        expect(shouldAutoApprove(mode, category)).toBe(
          autoApprove[mode][category],
        );
      }
    }
  });

  it("decidePermission matches the design table exactly", () => {
    for (const mode of modes) {
      for (const category of categories) {
        expect(decidePermission(mode, category)).toBe(decision[mode][category]);
      }
    }
  });
});

describe("categorizeTool", () => {
  it("maps edit, bash, and read-only tools to their categories", () => {
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(categorizeTool(t)).toBe("edit");
    }
    expect(categorizeTool("Bash")).toBe("bash");
    for (const t of ["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch"]) {
      expect(categorizeTool(t)).toBe("read-only");
    }
  });

  it("treats an unrecognized tool as the most restrictive category (bash)", () => {
    expect(categorizeTool("Frobnicate")).toBe("bash");
    expect(categorizeTool("")).toBe("bash");
  });
});

describe("PermissionCoordinator behaviors", () => {
  it("auto-approves a read-only tool and surfaces a running tool action (R10.1)", () => {
    const { coordinator, responses } = makeHarness("default");
    coordinator.handlePermissionRequest(mkEvent("r-1", "Read", { path: "a.ts" }));
    expect(responses).toEqual([
      { requestId: "r-1", behavior: "allow", updatedInput: { path: "a.ts" } },
    ]);
    const tool = coordinator.conversationItems.find(
      (i): i is ToolActionConversationItem => i.kind === "tool_action",
    )!;
    expect(tool.toolName).toBe("Read");
    expect(tool.status).toBe("running");
  });

  it("surfaces a bash request with the exact command string (R5.6)", () => {
    const { coordinator } = makeHarness("default");
    coordinator.handlePermissionRequest(
      mkEvent("r-1", "Bash", { command: "rm -rf build" }),
    );
    const item = coordinator.conversationItems.find(
      (i): i is PermissionRequestConversationItem =>
        i.kind === "permission_request",
    )!;
    expect(item.command).toBe("rm -rf build");
    expect(item.resolution).toBeUndefined();
  });

  it("denies bash under dontAsk without prompting (R5.4)", () => {
    const { coordinator, responses } = makeHarness("dontAsk");
    const decisionTaken = coordinator.handlePermissionRequest(
      mkEvent("r-1", "Bash", { command: "ls" }),
    );
    expect(decisionTaken).toBe("deny");
    expect(responses).toHaveLength(1);
    expect(responses[0]!.behavior).toBe("deny");
    expect(coordinator.pendingCount).toBe(0);
  });

  it("records a tool result, marking the action complete with its output (R10.2)", () => {
    const { coordinator } = makeHarness("bypassPermissions");
    coordinator.handlePermissionRequest(
      mkEvent("r-1", "Bash", { command: "echo hi" }, "tool-1"),
    );
    expect(coordinator.recordToolResult("tool-1", "hi\n")).toBe(true);
    const tool = coordinator.conversationItems.find(
      (i): i is ToolActionConversationItem => i.kind === "tool_action",
    )!;
    expect(tool.status).toBe("complete");
    expect(tool.output).toBe("hi\n");
  });

  it("ignores approve/deny for an unknown or already-answered request", () => {
    const { coordinator, responses } = makeHarness("default");
    expect(coordinator.approve("missing")).toBe(false);
    coordinator.handlePermissionRequest(mkEvent("r-1", "Bash", { command: "ls" }));
    expect(coordinator.deny("r-1", "no")).toBe(true);
    // A second answer is a no-op (no duplicate response).
    expect(coordinator.deny("r-1")).toBe(false);
    expect(coordinator.approve("r-1")).toBe(false);
    expect(responses.filter((r) => r.requestId === "r-1")).toHaveLength(1);
  });

  it("notifies onItemsChanged whenever produced items change", () => {
    const snapshots: number[] = [];
    const coordinator = new PermissionCoordinator({
      send: () => {},
      initialMode: "default",
      onItemsChanged: (items) => snapshots.push(items.length),
    });
    coordinator.handlePermissionRequest(mkEvent("r-1", "Bash", { command: "ls" }));
    coordinator.approve("r-1");
    // At least: surfaced (1 item), resolved (still 1), tool action (2 items).
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[snapshots.length - 1]).toBe(2);
  });
});
