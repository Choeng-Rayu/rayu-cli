import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
  VIDEO_BODY_BUILDERS,
  withBuilder,
} from '../src/tools/VideoGenTool/models.ts'
import {
  generateFalVideo,
  _setFalPollInterval,
} from '../src/tools/VideoGenTool/falVideoClient.ts'
import {
  _resetRayuVideoAvailabilityForTesting,
  VideoGenTool,
  resolveOutputPath,
  selectHostedVideoModel,
} from '../src/tools/VideoGenTool/VideoGenTool.ts'
import {
  generateRayuVideo,
  RAYU_VIDEO_TIMEOUT_MS,
} from '../src/tools/VideoGenTool/rayuVideoClient.ts'
import {
  _resetRayuEntitlementsForTesting,
  _setRayuEntitlementsForTesting,
  type RayuEntitlements,
} from '../src/services/rayuAuth/rayuEntitlements.ts'
import {
  _resetFeatureUsageForTesting,
  _setFeatureUsageForTesting,
} from '../src/services/rayuAuth/rayuFeatureUsage.ts'
import {
  markRayuCharges,
  rayuCreditsSince,
} from '../src/services/rayuAuth/rayuTurnCredits.ts'

// A fetched-style catalog: exactly what services/rayuAuth/mediaModels.ts produces
// from GET /v1/models?media=video. The CLI holds no video model registry, so every
// test drives the resolver with this. fal.ai and Vertex Veo are the
// bring-your-own video backends; NVIDIA (NVCF Cosmos, SVD) was removed.
const VIDEO_CATALOG: MediaModelEntry[] = [
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
    id: 'fal-ai/kling-video/v2.1/standard/image-to-video',
    label: 'Kling 2.1 (i2v)',
    mediaType: 'video',
    capabilities: ['image2video'],
    backend: 'fal',
    family: 'fal-kling',
    estimatedSeconds: 90,
    defaultParams: { duration: '5', aspect_ratio: '16:9' },
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
  {
    id: 'veo-3.1-fast-generate-001',
    label: 'Veo 3.1 Fast',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 90,
  },
]

const FAL_T2V = 'fal-ai/kling-video/v2.1/standard/text-to-video'
const FAL_I2V = 'fal-ai/kling-video/v2.1/standard/image-to-video'
/** An id the CLI used to serve through NVIDIA NVCF; it is no longer routable. */
const RETIRED_NVIDIA_VIDEO_MODEL = 'nvidia/cosmos-predict1-5b'

/**
 * The gateway synthesizes hosted video entries from the admin's hosted video
 * catalog: backend 'rayu' + family 'dashscope_video'. No BYO key is involved.
 */
const HOSTED_VIDEO_MODEL: MediaModelEntry = {
  id: 'rayu-qwen-wan3.0-video-prime',
  label: 'Qwen Wan 3.0 Video Prime',
  mediaType: 'video',
  capabilities: ['text2video'],
  backend: 'rayu',
  family: 'dashscope_video',
  estimatedSeconds: 120,
  defaultParams: {
    resolution: '720P',
    ratio: '16:9',
    duration: 5,
    prompt_extend: true,
    watermark: false,
  },
  isDefault: true,
}

/**
 * A hosted entry that ALSO carries image2video — the gateway maps it to an
 * upstream reference_image input, so input_image is accepted for this one.
 */
const HOSTED_I2V_MODEL: MediaModelEntry = {
  ...HOSTED_VIDEO_MODEL,
  id: 'rayu-qwen-wan-i2v',
  label: 'Qwen Wan I2V',
  capabilities: ['text2video', 'image2video'],
  isDefault: false,
}

/** Minimal PNG header (magic bytes) for reference-image tests. */
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])

function videoCatalog(video = VIDEO_CATALOG): MediaCatalog {
  return { image: [], video, source: 'gateway', fetchedAt: Date.now() }
}

