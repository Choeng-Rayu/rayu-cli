import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Installer tests run entirely against throwaway fixture directories, wired in
 * via the same env overrides the hosts themselves honour:
 *   CLAUDE_CONFIG_DIR → Claude Code's config dir (and `.claude.json` beside it)
 *   CODEX_HOME        → Codex's home
 *   RAYU_CONFIG_DIR   → where pre-install backups land
 * `RAYU_MCP_SERVER_COMMAND` pins the registered command so assertions do not
 * depend on whether `rayu` happens to be on PATH in CI.
 */

const FIXED_COMMAND = '/opt/rayu/bin/rayu'

let root: string
let claudeDir: string
let codexHome: string
let rayuHome: string
let projectDir: string

const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key]
  process.env[key] = value
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rayu-plugin-test-'))
  claudeDir = join(root, 'claude')
  codexHome = join(root, 'codex')
  rayuHome = join(root, 'rayu')
  projectDir = join(root, 'project')
  await mkdir(claudeDir, { recursive: true })
  await mkdir(codexHome, { recursive: true })
  await mkdir(projectDir, { recursive: true })

  setEnv('CLAUDE_CONFIG_DIR', claudeDir)
  setEnv('CODEX_HOME', codexHome)
  setEnv('RAYU_CONFIG_DIR', rayuHome)
  setEnv('RAYU_MCP_SERVER_COMMAND', FIXED_COMMAND)
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

