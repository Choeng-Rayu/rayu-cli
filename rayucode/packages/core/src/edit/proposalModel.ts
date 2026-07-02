// EditProposalModel — convert agent file-edit tool actions into a FileEditPlan
// (R6.1).
//
// The agent's file edits arrive as `tool_use` blocks named `Write`, `Edit`, or
// `MultiEdit`. This model converts an approved/aggregated set of those actions
// into a `FileEditPlan` whose every change carries a `baseContentHash` captured
// from the file's content at the moment the proposal is generated (R6.1) — the
// value the apply engine later compares against to detect a conflict (R6.3).
//
// It is pure and editor-agnostic: the caller injects a `BaseContentProvider`
// that yields the current on-disk content of a path (or `null` if the file does
// not exist). No process, no `vscode`, no filesystem access here (R13.1, R13.5).
//
// Tool input shapes (the Claude Code / Rayu tool schemas):
//   Write     { file_path, content }
//   Edit      { file_path, old_string, new_string, replace_all? }
//   MultiEdit { file_path, edits: { old_string, new_string, replace_all? }[] }
//
// `newContent` is the FULL post-edit file content: for `Write` it is the
// provided content; for `Edit`/`MultiEdit` it is computed by applying the
// string replacements to the base content. Multiple actions targeting the same
// file are aggregated in encounter order, composing on the evolving content
// while the `baseContentHash` stays pinned to the original base.

import type { FileEditChange, FileEditPlan } from "../editor/adapter.js";
import type { ToolUseBlock } from "../protocol/primitives.js";
import { hashContent } from "./contentHash.js";

/**
 * Resolves the base (pre-edit) content of a path at proposal-generation time.
 * Returns the file's current content, or `null` when the file does not exist
 * (so the resulting change is a `create`).
 */
export type BaseContentProvider = (path: string) => string | null;

/** Options for {@link EditProposalModel}. */
export interface EditProposalModelOptions {
  /** Content hash used to capture each change's base. Defaults to {@link hashContent}. */
  hash?: (content: string) => string;
}

/** Tool names this model knows how to convert into file edits. */
const SUPPORTED_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
]);

/** Whether `name` is a file-edit tool the proposal model can convert. */
export function isEditToolName(name: string): boolean {
  return SUPPORTED_TOOLS.has(name);
}

/** A single normalized string replacement extracted from an Edit/MultiEdit input. */
interface StringEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function coerceStringEdit(
  input: Record<string, unknown>,
  path: string,
): StringEdit {
  const oldString = coerceString(input["old_string"]);
  const newString = coerceString(input["new_string"]);
  if (oldString === undefined || newString === undefined) {
    throw new Error(
      `Edit for ${path} is missing a string old_string/new_string`,
    );
  }
  return { oldString, newString, replaceAll: input["replace_all"] === true };
}

function coerceMultiEdits(
  input: Record<string, unknown>,
  path: string,
): StringEdit[] {
  const raw = input["edits"];
  if (!Array.isArray(raw)) {
    throw new Error(`MultiEdit for ${path} is missing an edits array`);
  }
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`MultiEdit edit #${index} for ${path} is not an object`);
    }
    return coerceStringEdit(item as Record<string, unknown>, path);
  });
}

/** Apply one string replacement, throwing if `old_string` is empty or absent. */
function applyStringEdit(
  content: string,
  edit: StringEdit,
  path: string,
): string {
  if (edit.oldString === "") {
    throw new Error(`Edit for ${path} has an empty old_string`);
  }
  if (!content.includes(edit.oldString)) {
    throw new Error(`Edit old_string not found in ${path}`);
  }
  if (edit.replaceAll) {
    return content.split(edit.oldString).join(edit.newString);
  }
  const index = content.indexOf(edit.oldString);
  return (
    content.slice(0, index) +
    edit.newString +
    content.slice(index + edit.oldString.length)
  );
}

/** Compute the content after applying a single tool action to `content`. */
function applyAction(
  action: ToolUseBlock,
  content: string,
  path: string,
): string {
  switch (action.name) {
    case "Write": {
      const full = coerceString(action.input["content"]);
      if (full === undefined) {
        throw new Error(`Write for ${path} is missing string content`);
      }
      return full;
    }
    case "Edit": {
      return applyStringEdit(content, coerceStringEdit(action.input, path), path);
    }
    case "MultiEdit": {
      let next = content;
      for (const edit of coerceMultiEdits(action.input, path)) {
        next = applyStringEdit(next, edit, path);
      }
      return next;
    }
    default:
      // Unreachable: callers gate on isEditToolName. Kept exhaustive for safety.
      throw new Error(`Unsupported edit tool: ${action.name}`);
  }
}

/** Aggregation state for a single target file while building a plan. */
interface FileAccumulator {
  existed: boolean;
  baseContent: string;
  content: string;
}

/**
 * Converts approved Write/Edit/MultiEdit tool actions into a {@link FileEditPlan}
 * (R6.1). Stateless aside from the injected hash; one instance can build many
 * plans.
 */
export class EditProposalModel {
  private readonly hash: (content: string) => string;

  constructor(options: EditProposalModelOptions = {}) {
    this.hash = options.hash ?? hashContent;
  }

  /**
   * Build a plan from `actions`, capturing each file's base content (via
   * `getBaseContent`) and hash at proposal-generation time. Non-edit tool
   * actions are ignored. Throws if an action is malformed (missing `file_path`,
   * missing content/strings) or if an `Edit`/`MultiEdit` cannot be applied
   * (`old_string` empty or not found in the base content).
   */
  buildPlan(
    actions: readonly ToolUseBlock[],
    getBaseContent: BaseContentProvider,
  ): FileEditPlan {
    const order: string[] = [];
    const byPath = new Map<string, FileAccumulator>();

    for (const action of actions) {
      if (!isEditToolName(action.name)) {
        continue;
      }
      const path = coerceString(action.input["file_path"]);
      if (path === undefined) {
        throw new Error(`${action.name} action is missing a string file_path`);
      }

      let acc = byPath.get(path);
      if (acc === undefined) {
        const base = getBaseContent(path);
        acc = {
          existed: base !== null,
          baseContent: base ?? "",
          content: base ?? "",
        };
        byPath.set(path, acc);
        order.push(path);
      }
      acc.content = applyAction(action, acc.content, path);
    }

    const changes: FileEditChange[] = order.map((path) => {
      const acc = byPath.get(path) as FileAccumulator;
      const change: FileEditChange = {
        path,
        kind: acc.existed ? "modify" : "create",
        newContent: acc.content,
      };
      // A base hash is only meaningful for a file that existed at proposal
      // time; a `create` has nothing on disk to conflict with (R6.3).
      if (acc.existed) {
        change.baseContentHash = this.hash(acc.baseContent);
      }
      return change;
    });

    return { changes };
  }
}