/** Install the fetched catalog so no test depends on a gateway or on disk. */
function useVideoCatalog(video = VIDEO_CATALOG): void {
  _setMediaModelsForTesting(videoCatalog(video))
}

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

  test('the fal client default is the catalog fal model, with its metadata', () => {
    const m = resolveVideoModel(VIDEO_CATALOG, undefined, false, { backends: ['fal'] })
    expect(m.id).toBe(FAL_T2V)
    expect(m.backend).toBe('fal')
    // The duration estimate comes from the CATALOG, not the CLI.
    expect(m.estimatedSeconds).toBe(90)
  })

  test('NVIDIA request families are gone: a Cosmos/SVD row cannot be built', () => {
    for (const family of [
      'cosmos-predict1',
      'cosmos-transfer1',
      'cosmos3-nano',
      'cosmos-legacy',
      'svd',
    ]) {
      expect(family in VIDEO_BODY_BUILDERS).toBe(false)
    }
    expect(() =>
      withBuilder({
        id: RETIRED_NVIDIA_VIDEO_MODEL,
        label: 'Cosmos Predict1 5B',
        mediaType: 'video',
        capabilities: ['text2video'],
        backend: 'fal',
        family: 'cosmos-predict1',
      }),
    ).toThrow(/request family "cosmos-predict1"/)
  })

  test('fal-kling family switches shape on the presence of an image', () => {
    const t2v = resolveVideoModel(VIDEO_CATALOG, FAL_T2V, false)
    const textBody = t2v.buildBody({ prompt: 'a river' })
    expect(textBody.cfg_scale).toBe(0.5)
    expect('image_url' in textBody).toBe(false)
    const imageBody = t2v.buildBody({ prompt: 'animate', image: 'QUJD' })
    expect(String(imageBody.image_url)).toContain('data:image/png;base64,QUJD')
  })

  test('each operation gets its own fal default', () => {
    expect(
      resolveVideoModel(VIDEO_CATALOG, undefined, false, { backends: ['fal'] }).id,
    ).toBe(FAL_T2V)
    expect(
      resolveVideoModel(VIDEO_CATALOG, undefined, true, { backends: ['fal'] }).id,
    ).toBe(FAL_I2V)
  })

  test('a model added to the catalog is usable with NO CLI change', () => {
    const added: MediaModelEntry = {
      id: 'fal-ai/kling-video/v2.5/turbo/text-to-video',
      label: 'Kling 2.5 Turbo',
      mediaType: 'video',
      capabilities: ['text2video'],
      backend: 'fal',
      // Reuses a known request shape, so only the catalog row is new.
      family: 'fal-kling',
      estimatedSeconds: 45,
      defaultParams: { duration: '10' },
    }
    const m = resolveVideoModel([...VIDEO_CATALOG, added], added.id, false)
    expect(m.id).toBe(added.id)
    expect(m.estimatedSeconds).toBe(45)
    expect(m.buildBody({ prompt: 'x' }).duration).toBe('10')
  })

  test('an unknown request family fails with an actionable, named error', () => {
    expect(() =>
      withBuilder({
        id: 'fal-ai/brand-new',
        label: 'New',
        mediaType: 'video',
        capabilities: ['text2video'],
        backend: 'fal',
        family: 'holodeck-v1',
      }),
    ).toThrow(/holodeck-v1/)
  })

  test('an empty catalog fails with a dashboard hint, not a crash', () => {
    expect(() => resolveVideoModel([], undefined, false)).toThrow(/dashboard/i)
  })

  test('an UNKNOWN named model is an error, never a silent substitution', () => {
    // A retired NVIDIA id is just an unknown id now.
    expect(() => resolveVideoModel(VIDEO_CATALOG, RETIRED_NVIDIA_VIDEO_MODEL, false))
      .toThrow(/Unknown video model "nvidia\/cosmos-predict1-5b"/)
  })

  test('a KNOWN text2video-only model still falls back for image2video', () => {
    // Deliberate: this is how input_image routes to an image-capable model.
    expect(
      resolveVideoModel(VIDEO_CATALOG, FAL_T2V, true, { backends: ['fal'] }).id,
    ).toBe(FAL_I2V)
  })

  test('a model served by another backend reports a routing bug', () => {
    expect(() =>
      resolveVideoModel(VIDEO_CATALOG, 'veo-3.1-generate-001', false, {
        backends: ['fal'],
      }),
    ).toThrow(/routing bug/)
  })

  test('a Vertex default never resolves for the fal client', () => {
    // Regression guard: with a catalog whose ONLY default text2video model is Veo,
    // the fal client must still pick something it can actually POST to rather
    // than mis-routing a Veo body.
    const veoFirst: MediaModelEntry[] = [
      { ...VIDEO_CATALOG[2]!, isDefault: true }, // veo, default
      { ...VIDEO_CATALOG[0]!, isDefault: false }, // fal, not default
    ]
    const m = resolveVideoModel(veoFirst, undefined, false, { backends: ['fal'] })
    expect(m.backend).toBe('fal')
    expect(m.id).toBe(FAL_T2V)
  })

  test('NVIDIA_VIDEO_MODEL no longer pins anything', () => {
    const alt: MediaModelEntry = {
      ...VIDEO_CATALOG[0]!,
      id: 'fal-ai/kling-video/v2.5/turbo/text-to-video',
      isDefault: false,
    }
    process.env.NVIDIA_VIDEO_MODEL = alt.id
    expect(
      resolveVideoModel([...VIDEO_CATALOG, alt], undefined, false, {
        backends: ['fal'],
      }).id,
    ).toBe(FAL_T2V)
  })

  test('retainKnownVideoModel drops a stale remembered selection', () => {
    expect(retainKnownVideoModel(VIDEO_CATALOG, 'gone/forever')).toBeUndefined()
    expect(retainKnownVideoModel(VIDEO_CATALOG, FAL_T2V)).toBe(FAL_T2V)
    expect(retainKnownVideoModel(VIDEO_CATALOG, undefined)).toBeUndefined()
    // A remembered NVIDIA id is dropped: no catalog serves it any more.
    expect(
      retainKnownVideoModel(VIDEO_CATALOG, RETIRED_NVIDIA_VIDEO_MODEL),
    ).toBeUndefined()
    // A hand-written Veo id is kept — the Vertex client honours it verbatim.
    expect(retainKnownVideoModel(VIDEO_CATALOG, 'veo-4.0-generate-001')).toBe(
      'veo-4.0-generate-001',
    )
  })

  test('per-backend defaults come from the catalog', () => {
    expect(defaultVideoModelId(VIDEO_CATALOG, 'vertex', false)).toBe(
      'veo-3.1-generate-001',
    )
    expect(defaultVideoModelId(VIDEO_CATALOG, 'fal', false)).toBe(FAL_T2V)
    expect(defaultVideoModelId(VIDEO_CATALOG, 'fal', true)).toBe(FAL_I2V)
    expect(defaultVideoModelId(VIDEO_CATALOG, 'nvcf', true)).toBeUndefined()
  })

  test('VERTEX_VIDEO_MODEL pins the Vertex default only', () => {
    process.env.VERTEX_VIDEO_MODEL = 'veo-3.1-fast-generate-001'
    expect(defaultVideoModelId(VIDEO_CATALOG, 'vertex', false)).toBe(
      'veo-3.1-fast-generate-001',
    )
    // The Vertex pin never leaks into the fal default.
    expect(defaultVideoModelId(VIDEO_CATALOG, 'fal', false)).toBe(FAL_T2V)
  })

  test('isVertexVideoModel reads the catalog backend, not the id', () => {
    expect(isVertexVideoModel('veo-3.1-generate-001', VIDEO_CATALOG)).toBe(true)
    expect(isVertexVideoModel(FAL_T2V, VIDEO_CATALOG)).toBe(false)
    expect(isVertexVideoModel(undefined, VIDEO_CATALOG)).toBe(false)
  })
})

