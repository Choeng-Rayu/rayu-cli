/**
 * A provider API key never appears in a process command line.
 *
 * `validate`/`save` run in a helper child for a network round-trip. Anything in that
 * child's argv is readable by EVERY local user for that whole time (`ps`,
 * `/proc/<pid>/cmdline`), so the host sends the action over stdin. This drives the
 * real host function against the real built engine and inspects the process table
 * while the helper is mid-request.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { validateProvider } from '../src/vscode/host/auth/providerSetup.js'
import { CONNECT_FLAG } from '../src/vscode/shared/connectProtocol.js'

const ENGINE = resolve(import.meta.dir, '../dist/vscode-stage/engine.mjs')
const saved = { config: process.env.RAYU_CONFIG_DIR, oauth: process.env.USE_RAYU_OAUTH }
const dirs: string[] = []

afterEach(() => {
  if (saved.config === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = saved.config
  if (saved.oauth === undefined) delete process.env.USE_RAYU_OAUTH
  else process.env.USE_RAYU_OAUTH = saved.oauth
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Every command line currently visible in /proc, as the shell would show it. */
function commandLines(): string[] {
  const lines: string[] = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      lines.push(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\u0000', ' '))
    } catch {
      // Exited between the listing and the read.
    }
  }
  return lines
}

test.skipIf(process.platform !== 'linux' || !existsSync(ENGINE))(
  'validate sends the key over stdin, not argv, and still classifies the endpoint',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rayucode-connect-'))
    dirs.push(dir)
    process.env.RAYU_CONFIG_DIR = dir
    process.env.USE_RAYU_OAUTH = 'false'
    const key = 'test-secret-argv-must-not-carry'

    let sawHelper = false
    let leaked = false
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      // The helper is alive and mid-request exactly while this handler runs.
      fetch: () => {
        const lines = commandLines()
        sawHelper = lines.some(line => line.includes(CONNECT_FLAG))
        leaked = lines.some(line => line.includes(key))
        return new Response('', { status: 401 })
      },
    })
    try {
      const outcome = await validateProvider(
        { enginePath: ENGINE, cwd: dir },
        'deepseek',
        key,
        `http://127.0.0.1:${server.port}/v1`,
      )
      expect(sawHelper).toBe(true)
      expect(leaked).toBe(false)
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toContain('rejected')
      expect(outcome.error ?? '').not.toContain(key)
    } finally {
      server.stop(true)
    }
  },
  30_000,
)


/** Run the built helper with `input` on stdin; return its result frame and raw output. */
async function runHelper(input: string): Promise<{ result: Record<string, unknown>; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-connect-stdin-'))
  dirs.push(dir)
  const child = Bun.spawn(['node', ENGINE, CONNECT_FLAG], {
    cwd: dir,
    env: { ...process.env, RAYU_CONFIG_DIR: dir, USE_RAYU_OAUTH: 'false' },
    stdin: Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const result = stdout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .find(frame => frame.type === 'rayucode_connect_result')
  expect(result, `no result frame; stderr: ${stderr.slice(-400)}`).toBeDefined()
  return { result: result!, output: stdout + stderr }
}

test.skipIf(!existsSync(ENGINE))(
  'a malformed action is refused without quoting it back',
  async () => {
    // V8's JSON.parse message quotes the text it choked on, and this text can be a key.
    const secret = 'test-secret-malformed-action'
    const { result, output } = await runHelper(
      `{"action":"validate","providerId":"deepseek","apiKey":"${secret}"`,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Malformed provider-setup action.')
    expect(output).not.toContain(secret)
  },
  30_000,
)

test.skipIf(!existsSync(ENGINE))(
  'an oversized or empty action gets its own reason, as a result frame',
  async () => {
    const oversized = await runHelper('x'.repeat(70 * 1024))
    expect(oversized.result.ok).toBe(false)
    expect(oversized.result.error).toBe('The provider-setup action is too large.')

    const empty = await runHelper('')
    expect(empty.result.ok).toBe(false)
    expect(empty.result.error).toBe('No provider-setup action was supplied.')
  },
  30_000,
)
