/**
 * Renderer for `Grep` and `Glob` tool entries.
 *
 * File-search results (`search` typed result) show a file count.
 * Content-search results fall back to the output text.
 */
import React from 'react'
import type { ToolRenderer } from './index.js'
import type { TranscriptEntry } from '../../shared/webviewProtocol.js'

const SEARCH_TOOLS = new Set(['grep', 'glob'])

export const GrepRenderer: ToolRenderer = {
  canRender(entry: TranscriptEntry): boolean {
    return entry.kind === 'tool' && SEARCH_TOOLS.has(entry.name.toLowerCase())
  },

  render(entry: TranscriptEntry): React.ReactNode {
    if (entry.kind !== 'tool') return null

    const search =
      entry.toolResult?.kind === 'search' ? entry.toolResult : null

    return (
      <div className="rc-tool-grep">
        <div className="rc-tool-grep-header">
          <span className="rc-tool-name">{entry.name.toUpperCase()}</span>
          <code className="rc-tool-grep-pattern">{entry.label}</code>
        </div>
        {search && (
          <div className="rc-tool-grep-result">
            {search.totalCount === 0
              ? 'No matches'
              : `${search.totalCount} file${search.totalCount === 1 ? '' : 's'}`}
          </div>
        )}
        {!search && entry.output && (
          <pre className="rc-tool-grep-output">{entry.output}</pre>
        )}
      </div>
    )
  },
}
