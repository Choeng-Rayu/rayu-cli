/**
 * `/status` — the current session's model, provider, permission mode, account and MCP
 * connections, as a read-only Markdown tab.
 *
 * The facts are assembled by the extension host (which owns them); this module only
 * renders them.
 */
import type { StatusFacts } from './index.js'
import { showMarkdownDocument } from './openMarkdown.js'
import { statusMarkdown } from './statusFormat.js'

export async function runStatusCommand(facts: StatusFacts): Promise<void> {
  await showMarkdownDocument(statusMarkdown(facts))
}
