import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import {
  RAYU_CONFIG_DIRS,
  getExternalSkillDirs,
} from '../src/utils/externalSkillDiscovery.ts'
import { getClaudeFallbackMcpServers } from '../src/services/mcp/config.ts'

// ---- Skills interop ----
test('.agent (singular) is a recognized config dir alongside .rayu/.agents', () => {
  expect(RAYU_CONFIG_DIRS).toContain('.rayu')
  expect(RAYU_CONFIG_DIRS).toContain('.agents')
  expect(RAYU_CONFIG_DIRS).toContain('.agent')
})

test('project .claude/skills is discovered (skills-only Claude interop)', () => {
  const proj = mkdtempSync(join(tmpdir(), 'rayu-skills-'))
  try {
    mkdirSync(join(proj, '.claude', 'skills'), { recursive: true })
    const dirs = runWithCwdOverride(proj, () => getExternalSkillDirs())
    expect(
      dirs.some(d => d.startsWith(proj) && d.includes(`.claude${'/'}skills`)),
    ).toBe(true)
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

// ---- MCP fallback (mcpServers ONLY; rayu/claude auth+model stay separate) ----
test('Claude MCP fallback reads mcpServers and tags them user scope', () => {
  const proj = mkdtempSync(join(tmpdir(), 'rayu-mcp-'))
  try {
    mkdirSync(join(proj, '.claude'), { recursive: true })
    writeFileSync(
      join(proj, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          rayuTestClaudeServer: { command: 'echo', args: ['hi'] },
        },
        // These must be IGNORED — never read model/provider/auth from Claude.
        model: 'claude-should-be-ignored',
        apiKeyHelper: 'SECRET_SHOULD_NOT_LEAK',
        primaryApiKey: 'SECRET_SHOULD_NOT_LEAK',
      }),
    )
    const servers = runWithCwdOverride(proj, () =>
      getClaudeFallbackMcpServers(),
    )
    // The mcpServers entry is read…
    expect(servers.rayuTestClaudeServer).toBeDefined()
    expect(servers.rayuTestClaudeServer?.scope).toBe('user')
    expect((servers.rayuTestClaudeServer as { command?: string }).command).toBe(
      'echo',
    )
    // …and the model/auth keys are NOT turned into servers (invariant).
    expect('model' in servers).toBe(false)
    expect('apiKeyHelper' in servers).toBe(false)
    expect('primaryApiKey' in servers).toBe(false)
    // No returned server config carries the secret value anywhere obvious.
    const serialized = JSON.stringify(servers)
    expect(serialized.includes('SECRET_SHOULD_NOT_LEAK')).toBe(false)
    expect(serialized.includes('claude-should-be-ignored')).toBe(false)
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('Claude MCP fallback ignores a config with no mcpServers (model/auth only)', () => {
  const proj = mkdtempSync(join(tmpdir(), 'rayu-mcp2-'))
  try {
    mkdirSync(join(proj, '.claude'), { recursive: true })
    writeFileSync(
      join(proj, '.claude', 'settings.json'),
      JSON.stringify({ model: 'x', primaryApiKey: 'y' }),
    )
    const servers = runWithCwdOverride(proj, () =>
      getClaudeFallbackMcpServers(),
    )
    // Nothing from THIS file becomes a server (it had no mcpServers).
    expect('model' in servers).toBe(false)
    expect('primaryApiKey' in servers).toBe(false)
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})
