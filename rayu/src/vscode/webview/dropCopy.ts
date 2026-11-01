/**
 * Shared wording for the drag-and-drop hints.
 *
 * ── WHY THE HINT HAS TO BE STATIC ──────────────────────────────────────────────
 *
 * Dragging a file onto this panel only works while SHIFT is held (see `dropPayload.ts` for the
 * measurement). Without Shift, VS Code blanks the webview iframe's pointer events for the whole
 * gesture, so the panel receives no `dragenter` at all and nothing it renders during the drag
 * can explain what is happening. The explanation therefore has to be on screen BEFORE the
 * drag starts: the welcome screen and the Add Context button's tooltip.
 *
 * The strings live here so those places cannot drift apart. Plain text only: callers decide
 * how to lay it out.
 */

/** The requirement itself. */
export const DRAG_SHIFT_HINT =
  'Hold Shift while dragging files from the Explorer or an editor tab onto this panel.'

/** What to do instead, none of which needs a gesture. */
export const DRAG_ALTERNATIVES_HINT =
  'Or use Add Context, type @, or right-click a file and choose Add to Rayu Context.'

/** The full sentence pair, for the empty-transcript surface. */
export const DRAG_WELCOME_HINT = `${DRAG_SHIFT_HINT} ${DRAG_ALTERNATIVES_HINT}`

/** Tooltip for the composer's Add Context button. Newline-separated for the native title. */
export const ADD_CONTEXT_TOOLTIP =
  'Add files or folders as context.\n' +
  'To drag them onto this panel instead, hold Shift while dragging.\n' +
  'You can also type @ or right-click a file and choose Add to Rayu Context.'

/** Accessible name for the composer's Add Context button. */
export const ADD_CONTEXT_ARIA_LABEL =
  'Add context. Files can also be dragged onto the panel while holding Shift.'
