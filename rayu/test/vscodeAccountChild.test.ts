/**
 * The built `--rayucode-account` child signs Rayucode out the way the CLI's /logout
 * does — session, entitlements and the rayu-hosted provider, feature usage, media
 * catalog — in Rayucode's own profile only, and keeps a Rayu API key.
 *
 * Drives the host's own `signOutThroughEngine` against each built engine. Runs when
 * built:  bun run build:vscode [--target linux-x64]
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { signOutThroughEngine } from '../src/vscode/host/account/accountChild.js'
import { withLaunchEnv, type EngineLaunch } from '../src/vscode/host/engine/engineLaunch.js'
import { ACCOUNT_FLAG } from '../src/vscode/shared/accountChildProtocol.js'
import { nativeLaunch, scriptLaunch } from './helpers/engineLaunch.js'

const ENGINE_MJS = resolve(import.meta.dir, '../dist/vscode-stage/engine.mjs')
const NATIVE_ENGINE = resolve(
  import.meta.dir,
  `../dist/vscode/targets/${process.platform}-${process.arch}/rayucode-engine${process.platform === 'win32' ? '.exe' : ''}`,
)
const NODE = Bun.which('node')

const ENGINES: Array<{ name: string; available: boolean; launch: () => EngineLaunch }> = [
  { name: 'engine.mjs on Node', available: existsSync(ENGINE_MJS) && NODE !== null, launch: () => scriptLaunch(ENGINE_MJS, NODE ?? undefined) },
  { name: 'the compiled engine', available: existsSync(NATIVE_ENGINE), launch: () => nativeLaunch(NATIVE_ENGINE) },
]

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A signed-in Rayucode profile, beside a terminal CLI profile that must not change. */
function signedInProfiles(base: EngineLaunch): { profile: string; cli: string; launch: EngineLaunch } {
  const root = mkdtempSync(join(tmpdir(), 'rayucode-account-child-'))
  dirs.push(root)
  const profile = join(root, 'rayucode')
  const cli = join(root, 'cli')
  mkdirSync(profile)
  mkdirSync(cli)
  for (const dir of [profile, cli]) {
    writeFileSync(join(dir, 'rayu-auth.json'), JSON.stringify({
      accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 3_600_000,
      user: { id: 7, email: 'ada@example.com', displayName: 'Ada', avatarUrl: null, role: 'user' },
    }))
  }
  writeFileSync(join(profile, 'rayu-entitlements.json'), JSON.stringify({ plan: { code: 'pro' } }))
  writeFileSync(join(profile, 'rayu-media-models.json'), JSON.stringify({ image: [] }))
  writeFileSync(join(profile, 'providers.json'), JSON.stringify({
    activeProvider: 'rayu-hosted',
    providers: [
      { id: 'rayu-hosted', kind: 'rayu-hosted', baseURL: 'http://127.0.0.1:9/anthropic', defaultModel: 'm', fetchedModels: ['m'] },
      { id: 'rayu', kind: 'anthropic-compatible', baseURL: 'http://127.0.0.1:9', apiKey: 'rayu_sk_live_test', defaultModel: 'm' },
    ],
  }), { mode: 0o600 })
  const launch = withLaunchEnv(base, {
    RAYU_AUTH_CONFIG_DIR: profile,
    RAYU_CONFIG_DIR: cli,
    USE_RAYU_OAUTH: 'true',
    RAYU_DIAGNOSTICS_NO_FILE: '1',
  })
  return { profile, cli, launch }
}

for (const engine of ENGINES) {
  describe(engine.name, () => {
    test.skipIf(!engine.available)('signs out of Rayucode\'s profile only, and keeps the API key', async () => {
      const { profile, cli, launch } = signedInProfiles(engine.launch())
      expect(await signOutThroughEngine(launch)).toEqual({ ok: true, value: true })

      expect(existsSync(join(profile, 'rayu-auth.json'))).toBe(false)
      expect(existsSync(join(profile, 'rayu-entitlements.json'))).toBe(false)
      expect(existsSync(join(profile, 'rayu-media-models.json'))).toBe(false)
      const providers = JSON.parse(readFileSync(join(profile, 'providers.json'), 'utf8')) as { providers: Array<{ id: string }> }
      expect(providers.providers.map(provider => provider.id)).toEqual(['rayu'])
      // The terminal CLI's own sign-in is a different profile.
      expect(existsSync(join(cli, 'rayu-auth.json'))).toBe(true)
    }, 60_000)

    test.skipIf(!engine.available)('an unknown action is refused with a result frame', async () => {
      const { launch } = signedInProfiles(engine.launch())
      const child = Bun.spawn([launch.command, ...launch.baseArgs, ACCOUNT_FLAG], {
        env: { ...process.env, ...launch.env },
        stdin: Buffer.from(JSON.stringify({ action: 'delete-account' })),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual([
        { type: 'rayucode_account_result', ok: false, error: 'Unknown account action.' },
      ])
      expect(code).toBe(1)
    }, 60_000)
  })
}
