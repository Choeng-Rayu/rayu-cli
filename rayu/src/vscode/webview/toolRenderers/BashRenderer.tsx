/**
 * Renderer for `Bash` tool entries.
 *
 * Shows the command label and ANSI-decoded output in a terminal-style block.
 */
import React from 'react'
import type { ToolRenderer } from './index.js'
import type { TranscriptEntry } from '../../shared/webviewProtocol.js'
import { AnsiText } from '../components/ToolOutput.js'

export const BashRenderer: ToolRenderer = {
  canRender(entry: TranscriptEntry): boolean {
    return entry.kind === 'tool' && entry.name.toLowerCase() === 'bash'
  },

  render(entry: TranscriptEntry): React.ReactNode {
    if (entry.kind !== 'tool') return null
    const isError = entry.status === 'error'
    return (
      <div className="rc-tool-bash">
        <div className="rc-tool-bash-header">
          <span className="rc-tool-bash-prompt">$</span>
          <code className="rc-tool-bash-cmd">{entry.label}</code>
        </div>
        {entry.output != null && (
          <div className={`rc-tool-bash-result${isError ? ' rc-tool-bash-result--error' : ''}`}>
            <AnsiText text={entry.output} />
          </div>
        )}
      </div>
    )
  },
}