describe('dashscope_video family (Rayu-hosted)', () => {
  /** A bare-defaults builder so "absent" assertions are meaningful. */
  function bare() {
    return withBuilder({ ...HOSTED_VIDEO_MODEL, defaultParams: {} })
  }

  test('maps prompt, duration, ratio, the entry tier and sampling knobs', () => {
    const body = withBuilder(HOSTED_VIDEO_MODEL).buildBody({
      prompt: 'a river at dusk',
      num_frames: 57,
      fps: 24,
      aspect_ratio: '9:16',
      height: 1080,
      negative_prompt: 'blurry',
      seed: 7,
    })
    expect(body.prompt).toBe('a river at dusk')
    expect(body.duration).toBe(2) // round(57/24)
    expect(body.ratio).toBe('9:16')
    // The ENTRY's tier, not one derived from height: each hosted entry is one
    // priced resolution, and the gateway refuses any other.
    expect(body.resolution).toBe('720P')
    expect(body.negative_prompt).toBe('blurry')
    expect(body.seed).toBe(7)
    // Ordinary catalog defaults survive the merge.
    expect(body.prompt_extend).toBe(true)
    expect(body.watermark).toBe(false)
  })

  test('duration derives only from BOTH num_frames and fps, clamped 2–30', () => {
    expect(bare().buildBody({ prompt: 'x', num_frames: 600, fps: 24 }).duration).toBe(25)
    expect(bare().buildBody({ prompt: 'x', num_frames: 3000, fps: 24 }).duration).toBe(30)
    // wan3.0-video refuses a 1 s clip, so the floor is 2.
    expect(bare().buildBody({ prompt: 'x', num_frames: 10, fps: 24 }).duration).toBe(2)
    expect(bare().buildBody({ prompt: 'x', num_frames: 24, fps: 24 }).duration).toBe(2)
    // One missing → omitted, NOT zero (the gateway/model default applies).
    expect('duration' in bare().buildBody({ prompt: 'x', num_frames: 57 })).toBe(false)
    expect('duration' in bare().buildBody({ prompt: 'x', fps: 24 })).toBe(false)
    // A catalog default still applies when the caller gave no frame info.
    expect(withBuilder(HOSTED_VIDEO_MODEL).buildBody({ prompt: 'x' }).duration).toBe(5)
  })

  test('ratio takes an explicit accepted value, else derives from width/height', () => {
    expect(bare().buildBody({ prompt: 'x', aspect_ratio: '16:9' }).ratio).toBe('16:9')
    expect(bare().buildBody({ prompt: 'x', aspect_ratio: '9:16' }).ratio).toBe('9:16')
    expect(bare().buildBody({ prompt: 'x', aspect_ratio: '1:1' }).ratio).toBe('1:1')
    expect(bare().buildBody({ prompt: 'x', aspect_ratio: '4:3' }).ratio).toBe('4:3')
    expect(bare().buildBody({ prompt: 'x', aspect_ratio: '3:4' }).ratio).toBe('3:4')
    // `adaptive` is a wire value the gateway accepts, distinct from the numeric
    // ratios used for nearest-match derivation.
    expect(bare().buildBody({ prompt: 'x', aspect_ratio: 'adaptive' }).ratio).toBe('adaptive')
    // An unsupported ratio is ignored, not thrown.
    expect('ratio' in bare().buildBody({ prompt: 'x', aspect_ratio: '2.35:1' })).toBe(false)

    expect(bare().buildBody({ prompt: 'x', width: 1920, height: 1080 }).ratio).toBe('16:9')
    expect(bare().buildBody({ prompt: 'x', width: 1024, height: 768 }).ratio).toBe('4:3')
    expect(bare().buildBody({ prompt: 'x', width: 720, height: 1280 }).ratio).toBe('9:16')
    expect(bare().buildBody({ prompt: 'x', width: 500, height: 500 }).ratio).toBe('1:1')
    expect(bare().buildBody({ prompt: 'x', width: 900, height: 1200 }).ratio).toBe('3:4')
    expect('ratio' in bare().buildBody({ prompt: 'x' })).toBe(false)
  })

  test('height never changes a hosted entry’s resolution tier', () => {
    for (const height of [2160, 1080, 720, 480]) {
      // No tier in the defaults → no resolution sent at all (the row decides).
      expect('resolution' in bare().buildBody({ prompt: 'x', height })).toBe(false)
      // A tier in the defaults is the one sent, whatever the height.
      expect(
        withBuilder(HOSTED_VIDEO_MODEL).buildBody({ prompt: 'x', height }).resolution,
      ).toBe('720P')
    }
    expect('resolution' in bare().buildBody({ prompt: 'x' })).toBe(false)
  })

  test('never emits an image, even when one is passed or defaulted', () => {
    const body = withBuilder(HOSTED_VIDEO_MODEL).buildBody({
      prompt: 'x',
      image: 'base64-image',
    })
    expect('image' in body).toBe(false)
    expect('img_url' in body).toBe(false)
    expect('audio_url' in body).toBe(false)
    expect('video' in body).toBe(false)
  })

  test('defaultParams cannot smuggle routing or reference-input fields', () => {
    const rogue = withBuilder({
      ...HOSTED_VIDEO_MODEL,
      defaultParams: {
        model: 'hijacked/upstream-model',
        image: 'x',
        img_url: 'https://evil.example/i.png',
        audio_url: 'https://evil.example/a.mp3',
        video: 'https://evil.example/v.mp4',
        stream: false,
        mask: 'https://evil.example/m.png',
        prompt_extend: true,
      },
    })
    const body = rogue.buildBody({ prompt: 'x' })
    expect('model' in body).toBe(false)
    expect('image' in body).toBe(false)
    expect('img_url' in body).toBe(false)
    expect('audio_url' in body).toBe(false)
    expect('video' in body).toBe(false)
    // The gateway rejects these outright (400), even `stream: false`, so a
    // stray default must not reach the wire.
    expect('stream' in body).toBe(false)
    expect('mask' in body).toBe(false)
    // Ordinary knobs still flow through.
    expect(body.prompt_extend).toBe(true)
  })

  describe('reference image (image2video)', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'rayu-vidref-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    function i2vBuilder(defaults: Record<string, unknown> = {}) {
      return withBuilder({ ...HOSTED_I2V_MODEL, defaultParams: defaults })
    }

    test('a local PNG path becomes a data:image/png;base64 URL', () => {
      const p = join(dir, 'ref.png')
      writeFileSync(p, TINY_PNG)
      const body = i2vBuilder().buildBody({ prompt: 'x', input_image: p })
      expect(String(body.image)).toBe(
        `data:image/png;base64,${TINY_PNG.toString('base64')}`,
      )
    })

    test('an https URL passes through unchanged', () => {
      const url = 'https://example.com/i.png'
      const body = i2vBuilder().buildBody({ prompt: 'x', input_image: url })
      expect(body.image).toBe(url)
    })

    test('a local file over 12 MiB is refused before sending', () => {
      const p = join(dir, 'big.png')
      writeFileSync(p, Buffer.alloc(12 * 1024 * 1024 + 1, 0x89))
      expect(() => i2vBuilder().buildBody({ prompt: 'x', input_image: p })).toThrow(
        /too large/,
      )
    })

    test('a file at the decoded cap is still refused when the ENCODED body would overflow', () => {
      // 12 MiB base64-inflates to EXACTLY 16 MiB, and the data-URI prefix +
      // JSON + prompt push the body over the gateway's 16 MiB DefaultBodyLimit
      // — where the extractor 413s before any tagged error. The CLI must
      // enforce what the server actually accepts, not just the decoded cap.
      const p = join(dir, 'edge.png')
      writeFileSync(p, Buffer.alloc(12 * 1024 * 1024, 0x89))
      expect(() => i2vBuilder().buildBody({ prompt: 'x', input_image: p })).toThrow(
        /gateway request body/,
      )
    })

    test('a comfortably small file passes both caps', () => {
      const p = join(dir, 'ok.png')
      writeFileSync(p, TINY_PNG)
      const body = i2vBuilder().buildBody({ prompt: 'x', input_image: p })
      expect(String(body.image)).toContain('data:image/png;base64,')
    })

    test('an http:// reference URL is refused with an https-only message', () => {
      // The gateway accepts https:// and data: image references ONLY; passing a
      // plain-http URL through would earn a 400 the CLI can prevent.
      expect(() =>
        i2vBuilder().buildBody({ prompt: 'x', input_image: 'http://example.com/i.png' }),
      ).toThrow(/must use https/)
    })

    test('an unreadable local path errors clearly', () => {
      expect(() =>
        i2vBuilder().buildBody({ prompt: 'x', input_image: join(dir, 'gone.png') }),
      ).toThrow(/not found or unreadable/)
    })

    test('a defaulted image from defaultParams never overrides the caller', () => {
      // Routing/reference keys are stripped from the defaults; the caller's
      // image is added AFTER the spread, so a rogue default cannot smuggle one
      // when the caller supplied none.
      const body = i2vBuilder({ image: 'https://evil.example/smuggled.png' }).buildBody(
        { prompt: 'x' },
      )
      expect('image' in body).toBe(false)
      const caller = i2vBuilder({ image: 'https://evil.example/smuggled.png' }).buildBody(
        { prompt: 'x', input_image: 'https://ok.example/i.png' },
      )
      expect(caller.image).toBe('https://ok.example/i.png')
    })
  })
})

