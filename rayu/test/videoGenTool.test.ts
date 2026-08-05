import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React from 'react'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import {
  _resetMediaModelsForTesting,
  _setMediaModelsForTesting,
  type MediaCatalog,
  type MediaModelEntry,
} from '../src/services/rayuAuth/mediaModels.ts'
import {
  defaultVideoModelId,
  isVertexVideoModel,
  resolveVideoModel,
  retainKnownVideoModel,
  withBuilder,
} from '../src/tools/VideoGenTool/models.ts'
import {
  generateVideo,
  _setFalPollInterval,
  _setNvidiaPollInterval,
} from '../src/tools/VideoGenTool/nvidiaVideoClient.ts'
import {
  VideoGenTool,
  resolveOutputPath,
} from '../src/tools/VideoGenTool/VideoGenTool.ts'

// A fetched-style catalog: exactly what services/rayuAuth/mediaModels.ts produces
// from GET /v1/models?media=video. The CLI holds no video model registry, so every
// test drives the resolver with this.
const VIDEO_CATALOG: MediaModelEntry[] = [
  {
    id: 'nvidia/cosmos-predict1-5b',
    label: 'Cosmos Predict1 5B',
    mediaType: 'video',
    // Takes an OPTIONAL input image, so one model covers both operations.
    capabilities: ['text2video', 'image2video'],
    backend: 'nvcf',
    family: 'cosmos-predict1',
    nvcfFunctionId: 'eef816a3-3940-413b-93c9-513ae29f34f9',
    estimatedSeconds: 120,
    isDefault: true,
  },
  {
    id: 'nvidia/cosmos3-nano',
    label: 'Cosmos3 Nano',
    mediaType: 'video',
    capabilities: ['text2video'],
    backend: 'nvcf',
    family: 'cosmos3-nano',
    nvcfFunctionId: 'd09cd49d-d7f2-4361-928f-ea22af707249',
    estimatedSeconds: 90,
  },
  {
    id: 'nvidia/cosmos-1.0-7b-diffusion-text2world',
    label: 'Cosmos 1.0 7B',
    mediaType: 'video',
    capabilities: ['text2video'],
    backend: 'nvcf',
    family: 'cosmos-legacy',
    estimatedSeconds: 120,
  },
  {
    id: 'stabilityai/stable-video-diffusion',
    label: 'Stable Video Diffusion',
    mediaType: 'video',
    capabilities: ['image2video'],
    backend: 'nvidia-svd',
    family: 'svd',
    estimatedSeconds: 60,
    defaultParams: { cfg_scale: 1.8, motion_bucket_id: 127 },
  },
  {
    id: 'fal-ai/kling-video/v2.1/standard/text-to-video',
    label: 'Kling 2.1 (t2v)',
    mediaType: 'video',
    capabilities: ['text2video'],
    backend: 'fal',
    family: 'fal-kling',
    estimatedSeconds: 90,
    defaultParams: { duration: '5', aspect_ratio: '16:9', cfg_scale: 0.5 },
    isDefault: true,
  },
  {
    id: 'veo-3.1-generate-001',
    label: 'Veo 3.1',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 120,
    isDefault: true,
  },
]

function videoCatalog(video = VIDEO_CATALOG): MediaCatalog {
  return { image: [], video, source: 'gateway', fetchedAt: Date.now() }
}

/** Install the fetched catalog so no test depends on a gateway or on disk. */
function useVideoCatalog(video = VIDEO_CATALOG): void {
  _setMediaModelsForTesting(videoCatalog(video))
}

const DEFAULT_VIDEO_MODEL = 'nvidia/cosmos-predict1-5b'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  _resetMediaModelsForTesting()
})

