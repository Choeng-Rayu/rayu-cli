import type { McpServerView } from '../../shared/webviewProtocol.js'

export type McpWatchResult = 'connected' | 'failed' | 'timeout' | 'cancelled'

/** Observe the existing MCP engine's status after a browser OAuth handoff. */
export async function watchMcpConnection(options: {
  serverName: string
  read: () => Promise<readonly McpServerView[]>
  isCurrent: () => boolean
  onStatus: (servers: readonly McpServerView[]) => void
  wait?: (ms: number) => Promise<void>
  attempts?: number
}): Promise<McpWatchResult> {
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const attempts = options.attempts ?? 80 // Two minutes at 1.5 seconds per check.
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!options.isCurrent()) return 'cancelled'
    try {
      const servers = await options.read()
      if (!options.isCurrent()) return 'cancelled'
      options.onStatus(servers)
      const server = servers.find(item => item.name === options.serverName)
      if (server?.status === 'connected') return 'connected'
      if (server?.status === 'failed' || server?.status === 'disabled') return 'failed'
    } catch {
      // The engine may briefly be busy reconnecting. The public status refresh
      // remains available to show a persistent request failure explicitly.
    }
    if (attempt < attempts - 1) await wait(1500)
  }
  return options.isCurrent() ? 'timeout' : 'cancelled'
}
