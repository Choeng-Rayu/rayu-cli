import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const ENV_KEYS = [
  'GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'GCLOUD_PROJECT',
  'GCP_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'CLOUD_ML_REGION',
  'VERTEX_REGION',
]

let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  const m = await import('../src/services/api/gemini/vertexAuth.ts')
  m._resetVertexAuthCacheForTesting()
})

async function fresh() {
  const m = await import('../src/services/api/gemini/vertexAuth.ts')
  m._resetVertexAuthCacheForTesting()
  return m
}

describe('vertexAuth token caching', () => {
  test('caches a token until shortly before expiry, then refreshes', async () => {
    const m = await fresh()
    let calls = 0
    m._setVertexTokenSourcesForTesting([
      async () => {
        calls++
        return { token: `tok-${calls}`, expiresAtMs: Date.now() + 60 * 60 * 1000 }
      },
    ])
    const a = await m.getVertexAccessToken()
    const b = await m.getVertexAccessToken()
    expect(a).toBe('tok-1')
    expect(b).toBe('tok-1') // cached
    expect(calls).toBe(1)
  })

  test('refetches when the cached token is near expiry', async () => {
    const m = await fresh()
    let calls = 0
    m._setVertexTokenSourcesForTesting([
      async () => {
        calls++
        // expires in 1 minute -> inside the 5-minute refresh skew -> always stale
        return { token: `tok-${calls}`, expiresAtMs: Date.now() + 60 * 1000 }
      },
    ])
    const a = await m.getVertexAccessToken()
    const b = await m.getVertexAccessToken()
    expect(a).toBe('tok-1')
    expect(b).toBe('tok-2')
    expect(calls).toBe(2)
  })

  test('falls through to the next source when the first yields no creds', async () => {
    const m = await fresh()
    m._setVertexTokenSourcesForTesting([
      async () => null,
      async () => ({ token: 'fallback', expiresAtMs: Date.now() + 3600_000 }),
    ])
    expect(await m.getVertexAccessToken()).toBe('fallback')
  })

  test('throws a helpful error when no source has credentials', async () => {
    const m = await fresh()
    m._setVertexTokenSourcesForTesting([async () => null])
    await expect(m.getVertexAccessToken()).rejects.toThrow(/No Google Cloud credentials/)
  })
})

describe('detectGcpProjectAndRegion', () => {
  test('prefers GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'proj-a'
    process.env.GOOGLE_CLOUD_LOCATION = 'europe-west4'
    const m = await fresh()
    expect(await m.detectGcpProjectAndRegion()).toEqual({
      project: 'proj-a',
      region: 'europe-west4',
    })
  })

  test('falls back to ANTHROPIC_VERTEX_PROJECT_ID and default region', async () => {
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'proj-b'
    const m = await fresh()
    expect(await m.detectGcpProjectAndRegion()).toEqual({
      project: 'proj-b',
      region: 'global',
    })
  })

  test('uses the ADC project resolver when no env project is set', async () => {
    const m = await fresh()
    m._setAdcProjectResolverForTesting(async () => 'adc-proj')
    expect(await m.detectGcpProjectAndRegion()).toEqual({
      project: 'adc-proj',
      region: 'global',
    })
  })

  test('region precedence: CLOUD_ML_REGION over default, under GOOGLE_CLOUD_LOCATION', async () => {
    process.env.CLOUD_ML_REGION = 'us-east4'
    const m = await fresh()
    const r = await m.detectGcpProjectAndRegion()
    expect(r.region).toBe('us-east4')
  })
})