describe('hosted video default selection', () => {
  test('prefers isDefault among hosted text2video entries', () => {
    const other: MediaModelEntry = {
      ...HOSTED_VIDEO_MODEL,
      id: 'rayu-other-hosted-video',
      isDefault: false,
    }
    const flagged: MediaModelEntry = { ...HOSTED_VIDEO_MODEL, id: 'rayu-flagged' }
    // Server order puts `other` first; the default flag still wins.
    expect(selectHostedVideoModel([other, flagged])?.id).toBe('rayu-flagged')
  })

  test('falls back to server order, and ignores BYO + image2video-only entries', () => {
    const first: MediaModelEntry = {
      ...HOSTED_VIDEO_MODEL,
      id: 'rayu-first',
      isDefault: false,
    }
    const second: MediaModelEntry = {
      ...HOSTED_VIDEO_MODEL,
      id: 'rayu-second',
      isDefault: false,
    }
    expect(selectHostedVideoModel([first, second])?.id).toBe('rayu-first')
    expect(selectHostedVideoModel(VIDEO_CATALOG)).toBeUndefined()
    const hostedI2V: MediaModelEntry = {
      ...HOSTED_VIDEO_MODEL,
      id: 'rayu-i2v',
      capabilities: ['image2video'],
    }
    expect(selectHostedVideoModel([...VIDEO_CATALOG, hostedI2V])).toBeUndefined()
  })

  test('a reference-image request selects the image2video entry, not the text2video default', () => {
    // The text entry is flagged default; an input_image request must still land
    // on the image2video-capable entry — the gateway 400s a reference against a
    // text-to-video-only model.
    const i2v: MediaModelEntry = {
      ...HOSTED_I2V_MODEL,
      isDefault: false,
    }
    expect(selectHostedVideoModel([HOSTED_VIDEO_MODEL, i2v], true)?.id).toBe(
      i2v.id,
    )
    // …and among image2video entries the default flag still wins.
    const i2vDefault: MediaModelEntry = { ...HOSTED_I2V_MODEL, isDefault: true }
    expect(
      selectHostedVideoModel([i2v, i2vDefault], true)?.id,
    ).toBe(i2vDefault.id)
    // Text-only requests never pick an image2video-ONLY entry.
    const i2vOnly: MediaModelEntry = {
      ...HOSTED_VIDEO_MODEL,
      id: 'rayu-i2v-only',
      capabilities: ['image2video'],
    }
    expect(selectHostedVideoModel([i2vOnly], false)).toBeUndefined()
    // No image2video entry at all -> undefined (caller falls back / errors).
    expect(selectHostedVideoModel([HOSTED_VIDEO_MODEL], true)).toBeUndefined()
  })
})

/** Mock a successful fal.ai submit → poll COMPLETED → response → download. */
function mockFalSuccess(): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.endsWith('/s')) {
      return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 })
    }
    if (u.endsWith('/r')) {
      return new Response(
        JSON.stringify({ video: { url: 'https://cdn.fal.media/out.mp4' } }),
        { status: 200 },
      )
    }
    if (u.startsWith('https://queue.fal.run/')) {
      return new Response(
        JSON.stringify({
          request_id: 'r',
          status_url: 'https://queue.fal.run/s',
          response_url: 'https://queue.fal.run/r',
        }),
        { status: 200 },
      )
    }
    return new Response(new Uint8Array(TINY_MP4), { status: 200 })
  }) as unknown as typeof fetch
  return calls
}

describe('generateFalVideo client', () => {
  beforeEach(() => { _setFalPollInterval(0) })
  afterEach(() => { _setFalPollInterval(5000) })

  test('submit → poll COMPLETED → download produces a buffer', async () => {
    const calls = mockFalSuccess()

    const { buffer, mediaType, modelId } = await generateFalVideo({
      modelId: FAL_T2V,
      params: { prompt: 'a river' },
      apiKey: 'fal-test-key',
    })
    expect(buffer.length).toBeGreaterThan(0)
    expect(mediaType).toBe('video/mp4')
    expect(modelId).toBe(FAL_T2V)
    // The key goes to fal's queue host only, in fal's own scheme.
    const submit = calls[0]!
    expect(submit.url).toBe(`https://queue.fal.run/${FAL_T2V}`)
    const headers = submit.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Key fal-test-key')
  })

  test('with no id, image2video resolves the fal image-to-video model', async () => {
    const calls = mockFalSuccess()
    const { modelId } = await generateFalVideo({
      isImage2Video: true,
      params: { prompt: 'animate', image: 'QUJD' },
      apiKey: 'fal-test-key',
    })
    expect(modelId).toBe(FAL_I2V)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(String(body.image_url)).toContain('data:image/png;base64,QUJD')
  })

  test('a missing fal key is reported before any request', async () => {
    const saved = process.env.FAL_KEY
    delete process.env.FAL_KEY
    const calls = mockFalSuccess()
    try {
      await expect(
        generateFalVideo({ modelId: FAL_T2V, params: { prompt: 'x' } }),
      ).rejects.toThrow(/fal\.ai API key not configured/)
      expect(calls).toHaveLength(0)
    } finally {
      if (saved !== undefined) process.env.FAL_KEY = saved
    }
  })

  test('a non-fal model is a routing bug, never sent to fal', async () => {
    const calls = mockFalSuccess()
    await expect(
      generateFalVideo({
        modelId: 'veo-3.1-generate-001',
        params: { prompt: 'x' },
        apiKey: 'fal-test-key',
      }),
    ).rejects.toThrow(/routing bug/)
    expect(calls).toHaveLength(0)
  })

  test('a failed submit surfaces the fal status', async () => {
    globalThis.fetch = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    await expect(
      generateFalVideo({ modelId: FAL_T2V, params: { prompt: 'x' }, apiKey: 'k' }),
    ).rejects.toThrow(/fal\.ai submit error 403/)
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
  let savedAuthDir: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-vid-'))
    process.env.RAYU_CONFIG_DIR = dir
    // The hosted path reads rayu-auth.json from RAYU_AUTH_CONFIG_DIR (which
    // outranks RAYU_CONFIG_DIR); isolate it so a developer's real session cannot
    // make this "no key" assertion true.
    savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
    process.env.RAYU_AUTH_CONFIG_DIR = dir
    _resetRayuVideoAvailabilityForTesting()
    delete process.env.NVIDIA_API_KEY
    delete process.env.FAL_KEY
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
    _resetRayuVideoAvailabilityForTesting()
    delete process.env.NVIDIA_API_KEY
    delete process.env.FAL_KEY
  })

  test('false without any backend — an NVIDIA key alone does not enable it', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    _resetRayuConfigCache()
    expect(VideoGenTool.isEnabled()).toBe(false)
    process.env.NVIDIA_API_KEY = 'nv-x'
    _resetRayuConfigCache()
    expect(VideoGenTool.isEnabled()).toBe(false)
  })

  test('true with FAL_KEY', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    _resetRayuConfigCache()
    process.env.FAL_KEY = 'fal-k'
    _resetRayuConfigCache()
    expect(VideoGenTool.isEnabled()).toBe(true)
  })
})

