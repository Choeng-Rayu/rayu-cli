/**
 * Show generated Markdown in a read-only editor tab.
 *
 * An untitled document is the right surface for a report: it is not tied to a file on
 * disk, its language is Markdown so headings and lists render, and saving remains an
 * explicit user action rather than a side effect of running a command.
 */
import * as vscode from 'vscode'

export async function showMarkdownDocument(content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' })
  await vscode.window.showTextDocument(document, { preview: false })
}
