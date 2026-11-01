/**
 * Turning dropped or picked resources into workspace paths.
 *
 * ONE resolver for every route that adds context from a URI: the webview's own drop
 * (`resolveContextPaths`), the Add Context picker, the Explorer/editor menu command, and the
 * Rayucode Context tree view (`dropTargetView.ts`). They must produce identical paths, so the
 * logic lives here once.
 */
import * as vscode from 'vscode'

/**
 * Parse a `text/uri-list` body (or a list of bare paths) into URIs the host can stat.
 *
 * Only `file` and `vscode-remote` are accepted: anything else (an `http` link, an untitled
 * buffer) has no file behind it. A malformed entry is skipped so the rest of a multi-drop
 * stays usable.
 */
export function urisFromUriList(uriList: string): vscode.Uri[] {
  const uris: vscode.Uri[] = []
  for (const line of uriList.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    try {
      const uri = value.includes('://') ? vscode.Uri.parse(value, true) : vscode.Uri.file(value)
      if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') continue
      uris.push(uri)
    } catch {
      // A stale Explorer item or inaccessible external path is skipped while
      // other dropped resources remain usable.
    }
  }
  return uris
}

/**
 * Convert VS Code URIs to the same workspace-relative attachment references used
 * by the CLI. This deliberately lives in the extension host: browser File objects
 * do not reliably expose a path, and remote-workspace paths must go through VS Code.
 */
export async function contextPathsForUris(uris: readonly vscode.Uri[]): Promise<string[]> {
  const paths: string[] = []
  for (const uri of uris) {
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      const workspace = vscode.workspace.getWorkspaceFolder(uri)
      let display = workspace
        ? vscode.workspace.asRelativePath(uri, false)
        : uri.fsPath
      display = display.replace(/\\/g, '/')
      if (stat.type & vscode.FileType.Directory) display = `${display.replace(/\/$/, '')}/`
      if (!paths.includes(display)) paths.push(display)
    } catch {
      // Leave inaccessible members out while preserving the rest of a multi-drop.
    }
  }
  return paths
}
