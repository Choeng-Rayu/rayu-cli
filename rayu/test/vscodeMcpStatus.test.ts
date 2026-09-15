import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { ChatSession } from '../src/vscode/host/panel/sessionHandle.js'
import type { McpServerView } from '../src/vscode/shared/webviewProtocol.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

/**
 * `getMcpStatus()` / `applyMcpServers()` normalize whatever status string the engine
 * sent into the narrow `McpServerView['status']` union the webview renders. This exists
 * because `SessionHeader.tsx` reads that status to decide which action button to show —
 * `'failed'` gets a "Reconnect" button, `'pending'` gets none. Coercing an engine value
 * this build doesn't yet recognize into `'failed'` would offer the user a Reconnect
 * action for a server that never actually failed, which is worse than showing nothing.
 */
describe('Rayucode MCP server status normalization', () => {
  function sessionWithMcpResponse(mcpServers: unknown[]): {
    session: ChatSession
    reported: McpServerView[][]
  } {
    const reported: McpServerView[][] = []
    const session = new ChatSession(
      { enginePath: '/unused', cwd: tmpdir() },
      sessionCallbacks({ onMcpServers: servers => reported.push(servers) }),
    )
    ;(session as any).starting = Promise.resolve()
    ;(session as any).engine = { isRunning: true, send: () => true, dispose: () => {} }
    ;(session as any).control = {
      request: async () => ({ mcpServers }),
      dispose: () => {},
    }
    return { session, reported }
  }

  test('a recognized status passes through unchanged', async () => {
    const { session, reported } = sessionWithMcpResponse([
      { name: 'filesystem', status: 'connected' },
      { name: 'search', status: 'needs-auth' },
      { name: 'legacy', status: 'disabled' },
    ])

    const servers = await session.getMcpStatus()

    expect(servers.map(s => s.status)).toEqual(['connected', 'needs-auth', 'disabled'])
    expect(reported[0]!.map(s => s.status)).toEqual(['connected', 'needs-auth', 'disabled'])
    session.dispose()
  })

  test('an unrecognized status defaults to pending, not failed', async () => {
    // A newer engine emitting a status string this build predates — e.g. a future
    // "reconnecting" state — must not read as a hard failure to the user.
    const { session } = sessionWithMcpResponse([
      { name: 'future-server', status: 'reconnecting' },
    ])

    const servers = await session.getMcpStatus()

    expect(servers).toEqual([
      { name: 'future-server', status: 'pending', supportsOAuth: false, error: undefined },
    ])
    session.dispose()
  })

  test('a genuinely failed server still renders as failed', async () => {
    const { session } = sessionWithMcpResponse([
      { name: 'broken', status: 'failed', error: 'connection refused' },
    ])

    const servers = await session.getMcpStatus()

    expect(servers[0]!.status).toBe('failed')
    expect(servers[0]!.error).toBe('connection refused')
    session.dispose()
  })

  test('a missing status is also treated as pending', async () => {
    const { session } = sessionWithMcpResponse([{ name: 'no-status-field' }])

    const servers = await session.getMcpStatus()

    expect(servers[0]!.status).toBe('pending')
    session.dispose()
  })
})
