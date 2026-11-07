/**
 * The transcript-to-Markdown rendering and default file name for the editor's Export
 * command. Pure: no `vscode`, no filesystem.
 *
 * A tool row uses the host's PROJECTED `details` — the command, the path, the pattern the
 * call acted on — and never `parameters`, the model's raw argument object. That object
 * can carry a whole file body, a token from a `Bash` command or an MCP argument, and the
 * transcript already stopped showing it by default for exactly that reason.
 */
import type { TranscriptEntry } from '../../shared/webviewProtocol.js'
import { formatExportTimestamp, sanitizeFilename } from '../../../utils/exportFilename.js'

export function transcriptToMarkdown(
  entries: readonly TranscriptEntry[],
  meta: { title: string | null },
): string {
  const blocks: string[] = [`# ${meta.title?.trim() || 'Conversation'}`]

  for (const entry of entries) {
    switch (entry.kind) {
      case 'prompt': {
        const text = entry.text.trim()
        if (text) blocks.push(`## User\n\n${text}`)
        break
      }
      case 'assistant': {
        const text = entry.text.trim()
        if (text) blocks.push(`## Rayu\n\n${text}`)
        break
      }
      case 'tool': {
        const lines = [`### Tool: ${entry.name}`]
        const label = entry.label.trim()
        if (label) lines.push('', label)
        if (entry.details.length > 0) {
          lines.push('')
          for (const detail of entry.details) {
            const value = detail.code ? inlineCode(detail.value) : oneLine(detail.value)
            lines.push(`- **${detail.label}**: ${value}`)
          }
        }
        blocks.push(lines.join('\n'))
        break
      }
      case 'side_question': {
        const lines = ['## Side question', '', entry.question.trim()]
        if (entry.answer) lines.push('', entry.answer.trim())
        blocks.push(lines.join('\n'))
        break
      }
    }
  }

  return `${blocks.join('\n\n').trim()}\n`
}

export function defaultExportName(entries: readonly TranscriptEntry[]): string {
  const firstPrompt = entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'prompt' }> => entry.kind === 'prompt',
  )
  const name = firstPrompt ? sanitizeFilename(firstPrompt.text.split('\n')[0] ?? '') : ''
  const timestamp = formatExportTimestamp(new Date())
  return name ? `${timestamp}-${name}.md` : `conversation-${timestamp}.md`
}

function inlineCode(text: string): string {
  return `\`${oneLine(text).replace(/`/g, '\\`')}\``
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ')
}