describe('VideoGenTool.call', () => {
  let tmp: string
  let savedAuthDir: string | undefined
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rayu-vidcall-'))
    // No hosted session: the auth dir is the per-test config dir.
    savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
    process.env.RAYU_AUTH_CONFIG_DIR = testConfigDir
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
    process.env.FAL_KEY = 'fal-k'
    _setFalPollInterval(0)
    _resetRayuVideoAvailabilityForTesting()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(tmp, { recursive: true, force: true })
    if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
    delete process.env.FAL_KEY
    delete process.env.NVIDIA_API_KEY
    _setFalPollInterval(5000)
    _resetRayuVideoAvailabilityForTesting()
  })

  test('saves the mp4 to disk and returns a text result block', async () => {
    const calls = mockFalSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'a river', output_path: './out.mp4' } as never,
        { abortController: new AbortController() } as never,
      ),
    )

    expect(existsSync(join(tmp, 'out.mp4'))).toBe(true)
    expect(res.data.mediaType).toBe('video/mp4')
    expect(res.data.model).toBe(FAL_T2V)
    expect(calls[0]!.url).toBe(`https://queue.fal.run/${FAL_T2V}`)

    const block = VideoGenTool.mapToolResultToToolResultBlockParam(res.data, 'tid')
    const content = block.content as Array<{ type: string }>
    expect(content.some(b => b.type === 'text')).toBe(true)
  })

  test('with only an NVIDIA key, a call is refused with a setup hint and no request', async () => {
    delete process.env.FAL_KEY
    process.env.NVIDIA_API_KEY = 'nv-x'
    const calls = mockFalSuccess()

    await expect(
      runWithCwdOverride(tmp, () =>
        VideoGenTool.call(
          { prompt: 'a river', output_path: './out.mp4' } as never,
          { abortController: new AbortController() } as never,
        ),
      ),
    ).rejects.toThrow(/Rayu sign-in \(\/login\).*fal\.ai key/)
    expect(calls).toHaveLength(0)
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
  let savedAuthDir: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-vcmd-'))
    process.env.RAYU_CONFIG_DIR = dir
    // rayu-auth.json lives in RAYU_AUTH_CONFIG_DIR, which outranks
    // RAYU_CONFIG_DIR; isolate it so a developer's real session cannot make the
    // hosted gate true in the "no key" assertion.
    savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
    process.env.RAYU_AUTH_CONFIG_DIR = dir
    _resetRayuVideoAvailabilityForTesting()
    delete process.env.FAL_KEY
    delete process.env.NVIDIA_API_KEY
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
    _resetRayuVideoAvailabilityForTesting()
    delete process.env.FAL_KEY
    delete process.env.NVIDIA_API_KEY
  })

  test('is a prompt command whose prompt invokes GenerateVideo', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd: any = (await import('../src/commands/image-video.ts')).default
    expect(cmd.name).toBe('image-video')
    expect(cmd.type).toBe('prompt')
    expect(cmd.description).not.toMatch(/nvidia/i)
    const blocks = await cmd.getPromptForCommand('a flowing river')
    expect(blocks[0].text).toContain('a flowing river')
    expect(blocks[0].text).toContain('GenerateVideo')
  })

  test('is gated on FAL_KEY — an NVIDIA key alone does not enable it', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd: any = (await import('../src/commands/image-video.ts')).default
    _resetRayuConfigCache()
    expect(cmd.isEnabled()).toBe(false)
    process.env.NVIDIA_API_KEY = 'nv-x'
    _resetRayuConfigCache()
    expect(cmd.isEnabled()).toBe(false)
    process.env.FAL_KEY = 'fal-k'
    _resetRayuConfigCache()
    expect(cmd.isEnabled()).toBe(true)
  })
})

