/**
 * The `vscodeHost` entrypoint — the engine the Rayucode extension spawns.
 *
 * Two things are tested, and the second is the one that matters:
 *
 *  1. the argv contract, as a pure function. `--verbose` is not decoration:
 *     print.ts refuses `--output-format=stream-json` without it. Encoding the
 *     flag set on the engine side is the point of this entrypoint — it used to
 *     live in `rayucode/packages/core/src/cli/agentProcess.ts`, i.e. in another
 *     repository that could not see changes to the contract.
 *
 *  2. CAPABILITY PARITY. The host must expose the same tools, slash commands and
 *     skills as the CLI, because it delegates to the same `main()` rather than
 *     reassembling the registry. This is the property the whole design rests on:
 *     if the two ever diverge, the extension is running a different engine than
 *     the CLI and "one source of truth" is a claim rather than a fact.
 *
 * The parity check spawns both bundles, so it is slow and skips when they are not
 * built. Build with `bun run build && bun run build:vscode-host`.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildHostArgv } from '../src/entrypoints/vscodeHost.ts'

const ROOT = resolve(import.meta.dir, '..')
const CLI = join(ROOT, 'dist/rayu.js')
const HOST = join(ROOT, 'dist/rayu-vscode-host.js')
const bundlesBuilt = existsSync(CLI) && existsSync(HOST)

describe('the argv contract is owned by the engine', () => {
  test('an empty argv gets the full headless flag set', () => {
    expect(buildHostArgv([])).toEqual([
      '--print',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--verbose',
      '--permission-prompt-tool=stdio',
    ])
  })

  test('--permission-prompt-tool=stdio is present, or permissions never reach the host', () => {
    // getCanUseToolFn() in print.ts: 'stdio' sends a `can_use_tool` control
    // request; UNDEFINED decides locally. Without this flag the engine resolved
    // every permission by itself, so the panel reported that a tool needed
    // permission and the user was never asked for one.
    expect(buildHostArgv([])).toContain('--permission-prompt-tool=stdio')
  })

  test('a caller may override the permission prompt tool', () => {
    const out = buildHostArgv(['--permission-prompt-tool=some_mcp_tool'])
    expect(out.filter(a => a.startsWith('--permission-prompt-tool')).length).toBe(1)
    expect(out).toContain('--permission-prompt-tool=some_mcp_tool')
  })

  test('--verbose is always present, because stream-json output requires it', () => {
    // print.ts: "When using --print, --output-format=stream-json requires --verbose".
    expect(buildHostArgv([])).toContain('--verbose')
  })

  test('caller flags survive untouched', () => {
    const out = buildHostArgv(['--model', 'claude-sonnet-4', '--resume', 'abc'])
    expect(out.slice(0, 4)).toEqual(['--model', 'claude-sonnet-4', '--resume', 'abc'])
    expect(out).toContain('--print')
  })

  test('a flag the caller already set is not duplicated', () => {
    // A repeated --output-format would be ambiguous, not merely noisy.
    const out = buildHostArgv(['--output-format=stream-json'])
    expect(out.filter(a => a.startsWith('--output-format')).length).toBe(1)
  })

  test('a caller value for a required flag wins over the default', () => {
    // If a consumer ever needs a different output format, the host must not
    // silently append a second one.
    const out = buildHostArgv(['--output-format=json'])
    expect(out).toContain('--output-format=json')
    expect(out).not.toContain('--output-format=stream-json')
  })

  test('the space-separated form is recognised as already present', () => {
    const out = buildHostArgv(['--output-format', 'json'])
    expect(out.filter(a => a.startsWith('--output-format')).length).toBe(1)
  })

  test('a boolean flag already present is not repeated', () => {
    expect(buildHostArgv(['--print']).filter(a => a === '--print').length).toBe(1)
    expect(buildHostArgv(['--verbose']).filter(a => a === '--verbose').length).toBe(1)
  })
})

/** Run a bundle with one stream-json prompt on stdin and return its `system/init`. */
function systemInit(bundle: string, extraArgs: string[]): Record<string, unknown> | null {
  const configDir = mkdtempSync(join(tmpdir(), 'rayu-host-parity-'))
  // A session file so the login gate (print.ts) does not refuse the turn.
  writeFileSync(
    join(configDir, 'rayu-auth.json'),
    JSON.stringify({
      accessToken: 'test',
      refreshToken: 'test',
      expiresAt: Date.now() + 3_600_000,
    }),
    { mode: 0o600 },
  )

  const proc = Bun.spawnSync(['node', bundle, ...extraArgs], {
    cwd: configDir,
    env: { ...process.env, RAYU_CONFIG_DIR: configDir },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/cost' },
      }) + '\n',
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  for (const line of proc.stdout.toString().split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed.type === 'system' && parsed.subtype === 'init') return parsed
    } catch {
      // Non-JSON on stdout would itself be a bug, but it is not this test's
      // assertion — the stream guard is covered elsewhere.
    }
  }
  return null
}

describe.if(bundlesBuilt)('the host exposes the same engine as the CLI', () => {
  const cliInit = bundlesBuilt
    ? systemInit(CLI, [
        '--print',
        '--input-format=stream-json',
        '--output-format=stream-json',
        '--verbose',
      ])
    : null
  const hostInit = bundlesBuilt ? systemInit(HOST, []) : null

  test('both emit a system/init', () => {
    expect(cliInit, 'the CLI must announce init').not.toBeNull()
    expect(hostInit, 'the host must announce init').not.toBeNull()
  })

  test('the tool inventory is identical', () => {
    // Not just the same count — the same names. A host missing one tool would
    // silently make the extension less capable than the CLI.
    expect(hostInit?.tools).toEqual(cliInit?.tools)
    expect((hostInit?.tools as string[]).length).toBeGreaterThan(20)
  })

  test('the slash-command inventory is identical', () => {
    expect(hostInit?.slash_commands).toEqual(cliInit?.slash_commands)
    expect((hostInit?.slash_commands as string[]).length).toBeGreaterThan(10)
  })

  test('the skill inventory is identical', () => {
    expect(hostInit?.skills).toEqual(cliInit?.skills)
  })

  test('protocol version and permission mode agree', () => {
    expect(hostInit?.protocolVersion).toBe(cliInit?.protocolVersion)
    expect(hostInit?.permissionMode).toBe(cliInit?.permissionMode)
  })

  test('the host needs no flags of its own, proving it owns the contract', () => {
    // The CLI required four flags above; the host was spawned with none.
    expect(hostInit).not.toBeNull()
  })
})
