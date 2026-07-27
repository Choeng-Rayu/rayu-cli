import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RayuConfig } from '../src/utils/rayuConfig.ts'

// Task 5 of the unified-provider-format migration: the three saved Bedrock
// providers (bedrockApi converse / openai / anthropic) collapse into ONE
// per-model-routed 'bedrock' provider.
//
// providers.json holds API keys at mode 0600, so the migration must take a
// backup, write atomically, preserve the mode, and never drop credentials.

let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-bedrock-mig-'))
  process.env.RAYU_CONFIG_DIR = dir
  process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
})

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
})

function writeConfig(cfg: RayuConfig): string {
  const path = join(dir, 'providers.json')
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  return path
}

async function mig() {
  return await import('../src/migrations/migrateBedrockToUnifiedProvider.ts')
}

describe('unifyBedrockProviders (pure)', () => {
  test('merges the three legacy Bedrock providers into one, dropping bedrockApi', async () => {
    const { unifyBedrockProviders } = await mig()
    const out = unifyBedrockProviders({
      activeProvider: 'bedrock-anthropic',
      providers: [
        { id: 'nvidia', kind: 'openai-compatible', apiKey: 'nv' },
        { id: 'bedrock', kind: 'bedrock', bedrockApi: 'converse', apiKey: 'k1', awsRegion: 'us-west-2' },
        { id: 'bedrock-openai', kind: 'bedrock', bedrockApi: 'openai', apiKey: 'k2', baseURL: 'https://mantle/openai/v1' },
        { id: 'bedrock-anthropic', kind: 'bedrock', bedrockApi: 'anthropic', apiKey: 'k3', awsRegion: 'eu-west-1' },
      ],
    })
    const bedrocks = out.providers.filter(p => p.kind === 'bedrock')
    expect(bedrocks).toHaveLength(1)
    const b = bedrocks[0]!
    expect(b.id).toBe('bedrock')
    expect(b.bedrockApi).toBeUndefined()
    // The ACTIVE entry wins, so its own key/region are kept...
    expect(b.apiKey).toBe('k3')
    expect(b.awsRegion).toBe('eu-west-1')
    // ...and settings only the other entries had are not lost.
    expect(b.baseURL).toBe('https://mantle/openai/v1')
    // The active pointer follows the rename.
    expect(out.activeProvider).toBe('bedrock')
    // Unrelated providers are untouched.
    expect(out.providers.find(p => p.id === 'nvidia')?.apiKey).toBe('nv')
  })

  test('prefers an entry WITH credentials when the active one has none', async () => {
    const { unifyBedrockProviders } = await mig()
    const out = unifyBedrockProviders({
      activeProvider: 'nvidia',
      providers: [
        { id: 'nvidia', kind: 'openai-compatible', apiKey: 'nv' },
        { id: 'bedrock', kind: 'bedrock', bedrockApi: 'converse' },
        { id: 'bedrock-anthropic', kind: 'bedrock', bedrockApi: 'anthropic', apiKey: 'has-key', awsRegion: 'us-east-2' },
      ],
    })
    const b = out.providers.find(p => p.kind === 'bedrock')!
    expect(b.apiKey).toBe('has-key')
    expect(b.awsRegion).toBe('us-east-2')
    // A non-Bedrock active provider is left alone.
    expect(out.activeProvider).toBe('nvidia')
  })

  test('clears the cached catalog so the next refresh pulls the unified list', async () => {
    const { unifyBedrockProviders } = await mig()
    const out = unifyBedrockProviders({
      providers: [
        {
          id: 'bedrock-openai',
          kind: 'bedrock',
          bedrockApi: 'openai',
          apiKey: 'k',
          // A half-catalog from ONE surface (no Claude).
          fetchedModels: ['openai.gpt-oss-120b-1:0'],
        },
      ],
    })
    expect(out.providers[0]?.fetchedModels).toBeUndefined()
  })

  test('repoints a subagent pinned to a legacy Bedrock id', async () => {
    const { unifyBedrockProviders } = await mig()
    const out = unifyBedrockProviders({
      providers: [
        { id: 'bedrock-anthropic', kind: 'bedrock', bedrockApi: 'anthropic', apiKey: 'k' },
      ],
      subagent: { providerId: 'bedrock-anthropic', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
    })
    expect(out.subagent?.providerId).toBe('bedrock')
    expect(out.subagent?.model).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')
  })

  test('a config with no Bedrock provider is returned unchanged', async () => {
    const { unifyBedrockProviders, needsBedrockUnification } = await mig()
    const cfg: RayuConfig = {
      activeProvider: 'nvidia',
      providers: [{ id: 'nvidia', kind: 'openai-compatible', apiKey: 'nv' }],
    }
    expect(needsBedrockUnification(cfg)).toBe(false)
    expect(unifyBedrockProviders(cfg)).toBe(cfg)
  })

  test('an already-unified Bedrock provider needs no migration (idempotent)', async () => {
    const { needsBedrockUnification } = await mig()
    expect(
      needsBedrockUnification({
        providers: [{ id: 'bedrock', kind: 'bedrock', apiKey: 'k', awsRegion: 'us-east-1' }],
      }),
    ).toBe(false)
  })
})

describe('migrateBedrockToUnifiedProvider (on-disk)', () => {
  test('backs up, rewrites atomically, keeps 0600 and preserves the key', async () => {
    const path = writeConfig({
      activeProvider: 'bedrock-anthropic',
      providers: [
        { id: 'bedrock-anthropic', kind: 'bedrock', bedrockApi: 'anthropic', apiKey: 'secret-key', awsRegion: 'us-east-1' },
      ],
    })
    const { migrateBedrockToUnifiedProvider } = await mig()
    migrateBedrockToUnifiedProvider()

    const after = JSON.parse(readFileSync(path, 'utf8')) as RayuConfig
    expect(after.providers).toHaveLength(1)
    expect(after.providers[0]?.id).toBe('bedrock')
    expect(after.providers[0]?.bedrockApi).toBeUndefined()
    // SECURITY: the credential must survive the rewrite.
    expect(after.providers[0]?.apiKey).toBe('secret-key')
    expect(after.activeProvider).toBe('bedrock')

    // The rewritten file is still owner-only.
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o077).toBe(0)
    }
    // A timestamped backup exists, is not world/group readable, and still holds
    // the pre-migration content.
    const backups = readdirSync(dir).filter(f => f.startsWith('providers.json.bak-'))
    expect(backups).toHaveLength(1)
    const backup = JSON.parse(readFileSync(join(dir, backups[0]!), 'utf8')) as RayuConfig
    expect(backup.providers[0]?.id).toBe('bedrock-anthropic')
    expect(backup.providers[0]?.bedrockApi).toBe('anthropic')
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, backups[0]!)).mode & 0o077).toBe(0)
    }
    // No temp file is left behind.
    expect(readdirSync(dir).some(f => f.includes('.tmp-'))).toBe(false)
  })

  test('is idempotent: a second run makes no further backup or change', async () => {
    const path = writeConfig({
      providers: [{ id: 'bedrock', kind: 'bedrock', bedrockApi: 'converse', apiKey: 'k' }],
    })
    const { migrateBedrockToUnifiedProvider } = await mig()
    migrateBedrockToUnifiedProvider()
    const firstPass = readFileSync(path, 'utf8')
    const backupsAfterFirst = readdirSync(dir).filter(f => f.includes('.bak-')).length

    ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
    migrateBedrockToUnifiedProvider()
    expect(readFileSync(path, 'utf8')).toBe(firstPass)
    expect(readdirSync(dir).filter(f => f.includes('.bak-')).length).toBe(
      backupsAfterFirst,
    )
  })

  test('no config file at all is a no-op', async () => {
    const { migrateBedrockToUnifiedProvider } = await mig()
    migrateBedrockToUnifiedProvider()
    expect(existsSync(join(dir, 'providers.json'))).toBe(false)
  })

  test('an unwritable config leaves the original intact (fails safe)', async () => {
    if (process.platform === 'win32') return
    const path = writeConfig({
      providers: [{ id: 'bedrock', kind: 'bedrock', bedrockApi: 'converse', apiKey: 'k' }],
    })
    const before = readFileSync(path, 'utf8')
    chmodSync(dir, 0o500) // read+execute only: no new files may be created
    try {
      const { migrateBedrockToUnifiedProvider } = await mig()
      // Must not throw — a migration failure may never block startup.
      expect(() => migrateBedrockToUnifiedProvider()).not.toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})

describe('post-migration routing', () => {
  test('the migrated provider resolves BOTH wire formats per model', async () => {
    writeConfig({
      activeProvider: 'bedrock-anthropic',
      providers: [
        { id: 'bedrock-anthropic', kind: 'bedrock', bedrockApi: 'anthropic', apiKey: 'k', awsRegion: 'us-east-1', baseURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1' },
      ],
    })
    const { migrateBedrockToUnifiedProvider } = await mig()
    migrateBedrockToUnifiedProvider()

    const { getActiveProvider } = await import('../src/utils/rayuConfig.ts')
    const { resolveWireFormat, resolveClientTarget } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    const p = getActiveProvider()!
    expect(p.id).toBe('bedrock')
    expect<string>(
      resolveWireFormat(p, 'us.anthropic.claude-sonnet-4-6-v1'),
    ).toBe('anthropic-messages')
    expect<string>(resolveWireFormat(p, 'openai.gpt-oss-120b-1:0')).toBe(
      'openai-chat',
    )
    expect<string>(
      resolveClientTarget(p, 'us.anthropic.claude-sonnet-4-6-v1'),
    ).toBe('bedrock-anthropic')
    expect<string>(resolveClientTarget(p, 'deepseek.v3.2')).toBe('openai-chat')
  })
})