// ── Rayu-hosted video models ─────────────────────────────────────────────────
// Gateway-synthesized entries: backend 'rayu' + family 'dashscope_video'. No BYO
// key; the user's Rayu JWT authorizes the request and the gateway bills per
// second of generated video.
describe('VideoGenTool hosted (Rayu)', () => {
  let tmp: string
  let cfgDir: string
  let savedAuthDir: string | undefined

  function writeSignedInSession(): void {
    writeFileSync(
      join(cfgDir, 'rayu-auth.json'),
      JSON.stringify({
        accessToken: 'test-token',
        refreshToken: 'test-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
        user: null,
      }),
      { mode: 0o600 },
    )
  }

  function entitlements(opts?: { free?: boolean }): RayuEntitlements {
    const free = !!opts?.free
    return {
      plan: {
        code: free ? 'free' : 'pro',
        name: free ? 'Free' : 'Pro',
        priceCents: free ? 0 : 900,
        availability: 'public',
      },
      maxDailyTurns: null,
      features: { video_generation: { enabled: true } },
      allowedModels: free
        ? []
        : [{ code: HOSTED_VIDEO_MODEL.id, label: 'Wan', creditMultiplier: 1 }],
      hostedModels: [
        { code: HOSTED_VIDEO_MODEL.id, label: 'Wan', creditMultiplier: 1 },
      ],
      userId: null,
    }
  }

  /**
   * Replace fetch with a gateway handler. Session/entitlement/usage background
   * refreshes are answered with a harmless 404 and NOT recorded, so assertions
   * only ever see the video requests under test.
   */
  function mockFetch(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): Array<{ url: string; init?: RequestInit }> {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/me/entitlements') || u.includes('/usage/')) {
        return new Response('{}', { status: 404 })
      }
      calls.push({ url: u, init })
      return handler(u, init)
    }) as unknown as typeof fetch
    return calls
  }

  /** A full mock of a successful hosted generation (gateway + CDN download). */
  function mockHostedSuccess(): Array<{ url: string; init?: RequestInit }> {
    return mockFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(
          JSON.stringify({
            created: 1,
            data: [
              {
                url: 'https://cdn.example/generated.mp4',
                duration: 2,
                resolution: '1080P',
                ratio: '9:16',
              },
            ],
            rayu: {
              videos: 1,
              seconds: 2,
              billingUnit: 'video_second',
              billableTokens: 2000,
              tokensPerCredit: 1000,
            },
          }),
          { status: 200 },
        )
      }
      if (url === 'https://cdn.example/generated.mp4') {
        return new Response(new Uint8Array(TINY_MP4), {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'rayu-vidrayu-'))
    cfgDir = mkdtempSync(join(tmpdir(), 'rayu-vidrayucfg-'))
    process.env.RAYU_CONFIG_DIR = cfgDir
    savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
    process.env.RAYU_AUTH_CONFIG_DIR = cfgDir
    process.env.USE_RAYU_OAUTH = 'true'
    // Hosted-only: no BYO key of any kind.
    delete process.env.NVIDIA_API_KEY
    delete process.env.FAL_KEY
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
    writeSignedInSession()
    _setRayuEntitlementsForTesting(entitlements())
    _setFeatureUsageForTesting({ video_generation: { used: 0, limit: null } })
    _resetRayuVideoAvailabilityForTesting()
    useVideoCatalog([...VIDEO_CATALOG, HOSTED_VIDEO_MODEL])
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    _resetRayuEntitlementsForTesting()
    _resetFeatureUsageForTesting()
    _resetRayuVideoAvailabilityForTesting()
    rmSync(tmp, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.NVIDIA_API_KEY
    delete process.env.FAL_KEY
    if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
    else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
    // USE_RAYU_OAUTH is restored by the file-level afterEach.
  })

  test('isEnabled is true for a signed-in user with NO provider key', () => {
    expect(VideoGenTool.isEnabled()).toBe(true)
  })

  test('isEnabled stays false when signed out and no key exists', () => {
    rmSync(join(cfgDir, 'rayu-auth.json'), { force: true })
    delete process.env.USE_RAYU_OAUTH
    _resetRayuVideoAvailabilityForTesting()
    expect(VideoGenTool.isEnabled()).toBe(false)
  })

  test('a hosted-only user generates through the gateway and saves an MP4', async () => {
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        {
          prompt: 'a river',
          output_path: './hosted.mp4',
          num_frames: 57,
          fps: 24,
          height: 1080,
          aspect_ratio: '9:16',
        },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(existsSync(join(tmp, 'hosted.mp4'))).toBe(true)
    expect(res.data.model).toBe(HOSTED_VIDEO_MODEL.id)
    expect(res.data.mediaType).toBe('video/mp4')

    const gateway = calls.find((c) => c.url.includes('/v1/videos/generations'))
    expect(gateway).toBeDefined()
    const headers = gateway!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-token')
    const body = JSON.parse(String(gateway!.init?.body)) as Record<string, unknown>
    expect(body.model).toBe(HOSTED_VIDEO_MODEL.id)
    expect(body.prompt).toBe('a river')
    expect(body.duration).toBe(2)
    // The entry's own tier: height 1080 does not move a 720P entry to 1080P.
    expect(body.resolution).toBe('720P')
    expect(body.ratio).toBe('9:16')
    // Text-to-video only: no reference input ever reaches the gateway.
    expect('image' in body).toBe(false)

    // The URL fallback download refuses off-host redirects.
    const download = calls.find(
      (c) => c.url === 'https://cdn.example/generated.mp4',
    )
    expect(download).toBeDefined()
    expect(download!.init?.redirect).toBe('error')
  })

  test('a remembered model with no credentials falls back to hosted', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    // A stale fal selection survives in the catalog, but FAL_KEY is gone.
    cfg.setVideoModelSelection(
      'fal-ai/kling-video/v2.1/standard/text-to-video',
    )
    cfg._resetRayuConfigCache()
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'a river', output_path: './fallback.mp4' },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_VIDEO_MODEL.id)
    expect(calls[0].url).toContain('/v1/videos/generations')
  })

  test('a remembered retired NVIDIA model falls back to hosted', async () => {
    // An NVIDIA id saved by an older CLI is no longer servable; an NVIDIA key in
    // the environment must not revive it.
    process.env.NVIDIA_API_KEY = 'nv-x'
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.setVideoModelSelection(RETIRED_NVIDIA_VIDEO_MODEL)
    cfg._resetRayuConfigCache()
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'a river', output_path: './retired.mp4' },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_VIDEO_MODEL.id)
    expect(calls[0].url).toContain('/v1/videos/generations')
  })

  // ── Hosted is the DEFAULT for a signed-in user ─────────────────────────────
  // Regression: with nothing selected, a configured BYO key used to win, so a
  // signed-in user with a stray key never reached the gateway.

  test('with nothing selected, the hosted model wins over a configured fal key', async () => {
    process.env.NVIDIA_API_KEY = 'nv-x'
    process.env.FAL_KEY = 'fal-k'
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'a river', output_path: './default.mp4' },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_VIDEO_MODEL.id)
    expect(
      calls.every(
        (c) =>
          c.url.includes('/v1/videos/generations') ||
          c.url === 'https://cdn.example/generated.mp4',
      ),
    ).toBe(true)
  })

  test('a reference image with nothing selected uses the hosted image2video model over BYO', async () => {
    process.env.FAL_KEY = 'fal-k'
    useVideoCatalog([...VIDEO_CATALOG, HOSTED_VIDEO_MODEL, HOSTED_I2V_MODEL])
    writeFileSync(join(tmp, 'in.png'), TINY_PNG)
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'animate this', input_image: './in.png', output_path: './i2v.mp4' },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_I2V_MODEL.id)
    expect(calls.some((c) => c.url.includes('/v1/videos/generations'))).toBe(true)
  })

  test('a hosted entry WITHOUT image2video refuses input_image with the exact message', async () => {
    writeFileSync(join(tmp, 'in.png'), TINY_PNG)
    const calls = mockFetch(() => {
      throw new Error('must not reach the network')
    })

    await expect(
      runWithCwdOverride(tmp, () =>
        VideoGenTool.call(
          {
            prompt: 'animate this',
            input_image: './in.png',
            output_path: './out.mp4',
          },
          { abortController: new AbortController() } as never,
        ),
      ),
    ).rejects.toThrow(
      'Hosted video model "rayu-qwen-wan3.0-video-prime" is text-to-video only — ' +
        'choose a model with image2video to use a reference image.',
    )
    expect(calls).toHaveLength(0)
  })

  test('no model named + input_image selects the hosted image2video entry', async () => {
    // Regression: auto-selection used to prefer text2video unconditionally, so
    // an image request died with "…is text-to-video only" even though the
    // catalog carried an image2video-capable hosted model.
    useVideoCatalog([...VIDEO_CATALOG, HOSTED_VIDEO_MODEL, HOSTED_I2V_MODEL])
    writeFileSync(join(tmp, 'in.png'), TINY_PNG)
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'animate this', input_image: './in.png', output_path: './auto.mp4' },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_I2V_MODEL.id)
    const gateway = calls.find((c) => c.url.includes('/v1/videos/generations'))
    const body = JSON.parse(String(gateway!.init?.body)) as Record<string, unknown>
    expect(String(body.image)).toBe(
      `data:image/png;base64,${TINY_PNG.toString('base64')}`,
    )
  })

  test('a REMEMBERED hosted text2video model swaps to hosted i2v for a reference image', async () => {
    // Not an explicit tool argument — the /model_video_generation selection —
    // so the deliberate capability fall-through applies (same rule BYO models
    // already followed in resolveVideoModel).
    useVideoCatalog([...VIDEO_CATALOG, HOSTED_VIDEO_MODEL, HOSTED_I2V_MODEL])
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.setVideoModelSelection(HOSTED_VIDEO_MODEL.id)
    cfg._resetRayuConfigCache()
    writeFileSync(join(tmp, 'in.png'), TINY_PNG)
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'animate this', input_image: './in.png', output_path: './swap.mp4' },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_I2V_MODEL.id)
    const gateway = calls.find((c) => c.url.includes('/v1/videos/generations'))
    const body = JSON.parse(String(gateway!.init?.body)) as Record<string, unknown>
    expect(body.model).toBe(HOSTED_I2V_MODEL.id)
  })

  test('BYO keeps precedence when its key IS configured (hosted available too)', async () => {
    // Truth-table edge: signed-in Rayu user WITH a fal key, remembering a fal
    // model — the BYO backend must win; the hosted fallback is only for unusable
    // backends, never a silent takeover of a configured one.
    process.env.FAL_KEY = 'fal-k'
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.setVideoModelSelection(FAL_T2V)
    cfg._resetRayuConfigCache()
    _setFalPollInterval(0)
    let falSubmits = 0
    mockFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        throw new Error('hosted must not be used when a BYO key is configured')
      }
      if (url.endsWith('/s')) {
        return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 })
      }
      if (url.endsWith('/r')) {
        return new Response(
          JSON.stringify({ video: { url: 'https://cdn.fal.media/out.mp4' } }),
          { status: 200 },
        )
      }
      if (url === `https://queue.fal.run/${FAL_T2V}`) {
        falSubmits++
        return new Response(
          JSON.stringify({
            request_id: 'r',
            status_url: 'https://queue.fal.run/s',
            response_url: 'https://queue.fal.run/r',
          }),
          { status: 200 },
        )
      }
      return new Response(new Uint8Array(TINY_MP4), { status: 200 })
    })

    try {
      const res = await runWithCwdOverride(tmp, () =>
        VideoGenTool.call(
          { prompt: 'a river', output_path: './byo.mp4' },
          { abortController: new AbortController() } as never,
        ),
      )

      expect(res.data.model).toBe(FAL_T2V)
      expect(falSubmits).toBe(1)
    } finally {
      _setFalPollInterval(5000)
    }
  })

  test('the MP4 lands atomically — no temp sibling is left behind', async () => {
    mockHostedSuccess()
    await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'a river', output_path: './atomic.mp4' },
        { abortController: new AbortController() } as never,
      ),
    )
    const { readdirSync } = await import('fs')
    expect(readdirSync(tmp)).toContain('atomic.mp4')
    expect(readdirSync(tmp).filter((f) => f.includes('rayu-tmp'))).toHaveLength(0)
  })

  test('a network failure names the gateway, not a raw fetch stack', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed')
    })
    await expect(
      generateRayuVideo({
        model: withBuilder(HOSTED_VIDEO_MODEL),
        params: { prompt: 'x' },
      }),
    ).rejects.toThrow(/Could not reach the Rayu video gateway/)
  })

  test('a hosted entry WITH image2video sends the reference image', async () => {
    useVideoCatalog([...VIDEO_CATALOG, HOSTED_VIDEO_MODEL, HOSTED_I2V_MODEL])
    writeFileSync(join(tmp, 'in.png'), TINY_PNG)
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        {
          prompt: 'animate this',
          input_image: './in.png',
          model: HOSTED_I2V_MODEL.id,
          output_path: './i2v.mp4',
        },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_I2V_MODEL.id)
    const gateway = calls.find((c) => c.url.includes('/v1/videos/generations'))
    expect(gateway).toBeDefined()
    const body = JSON.parse(String(gateway!.init?.body)) as Record<string, unknown>
    expect(String(body.image)).toBe(
      `data:image/png;base64,${TINY_PNG.toString('base64')}`,
    )
    expect(body.model).toBe(HOSTED_I2V_MODEL.id)
  })

  test('a hosted https reference URL reaches the gateway verbatim', async () => {
    useVideoCatalog([...VIDEO_CATALOG, HOSTED_VIDEO_MODEL, HOSTED_I2V_MODEL])
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        {
          prompt: 'animate this',
          input_image: 'https://example.com/ref.png',
          model: HOSTED_I2V_MODEL.id,
          output_path: './i2vurl.mp4',
        },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_I2V_MODEL.id)
    const gateway = calls.find((c) => c.url.includes('/v1/videos/generations'))
    const body = JSON.parse(String(gateway!.init?.body)) as Record<string, unknown>
    expect(body.image).toBe('https://example.com/ref.png')
  })

  test('the tool result reports the ACTUAL duration billed by the gateway', async () => {
    // Requested: round(121/24) = 5s. The gateway bills 5.1s — the result must
    // say 5.1s, not the requested value.
    mockFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(
          JSON.stringify({
            created: 1,
            data: [
              {
                url: 'https://cdn.example/actual.mp4',
                duration: 5.1,
                resolution: '480P',
                ratio: '16:9',
              },
            ],
            rayu: { videos: 1, seconds: 5.1, billingUnit: 'video_second' },
          }),
          { status: 200 },
        )
      }
      return new Response(new Uint8Array(TINY_MP4), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    })

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        {
          prompt: 'a river',
          output_path: './actual.mp4',
          num_frames: 121,
          fps: 24,
        },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.durationSeconds).toBe(5.1)
    const block = VideoGenTool.mapToolResultToToolResultBlockParam(res.data, 'tid')
    const text = (block.content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === 'text',
    )!.text!
    expect(text).toContain('Generated 5.1s video (480P, 16:9)')
    expect(text).not.toContain('121 frames')
  })

  test('duration falls back to rayu.seconds, then to the requested duration', async () => {
    mockFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(
          JSON.stringify({
            created: 1,
            data: [{ url: 'https://cdn.example/fb.mp4' }],
            rayu: { videos: 1, seconds: 3 },
          }),
          { status: 200 },
        )
      }
      return new Response(new Uint8Array(TINY_MP4), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    })
    const res = await generateRayuVideo({
      model: withBuilder(HOSTED_VIDEO_MODEL),
      params: { prompt: 'x' },
    })
    expect(res.durationSeconds).toBe(3)

    // No data[0].duration and no rayu.seconds → the requested duration applies.
    mockFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(
          JSON.stringify({ created: 1, data: [{ url: 'https://cdn.example/fb.mp4' }] }),
          { status: 200 },
        )
      }
      return new Response(new Uint8Array(TINY_MP4), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    })
    const res2 = await generateRayuVideo({
      model: withBuilder(HOSTED_VIDEO_MODEL),
      params: { prompt: 'x' },
    })
    // HOSTED_VIDEO_MODEL.defaultParams.duration = 5 reaches the body.
    expect(res2.durationSeconds).toBe(5)
  })

  test('maps a gateway {error:{message}} to a clear Error', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { message: 'video_generation is not enabled for this plan' },
          }),
          { status: 403 },
        ),
    )
    await expect(
      generateRayuVideo({
        model: withBuilder(HOSTED_VIDEO_MODEL),
        params: { prompt: 'x' },
      }),
    ).rejects.toThrow(/403.*video_generation/)
  })

  test('rejects a download that is not an MP4 (no ftyp box)', async () => {
    mockFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(
          JSON.stringify({
            created: 1,
            data: [{ url: 'https://cdn.example/fake.mp4' }],
          }),
          { status: 200 },
        )
      }
      return new Response('definitely not a video', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    })
    await expect(
      generateRayuVideo({
        model: withBuilder(HOSTED_VIDEO_MODEL),
        params: { prompt: 'x' },
      }),
    ).rejects.toThrow(/MP4/)
  })

  test("the render's charge counts toward the turn even when its download then fails", async () => {
    mockFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(
          JSON.stringify({
            created: 1,
            data: [{ url: 'https://cdn.example/fake.mp4', duration: 5 }],
            rayu: { videos: 1, seconds: 5, billingUnit: 'video_second', billableTokens: 2500, tokensPerCredit: 1000 },
          }),
          { status: 200 },
        )
      }
      return new Response('definitely not a video', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    })
    const mark = markRayuCharges()
    await expect(
      generateRayuVideo({
        model: withBuilder(HOSTED_VIDEO_MODEL),
        params: { prompt: 'x' },
      }),
    ).rejects.toThrow(/MP4/)
    // The gateway settled the render before answering; a failed download does not undo it.
    expect(rayuCreditsSince(mark)).toBe(2.5)
  })

  test('the client timeout waits past the gateway 900s budget', () => {
    expect(RAYU_VIDEO_TIMEOUT_MS).toBeGreaterThanOrEqual(900_000)
  })

  test('a fallback catalog with no BYO key names the CATALOG, not a key', async () => {
    // The gateway catalog fetch fails: ensureMediaModels falls back to the
    // BYO-only built-in list, which has no hosted text-to-video entry to
    // select. With no BYO key configured, the fal client would report "API key
    // not configured" — the user's real problem is the catalog, so the error
    // must say so.
    _resetMediaModelsForTesting()
    const calls = mockFetch(() => new Response('{}', { status: 502 }))

    await expect(
      runWithCwdOverride(tmp, () =>
        VideoGenTool.call(
          { prompt: 'a river', output_path: './offline.mp4' },
          { abortController: new AbortController() } as never,
        ),
      ),
    ).rejects.toThrow(/Rayu model catalog unavailable/)
    expect(calls.every((c) => !c.url.includes('/v1/videos/generations'))).toBe(
      true,
    )
  })

  test('a gateway catalog with no hosted entry errors clearly too', async () => {
    // Online, but the (gateway-sourced) catalog has only BYO models and the
    // user has no BYO key: the hosted fallback has nothing to pick, and a
    // clear catalog error beats a misleading key error.
    useVideoCatalog([...VIDEO_CATALOG])
    const calls = mockFetch(() => {
      throw new Error('must not reach the network')
    })

    await expect(
      runWithCwdOverride(tmp, () =>
        VideoGenTool.call(
          { prompt: 'a river', output_path: './nohosted.mp4' },
          { abortController: new AbortController() } as never,
        ),
      ),
    ).rejects.toThrow(/Rayu model catalog unavailable/)
    expect(calls).toHaveLength(0)
  })

  test('PAYG: a funded top-up unlocks hosted gen on a feature-less plan', async () => {
    // The gateway serves video generation from a funded top-up even when the
    // plan lacks the video_generation feature. The client must not block what
    // the gateway would serve and bill.
    _setRayuEntitlementsForTesting({
      ...entitlements({ free: true }),
      features: { video_generation: { enabled: false } },
      topupBalance: 25,
    })
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        { prompt: 'a river', output_path: './payg.mp4' },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_VIDEO_MODEL.id)
    const gateway = calls.find((c) => c.url.includes('/v1/videos/generations'))
    expect(gateway).toBeDefined()
  })

  // ── Gateway-only invariant: `backend` outranks `family`, always ──────────
  // A hostile or admin-edited row pairing backend 'rayu' with a BYO request
  // family must still talk to the gateway and ONLY the gateway: the family
  // picks the body shape, never the client or the network target. These tests
  // fail if a fallback path is ever reintroduced that lets a rayu entry reach
  // an NVIDIA/fal/Vertex host, or that follows a redirect off the gateway.

  const BYO_HOST_PATTERN =
    /ai\.api\.nvidia\.com|nvcf\.nvidia\.com|fal\.run|aiplatform\.googleapis\.com|storage\.googleapis\.com/i

  test('a backend:rayu entry with a BYO-looking family still calls only the gateway', async () => {
    const hostile: MediaModelEntry = {
      id: 'rayu-hostile-kling',
      label: 'Hostile Kling-shaped hosted row',
      mediaType: 'video',
      capabilities: ['text2video'],
      backend: 'rayu',
      family: 'fal-kling',
    }
    useVideoCatalog([...VIDEO_CATALOG, HOSTED_VIDEO_MODEL, hostile])
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        {
          prompt: 'a river',
          model: hostile.id,
          output_path: './hostile.mp4',
        },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(hostile.id)
    expect(calls.every((c) => !BYO_HOST_PATTERN.test(c.url))).toBe(true)
    const gateway = calls.find((c) => c.url.includes('/v1/videos/generations'))
    expect(gateway).toBeDefined()
    const body = JSON.parse(String(gateway!.init?.body)) as Record<string, unknown>
    // The billed/routed model is the catalog entry's own id, never the family's
    // upstream name, whatever body the BYO-looking builder emitted.
    expect(body.model).toBe(hostile.id)
  })

  test('a backend:rayu entry with a retired NVIDIA family is refused before any request', async () => {
    const hostile: MediaModelEntry = {
      id: 'rayu-hostile-cosmos',
      label: 'Hostile Cosmos-shaped hosted row',
      mediaType: 'video',
      capabilities: ['text2video'],
      backend: 'rayu',
      family: 'cosmos-predict1',
    }
    useVideoCatalog([...VIDEO_CATALOG, HOSTED_VIDEO_MODEL, hostile])
    const calls = mockFetch((url) => {
      throw new Error(`unexpected fetch: ${url}`)
    })

    await expect(
      runWithCwdOverride(tmp, () =>
        VideoGenTool.call(
          { prompt: 'a river', model: hostile.id, output_path: './cosmos.mp4' },
          { abortController: new AbortController() } as never,
        ),
      ),
    ).rejects.toThrow(/request family "cosmos-predict1"/)
    expect(calls).toHaveLength(0)
  })

  test('a configured BYO key cannot steal a rayu entry from the gateway', async () => {
    process.env.FAL_KEY = 'fal-k'
    process.env.NVIDIA_API_KEY = 'nv-x'
    const calls = mockHostedSuccess()

    const res = await runWithCwdOverride(tmp, () =>
      VideoGenTool.call(
        {
          prompt: 'a river',
          model: HOSTED_VIDEO_MODEL.id,
          output_path: './steal.mp4',
        },
        { abortController: new AbortController() } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_VIDEO_MODEL.id)
    // Only the gateway call and the CDN download — no NVCF/fal/Vertex traffic.
    expect(
      calls.every(
        (c) =>
          c.url.includes('/v1/videos/generations') ||
          c.url === 'https://cdn.example/generated.mp4',
      ),
    ).toBe(true)
  })

  test('the gateway POST pins the configured host and refuses redirects', async () => {
    const saved = process.env.RAYU_GATEWAY_URL
    process.env.RAYU_GATEWAY_URL = 'https://gateway.rayucode.test'
    try {
      const calls = mockFetch((url) => {
        if (url === 'https://cdn.example/generated.mp4') {
          return new Response(new Uint8Array(TINY_MP4), {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
          })
        }
        throw new Error('must not reach the network')
      })
      await expect(
        generateRayuVideo({
          model: withBuilder(HOSTED_VIDEO_MODEL),
          params: { prompt: 'x' },
        }),
      ).rejects.toThrow(/must not reach the network/)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(
        'https://gateway.rayucode.test/v1/videos/generations',
      )
      // A redirect would move the bearer token off the vetted URL.
      expect(calls[0].init?.redirect).toBe('error')
    } finally {
      if (saved === undefined) delete process.env.RAYU_GATEWAY_URL
      else process.env.RAYU_GATEWAY_URL = saved
    }
  })

  test('a non-https gateway URL to a remote host is refused before any request', async () => {
    // RAYU_GATEWAY_URL is env-overridable; the Rayu JWT is a live account
    // credential, so plaintext http to anything but loopback must fail locally
    // instead of shipping the token in the clear.
    const saved = process.env.RAYU_GATEWAY_URL
    process.env.RAYU_GATEWAY_URL = 'http://gateway.attacker.example'
    try {
      const calls = mockFetch(() => {
        throw new Error('must not reach the network')
      })
      await expect(
        generateRayuVideo({
          model: withBuilder(HOSTED_VIDEO_MODEL),
          params: { prompt: 'x' },
        }),
      ).rejects.toThrow(/plaintext http/)
      expect(calls).toHaveLength(0)
    } finally {
      if (saved === undefined) delete process.env.RAYU_GATEWAY_URL
      else process.env.RAYU_GATEWAY_URL = saved
    }
  })

  test('http to loopback is allowed (the dev gateway)', async () => {
    const saved = process.env.RAYU_GATEWAY_URL
    process.env.RAYU_GATEWAY_URL = 'http://127.0.0.1:8080'
    try {
      const calls = mockHostedSuccess()
      const out = await generateRayuVideo({
        model: withBuilder(HOSTED_VIDEO_MODEL),
        params: { prompt: 'x' },
      })
      expect(out.modelId).toBe(HOSTED_VIDEO_MODEL.id)
      expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/videos/generations')
    } finally {
      if (saved === undefined) delete process.env.RAYU_GATEWAY_URL
      else process.env.RAYU_GATEWAY_URL = saved
    }
  })
})
