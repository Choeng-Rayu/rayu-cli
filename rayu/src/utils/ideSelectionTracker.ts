/**
 * The current editor selection, for code paths that are not React.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 *
 * The IDE selection already reaches the CLI: the editor extension broadcasts
 * `selection_changed` over the `ide` MCP connection, `useIdeSelection` registers a handler
 * for it, and `getSelectedLinesFromIDE` turns the result into a `selected_lines_in_ide`
 * attachment. But `useIdeSelection` is a REACT HOOK, so that chain only runs in the
 * interactive terminal UI.
 *
 * Every other consumer of the engine — the SDK/`--print` path, and therefore the Rayucode
 * extension — had no equivalent. `QueryEngine` called `processUserInput` without an
 * `ideSelection`, so the attachment path short-circuited and selecting code in the editor
 * had no effect on the answer.
 *
 * This module is that missing link, and deliberately nothing more:
 *
 *   - The MAPPING is not reimplemented. `toIdeSelection` is imported from the hook's module,
 *     where it was already extracted and tested, so both paths agree about what a selection
 *     means — including that a CLEARED selection is an event, not an absence.
 *   - The ATTACHMENT is not reimplemented. This only remembers the latest selection;
 *     `getSelectedLinesFromIDE` still decides whether it is usable, still checks the file
 *     is not read-denied, and still owns the wire format.
 *
 * ── MODULE-LEVEL STATE IS CORRECT HERE ─────────────────────────────────────────
 *
 * The selection is a property of the ONE editor this process is attached to, and the engine
 * is one process serving one session. Threading it through the call graph instead would mean
 * changing every layer between the MCP client list and `processUserInput` to carry a value
 * only the last of them uses.
 */
import { z } from 'zod/v4'

import { logError } from './log.js'
import { lazySchema } from './lazySchema.js'
import { getConnectedIdeClient } from './ide.js'
import {
  toIdeSelection,
  type IDESelection,
  type SelectionData,
} from './ideSelection.js'
import type { ConnectedMCPServer, MCPServerConnection } from '../services/mcp/types.js'

/**
 * The notification shape, matching the schema the hook validates against.
 *
 * Declared here as well because the hook keeps its copy inside the module for its own
 * handler; the shapes are asserted equal by test rather than shared, since exporting a
 * lazy schema from a React module into the engine's hot path would pull the hook's imports
 * along with it.
 */
const SelectionChangedSchema = lazySchema(() =>
  z.object({
    method: z.literal('selection_changed'),
    params: z.object({
      selection: z
        .object({
          start: z.object({ line: z.number(), character: z.number() }),
          end: z.object({ line: z.number(), character: z.number() }),
        })
        .nullable()
        .optional(),
      text: z.string().optional(),
      filePath: z.string().optional(),
    }),
  }),
)

let currentSelection: IDESelection | undefined
/** The client the handler is registered on, so re-registration is idempotent. */
let registeredClient: ConnectedMCPServer | undefined

/**
 * The latest selection the editor reported, or undefined when there is none.
 *
 * Returns undefined rather than an empty selection so callers can pass it straight to
 * `processUserInput`, whose parameter is optional.
 */
export function getCurrentIdeSelection(): IDESelection | undefined {
  return currentSelection
}

/** Forget the selection. Called when the IDE connection changes or goes away. */
export function clearIdeSelection(): void {
  currentSelection = undefined
}

/**
 * Start tracking the editor selection, if an IDE connection is present.
 *
 * Safe and cheap to call repeatedly — it is invoked once per turn from the query path,
 * because MCP clients connect asynchronously and the `ide` client may not exist yet when the
 * session starts. `setNotificationHandler` REPLACES rather than stacks, but the guard avoids
 * the work entirely in the common case.
 */
export function trackIdeSelection(mcpClients?: MCPServerConnection[]): void {
  const ideClient = getConnectedIdeClient(mcpClients)

  if (registeredClient !== ideClient) {
    registeredClient = ideClient
    // A different (or absent) editor means the previous selection describes a file this
    // session can no longer see. Keeping it would attach a stale range to the next prompt.
    clearIdeSelection()
  }

  if (!ideClient) return

  ideClient.client.setNotificationHandler(SelectionChangedSchema(), notification => {
    // A late notification from a connection we have already replaced must not overwrite the
    // current one.
    if (registeredClient !== ideClient) return
    try {
      const data = notification.params
      // The empty case is handled explicitly rather than filtered out: the editor sends
      // `selection: null` when the user clicks away, and dropping it is what previously
      // left a stale "12 lines selected" attached to a later message.
      currentSelection = toIdeSelection({
        selection: data.selection ?? null,
        text: data.text,
        filePath: data.filePath,
      } as SelectionData)
    } catch (error) {
      logError(error as Error)
    }
  })
}
