/**
 * `/memory` — list the memory files the engine loads (user, project and local), then
 * open one in the editor. A standard file that does not exist yet is offered as well and
 * is created, with its directory, when chosen.
 *
 * Discovery runs in the settings child (`src/utils/claudemd.ts` cannot load in the host).
 */
import { basename, dirname, join } from 'node:path'

import * as vscode from 'vscode'

import type { MemoryFileView, MemoryFrame } from '../../shared/settingsChildProtocol.js'
import { runChildAction } from './childAction.js'
import type { HostCommandContext } from './index.js'

interface MemoryPick extends vscode.QuickPickItem {
  file: MemoryFileView
}

export async function runMemoryCommand(ctx: HostCommandContext): Promise<void> {
  const result = await runChildAction<MemoryFileView[]>(ctx, {
    action: { action: 'memory-list' },
    consumeFrame: frame =>
      frame.type === 'rayucode_memory' ? (frame as unknown as MemoryFrame).files : undefined,
    fallbackError: 'Reading the memory files returned nothing.',
  })
  if (!result.ok || !result.value) return

  const pick = await vscode.window.showQuickPick<MemoryPick>(
    result.value.map(file => ({
      label: memoryLabel(file, ctx.cwd),
      description: file.exists ? file.path : `${file.path} (new)`,
      detail: scopeLabel(file.scope),
      file,
    })),
    { placeHolder: 'Open a memory file', matchOnDescription: true },
  )
  if (!pick) return

  try {
    const uri = vscode.Uri.file(pick.file.path)
    if (!pick.file.exists) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(pick.file.path)))
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(''))
    }
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document, { preview: false })
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not open ${pick.file.path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function memoryLabel(file: MemoryFileView, cwd: string): string {
  if (file.scope === 'user' && basename(file.path) === 'RAYU.md') return 'User memory'
  if (file.scope === 'project' && file.path === join(cwd, 'RAYU.md')) return 'Project memory'
  if (file.scope === 'local' && file.path === join(cwd, 'RAYU.local.md')) return 'Project local memory'
  return basename(file.path)
}

function scopeLabel(scope: MemoryFileView['scope']): string {
  switch (scope) {
    case 'user':
      return 'User'
    case 'project':
      return 'Project'
    case 'local':
      return 'Project local'
    case 'managed':
      return 'Managed'
    case 'auto':
      return 'Auto memory'
    default:
      return 'Memory'
  }
}
