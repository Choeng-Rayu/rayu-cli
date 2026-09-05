// Permission auto-approval policy (R5.4, R10.4).
//
// Pure, editor-agnostic functions that decide whether a tool action requires
// explicit user approval. The policy is grounded in the design's Permission
// Mode table, reproduced here exactly:
//
//   | Mode               | Edit tools | Bash   | Read-only |
//   |--------------------|------------|--------|-----------|
//   | default            | prompt     | prompt | auto      |
//   | acceptEdits        | auto       | prompt | auto      |
//   | bypassPermissions  | auto       | auto   | auto      |
//   | plan               | prompt     | prompt | auto      |
//   | dontAsk            | deny*      | deny*  | auto      |
//
//   (* dontAsk denies anything not pre-approved — i.e. never auto-approves
//   edit/bash and never prompts; it answers `deny` directly.)
//
// No `vscode` import (R13.1, R13.5).

import type { PermissionMode } from "../protocol/wire.js";

/**
 * The three tool-action categories the permission policy distinguishes
 * (matching the design's table columns). Every tool name maps to exactly one of
 * these via {@link categorizeTool}.
 */
export type ToolCategory = "edit" | "bash" | "read-only";

/**
 * Whether a tool action in the given category is auto-approved (no prompt)
 * under the given permission mode — a direct, total encoding of the design's
 * Permission Mode table.
 *
 * Read-only actions are auto-approved in every mode. Edit actions are
 * auto-approved only under `acceptEdits` and `bypassPermissions`. Bash actions
 * are auto-approved only under `bypassPermissions`. `dontAsk` never
 * auto-approves edit/bash (it denies them — see {@link decidePermission}), so
 * this returns `false` for those.
 */
export function shouldAutoApprove(
  mode: PermissionMode,
  category: ToolCategory,
): boolean {
  if (category === "read-only") {
    return true;
  }
  if (category === "edit") {
    return mode === "acceptEdits" || mode === "bypassPermissions";
  }
  // category === "bash"
  return mode === "bypassPermissions";
}

/** Tool names that modify files (the "edit" category). */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/** Tool names that are read-only / side-effect-free (the "read-only" category). */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
]);

/**
 * Map a tool name to its permission category. `Bash` is the bash category;
 * Write/Edit/MultiEdit/NotebookEdit are edit; Read/Glob/Grep/LS and similar
 * read tools are read-only.
 *
 * An unrecognized tool is treated as the most restrictive category (`bash`) so
 * it is never auto-approved outside `bypassPermissions` — a fail-safe default
 * that keeps an unknown side-effecting tool gated behind a prompt.
 */
export function categorizeTool(toolName: string): ToolCategory {
  if (toolName === "Bash") {
    return "bash";
  }
  if (EDIT_TOOLS.has(toolName)) {
    return "edit";
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    return "read-only";
  }
  return "bash";
}

/** The action the coordinator takes for a permission request. */
export type PermissionDecision = "allow" | "deny" | "prompt";

/**
 * The full per-request decision combining the auto-approval policy with the
 * `dontAsk` deny-by-default behavior:
 *
 *  - auto-approved category ⇒ `allow` (no prompt);
 *  - otherwise under `dontAsk` ⇒ `deny` (no prompt, "deny-if-not-preapproved");
 *  - otherwise ⇒ `prompt` (surface for explicit user decision).
 *
 * Auto-approval happens if and only if {@link shouldAutoApprove} is true,
 * keeping the policy the single source of truth for the `allow` branch.
 */
export function decidePermission(
  mode: PermissionMode,
  category: ToolCategory,
): PermissionDecision {
  if (shouldAutoApprove(mode, category)) {
    return "allow";
  }
  if (mode === "dontAsk") {
    return "deny";
  }
  return "prompt";
}
