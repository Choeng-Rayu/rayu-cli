// Tests for the SERVER-OWNED image/video model catalog client.
//
// The CLI keeps no model registry: it fetches GET /v1/models?media=all from the
// gateway, caches it with a TTL, and falls back to a minimal built-in list only
// when there is no gateway to ask. These tests cover the parse contract, the
// cache/TTL behaviour, and that fallback.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetMediaModelsForTesting,
  _setMediaModelsForTesting,
  clearMediaModels,
  ensureMediaModels,
  getCachedMediaModels,
  mediaModelsFor,
  parseMediaModels,
  refreshMediaModels,
} from '../src/services/rayuAuth/mediaModels.ts'

// One image + one video item exactly as the gateway serves them.
const GATEWAY_PAYLOAD = {
  object: 'list',
  media: 'all',
  data: [
    {
      id: 'black-forest-labs/flux.1-schnell',
      object: 'model',
      created: 1700000000,
      owned_by: 'rayu',
      label: 'FLUX.1 Schnell',
      mediaType: 'image',
      capabilities: ['generate'],
      backend: 'nvidia',
      family: 'flux',
      defaultParams: { cfg_scale: 0, steps: 4 },
      nvcfFunctionId: null,
      estimatedSeconds: null,
      default: true,
    },
    {
      id: 'nvidia/cosmos-predict1-5b',
      object: 'model',
      created: 1700000000,
      owned_by: 'rayu',
      label: 'Cosmos Predict1 5B',
      mediaType: 'video',
      capabilities: ['text2video', 'image2video'],
      backend: 'nvcf',
      family: 'cosmos-predict1',
      defaultParams: null,
      nvcfFunctionId: 'eef816a3-3940-413b-93c9-513ae29f34f9',
      estimatedSeconds: 120,
      default: true,
    },
  ],
}

const realFetch = globalThis.fetch
let cfgDir: string
let savedOAuth: string | undefined

beforeEach(() => {
  // Isolate the persisted catalog from the dev's real ~/.rayu.
  cfgDir = mkdtempSync(join(tmpdir(), 'rayu-media-'))
  process.env.RAYU_CONFIG_DIR = cfgDir
  savedOAuth = process.env.USE_RAYU_OAUTH
  delete process.env.USE_RAYU_OAUTH
  _resetMediaModelsForTesting()
})

