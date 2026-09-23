import { describe, expect, test } from 'bun:test'

import { watchMcpConnection } from '../src/vscode/host/panel/mcpConnectionUi.js'
import type { McpServerView } from '../src/vscode/shared/webviewProtocol.js'

const server = (status: McpServerView['status']): McpServerView => ({
  name: 'canva', status, supportsOAuth: true,
})

describe('VS Code MCP browser handoff', () => {
  test('Canva becomes connected after browser authorization', async () => {
    const states = [[server('needs-auth')], [server('pending')], [server('connected')]]
    const seen: string[] = []
    const result = await watchMcpConnection({
      serverName: 'canva',
      read: async () => states.shift() ?? [server('connected')],
      isCurrent: () => true,
      onStatus: servers => seen.push(servers[0]!.status),
      wait: async () => {},
    })
    expect(result).toBe('connected')
    expect(seen).toEqual(['needs-auth', 'pending', 'connected'])
  })

  test('a cancelled or superseded handoff does not post stale state', async () => {
    let current = true
    const seen: string[] = []
    const result = await watchMcpConnection({
      serverName: 'canva',
      read: async () => [server('needs-auth')],
      isCurrent: () => current,
      onStatus: servers => seen.push(servers[0]!.status),
      wait: async () => { current = false },
    })
    expect(result).toBe('cancelled')
    expect(seen).toEqual(['needs-auth'])
  })

  test('a failed server stops polling and remains actionable', async () => {
    const result = await watchMcpConnection({
      serverName: 'canva',
      read: async () => [server('failed')],
      isCurrent: () => true,
      onStatus: () => {},
      wait: async () => {},
    })
    expect(result).toBe('failed')
  })

  test('a browser callback that never arrives leaves a manual fallback', async () => {
    const result = await watchMcpConnection({
      serverName: 'canva',
      read: async () => [server('needs-auth')],
      isCurrent: () => true,
      onStatus: () => {},
      wait: async () => {},
      attempts: 2,
    })
    expect(result).toBe('timeout')
  })
})
