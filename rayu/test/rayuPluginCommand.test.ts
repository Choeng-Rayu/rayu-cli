import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LocalJSXCommandContext } from '../src/types/command.ts'

/**
 * Command-level tests for `/rayu-plugin`.
 *
 * These exercise the whole path a user hits: argument parsing → host selection →
 * installer → rendered text. Host config lives in throwaway fixture dirs wired
 * in through the same env overrides the hosts themselves honour.
 */

const FIXED_COMMAND = '/opt/rayu/bin/rayu'

let root: string
let claudeDir: string
let codexHome: string
let projectDir: string
const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key]
  process.env[key] = value
}

/** `/rayu-plugin` reads nothing off the context, so an empty stub is honest. */
const CONTEXT = {} as LocalJSXCommandContext

async function run(args: string): Promise<string> {
  const { call } = await import('../src/commands/rayu-plugin/rayu-plugin.ts')
  const result = await call(args, CONTEXT)
  if (result.type !== 'text') {
    throw new Error(`expected text result, got ${result.type}`)
  }
  return result.value
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rayu-plugin-cmd-'))
  claudeDir = join(root, 'claude')
  codexHome = join(root, 'codex')
  projectDir = join(root, 'project')
  await mkdir(claudeDir, { recursive: true })
  await mkdir(codexHome, { recursive: true })
  await mkdir(projectDir, { recursive: true })

  setEnv('CLAUDE_CONFIG_DIR', claudeDir)
  setEnv('CODEX_HOME', codexHome)
  setEnv('RAYU_CONFIG_DIR', join(root, 'rayu'))
  setEnv('RAYU_MCP_SERVER_COMMAND', FIXED_COMMAND)
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

describe('/rayu-plugin argument handling', () => {
  test('defaults to the read-only status action', async () => {
    const output = await run('')
    expect(output).toContain('MCP server command:')
    // Nothing was written to either host.
    expect(existsSync(join(claudeDir, '.claude.json'))).toBe(false)
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false)
  })

  test('rejects an unknown option with usage', async () => {
    const output = await run('install --wat')
    expect(output).toContain('Unknown option: --wat')
    expect(output).toContain('Usage: /rayu-plugin')
    expect(existsSync(join(claudeDir, '.claude.json'))).toBe(false)
  })

  test('rejects an unknown host with usage', async () => {
    const output = await run('install cursor')
    expect(output).toContain('Unknown argument: cursor')
    expect(existsSync(join(claudeDir, '.claude.json'))).toBe(false)
  })
})

describe('/rayu-plugin install', () => {
  test('installs into both detected hosts', async () => {
    const output = await run('install')

    expect(output).toContain('Installed into Claude Code')
    expect(output).toContain('Installed into Codex')
    expect(output).toContain('Restart the host agent')

    const claudeDoc = JSON.parse(
      await readFile(join(claudeDir, '.claude.json'), 'utf8'),
    ) as { mcpServers: Record<string, { command: string }> }
    expect(claudeDoc.mcpServers.rayu?.command).toBe(FIXED_COMMAND)

    const codexToml = await readFile(join(codexHome, 'config.toml'), 'utf8')
    expect(codexToml).toContain('[mcp_servers.rayu]')
  })

  test('installs into a single named host only', async () => {
    const output = await run('install codex')
    expect(output).toContain('Codex')
    expect(output).not.toContain('Claude Code')
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(true)
    expect(existsSync(join(claudeDir, '.claude.json'))).toBe(false)
  })

  test('accepts the `claude` alias', async () => {
    await run('install claude')
    expect(existsSync(join(claudeDir, '.claude.json'))).toBe(true)
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false)
  })

  test('reports "already installed" on a second run', async () => {
    await run('install')
    const output = await run('install')
    expect(output).toContain('Already installed in Claude Code')
    expect(output).toContain('Already installed in Codex')
  })

  test('--project targets <cwd>/.mcp.json and notes Codex has no such scope', async () => {
    // RAYU resolves the project dir through getCwd() (its own cwd state), not
    // process.cwd() — so process.chdir would silently write into the repo.
    // runWithCwdOverride is the supported way to scope it.
    const { runWithCwdOverride } = await import('../src/utils/cwd.ts')
    const output = await runWithCwdOverride(projectDir, () =>
      run('install --project'),
    )

    expect(output).toContain('.mcp.json')
    expect(output).toContain('Codex has no project-scope MCP file')
    expect(existsSync(join(projectDir, '.mcp.json'))).toBe(true)
    // User-scope config was left alone.
    expect(existsSync(join(claudeDir, '.claude.json'))).toBe(false)
  })

  test('--no-skills registers the server without skill files', async () => {
    await run('install --no-skills')
    expect(existsSync(join(claudeDir, '.claude.json'))).toBe(true)
    expect(existsSync(join(claudeDir, 'skills'))).toBe(false)
    expect(existsSync(join(codexHome, 'skills'))).toBe(false)
  })

  test('reports a per-host failure without aborting the other host', async () => {
    await writeFile(join(claudeDir, '.claude.json'), 'not json {{{')
    const output = await run('install')

    expect(output).toContain('✗ Claude Code')
    expect(output).toContain('refusing to modify')
    // Codex still got installed.
    expect(output).toContain('Installed into Codex')
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(true)
  })
})

describe('/rayu-plugin status', () => {
  test('reports an unregistered state and a healthy in-process server', async () => {
    const output = await run('status')
    expect(output).toContain(`MCP server command: ${FIXED_COMMAND} mcp serve`)
    // The health line comes from a real in-process handshake + tools/list.
    expect(output).toMatch(/MCP server: healthy — \d+ tools, \d+ skills/)
    expect(output).toContain('registered: no')
    expect(output).toContain('skills: none installed')
    expect(output).toContain('Tools exposed over MCP:')
    expect(output).toContain('Read')
  }, 60_000)

  test('reports registration and installed skills after install', async () => {
    await run('install')
    const output = await run('status')
    expect(output).toContain('registered: yes')
    expect(output).toContain('rayu, rayu-media, rayu-telegram')
  }, 60_000)

  test('flags a stale registration and tells the user how to fix it', async () => {
    await run('install')
    process.env.RAYU_MCP_SERVER_COMMAND = '/moved/rayu'
    const output = await run('status')
    expect(output).toContain('but points at')
    expect(output).toContain('re-run `/rayu-plugin install`')
  }, 60_000)
})

describe('/rayu-plugin uninstall', () => {
  test('removes the registration and the skills from both hosts', async () => {
    await run('install')
    const output = await run('uninstall')

    expect(output).toContain('Removed from Claude Code')
    expect(output).toContain('Removed from Codex')
    expect(output).toContain('skills removed: rayu, rayu-media, rayu-telegram')

    const claudeDoc = JSON.parse(
      await readFile(join(claudeDir, '.claude.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> }
    expect(claudeDoc.mcpServers.rayu).toBeUndefined()
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).not.toContain(
      'mcp_servers.rayu',
    )
  })

  test('is idempotent', async () => {
    const output = await run('uninstall')
    expect(output).toContain('nothing to remove')
  })
})

describe('MCP health ping', () => {
  test('reports the exposed tool set from a real round trip', async () => {
    const { pingRayuMcpServer } = await import(
      '../src/plugins/installers/health.ts'
    )
    const health = await pingRayuMcpServer(projectDir)
    expect(health.ok).toBe(true)
    if (!health.ok) return
    expect(health.toolCount).toBeGreaterThan(0)
    expect(health.toolNames).toContain('Read')
    expect(health.toolNames).not.toContain('TodoWrite')
  }, 60_000)
})
