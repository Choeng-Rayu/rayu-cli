import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Isolated RAYU_CONFIG_DIR per test so we never touch the real ~/.rayu.
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-gemini-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
})

describe('Gemini provider presets', () => {
  test('Gemini API-key preset exists with OpenAI-compatible endpoint', async () => {
    const { PROVIDER_PRESETS } = await import('../src/utils/rayuProviders.ts')
    const p = PROVIDER_PRESETS.find(x => x.id === 'gemini')
    expect(p).toBeDefined()
    expect(p?.kind).toBe('openai-compatible')
    expect(p?.baseURL).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    )
    expect(p?.envKeys).toContain('GEMINI_API_KEY')
    expect(p?.envKeys).toContain('GOOGLE_API_KEY')
  })

  test('Gemini/Vertex OAuth preset exists with kind vertex + requiresOAuth', async () => {
    const { PROVIDER_PRESETS, GEMINI_VERTEX_PROVIDER_ID } = await import(
      '../src/utils/rayuProviders.ts'
    )
    const p = PROVIDER_PRESETS.find(x => x.id === GEMINI_VERTEX_PROVIDER_ID)
    expect(p).toBeDefined()
    expect(p?.kind).toBe('vertex')
    expect(p?.requiresOAuth).toBe(true)
  })

  test('vertexBaseURL builds the per-region openapi endpoint', async () => {
    const { vertexBaseURL } = await import('../src/utils/rayuProviders.ts')
    expect(vertexBaseURL('my-proj', 'us-central1')).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/us-central1/endpoints/openapi',
    )
  })

  test('vertexBaseURL uses the un-prefixed host for the global location', async () => {
    const { vertexBaseURL, vertexHost } = await import('../src/utils/rayuProviders.ts')
    expect(vertexHost('global')).toBe('aiplatform.googleapis.com')
    expect(vertexHost('us-central1')).toBe('us-central1-aiplatform.googleapis.com')
    expect(vertexBaseURL('my-proj', 'global')).toBe(
      'https://aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/global/endpoints/openapi',
    )
  })

  test('migrateEnvKeysToConfig imports GEMINI_API_KEY as the gemini provider', async () => {
    process.env.GEMINI_API_KEY = 'gm-test-key'
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
    const { migrateEnvKeysToConfig } = await import('../src/utils/rayuProviders.ts')
    migrateEnvKeysToConfig()
    cfg._resetRayuConfigCache()
    const gemini = cfg
      .loadRayuConfig()
      .providers.find(p => p.id === 'gemini')
    expect(gemini).toBeDefined()
    expect(gemini?.apiKey).toBe('gm-test-key')
    expect(gemini?.baseURL).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    )
  })

  test('vertex provider persistence contract (what /connect writes)', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    const { GEMINI_VERTEX_PROVIDER_ID } = await import(
      '../src/utils/rayuProviders.ts'
    )
    cfg._resetRayuConfigCache()
    // Mirrors finishVertex() in RayuProviderSetup.tsx.
    cfg.upsertProvider(
      {
        id: GEMINI_VERTEX_PROVIDER_ID,
        kind: 'vertex',
        gcpProject: 'proj-x',
        gcpRegion: 'us-east4',
      },
      true,
    )
    cfg._resetRayuConfigCache()
    const active = cfg.getActiveProvider()
    expect(active?.id).toBe(GEMINI_VERTEX_PROVIDER_ID)
    expect(active?.kind).toBe('vertex')
    expect(active?.gcpProject).toBe('proj-x')
    expect(active?.gcpRegion).toBe('us-east4')
  })
})
