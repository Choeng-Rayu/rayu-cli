import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { RuntimeCenter } from '../src/vscode/webview/components/RuntimeCenter.js'
import { SessionHeader } from '../src/vscode/webview/components/SessionHeader.js'
import type { McpConnectionUiView, McpServerView } from '../src/vscode/shared/webviewProtocol.js'

const noop = () => {}
const canva: McpServerView = { name: 'canva', status: 'connected', supportsOAuth: true }

test('the MCP view shows browser progress and the connected Canva server', () => {
  const connection: McpConnectionUiView = {
    load: 'ready', error: null,
    auth: { serverName: 'canva', stage: 'connected' },
  }
  const html = renderToStaticMarkup(createElement(RuntimeCenter, {
    initialSection: 'mcp', commands: [], tools: [], mcpServers: [canva],
    mcpConnectionUi: connection, agents: [], plugins: [], skills: [], workflows: [],
    onClose: noop, onUseCommand: noop, onRefreshMcp: noop, onReconnectMcp: noop,
    onToggleMcp: noop, onAuthenticateMcp: noop, onClearMcpAuth: noop,
    onPasteMcpCallback: noop,
  }))
  expect(html).toContain('canva')
  expect(html).toContain('Connected.')
  expect(html).toContain('Refresh connections')
})

test('the MCP view distinguishes a failed status check from no connections', () => {
  const html = renderToStaticMarkup(createElement(RuntimeCenter, {
    initialSection: 'mcp', commands: [], tools: [], mcpServers: [],
    mcpConnectionUi: { load: 'error', error: 'engine unavailable', auth: null },
    agents: [], plugins: [], skills: [], workflows: [],
    onClose: noop, onUseCommand: noop, onRefreshMcp: noop, onReconnectMcp: noop,
    onToggleMcp: noop, onAuthenticateMcp: noop, onClearMcpAuth: noop,
    onPasteMcpCallback: noop,
  }))
  expect(html).toContain('Could not check MCP connections')
  expect(html).toContain('engine unavailable')
  expect(html).not.toContain('No MCP servers are connected')
})

test('the panel header shows the conversation title and Canva as connected', () => {
  const html = renderToStaticMarkup(createElement(SessionHeader, {
    ready: true, signedOut: false, identity: null, version: 'test', title: 'Canva session', activeSessionKey: 'test-session',
    surface: 'panel',
    status: 'idle', mcpServers: [canva],
    mcpConnectionUi: { load: 'ready', error: null, auth: null },
    onNewSession: noop, onRename: noop, onCloseTab: noop,
    detailed: false, onToggleDetailed: noop,
    backgroundTaskCount: 0, backgroundOpen: false, onToggleBackground: noop,
    onOpenProviderSetup: noop, onRefreshMcp: noop, onOpenMcp: noop,
    onReconnectMcp: noop, onAuthenticateMcp: noop, onToggleMcp: noop,
    onSignIn: noop, onSignOut: noop,
  }))
  expect(html).toContain('Canva session')
  expect(html).toContain('rc-icon-badge">1</span>')
  expect(html).toContain('1 MCP server connected')
})

// The sidebar is the management hub: its header carries no per-conversation chrome —
// no title, no status, no detail switch — only agent-level actions. This pins that
// split, because a title leaking back in is exactly the "duplicate of the tab" bug
// the redesign removed.
test('the sidebar header is management chrome only: no title, no close, but new session', () => {
  const html = renderToStaticMarkup(createElement(SessionHeader, {
    ready: true, signedOut: false, identity: null, version: 'test', title: 'Canva session', activeSessionKey: 'test-session',
    surface: 'sidebar',
    status: 'working', mcpServers: [canva],
    mcpConnectionUi: { load: 'ready', error: null, auth: null },
    onNewSession: noop, onRename: noop, onCloseTab: noop,
    detailed: false, onToggleDetailed: noop,
    backgroundTaskCount: 0, backgroundOpen: false, onToggleBackground: noop,
    onOpenProviderSetup: noop, onRefreshMcp: noop, onOpenMcp: noop,
    onReconnectMcp: noop, onAuthenticateMcp: noop, onToggleMcp: noop,
    onSignIn: noop, onSignOut: noop,
  }))
  expect(html).not.toContain('Canva session')
  expect(html).not.toContain('Working')
  expect(html).not.toContain('Toggle tool details')
  expect(html).not.toContain('Close session')
  expect(html).toContain('New session')
  expect(html).toContain('1 MCP server connected')
})