// These tests exercise video generation mechanics + capability (API-key) gating,
// NOT paid-plan gating. The dev's real ~/.rayu may hold a signed-in Free account
// (with USE_RAYU_OAUTH=true from .env), which would otherwise trip VideoGenTool's
// soft paid-gate and make call() refuse. Turn OAuth gating off + clear cached
// entitlements so rayuFeatureAllowed() fails open (BYOK semantics) and the gate
// stays open regardless of the dev's login state.
//
// RAYU_CONFIG_DIR is redirected to a temp dir for the same reason: nothing here
// may read the developer's real config (a remembered /model_video_generation
// choice would change which model these tests resolve) or write to it.
let savedUseRayuOAuth: string | undefined
let savedConfigDir: string | undefined
let testConfigDir: string
beforeEach(async () => {
  savedUseRayuOAuth = process.env.USE_RAYU_OAUTH
  delete process.env.USE_RAYU_OAUTH
  savedConfigDir = process.env.RAYU_CONFIG_DIR
  testConfigDir = mkdtempSync(join(tmpdir(), 'rayu-vidcfg-'))
  process.env.RAYU_CONFIG_DIR = testConfigDir
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
  const ents = await import('../src/services/rayuAuth/rayuEntitlements.ts')
  ents._resetRayuEntitlementsForTesting()
  useVideoCatalog()
})
afterEach(async () => {
  if (savedUseRayuOAuth === undefined) delete process.env.USE_RAYU_OAUTH
  else process.env.USE_RAYU_OAUTH = savedUseRayuOAuth
  rmSync(testConfigDir, { recursive: true, force: true })
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
  const cfg = await import('../src/utils/rayuConfig.ts')
  cfg._resetRayuConfigCache()
})

// Minimal valid MP4 header (ftyp box)
const TINY_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
])

/**
 * Model-pinning env vars are OVERRIDES, so a value in the developer's .env (bun
 * loads it automatically) would decide these assertions instead of the catalog.
 * Clear them for the resolution tests and exercise them in dedicated ones.
 */
const MODEL_ENV_VARS = [
  'NVIDIA_VIDEO_MODEL',
  'NVIDIA_IMAGE2VIDEO_MODEL',
  'VERTEX_VIDEO_MODEL',
] as const
let savedModelEnv: Record<string, string | undefined> = {}

