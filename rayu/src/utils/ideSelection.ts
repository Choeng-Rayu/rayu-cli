/**
 * The editor-selection shape, and the one mapping that interprets it.
 *
 * ── WHY THIS IS ITS OWN DEPENDENCY-FREE MODULE ─────────────────────────────────
 *
 * `toIdeSelection` used to live in `hooks/useIdeSelection.ts`. Three consumers need it and
 * only one of them is React:
 *
 *   - the interactive REPL, through the hook;
 *   - the engine's non-interactive path, through `ideSelectionTracker`;
 *   - the Rayucode EXTENSION HOST, which projects the same numbers for its composer.
 *
 * The third makes the placement load-bearing rather than tidy. The extension host is a
 * separate CJS bundle with a hard 1.6 MB budget and a build guard that fails on Node/React
 * imports; reaching into `hooks/` pulled React and most of the engine with it and measured
 * 19.9 MB. Types and arithmetic only, so every consumer can import it.
 *
 * The hook re-exports these, so existing imports keep working and there is still exactly one
 * definition.
 */

export type SelectionPoint = {
  line: number
  character: number
}

export type SelectionData = {
  selection: {
    start: SelectionPoint
    end: SelectionPoint
  } | null
  text?: string
  filePath?: string
}

export type IDESelection = {
  lineCount: number
  lineStart?: number
  text?: string
  filePath?: string
}

/**
 * Map an editor selection notification to the shape consumers render.
 *
 * ── A CLEARED SELECTION IS REPORTED, NOT DROPPED ───────────────────────────────
 *
 * An earlier version guarded its whole body on `data.selection?.start && …?.end` and returned
 * nothing when that failed. Callers invoke it with `selection: null` for an empty selection,
 * so that path did nothing at all: the LAST selection stayed on screen forever. The user
 * clicks away, deselects, and the prompt still claims "12 lines selected" — and would attach
 * that dead selection to the next message.
 *
 * `filePath` is preserved on a clear because the file is still the active editor; only the
 * selection inside it went away. `lineCount: 0` is what consumers already treat as "nothing
 * selected".
 */
export function toIdeSelection(data: SelectionData): IDESelection {
  if (data.selection?.start && data.selection?.end) {
    const { start, end } = data.selection
    let lineCount = end.line - start.line + 1
    // A selection ending on character 0 stops at the START of that line, so the line
    // itself is not selected.
    if (end.character === 0) {
      lineCount--
    }
    return {
      lineCount,
      lineStart: start.line,
      text: data.text,
      filePath: data.filePath,
    }
  }

  return {
    lineCount: 0,
    lineStart: undefined,
    text: undefined,
    filePath: data.filePath,
  }
}
