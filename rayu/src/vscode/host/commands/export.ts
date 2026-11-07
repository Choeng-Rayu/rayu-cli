/**
 * `/export` — write the conversation to a Markdown file chosen with VS Code's save
 * dialog, defaulting to the workspace and a name derived from the first prompt.
 */
import { join } from 'node:path'

import * as vscode from 'vscode'

import type { TranscriptEntry } from '../../shared/webviewProtocol.js'
import { defaultExportName, transcriptToMarkdown } from './exportFormat.js'

export async function runExportCommand(
  entries: readonly TranscriptEntry[],
  meta: { title: string | null; defaultDir: string },
): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(join(meta.defaultDir, defaultExportName(entries))),
    filters: { Markdown: ['md'] },
    saveLabel: 'Export',
  })
  if (!target) return

  try {
    const content = transcriptToMarkdown(entries, { title: meta.title })
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content))
    void vscode.window.showInformationMessage(`Conversation exported to ${target.fsPath}.`)
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not export the conversation: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
