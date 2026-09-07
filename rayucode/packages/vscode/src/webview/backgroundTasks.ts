/**
 * Background tasks — UI_PARITY flow 17.
 *
 * The engine reports long-running work with a `system/task_started` frame carrying
 * `task_id`, `description`, `task_type` and (for local workflows) `workflow_name`,
 * and the control protocol has a `stop_task` request to cancel one. Neither was being
 * used: a task that ran in the background was invisible, so a user had no idea work
 * was still happening and no way to stop it.
 *
 * The reducer here is pure so the lifecycle is testable without a session. It follows
 * the panel's standing rule — render what the engine reports, never recompute — so a
 * task is only listed because a frame said so, and only removed because a frame or a
 * completed turn said so.
 */

/** A task the engine has told us about. */
export type BackgroundTask = {
  readonly taskId: string;
  /** Human description from the engine. */
  readonly description: string;
  /** Engine-supplied kind, e.g. 'local_workflow'. Undefined when not reported. */
  readonly taskType?: string;
  /** Workflow name, set only when taskType is 'local_workflow'. */
  readonly workflowName?: string;
  /** The tool use that spawned it, when the engine reported one. */
  readonly toolUseId?: string;
};

/** A `system/task_started` frame, narrowed to what this module needs. */
export type TaskStartedFrame = {
  task_id?: unknown;
  description?: unknown;
  task_type?: unknown;
  workflow_name?: unknown;
  tool_use_id?: unknown;
};

/**
 * Add a started task, or null when the frame is unusable.
 *
 * A frame without a `task_id` cannot be tracked or stopped, so it is dropped rather
 * than shown as an unstoppable entry. A duplicate id replaces the existing entry —
 * the engine is the authority on a task's description.
 */
export function withTaskStarted(
  current: readonly BackgroundTask[],
  frame: TaskStartedFrame,
): BackgroundTask[] | null {
  const taskId = typeof frame.task_id === "string" ? frame.task_id.trim() : "";
  if (taskId.length === 0) return null;

  const task: BackgroundTask = {
    taskId,
    description:
      typeof frame.description === "string" && frame.description.trim().length > 0
        ? frame.description
        : // A task with no description still needs a label, or the row is blank.
          "Background task",
    ...(typeof frame.task_type === "string" ? { taskType: frame.task_type } : {}),
    ...(typeof frame.workflow_name === "string"
      ? { workflowName: frame.workflow_name }
      : {}),
    ...(typeof frame.tool_use_id === "string" ? { toolUseId: frame.tool_use_id } : {}),
  };

  const without = current.filter((existing) => existing.taskId !== taskId);
  return [...without, task];
}

/** Remove a finished or stopped task. */
export function withTaskEnded(
  current: readonly BackgroundTask[],
  taskId: string,
): BackgroundTask[] {
  return current.filter((task) => task.taskId !== taskId);
}

/**
 * The label for a task row.
 *
 * A workflow's name is more meaningful than its generic description, so it wins when
 * present — "spec" tells the user what is running better than "Running local workflow".
 */
export function taskLabel(task: BackgroundTask): string {
  if (task.workflowName !== undefined && task.workflowName.length > 0) {
    return `${task.workflowName} — ${task.description}`;
  }
  return task.description;
}