describe('video model resolution (server-owned catalog)', () => {
  beforeEach(() => {
    savedModelEnv = {}
    for (const k of MODEL_ENV_VARS) {
      savedModelEnv[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(savedModelEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test('the catalog default is the NVCF cosmos model, with its function id', () => {
    const m = resolveVideoModel(VIDEO_CATALOG, undefined, false)
    expect(m.id).toBe(DEFAULT_VIDEO_MODEL)
    expect(m.backend).toBe('nvcf')
    expect(m.capabilities).toContain('text2video')
    // The UUID and the duration estimate come from the CATALOG, not the CLI.
    expect(m.nvcfFunctionId).toBe('eef816a3-3940-413b-93c9-513ae29f34f9')
    expect(m.estimatedSeconds).toBe(120)
  })

  test('cosmos-predict1 family builds the Triton command body', () => {
    const m = resolveVideoModel(VIDEO_CATALOG, DEFAULT_VIDEO_MODEL, false)
    const body = m.buildBody({ prompt: 'a river', seed: 42 }) as {
      inputs: Array<{ name: string; data: string[] }>
      outputs: Array<{ name: string }>
    }
    expect(body.inputs[0].name).toBe('command')
    expect(body.inputs[0].data[0]).toContain('a river')
    expect(body.outputs[0].name).toBe('status')
  })

  test('per-model NVCF function ids come from the catalog entry', () => {
    const nano = resolveVideoModel(VIDEO_CATALOG, 'nvidia/cosmos3-nano', false)
    expect(nano.nvcfFunctionId).toBe('d09cd49d-d7f2-4361-928f-ea22af707249')
    const legacy = resolveVideoModel(
      VIDEO_CATALOG,
      'nvidia/cosmos-1.0-7b-diffusion-text2world',
      false,
    )
    expect(legacy.nvcfFunctionId).toBeUndefined()
  })

  test('svd family builds the data-URI body with catalog defaults', () => {
    const m = resolveVideoModel(
      VIDEO_CATALOG,
      'stabilityai/stable-video-diffusion',
      true,
    )
    const body = m.buildBody({ prompt: 'animate', image: 'QUJD' })
    expect(String(body.image)).toContain('data:image/png;base64,QUJD')
    expect(body.cfg_scale).toBe(1.8)
    expect(body.motion_bucket_id).toBe(127)
  })

  test('fal-kling family switches shape on the presence of an image', () => {
    const t2v = resolveVideoModel(
      VIDEO_CATALOG,
      'fal-ai/kling-video/v2.1/standard/text-to-video',
      false,
    )
    const textBody = t2v.buildBody({ prompt: 'a river' })
    expect(textBody.cfg_scale).toBe(0.5)
    expect('image_url' in textBody).toBe(false)
    const imageBody = t2v.buildBody({ prompt: 'animate', image: 'QUJD' })
    expect(String(imageBody.image_url)).toContain('data:image/png;base64,QUJD')
  })

  test('a model serving both operations is the default for both', () => {
    expect(resolveVideoModel(VIDEO_CATALOG, undefined, false).id).toBe(
      DEFAULT_VIDEO_MODEL,
    )
    expect(resolveVideoModel(VIDEO_CATALOG, undefined, true).id).toBe(
      DEFAULT_VIDEO_MODEL,
    )
  })

  test('a model added to the catalog is usable with NO CLI change', () => {
    const added: MediaModelEntry = {
      id: 'nvidia/cosmos4-nano',
      label: 'Cosmos4 Nano',
      mediaType: 'video',
      capabilities: ['text2video'],
      backend: 'nvcf',
      // Reuses a known request shape, so only the catalog row is new.
      family: 'cosmos3-nano',
      nvcfFunctionId: '11111111-2222-3333-4444-555555555555',
      estimatedSeconds: 45,
    }
    const m = resolveVideoModel([...VIDEO_CATALOG, added], added.id, false)
    expect(m.id).toBe(added.id)
    expect(m.nvcfFunctionId).toBe('11111111-2222-3333-4444-555555555555')
    expect(m.estimatedSeconds).toBe(45)
  })

  test('an unknown request family fails with an actionable, named error', () => {
    expect(() =>
      withBuilder({
        id: 'nvidia/brand-new',
        label: 'New',
        mediaType: 'video',
        capabilities: ['text2video'],
        backend: 'nvcf',
        family: 'holodeck-v1',
      }),
    ).toThrow(/holodeck-v1/)
  })

  test('an empty catalog fails with a dashboard hint, not a crash', () => {
    expect(() => resolveVideoModel([], undefined, false)).toThrow(/dashboard/i)
  })

  test('an UNKNOWN named model is an error, never a silent substitution', () => {
    expect(() => resolveVideoModel(VIDEO_CATALOG, 'nvidia/cosmos-imaginary', false))
      .toThrow(/Unknown video model "nvidia\/cosmos-imaginary"/)
  })

  test('a KNOWN text2video-only model still falls back for image2video', () => {
    // Deliberate: this is how input_image routes to an image-capable model.
    expect(resolveVideoModel(VIDEO_CATALOG, 'nvidia/cosmos3-nano', true).id).toBe(
      DEFAULT_VIDEO_MODEL,
    )
  })

  test('a model served by another backend reports a routing bug', () => {
    expect(() =>
      resolveVideoModel(VIDEO_CATALOG, 'veo-3.1-generate-001', false, {
        backends: ['nvcf', 'nvidia-svd', 'fal'],
      }),
    ).toThrow(/routing bug/)
  })

  test('a Vertex default never resolves for the NVIDIA/fal client', () => {
    // Regression guard: with a catalog whose ONLY default text2video model is Veo,
    // the NVIDIA/fal client must still pick something it can actually POST to
    // rather than mis-routing a Veo body (which used to surface as a bogus
    // "routing bug — please report it" for an ordinary user).
    const veoFirst: MediaModelEntry[] = [
      { ...VIDEO_CATALOG[5], isDefault: true }, // veo, default
      { ...VIDEO_CATALOG[0], isDefault: false }, // cosmos, not default
    ]
    const m = resolveVideoModel(veoFirst, undefined, false, {
      backends: ['nvcf', 'nvidia-svd', 'fal'],
    })
    expect(m.backend).toBe('nvcf')
    expect(m.id).toBe(DEFAULT_VIDEO_MODEL)
  })

  test('backend preference order picks the credential the user actually has', () => {
    // A fal-only user must get the fal model, not an NVIDIA one they cannot call.
    const m = resolveVideoModel(VIDEO_CATALOG, undefined, false, {
      backends: ['fal', 'nvcf', 'nvidia-svd'],
    })
    expect(m.backend).toBe('fal')
  })

  test('NVIDIA_VIDEO_MODEL pins the default — but only to a servable model', () => {
    process.env.NVIDIA_VIDEO_MODEL = 'nvidia/cosmos3-nano'
    expect(
      resolveVideoModel(VIDEO_CATALOG, undefined, false, {
        backends: ['nvcf', 'nvidia-svd', 'fal'],
      }).id,
    ).toBe('nvidia/cosmos3-nano')

    // An override naming a Vertex model must NOT reach the NVIDIA/fal client.
    process.env.NVIDIA_VIDEO_MODEL = 'veo-3.1-generate-001'
    expect(
      resolveVideoModel(VIDEO_CATALOG, undefined, false, {
        backends: ['nvcf', 'nvidia-svd', 'fal'],
      }).id,
    ).toBe(DEFAULT_VIDEO_MODEL)
  })

  test('retainKnownVideoModel drops a stale remembered selection', () => {
    expect(retainKnownVideoModel(VIDEO_CATALOG, 'gone/forever')).toBeUndefined()
    expect(retainKnownVideoModel(VIDEO_CATALOG, DEFAULT_VIDEO_MODEL)).toBe(
      DEFAULT_VIDEO_MODEL,
    )
    expect(retainKnownVideoModel(VIDEO_CATALOG, undefined)).toBeUndefined()
    // A hand-written Veo id is kept — the Vertex client honours it verbatim.
    expect(retainKnownVideoModel(VIDEO_CATALOG, 'veo-4.0-generate-001')).toBe(
      'veo-4.0-generate-001',
    )
  })

  test('per-backend defaults come from the catalog', () => {
    expect(defaultVideoModelId(VIDEO_CATALOG, 'vertex', false)).toBe(
      'veo-3.1-generate-001',
    )
    expect(defaultVideoModelId(VIDEO_CATALOG, 'fal', false)).toBe(
      'fal-ai/kling-video/v2.1/standard/text-to-video',
    )
    expect(defaultVideoModelId(VIDEO_CATALOG, 'nvcf', true)).toBe(
      DEFAULT_VIDEO_MODEL,
    )
  })

  test('isVertexVideoModel reads the catalog backend, not the id', () => {
    expect(isVertexVideoModel('veo-3.1-generate-001', VIDEO_CATALOG)).toBe(true)
    expect(isVertexVideoModel(DEFAULT_VIDEO_MODEL, VIDEO_CATALOG)).toBe(false)
    expect(isVertexVideoModel(undefined, VIDEO_CATALOG)).toBe(false)
  })
})

// Mock a successful NVIDIA NVCF submit→poll→asset_url→download sequence
function mockNvcfSuccess(): void {
  let calls = 0
  globalThis.fetch = (async (url: string) => {
    calls++
    if (calls === 1) {
      // POST to nvcf/pexec/functions/{id} → 202
      return new Response('', { status: 202, headers: { 'NVCF-REQID': 'req-1' } })
    }
    if (String(url).includes('/pexec/status/')) {
      // Poll → 200 with asset_url
      return new Response(
        JSON.stringify({ asset_url: `${NVCF_ASSET_HOST}/asset-abc123` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // Asset download
    return new Response(TINY_MP4, { status: 200, headers: { 'Content-Type': 'video/mp4' } })
  }) as unknown as typeof fetch
}

// NVCF_ASSET_HOST for mock URL construction
const NVCF_ASSET_HOST = 'https://api.nvcf.nvidia.com/v1/assets'

describe('generateVideo client — NVCF backend (cosmos-predict1-5b)', () => {
  beforeEach(() => { _setNvidiaPollInterval(0) })
  afterEach(() => { _setNvidiaPollInterval(5000) })

  test('submit 202 → poll → asset download returns buffer', async () => {
    mockNvcfSuccess()
    const { buffer, mediaType } = await generateVideo({
      params: { prompt: 'a river' },
      apiKey: 'nvidia-test-key',
    })
    expect(buffer.length).toBeGreaterThan(0)
    expect(mediaType).toBe('video/mp4')
  })

  test('synchronous 200 with asset_url works too', async () => {
    let calls = 0
    globalThis.fetch = (async (url: string) => {
      calls++
      if (calls === 1)
        return new Response(
          JSON.stringify({ asset_url: `${NVCF_ASSET_HOST}/asset-xyz` }),
          { status: 200 },
        )
      return new Response(TINY_MP4, { status: 200 })
    }) as unknown as typeof fetch
    const { buffer } = await generateVideo({
      params: { prompt: 'a river' },
      apiKey: 'nvidia-test-key',
    })
    expect(buffer.length).toBeGreaterThan(0)
  })

  test('throws on non-OK HTTP status', async () => {
    globalThis.fetch = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    await expect(
      generateVideo({ params: { prompt: 'x' }, apiKey: 'nvidia-k' }),
    ).rejects.toThrow(/403/)
  })
})

describe('generateVideo client — fal.ai backend', () => {
  beforeEach(() => { _setFalPollInterval(0) })
  afterEach(() => { _setFalPollInterval(5000) })

  test('submit → poll COMPLETED → download produces a buffer', async () => {
    let calls = 0
    globalThis.fetch = (async (url: string) => {
      calls++
      if (calls === 1)
        return new Response(
          JSON.stringify({ request_id: 'r', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' }),
          { status: 200 },
        )
      if (url.endsWith('/s')) return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 })
      if (url.endsWith('/r')) return new Response(JSON.stringify({ video: { url: 'https://cdn.fal.media/out.mp4' } }), { status: 200 })
      return new Response(TINY_MP4, { status: 200 })
    }) as unknown as typeof fetch

    const { buffer, mediaType } = await generateVideo({
      modelId: 'fal-ai/kling-video/v2.1/standard/text-to-video',
      params: { prompt: 'a river' },
      apiKey: 'fal-test-key',
    })
    expect(buffer.length).toBeGreaterThan(0)
    expect(mediaType).toBe('video/mp4')
  })
})

describe('VideoGenTool scaffold', () => {
  test('schema rejects empty prompt, accepts valid prompt', () => {
    expect(VideoGenTool.inputSchema.safeParse({ prompt: '' }).success).toBe(false)
    expect(VideoGenTool.inputSchema.safeParse({ prompt: 'a river' }).success).toBe(true)
  })

  test('resolveOutputPath accepts default, rejects outside cwd', () => {
    expect(resolveOutputPath(undefined).ok).toBe(true)
    expect(resolveOutputPath('/etc/passwd.mp4').ok).toBe(false)
    expect(resolveOutputPath('../escape.mp4').ok).toBe(false)
  })

  test('checkPermissions passes through', async () => {
    const r = await VideoGenTool.checkPermissions({ prompt: 'x' } as never)
    expect(r.behavior).toBe('passthrough')
  })
})

describe('VideoGenTool.isEnabled', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-vid-'))
    process.env.RAYU_CONFIG_DIR = dir
    delete process.env.NVIDIA_API_KEY
    delete process.env.FAL_KEY
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.NVIDIA_API_KEY
    delete process.env.FAL_KEY
  })

  test('false without any key, true with NVIDIA_API_KEY', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    _resetRayuConfigCache()
    expect(VideoGenTool.isEnabled()).toBe(false)
    process.env.NVIDIA_API_KEY = 'nv-x'
    _resetRayuConfigCache()
    expect(VideoGenTool.isEnabled()).toBe(true)
  })

  test('true with FAL_KEY too', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    _resetRayuConfigCache()
    process.env.FAL_KEY = 'fal-k'
    _resetRayuConfigCache()
    expect(VideoGenTool.isEnabled()).toBe(true)
  })
})

describe('VideoGenTool.call', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rayu-vidcall-'))
    process.env.NVIDIA_API_KEY = 'nv-x'
    _setNvidiaPollInterval(0)
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(tmp, { recursive: true, force: true })
    delete process.env.NVIDIA_API_KEY
    _setNvidiaPollInterval(5000)
  })

  test('saves the mp4 to disk and returns a text result block', async () => {
    mockNvcfSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'a river', output_path: './out.mp4' } as never,
        { abortController: new AbortController() } as never,
      ),
    )

    expect(existsSync(join(tmp, 'out.mp4'))).toBe(true)
    expect(res.data.mediaType).toBe('video/mp4')

    const block = VideoGenTool.mapToolResultToToolResultBlockParam(res.data, 'tid')
    const content = block.content as Array<{ type: string }>
    expect(content.some(b => b.type === 'text')).toBe(true)
  })

  test('rejects output_path outside the working directory', async () => {
    await expect(
      runWithCwdOverride(tmp, () =>
        VideoGenTool.call(
          { prompt: 'x', output_path: '/etc/evil.mp4' } as never,
          { abortController: new AbortController() } as never,
        ),
      ),
    ).rejects.toThrow(/working directory/)
  })
})

