/**
 * The "Rayucode Context" Explorer pane: a drop target that needs no Shift key.
 *
 * VS Code blanks a webview's pointer events for the duration of any drag that looks like it
 * carries a file unless Shift is held, so the chat panel itself only accepts a Shift-drag. A
 * tree view's `TreeDragAndDropController` is the route the platform supports for a plain drag:
 * the workbench hands it the drop as a `DataTransfer` in the extension host.
 *
 * The pane is collapsed by default and gated by `rayucode.contextDropView`. A drop is resolved
 * by the same resolver as every other context route (`contextPaths.ts`) and delivered through
 * the same `@`-mention format, so all routes produce identical prompt text.
 */
import * as vscode from 'vscode'

import { splitUriList } from '../../shared/contextMentions.js'
import { urisFromUriList } from './contextPaths.js'

export const CONTEXT_DROP_VIEW_ID = 'rayucode.contextDrop'
const URI_LIST_MIME = 'text/uri-list'
const DROP_FAILED_MESSAGE = 'Rayucode could not read that file or folder.'

export interface ContextDropDeps {
  /** Turn dropped URI strings into workspace paths. Empty when nothing was readable. */
  readonly resolve: (uriStrings: string[]) => Promise<string[]>
  /** Hand resolved paths to the active conversation. */
  readonly deliver: (paths: string[]) => void
  /** Tell the user nothing could be added. */
  readonly warn: () => void
}

/**
 * Handle the text of a dropped `text/uri-list`. Vscode-free so it can be unit tested without
 * a drag event: the real controller injects `resolve` built from `urisFromUriList` and
 * `contextPathsForUris`.
 */
export async function handleContextDrop(uriListText: string, deps: ContextDropDeps): Promise<void> {
  const entries = splitUriList(uriListText)
  const paths = entries.length > 0 ? await deps.resolve(entries) : []
  if (paths.length === 0) {
    deps.warn()
    return
  }
  deps.deliver(paths)
}

export interface ContextDropViewOptions {
  readonly resolve: (uris: vscode.Uri[]) => Promise<string[]>
  readonly deliver: (paths: string[]) => void
}

/** The single inert row shown in the pane. */
class DropHintProvider implements vscode.TreeDataProvider<string> {
  getTreeItem(label: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None)
    item.description = 'Drop here to add to Rayucode'
    item.iconPath = new vscode.ThemeIcon('cloud-upload')
    item.tooltip = 'Drag files or folders from the Explorer or an editor tab onto this pane.'
    return item
  }

  getChildren(element?: string): string[] {
    return element === undefined ? ['Drop files or folders here'] : []
  }
}

class ContextDropController implements vscode.TreeDragAndDropController<string> {
  readonly dropMimeTypes = [URI_LIST_MIME]
  readonly dragMimeTypes: readonly string[] = []

  constructor(private readonly options: ContextDropViewOptions) {}

  async handleDrop(
    _target: string | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const text = (await dataTransfer.get(URI_LIST_MIME)?.asString()) ?? ''
    await handleContextDrop(text, {
      resolve: entries => this.options.resolve(urisFromUriList(entries.join('\n'))),
      deliver: this.options.deliver,
      warn: () => void vscode.window.showWarningMessage(DROP_FAILED_MESSAGE),
    })
  }
}

/** Register the Explorer pane. The returned disposable removes the view and its controller. */
export function registerContextDropView(options: ContextDropViewOptions): vscode.Disposable {
  return vscode.window.createTreeView(CONTEXT_DROP_VIEW_ID, {
    treeDataProvider: new DropHintProvider(),
    dragAndDropController: new ContextDropController(options),
    canSelectMany: false,
  })
}