afterEach(() => {
  globalThis.fetch = realFetch
  _resetMediaModelsForTesting()
  rmSync(cfgDir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  if (savedOAuth === undefined) delete process.env.USE_RAYU_OAUTH
  else process.env.USE_RAYU_OAUTH = savedOAuth
})

describe('parseMediaModels (wire contract)', () => {
  test('splits the list by mediaType and keeps every media field', () => {
    const { image, video, dropped } = parseMediaModels(GATEWAY_PAYLOAD)
    expect(dropped).toBe(0)
    expect(image).toHaveLength(1)
    expect(video).toHaveLength(1)

    const img = image[0]
    expect(img.id).toBe('black-forest-labs/flux.1-schnell')
    expect(img.label).toBe('FLUX.1 Schnell')
    expect(img.backend).toBe('nvidia')
    expect(img.family).toBe('flux')
    expect(img.capabilities).toEqual(['generate'])
    expect(img.defaultParams).toEqual({ cfg_scale: 0, steps: 4 })
    // `default` on the wire becomes isDefault on the entry.
    expect(img.isDefault).toBe(true)
    // A null nvcfFunctionId/estimatedSeconds must not become "null"/NaN.
    expect(img.nvcfFunctionId).toBeUndefined()
    expect(img.estimatedSeconds).toBeUndefined()

    const vid = video[0]
    expect(vid.nvcfFunctionId).toBe('eef816a3-3940-413b-93c9-513ae29f34f9')
    expect(vid.estimatedSeconds).toBe(120)
    expect(vid.capabilities).toEqual(['text2video', 'image2video'])
  })

  test('an unknown family is KEPT — a newer gateway may know shapes we do not', () => {
    const { image, dropped } = parseMediaModels({
      data: [
        {
          id: 'x/y',
          mediaType: 'image',
          capabilities: ['generate'],
          backend: 'nvidia',
          family: 'brand-new-shape',
        },
      ],
    })
    expect(dropped).toBe(0)
    // Kept here; the tool is what refuses it, with an error naming the family.
    expect(image[0].family).toBe('brand-new-shape')
  })

  test('items missing a field the CLI needs are dropped and COUNTED', () => {
    const { image, video, dropped } = parseMediaModels({
      data: [
        // no id
        { mediaType: 'image', capabilities: ['generate'], backend: 'nvidia', family: 'flux' },
        // unknown mediaType
        { id: 'a', mediaType: 'audio', capabilities: ['generate'], backend: 'nvidia', family: 'flux' },
        // capability that doesn't apply to the media type
        { id: 'b', mediaType: 'image', capabilities: ['text2video'], backend: 'nvidia', family: 'flux' },
        // unknown backend
        { id: 'c', mediaType: 'image', capabilities: ['generate'], backend: 'mystery', family: 'flux' },
        // no family
        { id: 'd', mediaType: 'image', capabilities: ['generate'], backend: 'nvidia' },
      ],
    })
    expect(image).toHaveLength(0)
    expect(video).toHaveLength(0)
    expect(dropped).toBe(5)
  })

  test('a non-list payload yields an empty catalog rather than throwing', () => {
    expect(parseMediaModels(null)).toEqual({
      image: [],
      video: [],
      dropped: 0,
      chatShaped: false,
    })
    expect(parseMediaModels({ data: 'nope' })).toEqual({
      image: [],
      video: [],
      dropped: 0,
      chatShaped: false,
    })
  })

  test('a CHAT model list is recognised as such, not as corrupt data', () => {
    // What a gateway too old to know ?media= returns: it ignores the unknown
    // query param and answers 200 with the chat catalog.
    const r = parseMediaModels({
      object: 'list',
      data: [
        { id: 'deepseek-v4-pro', object: 'model', label: 'DeepSeek V4 Pro', supportsTools: true },
        { id: 'glm-5.2', object: 'model', label: 'GLM-5.2', supportsTools: true },
      ],
    })
    expect(r.chatShaped).toBe(true)
    expect(r.image).toHaveLength(0)
    expect(r.video).toHaveLength(0)
  })

  test('a genuine media list is never mistaken for a chat list', () => {
    expect(parseMediaModels(GATEWAY_PAYLOAD).chatShaped).toBe(false)
  })
})

/**
 * Make the gateway path reachable deterministically: a session file with a
 * far-future expiry means hasRayuSession() is true and getValidRayuAccessToken()
 * returns the token WITHOUT a refresh round-trip.
 */
function stubSignedIn(): void {
  process.env.USE_RAYU_OAUTH = 'true'
  writeFileSync(
    join(cfgDir, 'rayu-auth.json'),
    JSON.stringify({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      user: { id: 4242, email: null, displayName: null, avatarUrl: null, role: 'user' },
    }),
    { mode: 0o600 },
  )
}

describe('catalog cache', () => {
  test('fetches once, then serves from memory', async () => {
    stubSignedIn()
    let calls = 0
    globalThis.fetch = (async (url: string) => {
      calls++
      expect(String(url)).toContain('/v1/models?media=all')
      return new Response(JSON.stringify(GATEWAY_PAYLOAD), { status: 200 })
    }) as unknown as typeof fetch

    const first = await ensureMediaModels()
    expect(first.source).toBe('gateway')
    expect(first.image).toHaveLength(1)
    expect(first.video).toHaveLength(1)
    const second = await ensureMediaModels()
    expect(second.image).toHaveLength(1)
    // Fresh within the TTL → no second round-trip.
    expect(calls).toBe(1)
  })

  test('concurrent callers share ONE request', async () => {
    stubSignedIn()
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return new Response(JSON.stringify(GATEWAY_PAYLOAD), { status: 200 })
    }) as unknown as typeof fetch

    const [a, b, c] = await Promise.all([
      ensureMediaModels(),
      ensureMediaModels(),
      ensureMediaModels(),
    ])
    expect(calls).toBe(1)
    expect(a.image).toHaveLength(1)
    expect(b.image).toHaveLength(1)
    expect(c.image).toHaveLength(1)
  })

  test('an EMPTY gateway catalog is authoritative, not a fallback trigger', async () => {
    // An admin who disabled every media model has disabled the feature. Reverting
    // to the CLI built-ins would silently override that decision.
    stubSignedIn()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ object: 'list', media: 'all', data: [] }), {
        status: 200,
      })) as unknown as typeof fetch

    const catalog = await ensureMediaModels()
    expect(catalog.source).toBe('gateway')
    expect(catalog.image).toHaveLength(0)
    expect(catalog.video).toHaveLength(0)
    // And the sync reader agrees (the picker must show an empty list, not built-ins).
    expect(getCachedMediaModels().source).toBe('gateway')
  })

  test('a gateway too old to know ?media= does NOT poison the cache', async () => {
    // It ignores the unknown query param and returns the CHAT catalog. Caching
    // that as an empty media catalog would disable image/video generation.
    stubSignedIn()
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'deepseek-v4-pro', object: 'model', label: 'DeepSeek V4 Pro' }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    expect(await refreshMediaModels(true)).toBeNull()
    const catalog = await ensureMediaModels()
    expect(catalog.source).toBe('fallback')
    expect(catalog.image.length).toBeGreaterThan(0)
  })

  test('a failed fetch keeps the last good catalog', async () => {
    stubSignedIn()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(GATEWAY_PAYLOAD), {
        status: 200,
      })) as unknown as typeof fetch
    await ensureMediaModels()

    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await refreshMediaModels(true)).toBeNull()
    const catalog = getCachedMediaModels()
    expect(catalog.source).toBe('gateway')
    expect(catalog.image).toHaveLength(1)
  })

  test('a catalog fetched for another user is discarded', async () => {
    stubSignedIn()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(GATEWAY_PAYLOAD), {
        status: 200,
      })) as unknown as typeof fetch
    await ensureMediaModels()
    expect(getCachedMediaModels().source).toBe('gateway')

    // The session ends (logged out elsewhere / token file removed). The previous
    // user's plan-filtered catalog must not be served to whoever comes next.
    rmSync(join(cfgDir, 'rayu-auth.json'), { force: true })
    delete process.env.USE_RAYU_OAUTH
    expect(getCachedMediaModels().source).toBe('fallback')
  })

  test('an injected catalog is served without any network call', async () => {
    globalThis.fetch = (async () => {
      throw new Error('must not fetch')
    }) as unknown as typeof fetch
    _setMediaModelsForTesting({
      image: [
        {
          id: 'i/1',
          label: 'I1',
          mediaType: 'image',
          capabilities: ['generate'],
          backend: 'nvidia',
          family: 'flux',
          isDefault: true,
        },
      ],
      video: [],
      source: 'gateway',
      fetchedAt: Date.now(),
    })
    const catalog = await ensureMediaModels()
    expect(catalog.source).toBe('gateway')
    expect(catalog.image[0].id).toBe('i/1')
    expect(mediaModelsFor(catalog, 'image')).toHaveLength(1)
    expect(mediaModelsFor(catalog, 'video')).toHaveLength(0)
  })

  test('refresh is a no-op without a gateway (OAuth off)', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    expect(await refreshMediaModels(true)).toBeNull()
    expect(calls).toBe(0)
  })

  test('clearMediaModels drops the cache back to the fallback', () => {
    _setMediaModelsForTesting({
      image: [
        {
          id: 'i/1',
          label: 'I1',
          mediaType: 'image',
          capabilities: ['generate'],
          backend: 'nvidia',
          family: 'flux',
        },
      ],
      video: [],
      source: 'gateway',
      fetchedAt: Date.now(),
    })
    expect(getCachedMediaModels().source).toBe('gateway')
    clearMediaModels()
    expect(getCachedMediaModels().source).toBe('fallback')
  })

  test('a caller cannot corrupt the shared cache through its returned lists', () => {
    // The cache is process-wide and long-lived, so a consumer that sorts or
    // splices "its own" list must not change what everyone else reads.
    stubSignedIn()
    _setMediaModelsForTesting({
      image: [
        {
          id: 'i/1',
          label: 'I1',
          mediaType: 'image',
          capabilities: ['generate'],
          backend: 'nvidia',
          family: 'flux',
        },
      ],
      video: [],
      source: 'gateway',
      fetchedAt: Date.now(),
    })
    const first = getCachedMediaModels()
    first.image.length = 0
    first.video.push({
      id: 'injected',
      label: 'x',
      mediaType: 'video',
      capabilities: ['text2video'],
      backend: 'nvcf',
      family: 'cosmos-predict1',
    })
    const second = getCachedMediaModels()
    expect(second.image).toHaveLength(1)
    expect(second.video).toHaveLength(0)
  })

  test('a recurring schema-drift warning is reported ONCE, not every refresh', async () => {
    // The 5-minute refresh would otherwise append the same line to the error log
    // forever, burying whatever the user is actually debugging.
    const savedDisable = process.env.DISABLE_ERROR_REPORTING
    delete process.env.DISABLE_ERROR_REPORTING
    try {
      const { getInMemoryErrors } = await import('../src/utils/log.ts')
      const before = getInMemoryErrors().length
      stubSignedIn()
      // One good entry plus one the CLI cannot read → dropped > 0 every time.
      const drifted = {
        object: 'list',
        media: 'all',
        data: [
          GATEWAY_PAYLOAD.data[0],
          { id: 'broken', mediaType: 'image', backend: 'nvidia' }, // no capabilities
        ],
      }
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(drifted), { status: 200 })) as unknown as typeof fetch

      await refreshMediaModels(true)
      await refreshMediaModels(true)
      await refreshMediaModels(true)

      const logged = getInMemoryErrors()
        .slice(before)
        .filter((e) => e.error.includes('could not be read'))
      // The catalog itself still works — only the log is deduped.
      expect(getCachedMediaModels().image).toHaveLength(1)
      expect(logged.length).toBeLessThanOrEqual(1)
    } finally {
      if (savedDisable === undefined) delete process.env.DISABLE_ERROR_REPORTING
      else process.env.DISABLE_ERROR_REPORTING = savedDisable
    }
  })
})

