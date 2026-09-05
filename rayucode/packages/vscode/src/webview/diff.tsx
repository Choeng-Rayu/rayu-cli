// Diff rendering for file-edit permission requests.
//
// Before this existed, approving a file edit meant reading the tool's raw JSON
// input — so the user was effectively approving blind. This turns the same input
// into a line diff.
//
// The diff is computed HERE, in the webview, from the tool input the permission
// request already carries. No new protocol message and no core change is needed:
// `Edit`/`MultiEdit` carry `old_string`/`new_string`, and `Write` carries
// `content`.
//
// SCOPE: this is a review VIEW. Approval remains whole-request — accepting a
// SUBSET of hunks would require the core apply engine to take a hunk selection,
// which is a larger change than a rendering one. The per-hunk checkboxes are
// therefore deliberately absent rather than present and non-functional.

import type { ReactNode } from "react";

/** The edit tools whose input can be rendered as a diff. */
const DIFFABLE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** Whether this tool's input can be shown as a diff. */
export function isDiffableTool(toolName: string): boolean {
  return DIFFABLE_TOOLS.has(toolName);
}

/** One line of a rendered diff. */
interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
}

/** A contiguous group of changes with surrounding context. */
interface Hunk {
  lines: DiffLine[];
}

/** A single file's proposed change. */
interface FileDiff {
  path: string;
  /** Absent for a whole-file write, where there is no "before". */
  hunks: Hunk[];
  /** True when the whole file content is being replaced or created. */
  wholeFile: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function splitLines(text: string): string[] {
  // A trailing newline would otherwise produce a phantom empty final line.
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Longest-common-subsequence line diff.
 *
 * Bounded deliberately: the DP table is O(n·m), so for large inputs the diff is
 * skipped in favour of a plain before/after view. A review panel must never
 * become unresponsive because a model proposed a big file.
 */
const MAX_DIFF_LINES = 800;

function diffLines(before: string[], after: string[]): DiffLine[] | null {
  if (before.length + after.length > MAX_DIFF_LINES) {
    return null;
  }
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = length of the LCS of before[i..] and after[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: "context", text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "remove", text: before[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: after[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "remove", text: before[i++]! });
  while (j < m) out.push({ kind: "add", text: after[j++]! });
  return out;
}

/** Context lines kept either side of a change. */
const CONTEXT = 3;

/** Group a flat diff into hunks, collapsing long unchanged runs. */
function toHunks(lines: DiffLine[]): Hunk[] {
  const changed = lines
    .map((l, idx) => (l.kind === "context" ? -1 : idx))
    .filter((idx) => idx >= 0);
  if (changed.length === 0) {
    return [];
  }
  const hunks: Hunk[] = [];
  let start = Math.max(0, changed[0]! - CONTEXT);
  let end = Math.min(lines.length - 1, changed[0]! + CONTEXT);
  for (const idx of changed.slice(1)) {
    if (idx - CONTEXT <= end + 1) {
      end = Math.min(lines.length - 1, idx + CONTEXT);
    } else {
      hunks.push({ lines: lines.slice(start, end + 1) });
      start = Math.max(0, idx - CONTEXT);
      end = Math.min(lines.length - 1, idx + CONTEXT);
    }
  }
  hunks.push({ lines: lines.slice(start, end + 1) });
  return hunks;
}

/**
 * Extract the proposed change(s) from an edit tool's input.
 *
 * Returns an empty array when the input does not have a recognised shape, so an
 * unexpected payload falls back to the raw JSON view rather than rendering a
 * misleading diff.
 */
export function extractFileDiffs(
  toolName: string,
  input: Record<string, unknown>,
): FileDiff[] {
  const path = asString(input["file_path"]) ?? "(unknown path)";

  if (toolName === "Write") {
    const content = asString(input["content"]);
    if (content === undefined) return [];
    return [
      {
        path,
        wholeFile: true,
        hunks: [
          { lines: splitLines(content).map((text) => ({ kind: "add", text })) },
        ],
      },
    ];
  }

  // Edit and MultiEdit both reduce to a list of string replacements.
  const edits: { oldString: string; newString: string }[] = [];
  if (toolName === "Edit") {
    const oldString = asString(input["old_string"]);
    const newString = asString(input["new_string"]);
    if (oldString === undefined || newString === undefined) return [];
    edits.push({ oldString, newString });
  } else if (toolName === "MultiEdit") {
    const raw = input["edits"];
    if (!Array.isArray(raw)) return [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const oldString = asString(e["old_string"]);
      const newString = asString(e["new_string"]);
      if (oldString === undefined || newString === undefined) continue;
      edits.push({ oldString, newString });
    }
    if (edits.length === 0) return [];
  } else {
    return [];
  }

  const hunks: Hunk[] = [];
  for (const { oldString, newString } of edits) {
    const flat = diffLines(splitLines(oldString), splitLines(newString));
    if (flat === null) {
      // Too large to diff: show it as a replacement instead of hanging.
      hunks.push({
        lines: [
          ...splitLines(oldString).map(
            (text) => ({ kind: "remove", text }) as DiffLine,
          ),
          ...splitLines(newString).map(
            (text) => ({ kind: "add", text }) as DiffLine,
          ),
        ],
      });
      continue;
    }
    hunks.push(...toHunks(flat));
  }
  return [{ path, wholeFile: false, hunks }];
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

function HunkView({ hunk, index }: { hunk: Hunk; index: number }): ReactNode {
  const added = hunk.lines.filter((l) => l.kind === "add").length;
  const removed = hunk.lines.filter((l) => l.kind === "remove").length;
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">
        {`Hunk ${index + 1} · +${added} −${removed}`}
      </div>
      {/*
        A table, not a <pre>: a screen reader can then announce each line's role
        from the marker column instead of relying on colour alone, which also
        keeps it readable in high-contrast themes.
      */}
      <table className="diff-lines">
        <tbody>
          {hunk.lines.map((line, i) => (
            <tr key={i} className={`diff-${line.kind}`}>
              <td className="diff-marker" aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
              </td>
              <td className="diff-text">
                <span className="sr-only">
                  {line.kind === "add"
                    ? "added: "
                    : line.kind === "remove"
                      ? "removed: "
                      : ""}
                </span>
                {line.text === "" ? "\u00a0" : line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Render the proposed change for an edit tool, or `null` when the input has no
 * recognised diffable shape (the caller then falls back to the raw JSON view).
 */
export function EditDiff({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}): ReactNode {
  const diffs = extractFileDiffs(toolName, input);
  if (diffs.length === 0) {
    return null;
  }
  return (
    <div className="diff">
      {diffs.map((file) => (
        <div key={file.path} className="diff-file">
          <div className="diff-file-header">
            <span className="diff-path">{file.path}</span>
            {file.wholeFile ? (
              <span className="diff-whole-file">whole file</span>
            ) : null}
          </div>
          {file.hunks.length === 0 ? (
            <div className="diff-empty">No textual change.</div>
          ) : (
            file.hunks.map((hunk, i) => (
              <HunkView key={i} hunk={hunk} index={i} />
            ))
          )}
        </div>
      ))}
    </div>
  );
}
