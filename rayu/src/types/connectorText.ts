// Stub for a source file absent from the leaked tree. Connector-text blocks are
// gated behind feature('CONNECTOR_TEXT') (default off), so the runtime guard is
// effectively dead code; these minimal types/shape keep the tree compiling.
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

export type ConnectorTextBlock = { type: 'connector_text'; text: string }
export type ConnectorTextDelta = { type: 'connector_text_delta'; text: string }

export function isConnectorTextBlock(
  block: BetaContentBlock | { type?: string } | undefined | null,
): block is ConnectorTextBlock {
  return !!block && (block as { type?: string }).type === 'connector_text'
}
