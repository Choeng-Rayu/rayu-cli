// Migration coverage: the subscription provider id moved from
// 'claude-subscription' to 'rayu-subscription'. It is persisted in four places
// in providers.json; loadRayuConfig must rewrite all of them on read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-provider-id-migration-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_AUTH_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_AUTH_CONFIG_DIR
  const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
  _resetRayuConfigCache()
})

describe('migrateLegacyProviderIds (pure)', () => {
  test('rewrites all four persisted locations', async () => {
    const { migrateLegacyProviderIds } = await import(
      '../src/utils/rayuProviders.ts'
    )
    const cfg = {
      activeProvider: 'claude-subscription',
      providers: [
        { id: 'claude-subscription', kind: 'anthropic' },
        { id: 'nvidia', kind: 'openai-compatible' },
      ],
      subagent: { providerId: 'claude-subscription', model: 'm' },
      subagentByAgent: {
        'general-purpose': { providerId: 'claude-subscription', model: 'm' },
        explore: { providerId: 'nvidia', model: 'm' },
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const changed = migrateLegacyProviderIds(cfg as any)
    expect(changed).toBe(true)
    expect(cfg.activeProvider).toBe('rayu-subscription')
    expect(cfg.providers[0].id).toBe('rayu-subscription')
    expect(cfg.providers[1].id).toBe('nvidia')
    expect(cfg.subagent!.providerId).toBe('rayu-subscription')
    expect(cfg.subagentByAgent!['general-purpose'].providerId).toBe('rayu-subscription')
    expect(cfg.subagentByAgent!.explore.providerId).toBe('nvidia')
  })
  test('returns false and changes nothing when no legacy id present', async () => {
    const { migrateLegacyProviderIds } = await import(
      '../src/utils/rayuProviders.ts'
    )
    const cfg = {
      activeProvider: 'nvidia',
      providers: [{ id: 'nvidia', kind: 'openai-compatible' }],
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(migrateLegacyProviderIds(cfg as any)).toBe(false)
    expect(cfg.activeProvider).toBe('nvidia')
  })
})

describe('loadRayuConfig provider-id migration (filesystem)', () => {
  test('rewrites legacy id in memory and on disk, keeps mode 0600', async () => {
    const file = join(dir, 'providers.json')
    writeFileSync(
      file,
      JSON.stringify({
        activeProvider: 'claude-subscription',
        providers: [{ id: 'claude-subscription', kind: 'anthropic' }],
        subagent: { providerId: 'claude-subscription', model: 'm' },
        subagentByAgent: {
          'general-purpose': { providerId: 'claude-subscription', model: 'm' },
        },
      }),
      { mode: 0o600 },
    )
    const { loadRayuConfig, _resetRayuConfigCache } = await import(
      '../src/utils/rayuConfig.ts'
    )
    _resetRayuConfigCache()
    const cfg = loadRayuConfig()
    expect(cfg.activeProvider).toBe('rayu-subscription')
    expect(cfg.providers[0].id).toBe('rayu-subscription')
    expect(cfg.subagent?.providerId).toBe('rayu-subscription')
    expect(cfg.subagentByAgent?.['general-purpose'].providerId).toBe('rayu-subscription')

    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.activeProvider).toBe('rayu-subscription')
    expect(onDisk.providers[0].id).toBe('rayu-subscription')
    expect(onDisk.subagent.providerId).toBe('rayu-subscription')
    expect(onDisk.subagentByAgent['general-purpose'].providerId).toBe('rayu-subscription')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})