describe('offline fallback (no gateway)', () => {
  test('covers every backend/capability the CLI can talk to', () => {
    const catalog = getCachedMediaModels()
    expect(catalog.source).toBe('fallback')

    const imageKeys = new Set(
      catalog.image.flatMap((m) => m.capabilities.map((c) => `${c}:${m.backend}`)),
    )
    expect(imageKeys).toContain('generate:nvidia')
    expect(imageKeys).toContain('edit:nvidia')
    expect(imageKeys).toContain('generate:vertex')
    expect(imageKeys).toContain('edit:vertex')

    const videoKeys = new Set(
      catalog.video.flatMap((m) => m.capabilities.map((c) => `${c}:${m.backend}`)),
    )
    expect(videoKeys).toContain('text2video:nvcf')
    expect(videoKeys).toContain('image2video:nvcf')
    expect(videoKeys).toContain('image2video:nvidia-svd')
    expect(videoKeys).toContain('text2video:fal')
    expect(videoKeys).toContain('image2video:fal')
    expect(videoKeys).toContain('text2video:vertex')
  })

  test('every fallback entry names a family the CLI can actually build', async () => {
    const catalog = getCachedMediaModels()
    const { IMAGE_BODY_BUILDERS } = await import(
      '../src/tools/ImageGenTool/models.ts'
    )
    const { VIDEO_BODY_BUILDERS } = await import(
      '../src/tools/VideoGenTool/models.ts'
    )
    for (const m of catalog.image) {
      expect(Object.keys(IMAGE_BODY_BUILDERS)).toContain(m.family)
    }
    for (const m of catalog.video) {
      expect(Object.keys(VIDEO_BODY_BUILDERS)).toContain(m.family)
    }
  })

  test('loses NO model a direct-key user could use before catalog discovery', () => {
    // The fallback is FROZEN at the exact set the CLI shipped when it still had a
    // hardcoded registry, so an offline BYOK user is not downgraded. New models go
    // in the backend seed, never here — this list must not change.
    const catalog = getCachedMediaModels()
    expect(catalog.image.map((m) => m.id)).toEqual([
      'black-forest-labs/flux.1-schnell',
      'black-forest-labs/flux.1-dev',
      'stabilityai/stable-diffusion-3.5-large',
      'black-forest-labs/flux.1-kontext-dev',
      'imagen-4.0-generate-001',
      'imagen-4.0-fast-generate-001',
      'imagen-4.0-ultra-generate-001',
      'imagen-3.0-capability-001',
    ])
    expect(catalog.video.map((m) => m.id)).toEqual([
      'nvidia/cosmos-predict1-5b',
      'nvidia/cosmos-transfer1-7b',
      'nvidia/cosmos3-nano',
      'nvidia/cosmos-1.0-7b-diffusion-text2world',
      'stabilityai/stable-video-diffusion',
      'fal-ai/kling-video/v2.1/standard/text-to-video',
      'fal-ai/kling-video/v2.1/standard/image-to-video',
      'veo-3.1-generate-001',
      'veo-3.1-fast-generate-001',
      'veo-3.0-generate-001',
      'veo-3.0-fast-generate-001',
    ])
  })

  test('reproduces the OLD hardcoded defaults exactly', async () => {
    const catalog = getCachedMediaModels()
    const { resolveModel } = await import('../src/tools/ImageGenTool/models.ts')
    const { resolveVideoModel } = await import('../src/tools/VideoGenTool/models.ts')
    // Old DEFAULT_IMAGE_MODEL / DEFAULT_EDIT_MODEL.
    expect(
      resolveModel(catalog.image, undefined, false, { backends: ['nvidia'] }).id,
    ).toBe('black-forest-labs/flux.1-schnell')
    expect(
      resolveModel(catalog.image, undefined, true, { backends: ['nvidia'] }).id,
    ).toBe('black-forest-labs/flux.1-kontext-dev')
    // Old DEFAULT_VIDEO_MODEL / DEFAULT_IMAGE2VIDEO_MODEL (the same model).
    expect(resolveVideoModel(catalog.video, undefined, false).id).toBe(
      'nvidia/cosmos-predict1-5b',
    )
    expect(resolveVideoModel(catalog.video, undefined, true).id).toBe(
      'nvidia/cosmos-predict1-5b',
    )
  })

  test('the fallback mirrors the backend seed (no drift between the two)', async () => {
    // Anything in the fallback must also exist server-side, or an offline user
    // could pick a model that vanishes the moment they sign in.
    const catalog = getCachedMediaModels()
    const { MEDIA_MODEL_SEED } = (await import(
      '../../rayu-backend/src/media-models/media-models.constants.ts'
    )) as { MEDIA_MODEL_SEED: Array<{ code: string; family: string }> }
    const seeded = new Map(MEDIA_MODEL_SEED.map((m) => [m.code, m]))
    for (const m of [...catalog.image, ...catalog.video]) {
      const s = seeded.get(m.id)
      expect(s, `fallback model ${m.id} is missing from MEDIA_MODEL_SEED`).toBeDefined()
      expect(s?.family).toBe(m.family)
    }
  })
})
