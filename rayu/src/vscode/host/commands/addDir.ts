/**
 * `/add-dir` — pick a folder, save it to an editable settings file, and restart the
 * conversation.
 *
 * Permission edits are picked up live by a running engine because headless mode
 * subscribes to settings changes. An additional directory is different: no control
 * request tells a live engine to widen its working set, so the conversation is restarted
 * (with resume) to start the engine again with the new settings.
 */
import * as vscode from 'vscode'

import type { AdditionalDirectorySource } from '../../shared/settingsChildProtocol.js'
import { runChildAction } from './childAction.js'
import type { HostCommandContext } from './index.js'

interface SourcePick extends vscode.QuickPickItem {
  scope: AdditionalDirectorySource
}

const SOURCES: ReadonlyArray<SourcePick> = [
  { label: 'Project settings', description: '.rayu/settings.json — shared with the repository', scope: 'project' },
  { label: 'Local settings', description: '.rayu/settings.local.json — this checkout only', scope: 'local' },
  { label: 'User settings', description: '~/.rayu/settings.json — every project', scope: 'user' },
]

export async function runAddDirectoryCommand(ctx: HostCommandContext): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Add directory',
  })
  const directory = picked?.[0]
  if (!directory) return

  const source = await vscode.window.showQuickPick<SourcePick>([...SOURCES], {
    placeHolder: 'Where should this directory be remembered?',
  })
  if (!source) return

  const result = await runChildAction<never>(ctx, {
    action: { action: 'add-directory', path: directory.fsPath, source: source.scope },
    fallbackError: 'Adding the directory returned no answer.',
  })
  if (!result.ok) return

  await ctx.restartConversation()
  void vscode.window.showInformationMessage(
    `Added ${directory.fsPath} as a working directory. The conversation restarted to pick it up.`,
  )
}
