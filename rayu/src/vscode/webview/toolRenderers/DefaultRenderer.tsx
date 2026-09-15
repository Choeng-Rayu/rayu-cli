/**
 * Fallback renderer for tool entries with no specific renderer.
 *
 * Renders the tool name, label, and plain text output.
 */
import React from 'react'
import type { ToolRenderer } from './index.js'
import type { TranscriptEntry } from '../../shared/webviewProtocol.js'

export const DefaultRenderer: ToolRenderer = {
  canRender(entry: TranscriptEntry): boolean {
    return entry.kind === 'tool'
  },

  render(entry: TranscriptEntry): React.ReactNode {
    if (entry.kind !== 'tool') return null

    return (
      <div className="rc-tool-default">
        <div className="rc-tool-default-header">
          <span className="rc-tool-name">{entry.name}</span>
          {entry.label && (
            <code className="rc-tool-default-label">{entry.label}</code>
          )}
        </div>
        {entry.output != null && (
          <pre className="rc-tool-output">{entry.output}</pre>
        )}
      </div>
    )
  },
}
