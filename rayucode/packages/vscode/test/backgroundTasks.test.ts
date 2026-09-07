/**
 * Background tasks — UI_PARITY flow 17.
 *
 * The engine reports long-running work with `system/task_started` (task_id,
 * description, task_type, workflow_name) and accepts a `stop_task` control request.
 * Neither was used, so a task running in the background was invisible: no indication
 * work was still happening, and no way to stop it.
 */
import { describe, expect, it } from "vitest";

import {
  taskLabel,
  withTaskEnded,
  withTaskStarted,
  type BackgroundTask,
} from "../src/webview/backgroundTasks.js";

describe("tracking started tasks", () => {
  it("adds a reported task", () => {
    const next = withTaskStarted([], {
      task_id: "t1",
      description: "Running the test suite",
    });
    expect(next).toEqual([{ taskId: "t1", description: "Running the test suite" }]);
  });

  it("drops a frame with no task_id, which could not be stopped", () => {
    // An unstoppable row is worse than none.
    expect(withTaskStarted([], { description: "orphan" })).toBeNull();
    expect(withTaskStarted([], { task_id: "   ", description: "orphan" })).toBeNull();
  });

  it("labels a task with no description rather than showing a blank row", () => {
    const next = withTaskStarted([], { task_id: "t1" });
    expect(next?.[0]?.description).toBe("Background task");
  });

  it("replaces a repeated id, since the engine is the authority", () => {
    const first = withTaskStarted([], { task_id: "t1", description: "old" })!;
    const second = withTaskStarted(first, { task_id: "t1", description: "new" })!;
    expect(second).toHaveLength(1);
    expect(second[0]?.description).toBe("new");
  });

  it("carries the workflow fields when present", () => {
    const next = withTaskStarted([], {
      task_id: "t1",
      description: "Running a workflow",
      task_type: "local_workflow",
      workflow_name: "spec",
      tool_use_id: "tu1",
    })!;
    expect(next[0]).toEqual({
      taskId: "t1",
      description: "Running a workflow",
      taskType: "local_workflow",
      workflowName: "spec",
      toolUseId: "tu1",
    });
  });

  it("omits fields the engine did not report", () => {
    const task = withTaskStarted([], { task_id: "t1", description: "d" })![0]!;
    expect("taskType" in task).toBe(false);
    expect("workflowName" in task).toBe(false);
  });

  it("keeps other tasks when one starts", () => {
    const one = withTaskStarted([], { task_id: "t1", description: "a" })!;
    const two = withTaskStarted(one, { task_id: "t2", description: "b" })!;
    expect(two.map((t) => t.taskId)).toEqual(["t1", "t2"]);
  });
});

describe("ending tasks", () => {
  it("removes only the named task", () => {
    const tasks: BackgroundTask[] = [
      { taskId: "t1", description: "a" },
      { taskId: "t2", description: "b" },
    ];
    expect(withTaskEnded(tasks, "t1").map((t) => t.taskId)).toEqual(["t2"]);
  });

  it("is a no-op for an unknown id", () => {
    const tasks: BackgroundTask[] = [{ taskId: "t1", description: "a" }];
    expect(withTaskEnded(tasks, "nope")).toEqual(tasks);
  });
});

describe("the task label", () => {
  it("leads with the workflow name, which says more than the description", () => {
    expect(
      taskLabel({ taskId: "t", description: "Running local workflow", workflowName: "spec" }),
    ).toBe("spec — Running local workflow");
  });

  it("falls back to the description", () => {
    expect(taskLabel({ taskId: "t", description: "Running tests" })).toBe(
      "Running tests",
    );
  });
});
