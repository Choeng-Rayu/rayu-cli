import { useEffect, useRef } from 'react'
import { logError } from 'src/utils/log.js'
import { z } from 'zod/v4'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { lazySchema } from '../utils/lazySchema.js'
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

// Define the selection changed notification schema
const SelectionChangedSchema = lazySchema(() =>
  z.object({
    method: z.literal('selection_changed'),
    params: z.object({
      selection: z
        .object({
          start: z.object({
            line: z.number(),
            character: z.number(),
          }),
          end: z.object({
            line: z.number(),
            character: z.number(),
          }),
        })
        .nullable()
        .optional(),
      text: z.string().optional(),
      filePath: z.string().optional(),
    }),
  }),
)

/**
 * Map an editor selection notification to the shape consumers render.
 *
 * ── EXTRACTED SO IT CAN BE TESTED ──────────────────────────────────────────────
 *
 * This was a closure inside the hook's `useEffect`, which made the one interesting
 * decision in the file — what a CLEARED selection means — unreachable from a test.
 *
 * ── A CLEARED SELECTION IS REPORTED, NOT DROPPED ───────────────────────────────
 *
 * The previous version guarded the whole body on `data.selection?.start && …?.end` and
 * returned nothing when that failed. The caller invokes it with `selection: null` for an
 * empty selection, so that path did nothing at all: the LAST selection stayed on screen
 * forever. The user clicks away, deselects, and the prompt still claims "12 lines
 * selected" — and would attach that dead selection to the next message.
 *
 * `filePath` is preserved on a clear because the file is still the active editor; only
 * the selection inside it went away. `lineCount: 0` is what consumers already treat as
 * "nothing selected".
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

/**
 * A hook that tracks IDE text selection information by directly registering
 * with MCP client notification handlers
 */
export function useIdeSelection(
  mcpClients: MCPServerConnection[],
  onSelect: (selection: IDESelection) => void,
): void {
  const handlersRegistered = useRef(false)
  const currentIDERef = useRef<ConnectedMCPServer | null>(null)

  useEffect(() => {
    // Find the IDE client from the MCP clients list
    const ideClient = getConnectedIdeClient(mcpClients)

    // If the IDE client changed, we need to re-register handlers.
    // Normalize undefined to null so the initial ref value (null) matches
    // "no IDE found" (undefined), avoiding spurious resets on every MCP update.
    if (currentIDERef.current !== (ideClient ?? null)) {
      handlersRegistered.current = false
      currentIDERef.current = ideClient || null
      // Reset the selection when the IDE client changes.
      onSelect({
        lineCount: 0,
        lineStart: undefined,
        text: undefined,
        filePath: undefined,
      })
    }

    // Skip if we've already registered handlers for the current IDE or if there's no IDE client
    if (handlersRegistered.current || !ideClient) {
      return
    }

    // Handler function for selection changes. The mapping — including what a cleared
    // selection means — lives in `toIdeSelection` so it is testable.
    const selectionChangeHandler = (data: SelectionData) => {
      onSelect(toIdeSelection(data))
    }

    // Register notification handler for selection_changed events
    ideClient.client.setNotificationHandler(
      SelectionChangedSchema(),
      notification => {
        if (currentIDERef.current !== ideClient) {
          return
        }

        try {
          // Get the selection data from the notification params
          const selectionData = notification.params

          // Process selection data - validate it has required properties
          if (
            selectionData.selection &&
            selectionData.selection.start &&
            selectionData.selection.end
          ) {
            // Handle selection changes
            selectionChangeHandler(selectionData as SelectionData)
          } else if (selectionData.selection === null || selectionData.text !== undefined) {
            // Handle empty selection (when text is empty string)
            selectionChangeHandler({
              selection: null,
              text: selectionData.text,
              filePath: selectionData.filePath,
            })
          }
        } catch (error) {
          logError(error as Error)
        }
      },
    )

    // Mark that we've registered handlers
    handlersRegistered.current = true

    // No cleanup needed as MCP clients manage their own lifecycle
  }, [mcpClients, onSelect])
}
