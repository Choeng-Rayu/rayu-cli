/**
 * The `/status` report, as Markdown. Pure: every fact is supplied by the host, so the
 * same string can be shown in the editor and asserted in a test without a window.
 */
import type { StatusFacts } from './index.js'

export function statusMarkdown(facts: StatusFacts): string {
  const lines = [
    '# Rayucode status',
    '',
    `- **Extension version**: ${facts.extensionVersion}`,
    `- **Model**: ${facts.model ?? 'not set'}`,
    `- **Provider**: ${facts.provider ?? 'not set'}`,
    `- **Working directory**: \`${facts.cwd}\``,
    `- **Session**: ${facts.sessionId ?? 'none'}`,
    `- **Permission mode**: ${facts.permissionMode}`,
    `- **Signed in**: ${signInLabel(facts)}`,
    '',
    '## MCP servers',
    '',
  ]

  if (facts.mcpServers.length === 0) {
    lines.push('No MCP servers.')
  } else {
    for (const server of facts.mcpServers) {
      lines.push(`- **${server.name}**: ${server.status}`)
    }
  }

  return `${lines.join('\n').trim()}\n`
}

function signInLabel(facts: StatusFacts): string {
  if (!facts.signedIn) return 'no'
  return facts.account ? `yes (${facts.account})` : 'yes'
}
