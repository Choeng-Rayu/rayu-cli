import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyEditPlan,
  EditProposalModel,
  hashContent,
} from "../src/index.js";
import type {
  BaseContentProvider,
  FileEditChange,
  FileModel,
  ToolUseBlock,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Text that exercises newlines, tabs, quotes, unicode, and emoji. */
const richText = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 4 }),
      fc.constantFrom("\n", "\t", '"', "\\", "é", "中", "😀", " ", "{}"),
    ),
    { maxLength: 8 },
  )
  .map((parts) => parts.join(""));

// ---------------------------------------------------------------------------
// Property 9 — file-edit partial-failure isolation (task 6.2)
// ---------------------------------------------------------------------------

// A plan member: a `modify` of an existing file (base hash matches current, so
// it is NOT a conflict) or a `create` of a fresh path, plus whether this change
// is forced to fail. Failures are driven deterministically via an injected
// predicate, exactly as the task prescribes.
const memberSpec = fc.record({
  kind: fc.constantFrom<"modify" | "create">("modify", "create"),
  baseContent: richText, // initial on-disk content for a `modify`
  newContent: richText, // intended post-edit content
  fail: fc.boolean(),
});

describe("applyEditPlan partial-failure isolation", () => {
  it("non-failing targets reach their intended state; every other file is unchanged, for any failing subset", () => {
    // Feature: rayucode, Property 9: For any file-edit plan in which an arbitrary subset of changes fails to apply, every non-failing change's target ends in its intended post-edit state and every file not in the plan is unchanged, regardless of which subset failed.
    // Validates: Requirements 6.6
    fc.assert(
      fc.property(
        fc.array(memberSpec, { maxLength: 24 }),
        fc.array(richText, { maxLength: 6 }), // bystander file contents
        (specs, bystanderContents) => {
          // Bystanders are files present in the model but NOT in the plan.
          const initial: FileModel = {};
          bystanderContents.forEach((content, i) => {
            initial[`by-${i}`] = content;
          });

          const changes: FileEditChange[] = [];
          const failPaths = new Set<string>();
          specs.forEach((spec, index) => {
            const path = `plan-${index}`;
            const change: FileEditChange = {
              path,
              kind: spec.kind,
              newContent: spec.newContent,
            };
            if (spec.kind === "modify") {
              // Existing file whose base hash matches → not a conflict.
              initial[path] = spec.baseContent;
              change.baseContentHash = hashContent(spec.baseContent);
            }
            changes.push(change);
            if (spec.fail) {
              failPaths.add(path);
            }
          });

          const frozen = { ...initial };
          const { result, model } = applyEditPlan(
            initial,
            { changes },
            { shouldFail: (c) => (failPaths.has(c.path) ? "injected" : null) },
          );

          // The input model is never mutated (purity).
          expect(initial).toEqual(frozen);

          specs.forEach((spec, index) => {
            const path = `plan-${index}`;
            if (failPaths.has(path)) {
              // Failed change: recorded in `failed` and target left untouched.
              expect(result.failed.some((f) => f.path === path)).toBe(true);
              expect(result.applied).not.toContain(path);
              if (spec.kind === "modify") {
                expect(model[path]).toBe(spec.baseContent);
              } else {
                expect(
                  Object.prototype.hasOwnProperty.call(model, path),
                ).toBe(false);
              }
            } else {
              // Non-failing change: applied to its intended post-edit state.
              expect(result.applied).toContain(path);
              expect(model[path]).toBe(spec.newContent);
            }
          });

          // Every file not in the plan is unchanged.
          bystanderContents.forEach((content, i) => {
            expect(model[`by-${i}`]).toBe(content);
          });

          // No conflicts arise here (every captured base matches its file).
          expect(result.conflicts).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10 — conflict detection on stale base (task 6.3)
// ---------------------------------------------------------------------------

const conflictSpec = fc.record({
  currentContent: richText, // what's on disk now
  baseContent: richText, // what the proposal captured as the base
  newContent: richText, // what the change would write
});

describe("applyEditPlan conflict detection", () => {
  it("classifies a change as a conflict and leaves the file unmodified exactly when the current hash differs from the captured base", () => {
    // Feature: rayucode, Property 10: For any edit change whose target's current on-disk content hash differs from the change's captured base hash, the apply step classifies that change as a conflict and does not modify the file without explicit confirmation.
    // Validates: Requirements 6.3
    fc.assert(
      fc.property(fc.array(conflictSpec, { maxLength: 24 }), (specs) => {
        const initial: FileModel = {};
        const changes: FileEditChange[] = [];
        specs.forEach((spec, index) => {
          const path = `f-${index}`;
          initial[path] = spec.currentContent;
          changes.push({
            path,
            kind: "modify",
            baseContentHash: hashContent(spec.baseContent),
            newContent: spec.newContent,
          });
        });

        const frozen = { ...initial };
        const { result, model } = applyEditPlan(initial, { changes });

        // The input model is never mutated (purity).
        expect(initial).toEqual(frozen);

        specs.forEach((spec, index) => {
          const path = `f-${index}`;
          const stale =
            hashContent(spec.currentContent) !== hashContent(spec.baseContent);
          if (stale) {
            // Stale base ⇒ conflict, and the file is NOT modified (R6.3).
            expect(result.conflicts.some((c) => c.path === path)).toBe(true);
            expect(result.applied).not.toContain(path);
            expect(model[path]).toBe(spec.currentContent);
          } else {
            // Base matches the current content ⇒ safe to apply.
            expect(result.applied).toContain(path);
            expect(model[path]).toBe(spec.newContent);
            expect(result.conflicts.some((c) => c.path === path)).toBe(false);
          }
        });
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example/unit tests — apply engine edge cases
// ---------------------------------------------------------------------------

describe("applyEditPlan examples", () => {
  it("creates a new file and modifies an existing one", () => {
    const { result, model } = applyEditPlan(
      { "a.ts": "old" },
      {
        changes: [
          {
            path: "a.ts",
            kind: "modify",
            baseContentHash: hashContent("old"),
            newContent: "new",
          },
          { path: "b.ts", kind: "create", newContent: "fresh" },
        ],
      },
    );
    expect(result.applied).toEqual(["a.ts", "b.ts"]);
    expect(result.failed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(model).toEqual({ "a.ts": "new", "b.ts": "fresh" });
  });

  it("fails a modify of a missing file (no base) and leaves the model untouched", () => {
    const { result, model } = applyEditPlan(
      { "keep.ts": "x" },
      { changes: [{ path: "missing.ts", kind: "modify", newContent: "y" }] },
    );
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe("missing.ts");
    expect(model).toEqual({ "keep.ts": "x" });
  });

  it("fails a create of an existing file", () => {
    const { result, model } = applyEditPlan(
      { "a.ts": "exists" },
      { changes: [{ path: "a.ts", kind: "create", newContent: "nope" }] },
    );
    expect(result.applied).toEqual([]);
    expect(result.failed[0]!.path).toBe("a.ts");
    expect(model).toEqual({ "a.ts": "exists" });
  });

  it("treats a captured base for a removed file as a conflict", () => {
    const { result, model } = applyEditPlan(
      {},
      {
        changes: [
          {
            path: "gone.ts",
            kind: "modify",
            baseContentHash: hashContent("was here"),
            newContent: "z",
          },
        ],
      },
    );
    expect(result.conflicts).toEqual([{ path: "gone.ts" }]);
    expect(result.applied).toEqual([]);
    expect(model).toEqual({});
  });

  it("isolates a thrown error in the failure predicate to the offending file", () => {
    const { result, model } = applyEditPlan(
      { "a.ts": "1", "b.ts": "2" },
      {
        changes: [
          {
            path: "a.ts",
            kind: "modify",
            baseContentHash: hashContent("1"),
            newContent: "A",
          },
          {
            path: "b.ts",
            kind: "modify",
            baseContentHash: hashContent("2"),
            newContent: "B",
          },
        ],
      },
      {
        shouldFail: (c) => {
          if (c.path === "a.ts") {
            throw new Error("disk on fire");
          }
          return null;
        },
      },
    );
    expect(result.failed).toEqual([{ path: "a.ts", reason: "disk on fire" }]);
    expect(result.applied).toEqual(["b.ts"]);
    // a.ts untouched; b.ts applied.
    expect(model).toEqual({ "a.ts": "1", "b.ts": "B" });
  });
});

// ---------------------------------------------------------------------------
// Example/unit tests — EditProposalModel
// ---------------------------------------------------------------------------

function toolUse(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id: `tu-${name}`, name, input };
}

/** A base-content provider over a fixed in-memory map (null ⇒ file absent). */
function provider(files: Record<string, string>): BaseContentProvider {
  return (path) =>
    Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null;
}

describe("EditProposalModel", () => {
  const model = new EditProposalModel();

  it("converts a Write of a new file into a create change with no base hash", () => {
    const plan = model.buildPlan(
      [toolUse("Write", { file_path: "new.ts", content: "hello" })],
      provider({}),
    );
    expect(plan.changes).toEqual([
      { path: "new.ts", kind: "create", newContent: "hello" },
    ]);
    expect(plan.changes[0]!.baseContentHash).toBeUndefined();
  });

  it("converts a Write over an existing file into a modify change carrying the base hash", () => {
    const plan = model.buildPlan(
      [toolUse("Write", { file_path: "a.ts", content: "next" })],
      provider({ "a.ts": "prev" }),
    );
    expect(plan.changes[0]).toEqual({
      path: "a.ts",
      kind: "modify",
      newContent: "next",
      baseContentHash: hashContent("prev"),
    });
  });

  it("computes newContent for an Edit by applying the replacement to the base", () => {
    const plan = model.buildPlan(
      [
        toolUse("Edit", {
          file_path: "a.ts",
          old_string: "world",
          new_string: "there",
        }),
      ],
      provider({ "a.ts": "hello world, world" }),
    );
    // First occurrence only (replace_all defaults to false).
    expect(plan.changes[0]!.newContent).toBe("hello there, world");
    expect(plan.changes[0]!.baseContentHash).toBe(hashContent("hello world, world"));
  });

  it("honors replace_all on an Edit", () => {
    const plan = model.buildPlan(
      [
        toolUse("Edit", {
          file_path: "a.ts",
          old_string: "x",
          new_string: "y",
          replace_all: true,
        }),
      ],
      provider({ "a.ts": "xxx" }),
    );
    expect(plan.changes[0]!.newContent).toBe("yyy");
  });

  it("applies MultiEdit replacements in sequence", () => {
    const plan = model.buildPlan(
      [
        toolUse("MultiEdit", {
          file_path: "a.ts",
          edits: [
            { old_string: "a", new_string: "b" },
            { old_string: "b", new_string: "c" },
          ],
        }),
      ],
      provider({ "a.ts": "a" }),
    );
    // a → b → c
    expect(plan.changes[0]!.newContent).toBe("c");
  });

  it("aggregates multiple actions on the same file, pinning the base to the original", () => {
    const plan = model.buildPlan(
      [
        toolUse("Write", { file_path: "a.ts", content: "one\n" }),
        toolUse("Edit", {
          file_path: "a.ts",
          old_string: "one",
          new_string: "two",
        }),
      ],
      provider({ "a.ts": "original" }),
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.newContent).toBe("two\n");
    // Base hash reflects the ORIGINAL on-disk content, not an intermediate.
    expect(plan.changes[0]!.baseContentHash).toBe(hashContent("original"));
  });

  it("preserves first-encounter order across multiple files", () => {
    const plan = model.buildPlan(
      [
        toolUse("Write", { file_path: "b.ts", content: "B" }),
        toolUse("Write", { file_path: "a.ts", content: "A" }),
      ],
      provider({}),
    );
    expect(plan.changes.map((c) => c.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("ignores non-edit tool actions", () => {
    const plan = model.buildPlan(
      [
        toolUse("Bash", { command: "ls" }),
        toolUse("Read", { file_path: "a.ts" }),
        toolUse("Write", { file_path: "a.ts", content: "C" }),
      ],
      provider({}),
    );
    expect(plan.changes).toEqual([
      { path: "a.ts", kind: "create", newContent: "C" },
    ]);
  });

  it("throws when an Edit old_string is not found in the base", () => {
    expect(() =>
      model.buildPlan(
        [
          toolUse("Edit", {
            file_path: "a.ts",
            old_string: "absent",
            new_string: "x",
          }),
        ],
        provider({ "a.ts": "present" }),
      ),
    ).toThrow(/old_string not found/);
  });

  it("throws when a tool action is missing file_path", () => {
    expect(() =>
      model.buildPlan([toolUse("Write", { content: "x" })], provider({})),
    ).toThrow(/file_path/);
  });

  it("round-trips through the apply engine: a built plan applies cleanly against its own base", () => {
    const base = { "a.ts": "hello world" };
    const plan = model.buildPlan(
      [
        toolUse("Edit", {
          file_path: "a.ts",
          old_string: "world",
          new_string: "there",
        }),
        toolUse("Write", { file_path: "b.ts", content: "new file" }),
      ],
      provider(base),
    );
    const { result, model: applied } = applyEditPlan({ ...base }, plan);
    expect(result.failed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(applied).toEqual({ "a.ts": "hello there", "b.ts": "new file" });
  });
});
