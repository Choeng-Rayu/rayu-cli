/**
 * Renderer for `Edit`, `Write`, and `Read` file tool entries.
 *
 * Edit/Write entries with a typed diff show `DiffView`; others show a status line.
 */
import React from 'react'
import type { ToolRenderer } from './index.js'
import type { TranscriptEntry } from '../../shared/webviewProtocol.js'
import { DiffView } from '../components/DiffView.js'

const FILE_TOOLS = new Set(['edit', 'write', 'read', 'multiedit'])

export const FileEditRenderer: ToolRenderer = {
  canRender(entry: TranscriptEntry): boolean {
    return entry.kind === 'tool' && FILE_TOOLS.has(entry.name.toLowerCase())
  },

  render(entry: TranscriptEntry): React.ReactNode {
    if (entry.kind !== 'tool') return null

    const name = entry.name.toLowerCase()
    const icon = name === 'read' ? '📖' : name === 'write' ? '✏️' : '📝'

    const diff =
      entry.toolResult?.kind === 'edit'
        ? entry.toolResult
        : null

    return (
      <div className="rc-tool-file">
        <div className="rc-tool-file-header">
          <span className="rc-tool-file-icon">{icon}</span>
          <span className="rc-tool-file-name">{name.toUpperCase()}</span>
          <code className="rc-tool-file-path">{entry.label}</code>
          {entry.status === 'error' && (
            <span className="rc-tool-file-error">✗</span>
          )}
          {entry.status === 'done' && !diff && (
            <span className="rc-tool-file-ok">✓</span>
          )}
        </div>
        {diff && (
          <DiffView
            hunks={diff.hunks}
            filePath={diff.filePath}
            truncated={diff.truncated}
          />
        )}
        {entry.status === 'error' && entry.output && (
          <pre className="rc-tool-file-output rc-tool-file-output--error">{entry.output}</pre>
        )}
      </div>
    )
  },
}