describe('host detection', () => {
  test('honours the host env overrides', async () => {
    const {
      getClaudeCodeUserConfigFile,
      getClaudeCodeSkillsInstallDir,
      getCodexConfigFile,
      getCodexSkillsInstallDir,
      getProjectMcpJsonFile,
    } = await import('../src/plugins/installers/detect.ts')

    expect(getClaudeCodeUserConfigFile()).toBe(join(claudeDir, '.claude.json'))
    expect(getClaudeCodeSkillsInstallDir()).toBe(join(claudeDir, 'skills'))
    expect(getCodexConfigFile()).toBe(join(codexHome, 'config.toml'))
    expect(getCodexSkillsInstallDir()).toBe(join(codexHome, 'skills'))
    expect(getProjectMcpJsonFile(projectDir)).toBe(join(projectDir, '.mcp.json'))
  })

  test('reports both hosts as present when their dirs exist', async () => {
    const { detectHosts } = await import('../src/plugins/installers/detect.ts')
    const hosts = detectHosts()
    expect(hosts.map(h => h.id)).toEqual(['claude-code', 'codex'])
    expect(hosts.every(h => h.present)).toBe(true)
  })

  test('parses host names, including aliases and "all"', async () => {
    const { parseHostId } = await import('../src/plugins/installers/detect.ts')
    expect(parseHostId('claude')).toBe('claude-code')
    expect(parseHostId('Claude-Code')).toBe('claude-code')
    expect(parseHostId('codex')).toBe('codex')
    expect(parseHostId('all')).toBe('all')
    expect(parseHostId('')).toBe('all')
    expect(parseHostId('cursor')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

describe('Claude Code installer', () => {
  test('creates ~/.claude.json with the rayu MCP entry', async () => {
    const { installClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    const result = await installClaudeCode({ scope: 'user' })

    expect(result.mcpChanged).toBe(true)
    expect(result.serverCommand).toBe(`${FIXED_COMMAND} mcp serve`)

    const doc = await readJson(result.configFile)
    expect(doc.mcpServers).toEqual({
      rayu: { type: 'stdio', command: FIXED_COMMAND, args: ['mcp', 'serve'] },
    })
  })

  test('merges into an existing config without clobbering other keys', async () => {
    const configFile = join(claudeDir, '.claude.json')
    await writeFile(
      configFile,
      JSON.stringify(
        {
          numStartups: 42,
          mcpServers: { Canva: { type: 'http', url: 'https://example.test' } },
          projects: { '/tmp/x': { allowedTools: [] } },
        },
        null,
        2,
      ),
    )

    const { installClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    await installClaudeCode({ scope: 'user' })

    const doc = await readJson(configFile)
    expect(doc.numStartups).toBe(42)
    expect(doc.projects).toEqual({ '/tmp/x': { allowedTools: [] } })
    const servers = doc.mcpServers as Record<string, unknown>
    expect(servers.Canva).toEqual({ type: 'http', url: 'https://example.test' })
    expect(servers.rayu).toBeDefined()
  })

  test('backs the config up before modifying it', async () => {
    const configFile = join(claudeDir, '.claude.json')
    await writeFile(configFile, JSON.stringify({ numStartups: 1 }))

    const { installClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    const result = await installClaudeCode({ scope: 'user' })

    expect(result.backupPath).toBeDefined()
    expect(existsSync(result.backupPath!)).toBe(true)
    expect(JSON.parse(await readFile(result.backupPath!, 'utf8'))).toEqual({
      numStartups: 1,
    })
  })

  test('is idempotent — a second install writes nothing', async () => {
    const { installClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    await installClaudeCode({ scope: 'user' })
    const second = await installClaudeCode({ scope: 'user' })

    expect(second.mcpChanged).toBe(false)
    expect(second.backupPath).toBeUndefined()
    expect(second.skillsWritten).toEqual([])
  })

  test('refuses to modify a config that is not a JSON object', async () => {
    const configFile = join(claudeDir, '.claude.json')
    await writeFile(configFile, 'not json at all {{{')

    const { installClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    await expect(installClaudeCode({ scope: 'user' })).rejects.toThrow(
      /refusing to modify/,
    )
    // The original bytes are still there.
    expect(await readFile(configFile, 'utf8')).toBe('not json at all {{{')
  })

  test('project scope writes <project>/.mcp.json', async () => {
    const { installClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    const result = await installClaudeCode({ scope: 'project', projectDir })

    expect(result.configFile).toBe(join(projectDir, '.mcp.json'))
    const doc = await readJson(result.configFile)
    expect((doc.mcpServers as Record<string, unknown>).rayu).toBeDefined()
    // User-scope config was left alone.
    expect(existsSync(join(claudeDir, '.claude.json'))).toBe(false)
  })

  test('installs the host SKILL.md files', async () => {
    const { installClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    const result = await installClaudeCode({ scope: 'user' })

    expect(result.skillsWritten).toEqual(['rayu', 'rayu-media', 'rayu-telegram'])
    const skill = await readFile(
      join(claudeDir, 'skills', 'rayu', 'SKILL.md'),
      'utf8',
    )
    expect(skill).toContain('name: rayu')
    expect(skill).toContain('mcp__rayu__Read')
  })

  test('--no-skills registers the server only', async () => {
    const { installClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    const result = await installClaudeCode({ scope: 'user', skipSkills: true })

    expect(result.mcpChanged).toBe(true)
    expect(result.skillsDir).toBeUndefined()
    expect(existsSync(join(claudeDir, 'skills'))).toBe(false)
  })

  test('uninstall restores the pre-install config exactly', async () => {
    const configFile = join(claudeDir, '.claude.json')
    const original = {
      numStartups: 7,
      mcpServers: { Canva: { type: 'http', url: 'https://example.test' } },
    }
    await writeFile(configFile, `${JSON.stringify(original, null, 2)}\n`)

    const { installClaudeCode, uninstallClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    await installClaudeCode({ scope: 'user' })
    const result = await uninstallClaudeCode({ scope: 'user' })

    expect(result.mcpRemoved).toBe(true)
    expect(await readJson(configFile)).toEqual(original)
    expect(result.skillsRemoved).toEqual(['rayu', 'rayu-media', 'rayu-telegram'])
    expect(existsSync(join(claudeDir, 'skills', 'rayu'))).toBe(false)
  })

  test('uninstall is idempotent', async () => {
    const { uninstallClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    const result = await uninstallClaudeCode({ scope: 'user' })
    expect(result.mcpRemoved).toBe(false)
    expect(result.skillsRemoved).toEqual([])
  })

  test('status reports registration, skills and staleness', async () => {
    const { getClaudeCodeStatus, installClaudeCode } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )

    const before = await getClaudeCodeStatus({ scope: 'user' })
    expect(before.registered).toBe(false)
    expect(before.installedSkills).toEqual([])

    await installClaudeCode({ scope: 'user' })
    const after = await getClaudeCodeStatus({ scope: 'user' })
    expect(after.registered).toBe(true)
    expect(after.stale).toBe(false)
    expect(after.registeredCommand).toBe(`${FIXED_COMMAND} mcp serve`)
    expect(after.installedSkills).toEqual(['rayu', 'rayu-media', 'rayu-telegram'])

    // A registration pointing somewhere else is reported as stale, not absent.
    process.env.RAYU_MCP_SERVER_COMMAND = '/somewhere/else/rayu'
    const stale = await getClaudeCodeStatus({ scope: 'user' })
    expect(stale.registered).toBe(true)
    expect(stale.stale).toBe(true)
  })

  test('status surfaces an unparseable config instead of throwing', async () => {
    await writeFile(join(claudeDir, '.claude.json'), '}{')
    const { getClaudeCodeStatus } = await import(
      '../src/plugins/installers/claudeCode.ts'
    )
    const status = await getClaudeCodeStatus({ scope: 'user' })
    expect(status.parseError).toMatch(/refusing to modify/)
    expect(status.registered).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

describe('Codex installer', () => {
  const CONFIG = `model = "gpt-5.5"

[projects."/home/rayu/rayu-cli"]
trust_level = "trusted"
`

  test('creates config.toml with the mcp_servers.rayu table', async () => {
    const { installCodex } = await import('../src/plugins/installers/codex.ts')
    const result = await installCodex()

    expect(result.mcpChanged).toBe(true)
    const toml = await readFile(result.configFile, 'utf8')
    expect(toml).toContain('[mcp_servers.rayu]')
    expect(toml).toContain(`command = "${FIXED_COMMAND}"`)
    expect(toml).toContain('args = ["mcp", "serve"]')
    expect(toml).toContain('startup_timeout_sec = 30')
  })

  test('preserves existing config content and comments', async () => {
    const configFile = join(codexHome, 'config.toml')
    await writeFile(configFile, CONFIG)

    const { installCodex } = await import('../src/plugins/installers/codex.ts')
    await installCodex()

    const toml = await readFile(configFile, 'utf8')
    expect(toml).toContain('model = "gpt-5.5"')
    expect(toml).toContain('[projects."/home/rayu/rayu-cli"]')
    expect(toml).toContain('trust_level = "trusted"')
    expect(toml).toContain('[mcp_servers.rayu]')
  })

  test('backs up before modifying', async () => {
    await writeFile(join(codexHome, 'config.toml'), CONFIG)
    const { installCodex } = await import('../src/plugins/installers/codex.ts')
    const result = await installCodex()

    expect(result.backupPath).toBeDefined()
    expect(await readFile(result.backupPath!, 'utf8')).toBe(CONFIG)
  })

  test('is idempotent', async () => {
    const { installCodex } = await import('../src/plugins/installers/codex.ts')
    await installCodex()
    const before = await readFile(join(codexHome, 'config.toml'), 'utf8')
    const second = await installCodex()

    expect(second.mcpChanged).toBe(false)
    expect(second.backupPath).toBeUndefined()
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe(before)
  })

  test('refreshes a stale registration in place', async () => {
    const { installCodex, getCodexStatus } = await import(
      '../src/plugins/installers/codex.ts'
    )
    await writeFile(join(codexHome, 'config.toml'), CONFIG)
    await installCodex()

    process.env.RAYU_MCP_SERVER_COMMAND = '/new/path/rayu'
    expect((await getCodexStatus()).stale).toBe(true)

    const refreshed = await installCodex()
    expect(refreshed.mcpChanged).toBe(true)

    const toml = await readFile(join(codexHome, 'config.toml'), 'utf8')
    expect(toml).toContain('command = "/new/path/rayu"')
    expect(toml).not.toContain(FIXED_COMMAND)
    expect(toml.match(/\[mcp_servers\.rayu\]/g)).toHaveLength(1)
    expect(toml).toContain('[projects."/home/rayu/rayu-cli"]')
  })

  test('installs host skills into <CODEX_HOME>/skills', async () => {
    const { installCodex } = await import('../src/plugins/installers/codex.ts')
    const result = await installCodex()
    expect(result.skillsWritten).toEqual(['rayu', 'rayu-media', 'rayu-telegram'])
    expect(existsSync(join(codexHome, 'skills', 'rayu-media', 'SKILL.md'))).toBe(
      true,
    )
  })

  test('uninstall restores the original config byte-for-byte', async () => {
    const configFile = join(codexHome, 'config.toml')
    await writeFile(configFile, CONFIG)

    const { installCodex, uninstallCodex } = await import(
      '../src/plugins/installers/codex.ts'
    )
    await installCodex()
    const result = await uninstallCodex()

    expect(result.mcpRemoved).toBe(true)
    expect(await readFile(configFile, 'utf8')).toBe(CONFIG)
    expect(result.skillsRemoved).toEqual(['rayu', 'rayu-media', 'rayu-telegram'])
  })

  test('uninstall is idempotent', async () => {
    const { uninstallCodex } = await import('../src/plugins/installers/codex.ts')
    const result = await uninstallCodex()
    expect(result.mcpRemoved).toBe(false)
    expect(result.skillsRemoved).toEqual([])
  })

  test('status reports registration state', async () => {
    const { getCodexStatus, installCodex } = await import(
      '../src/plugins/installers/codex.ts'
    )
    expect((await getCodexStatus()).registered).toBe(false)

    await installCodex()
    const status = await getCodexStatus()
    expect(status.registered).toBe(true)
    expect(status.stale).toBe(false)
    expect(status.registeredCommand).toBe(`${FIXED_COMMAND} mcp serve`)
    expect(status.installedSkills).toEqual([
      'rayu',
      'rayu-media',
      'rayu-telegram',
    ])
  })
})

// ---------------------------------------------------------------------------
// User-owned files are never collateral damage
// ---------------------------------------------------------------------------

describe('skill file safety', () => {
  test("uninstall keeps a user's own files in a RAYU skill directory", async () => {
    const { installHostSkills, uninstallHostSkills } = await import(
      '../src/plugins/installers/skillFiles.ts'
    )
    const skillsDir = join(root, 'skills')
    await installHostSkills(skillsDir)

    const userFile = join(skillsDir, 'rayu', 'my-notes.md')
    await writeFile(userFile, 'mine')

    await uninstallHostSkills(skillsDir)

    expect(existsSync(join(skillsDir, 'rayu', 'SKILL.md'))).toBe(false)
    expect(existsSync(userFile)).toBe(true)
    // Directories RAYU emptied are reclaimed.
    expect(existsSync(join(skillsDir, 'rayu-media'))).toBe(false)
  })

  test('re-installing an edited skill restores RAYU content', async () => {
    const { installHostSkills } = await import(
      '../src/plugins/installers/skillFiles.ts'
    )
    const skillsDir = join(root, 'skills2')
    await installHostSkills(skillsDir)

    const target = join(skillsDir, 'rayu', 'SKILL.md')
    await writeFile(target, 'tampered')

    const result = await installHostSkills(skillsDir)
    expect(result.written).toEqual(['rayu'])
    expect(result.unchanged).toEqual(['rayu-media', 'rayu-telegram'])
    expect(await readFile(target, 'utf8')).toContain('name: rayu')
  })
})
