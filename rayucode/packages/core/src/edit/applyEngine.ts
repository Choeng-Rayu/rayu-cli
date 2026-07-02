// Pure file-edit apply engine (R6.3, R6.5, R6.6).
//
// This is the editor-AGNOSTIC core of file-edit application. It operates over
// an in-memory file model (a `Record<path, content>`) and returns an
// `ApplyResult` plus a NEW model — it never mutates the input model. The
// concrete editor-side applier (the VS Code `WorkspaceEdit` path) is a later
// task (12.4); it performs the same per-file classification against the real
// workspace. Keeping the decision logic here, pure, lets Properties 9 and 10 be
// validated with no `vscode` dependency present (reinforcing R13.5).
//
// Per-change handling, in order:
//   1. Injected failure  — a supplied predicate (or a thrown error) records the
//      change in `failed` and modifies nothing (models a real write error).
//   2. Conflict (R6.3)   — when a `baseContentHash` was captured and the file's
//      current content hash differs (including a file that has since been
//      removed), the change is recorded in `conflicts` and NOT applied. The
//      host then requires explicit confirmation before overriding.
//   3. Structural failure — `modify` of a missing file (with no captured base)
//      or `create` of an existing file is recorded in `failed`.
//   4. Apply              — `create` adds a new file, `modify` replaces the
//      existing content; the path is recorded in `applied`.
//
// Each file is processed independently, so any single failure or conflict
// leaves every other file — already applied or not yet attempted — untouched
// (partial-failure isolation, R6.6).

import type {
  ApplyResult,
  FileEditChange,
  FileEditPlan,
} from "../editor/adapter.js";
import { hashContent } from "./contentHash.js";

/** An in-memory model of file contents keyed by (workspace-relative) path. */
export type FileModel = Record<string, string>;

/**
 * Decides, per change, whether to force a failure. Returns a non-empty reason
 * string to fail the change, or `null` to let it proceed. Used to drive
 * deterministic failures in tests (Property 9) and, in production, to model a
 * file-specific write error surfaced by the editor host.
 */
export type FailurePredicate = (change: FileEditChange) => string | null;

/** Options for {@link applyEditPlan}. */
export interface ApplyEngineOptions {
  /** Content hash used for conflict detection. Defaults to {@link hashContent}. */
  hash?: (content: string) => string;
  /** Optional per-change failure injection (tests / simulated write errors). */
  shouldFail?: FailurePredicate;
}

/** The outcome of {@link applyEditPlan}: the result and the resulting model. */
export interface ApplyEngineResult {
  /** Per-file classification (applied / failed / conflicts). */
  result: ApplyResult;
  /** A NEW file model reflecting the applied changes; the input is unchanged. */
  model: FileModel;
}

const REASON_MODIFY_MISSING = "cannot modify a file that does not exist";
const REASON_CREATE_EXISTS = "cannot create a file that already exists";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Apply a {@link FileEditPlan} to a copy of `model`, classifying each change as
 * applied, failed, or a conflict, and returning both the result and the new
 * model. The input `model` is never mutated.
 */
export function applyEditPlan(
  model: FileModel,
  plan: FileEditPlan,
  options: ApplyEngineOptions = {},
): ApplyEngineResult {
  const hash = options.hash ?? hashContent;
  const shouldFail = options.shouldFail;

  // Work on a clone so the caller's model is never mutated (purity).
  const next: FileModel = { ...model };

  const applied: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  const conflicts: { path: string }[] = [];

  for (const change of plan.changes) {
    try {
      // 1. Injected/simulated failure: record and modify nothing.
      const injected = shouldFail ? shouldFail(change) : null;
      if (injected !== null) {
        failed.push({ path: change.path, reason: injected });
        continue;
      }

      const exists = Object.prototype.hasOwnProperty.call(next, change.path);

      // 2. Conflict detection (R6.3): a captured base that no longer matches
      //    the current content means the file changed since the proposal was
      //    generated (a removed file can never match a captured hash).
      if (change.baseContentHash !== undefined) {
        const currentHash = exists ? hash(next[change.path]) : null;
        if (currentHash !== change.baseContentHash) {
          conflicts.push({ path: change.path });
          continue;
        }
      }

      // 3. Structural failures independent of a captured base.
      if (change.kind === "modify" && !exists) {
        failed.push({ path: change.path, reason: REASON_MODIFY_MISSING });
        continue;
      }
      if (change.kind === "create" && exists) {
        failed.push({ path: change.path, reason: REASON_CREATE_EXISTS });
        continue;
      }

      // 4. Apply: create adds a new file, modify replaces existing content.
      next[change.path] = change.newContent;
      applied.push(change.path);
    } catch (error) {
      // A thrown error for one file must not abort the rest of the plan (R6.6).
      failed.push({ path: change.path, reason: errorMessage(error) });
    }
  }

  return { result: { applied, failed, conflicts }, model: next };
}
