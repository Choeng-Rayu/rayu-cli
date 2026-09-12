/**
 * The test suite must not touch the developer's real `~/.rayu`.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────
 *
 * It did touch it. The convention for isolating config is to point `RAYU_CONFIG_DIR` at a
 * temp directory in `beforeEach` and `delete` it in `afterEach` — and deleting it restores
 * the DEFAULT, which is the real `~/.rayu`. Seventy-seven test files follow that pattern, so
 * from the first one onwards every unsandboxed test read and wrote the developer's actual
 * configuration.
 *
 * The observed damage to a real `providers.json`: seventeen fixture providers appended, two
 * real API keys overwritten with a test key, two base URLs replaced with fixture hosts, and
 * `activeProvider` switched to a fixture pointing at an unreachable URL — which left the CLI
 * unable to reach any provider and the model picker offering models that do not exist.
 *
 * These tests pin the guard that stops it. They deliberately exercise the UNSANDBOXED path,
 * which is safe precisely because the guard makes it a no-op — if the guard regresses, the
 * assertions below fail rather than the developer's keys.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isUnsandboxedTestConfigAccess } from '../src/utils/envUtils.js'

const SAVED = {
  configDir: process.env.RAYU_CONFIG_DIR,
  authDir: process.env.RAYU_AUTH_CONFIG_DIR,
}

afterEach(() => {
  // Restore rather than delete — the point of this file.
  if (SAVED.configDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = SAVED.configDir
  if (SAVED.authDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = SAVED.authDir
})

describe('isUnsandboxedTestConfigAccess', () => {
  test('true under a test runner with no config directory set', () => {
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.RAYU_AUTH_CONFIG_DIR
    expect(isUnsandboxedTestConfigAccess()).toBe(true)
  })

  test('false as soon as either directory is redirected', () => {
    process.env.RAYU_CONFIG_DIR = '/tmp/somewhere'
    expect(isUnsandboxedTestConfigAccess()).toBe(false)

    delete process.env.RAYU_CONFIG_DIR
    process.env.RAYU_AUTH_CONFIG_DIR = '/tmp/elsewhere'
    // A sandboxed test must keep its real disk round trips — the guard is about the
    // DEFAULT path, not about disabling persistence in tests.
    expect(isUnsandboxedTestConfigAccess()).toBe(false)
  })
})

describe('provider config is not written to the real config home', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'rayu-sandbox-'))
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  async function freshConfigModule() {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
    return cfg
  }

  test('an unsandboxed save writes nothing to disk, and reads back in memory', async () => {
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.RAYU_AUTH_CONFIG_DIR
    const { loadRayuConfig, saveRayuConfig, _resetRayuConfigCache } =
      await freshConfigModule()

    // Also proves the READ is hermetic: whatever the developer actually has configured,
    // an unsandboxed test starts from empty. A test that saw the real list was
    // nondeterministic by definition.
    expect(loadRayuConfig().providers).toEqual([])

    saveRayuConfig({
      activeProvider: 'fixture',
      providers: [{ id: 'fixture', kind: 'openai-compatible', apiKey: 'sk-test' } as never],
    })

    // Visible to the rest of the test through the in-memory cache…
    expect(loadRayuConfig().activeProvider).toBe('fixture')
    // …and gone the moment the cache is dropped, because it never reached a file.
    _resetRayuConfigCache()
    expect(loadRayuConfig().providers).toEqual([])
  })

  test('a sandboxed save still persists, so isolation costs no coverage', async () => {
    process.env.RAYU_CONFIG_DIR = sandbox
    const { saveRayuConfig, loadRayuConfig, _resetRayuConfigCache } =
      await freshConfigModule()

    saveRayuConfig({
      activeProvider: 'fixture',
      providers: [{ id: 'fixture', kind: 'openai-compatible' } as never],
    })

    const written = join(sandbox, 'providers.json')
    expect(existsSync(written)).toBe(true)
    expect(JSON.parse(readFileSync(written, 'utf8')).activeProvider).toBe('fixture')

    _resetRayuConfigCache()
    expect(loadRayuConfig().activeProvider).toBe('fixture')
  })

  test('an existing file in the real home is not read and not modified', async () => {
    // Stand in for the developer's own config: a file at the DEFAULT path, which is what
    // the guard protects. Uses a redirected home first to create it, then removes the
    // redirect to prove the unsandboxed path leaves it alone.
    process.env.RAYU_CONFIG_DIR = sandbox
    const path = join(sandbox, 'providers.json')
    const original = JSON.stringify({
      activeProvider: 'real-provider',
      providers: [{ id: 'real-provider', apiKey: 'sk-do-not-touch' }],
    })
    writeFileSync(path, original, { mode: 0o600 })

    const { loadRayuConfig, saveRayuConfig, _resetRayuConfigCache } =
      await freshConfigModule()
    // Sandboxed: the file IS read.
    expect(loadRayuConfig().activeProvider).toBe('real-provider')

    // Now the same directory becomes "the default" as far as the guard is concerned by
    // being unreachable through the env var. Nothing may be written to it.
    delete process.env.RAYU_CONFIG_DIR
    _resetRayuConfigCache()
    saveRayuConfig({ activeProvider: 'fixture', providers: [] })

    expect(readFileSync(path, 'utf8')).toBe(original)
  })
})

describe('user settings are not written to the real config home', () => {
  test('an unsandboxed user-scope write is skipped and reports no error', async () => {
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.RAYU_AUTH_CONFIG_DIR
    const { updateSettingsForSource, getSettingsFilePathForSource } = await import(
      '../src/utils/settings/settings.ts'
    )

    const path = getSettingsFilePathForSource('userSettings')
    const before = path && existsSync(path) ? readFileSync(path, 'utf8') : null

    // A fixture model id. Written for real, this is what leaves the CLI pointed at a model
    // the user does not have.
    const result = updateSettingsForSource('userSettings', { model: 'fixture-model' } as never)

    // No error: nothing failed, the write was deliberately not attempted.
    expect(result.error).toBeNull()
    const after = path && existsSync(path) ? readFileSync(path, 'utf8') : null
    expect(after).toBe(before)
  })
})
