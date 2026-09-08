/**
 * Track the active editor's selection and publish it to attached engines.
 *
 * ── A CLEARED SELECTION IS AN EVENT, NOT AN ABSENCE ────────────────────────────
 *
 * This deliberately reports empty selections as well as non-empty ones. The shared
 * consumer (`src/hooks/useIdeSelection.ts`) had a bug where a null selection was ignored,
 * leaving a stale "N lines selected" indicator after the user clicked away — so a
 * selection could be attached to a message long after the user stopped pointing at it.
 * That is fixed in the hook; this end must still SEND the clear, or there is nothing to
 * act on.
 *
 * ── THROTTLED, BECAUSE SELECTION EVENTS ARE CONTINUOUS ─────────────────────────
 *
 * Dragging a selection fires per pixel-row. The engine only needs to know where the
 * selection ended up, so events are coalesced on a short trailing timer. The value sent
 * is always read fresh at flush time rather than captured, so the last state wins.
 */
import * as vscode from 'vscode'

import type { IdeServerHandle, SelectionPayload } from './ideServer.js'

/**
 * Coalescing window. Long enough to collapse a drag into one message, short enough that
 * the selection is current by the time the user reaches the composer.
 */
const SELECTION_DEBOUNCE_MS = 150

/** Cap on the selected text sent. A whole-file selection should not become a huge frame. */
const MAX_SELECTION_CHARS = 32_000

export function trackEditorSelection(server: IdeServerHandle): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush(): void {
    timer = undefined
    server.broadcastSelection(readCurrentSelection())
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, SELECTION_DEBOUNCE_MS)
  }

  const subscriptions = [
    vscode.window.onDidChangeTextEditorSelection(schedule),
    // Switching editors changes the selection context even when no selection event fires.
    vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.workspace.onDidChangeTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument(schedule),
  ]

  // Publish once at startup so an engine attaching later does not wait for the user to
  // move the caret before it knows anything.
  schedule()

  return new vscode.Disposable(() => {
    if (timer) clearTimeout(timer)
    for (const subscription of subscriptions) subscription.dispose()
  })
}

/**
 * Read the current selection in the shape the engine's handler expects.
 *
 * `selection: null` for an empty selection is the contract `SelectionChangedSchema`
 * declares (`.nullable().optional()`), and it is what distinguishes "nothing selected in
 * this file" from "no file open".
 */
export function readCurrentSelection(): SelectionPayload {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    // No editor at all: no path either, so the engine clears both.
    return { selection: null }
  }

  const filePath = editor.document.uri.fsPath
  const { selection } = editor

  if (selection.isEmpty) {
    // The file is still open and active — only the selection went away, so the path is
    // preserved. Dropping it would also clear the engine's notion of the current file.
    return { filePath, selection: null }
  }

  const text = editor.document.getText(selection)
  return {
    filePath,
    text: text.length > MAX_SELECTION_CHARS ? text.slice(0, MAX_SELECTION_CHARS) : text,
    selection: {
      // VS Code positions are 0-based, which is what the schema declares.
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character },
    },
  }
}
