import { useEffect, useRef } from 'react'
import { logError } from 'src/utils/log.js'
import { z } from 'zod/v4'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { lazySchema } from '../utils/lazySchema.js'
/**
 * Re-exported from `utils/ideSelection.ts`, which is where the shape and the mapping now
 * live. They moved because the Rayucode extension host needs the same arithmetic and cannot
 * import this module: it is a separate bundle with a hard size budget and a build guard that
 * rejects React, and reaching in here measured 19.9 MB against a 1.6 MB limit.
 *
 * Re-exported rather than relocated silently so every existing `useIdeSelection` import
 * keeps working against one definition.
 */
export {
  toIdeSelection,
  type IDESelection,
  type SelectionData,
  type SelectionPoint,
} from '../utils/ideSelection.js'
import {
  toIdeSelection,
  type IDESelection,
  type SelectionData,
} from '../utils/ideSelection.js'

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