describe('VideoGenTool UI', () => {
  test('renderToolUseMessage shows the prompt', () => {
    expect(
      VideoGenTool.renderToolUseMessage({ prompt: 'a river' } as never),
    ).toBe('a river')
  })

  test('renderToolResultMessage returns a React element', () => {
    const el = VideoGenTool.renderToolResultMessage?.({
      path: '/x/out.mp4',
      model: 'm',
      frames: 57,
      fps: 24,
      mediaType: 'video/mp4',
    } as never)
    expect(React.isValidElement(el)).toBe(true)
  })
})

describe('/image-video command', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-vcmd-'))
    process.env.RAYU_CONFIG_DIR = dir
    delete process.env.FAL_KEY
    delete process.env.NVIDIA_API_KEY
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.FAL_KEY
    delete process.env.NVIDIA_API_KEY
  })

  test('is a prompt command whose prompt invokes GenerateVideo', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd: any = (await import('../src/commands/image-video.ts')).default
    expect(cmd.name).toBe('image-video')
    expect(cmd.type).toBe('prompt')
    const blocks = await cmd.getPromptForCommand('a flowing river')
    expect(blocks[0].text).toContain('a flowing river')
    expect(blocks[0].text).toContain('GenerateVideo')
  })

  test('is gated on NVIDIA_API_KEY or FAL_KEY', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd: any = (await import('../src/commands/image-video.ts')).default
    _resetRayuConfigCache()
    expect(cmd.isEnabled()).toBe(false)
    process.env.NVIDIA_API_KEY = 'nv-x'
    _resetRayuConfigCache()
    expect(cmd.isEnabled()).toBe(true)
  })
})
