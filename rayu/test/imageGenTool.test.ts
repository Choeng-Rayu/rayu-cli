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
  defaultImageModelId,
  IMAGE_BODY_BUILDERS,
  isVertexImageModel,
  retainKnownImageModel,
  sizeFromParams,
  withBuilder,
} from '../src/tools/ImageGenTool/models.ts'
import {
  generateRayuImage,
  RAYU_IMAGE_TIMEOUT_MS,
} from '../src/tools/ImageGenTool/rayuImageClient.ts'
import {
  _resetRayuImageAvailabilityForTesting,
  ImageGenTool,
  resolveOutputPath,
  selectHostedGenerateModel,
} from '../src/tools/ImageGenTool/ImageGenTool.ts'
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

// A fetched-style catalog: exactly the shape services/rayuAuth/mediaModels.ts
// produces from GET /v1/models?media=image. Nothing about image models is
// hardcoded in the CLI any more, so every test drives the resolver with this.
// Vertex Imagen is the only bring-your-own image backend; NVIDIA was removed.
const IMAGE_CATALOG: MediaModelEntry[] = [
  {
    id: 'imagen-4.0-generate-001',
    label: 'Imagen 4',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'vertex',
    family: 'imagen',
    isDefault: true,
  },
  {
    id: 'imagen-4.0-fast-generate-001',
    label: 'Imagen 4 Fast',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'vertex',
    family: 'imagen',
  },
  {
    id: 'imagen-3.0-capability-001',
    label: 'Imagen 3 Capability',
    mediaType: 'image',
    capabilities: ['edit'],
    backend: 'vertex',
    family: 'imagen',
    isDefault: true,
  },
]

function catalog(image = IMAGE_CATALOG): MediaCatalog {
  return { image, video: [], source: 'gateway', fetchedAt: Date.now() }
}

/** Install the fetched catalog so no test depends on a real gateway or on disk. */
function useCatalog(image = IMAGE_CATALOG): void {
  _setMediaModelsForTesting(catalog(image))
}

const VERTEX_IMAGE_MODEL = 'imagen-4.0-generate-001'
const VERTEX_EDIT_MODEL = 'imagen-3.0-capability-001'
/** An id the CLI used to serve through NVIDIA genai; it is no longer routable. */
const RETIRED_NVIDIA_MODEL = 'black-forest-labs/flux.1-schnell'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  _resetMediaModelsForTesting()
})

/**
 * Model-pinning env vars are OVERRIDES, so a value in the developer's .env (bun
 * loads it automatically) would decide these assertions instead of the catalog.
 * Clear them for the resolution tests and exercise them in dedicated ones.
 */
const MODEL_ENV_VARS = [
  'NVIDIA_IMAGE_MODEL',
  'NVIDIA_EDIT_MODEL',
  'VERTEX_IMAGE_MODEL',
  'VERTEX_EDIT_MODEL',
] as const
let savedModelEnv: Record<string, string | undefined> = {}
// Nothing in the resolution/client tests may touch the developer's real ~/.rayu:
// the catalog cache is user-bound, so reading a real session id there would make
// these assertions depend on who is logged in.
let savedConfigDir: string | undefined
let isolatedCfgDir: string

function isolateConfigDir(): void {
  savedConfigDir = process.env.RAYU_CONFIG_DIR
  isolatedCfgDir = mkdtempSync(join(tmpdir(), 'rayu-imgres-'))
  process.env.RAYU_CONFIG_DIR = isolatedCfgDir
}

function restoreConfigDir(): void {
  rmSync(isolatedCfgDir, { recursive: true, force: true })
  if (savedConfigDir === undefined) delete process.env.RAYU_CONFIG_DIR
  else process.env.RAYU_CONFIG_DIR = savedConfigDir
}

/**
 * Auth files (rayu-auth.json, providers.json) live in RAYU_AUTH_CONFIG_DIR,
 * which outranks RAYU_CONFIG_DIR. An editor/agent host may set it, in which
 * case a test that only redirects RAYU_CONFIG_DIR silently reads the
 * developer's REAL session and API keys. Every test here redirects both.
 */
let savedAuthDir: string | undefined

function isolateAuthDir(dir: string): void {
  savedAuthDir = process.env.RAYU_AUTH_CONFIG_DIR
  process.env.RAYU_AUTH_CONFIG_DIR = dir
}

function restoreAuthDir(): void {
  if (savedAuthDir === undefined) delete process.env.RAYU_AUTH_CONFIG_DIR
  else process.env.RAYU_AUTH_CONFIG_DIR = savedAuthDir
}

function clearModelEnv(): void {
  savedModelEnv = {}
  for (const k of MODEL_ENV_VARS) {
    savedModelEnv[k] = process.env[k]
    delete process.env[k]
  }
}

function restoreModelEnv(): void {
  for (const [k, v] of Object.entries(savedModelEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe('image model resolution (server-owned catalog)', () => {
  beforeEach(() => {
    isolateConfigDir()
    useCatalog()
    clearModelEnv()
  })
  afterEach(() => {
    restoreModelEnv()
    restoreConfigDir()
  })

  test('NVIDIA request families are gone: a FLUX/SD/Kontext row cannot be built', () => {
    // The CLI no longer carries NVIDIA genai request shapes. A row that still
    // names one (an old cache, a hand-edited catalog) fails with the named
    // "update the CLI" error instead of reaching an NVIDIA host.
    for (const family of ['flux', 'sd3', 'kontext']) {
      expect(family in IMAGE_BODY_BUILDERS).toBe(false)
    }
    expect(() =>
      withBuilder({
        id: RETIRED_NVIDIA_MODEL,
        label: 'FLUX.1 Schnell',
        mediaType: 'image',
        capabilities: ['generate'],
        backend: 'rayu',
        family: 'flux',
      }),
    ).toThrow(/request family "flux"/)
  })

  test('an unknown request family fails with an actionable, named error', () => {
    expect(() =>
      withBuilder({
        id: 'some/new-model',
        label: 'New',
        mediaType: 'image',
        capabilities: ['generate'],
        backend: 'rayu',
        family: 'diffusion-x9',
      }),
    ).toThrow(/diffusion-x9/)
  })

  test('retainKnownImageModel drops a stale remembered selection', () => {
    // A model chosen weeks ago via /model_image_generation and since removed must
    // not fail every generation — it is dropped so the default applies.
    expect(retainKnownImageModel(IMAGE_CATALOG, 'gone/forever')).toBeUndefined()
    expect(retainKnownImageModel(IMAGE_CATALOG, VERTEX_IMAGE_MODEL)).toBe(
      VERTEX_IMAGE_MODEL,
    )
    expect(retainKnownImageModel(IMAGE_CATALOG, undefined)).toBeUndefined()
    // A remembered NVIDIA id is dropped too: no catalog serves it any more.
    expect(retainKnownImageModel(IMAGE_CATALOG, RETIRED_NVIDIA_MODEL)).toBeUndefined()
    // A hand-written Vertex id is kept: the Vertex client honours it verbatim, so
    // a brand-new Google model works before the dashboard has it.
    expect(retainKnownImageModel(IMAGE_CATALOG, 'imagen-5.0-generate-001')).toBe(
      'imagen-5.0-generate-001',
    )
  })

  test('backend filter picks the per-backend default', () => {
    expect(defaultImageModelId(IMAGE_CATALOG, 'vertex', false)).toBe(
      VERTEX_IMAGE_MODEL,
    )
    expect(defaultImageModelId(IMAGE_CATALOG, 'vertex', true)).toBe(
      VERTEX_EDIT_MODEL,
    )
    expect(defaultImageModelId(IMAGE_CATALOG, 'nvidia', false)).toBeUndefined()
  })

  test('VERTEX_IMAGE_MODEL pins the Vertex default; NVIDIA_IMAGE_MODEL is ignored', () => {
    process.env.NVIDIA_IMAGE_MODEL = 'imagen-4.0-fast-generate-001'
    expect(defaultImageModelId(IMAGE_CATALOG, 'vertex', false)).toBe(
      VERTEX_IMAGE_MODEL,
    )
    process.env.VERTEX_IMAGE_MODEL = 'imagen-4.0-fast-generate-001'
    expect(defaultImageModelId(IMAGE_CATALOG, 'vertex', false)).toBe(
      'imagen-4.0-fast-generate-001',
    )
    // A pin naming a model that is not in the catalog is ignored.
    process.env.VERTEX_IMAGE_MODEL = 'gone/forever'
    expect(defaultImageModelId(IMAGE_CATALOG, 'vertex', false)).toBe(
      VERTEX_IMAGE_MODEL,
    )
  })

  test('isVertexImageModel reads the catalog backend, not the id', () => {
    // A vertex-backed model whose id looks nothing like "imagen-*".
    const odd: MediaModelEntry = {
      id: 'google/some-future-image-model',
      label: 'Future',
      mediaType: 'image',
      capabilities: ['generate'],
      backend: 'vertex',
      family: 'imagen',
    }
    expect(isVertexImageModel(odd.id, [...IMAGE_CATALOG, odd])).toBe(true)
    expect(isVertexImageModel(RETIRED_NVIDIA_MODEL, IMAGE_CATALOG)).toBe(false)
    expect(isVertexImageModel(undefined, IMAGE_CATALOG)).toBe(false)
  })
})

describe('ImageGenTool scaffold', () => {
  test('schema rejects empty prompt, accepts valid prompt', () => {
    expect(ImageGenTool.inputSchema.safeParse({ prompt: '' }).success).toBe(false)
    expect(ImageGenTool.inputSchema.safeParse({ prompt: 'a cat' }).success).toBe(
      true,
    )
  })

  test('resolveOutputPath accepts default, rejects outside cwd', () => {
    expect(resolveOutputPath(undefined).ok).toBe(true)
    expect(resolveOutputPath('/etc/passwd.png').ok).toBe(false)
    expect(resolveOutputPath('../escape.png').ok).toBe(false)
  })

  test('checkPermissions passes through with an allow-rule suggestion', async () => {
    const r = await ImageGenTool.checkPermissions({ prompt: 'x' } as never)
    expect(r.behavior).toBe('passthrough')
  })})

/** Env that would turn on Vertex Imagen; cleared so routing is deterministic. */
const VERTEX_ENV_VARS = [
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_VERTEX_PROJECT_ID',
] as const

describe('ImageGenTool with no hosted session and no Vertex', () => {
  let dir: string
  let tmp: string
  let savedVertexEnv: Record<string, string | undefined> = {}
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-img-'))
    tmp = mkdtempSync(join(tmpdir(), 'rayu-imgcall-'))
    process.env.RAYU_CONFIG_DIR = dir
    isolateAuthDir(dir)
    savedVertexEnv = {}
    for (const k of VERTEX_ENV_VARS) {
      savedVertexEnv[k] = process.env[k]
      delete process.env[k]
    }
    // An NVIDIA key is the one thing that used to enable image generation here.
    process.env.NVIDIA_API_KEY = 'nv-x'
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    _resetRayuConfigCache()
    _resetRayuImageAvailabilityForTesting()
    useCatalog()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    restoreAuthDir()
    _resetRayuImageAvailabilityForTesting()
    delete process.env.NVIDIA_API_KEY
    for (const [k, v] of Object.entries(savedVertexEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test('an NVIDIA key no longer enables the tool or the commands', async () => {
    expect(ImageGenTool.isEnabled()).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generate: any = (await import('../src/commands/generate-image.ts')).default
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edit: any = (await import('../src/commands/image-editor.ts')).default
    expect(generate.isEnabled()).toBe(false)
    expect(edit.isEnabled()).toBe(false)
  })

  test('a call is refused with a sign-in hint and never reaches a network', async () => {
    let fetched = 0
    globalThis.fetch = (async () => {
      fetched++
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch

    await expect(
      runWithCwdOverride(tmp, () =>
        ImageGenTool.call(
          { prompt: 'a cat', output_path: './out.png' } as never,
          {
            abortController: new AbortController(),
            options: { isNonInteractiveSession: true },
          } as never,
        ),
      ),
    ).rejects.toThrow(/Rayu sign-in \(\/login\).*Vertex AI/)
    expect(fetched).toBe(0)
  })

  test('rejects output_path outside the working directory', async () => {
    await expect(
      runWithCwdOverride(tmp, () =>
        ImageGenTool.call(
          { prompt: 'x', output_path: '/etc/evil.png' } as never,
          { abortController: new AbortController() } as never,
        ),
      ),
    ).rejects.toThrow(/working directory/)
  })
})

// 1x1 transparent PNG (valid IHDR so pngDimensions works).
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('terminal image rendering', () => {
  test('decodeImage decodes a JPEG to RGBA dimensions', async () => {
    const { encode: encodeJpeg } = await import('jpeg-js')
    const { decodeImage } = await import(
      '../src/tools/ImageGenTool/terminalImage.ts'
    )
    const jpg = encodeJpeg(
      { data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1 },
      90,
    )
    const img = decodeImage(Buffer.from(jpg.data), 'image/jpeg')
    expect(img?.width).toBe(2)
    expect(img?.height).toBe(1)
    expect(img?.data.length).toBe(8)
  })

  test('imageToAnsiLines emits truecolor half-block rows', async () => {
    const { imageToAnsiLines } = await import(
      '../src/tools/ImageGenTool/terminalImage.ts'
    )
    const { lines, width } = imageToAnsiLines(
      { width: 1, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) },
      1,
    )
    expect(width).toBe(1)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('▀')
    expect(lines[0]).toContain('\x1b[38;2;255;0;0m')
    expect(lines[0]).toContain('\x1b[48;2;0;0;255m')
    expect(lines[0].endsWith('\x1b[0m')).toBe(true)
  })
})

describe('ImageGenTool UI', () => {
  test('renderToolUseMessage shows the prompt', () => {
    expect(
      ImageGenTool.renderToolUseMessage({ prompt: 'a cat' } as never),
    ).toBe('a cat')
  })

  test('renderToolResultMessage returns a React element', () => {
    const el = ImageGenTool.renderToolResultMessage?.({
      path: '/x/out.png',
      model: 'm',
      width: 10,
      height: 20,
      mediaType: 'image/png',
      base64: '',
    } as never)
    expect(React.isValidElement(el)).toBe(true)
  })
})

describe('/generate-image command', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-cmd-'))
    process.env.RAYU_CONFIG_DIR = dir
    isolateAuthDir(dir)
    _resetRayuImageAvailabilityForTesting()
    delete process.env.NVIDIA_API_KEY
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    restoreAuthDir()
    _resetRayuImageAvailabilityForTesting()
    delete process.env.NVIDIA_API_KEY
  })

  test('is a prompt command whose prompt invokes GenerateImage', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd: any = (await import('../src/commands/generate-image.ts')).default
    expect(cmd.name).toBe('generate-image')
    expect(cmd.type).toBe('prompt')
    expect(cmd.description).not.toMatch(/nvidia/i)
    const blocks = await cmd.getPromptForCommand('a red sports car')
    expect(blocks[0].text).toContain('a red sports car')
    expect(blocks[0].text).toContain('GenerateImage')
  })

  test('is gated on Vertex when signed out', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd: any = (await import('../src/commands/generate-image.ts')).default
    const saved = process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_CLOUD_PROJECT
    try {
      _resetRayuConfigCache()
      expect(cmd.isEnabled()).toBe(false)
      process.env.GOOGLE_CLOUD_PROJECT = 'test-proj'
      _resetRayuConfigCache()
      expect(cmd.isEnabled()).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_CLOUD_PROJECT
      else process.env.GOOGLE_CLOUD_PROJECT = saved
    }
  })
})

// ── Rayu-hosted image models ─────────────────────────────────────────────────
// The gateway synthesizes these from the admin's `image_models` catalog:
// backend 'rayu' + family 'openai_images'. No BYO key is involved; the user's
// Rayu JWT authorizes the request and the gateway bills per image.
const HOSTED_IMAGE_MODEL: MediaModelEntry = {
  id: 'rayu-qwen-image-3.0',
  label: 'Qwen Image 3.0',
  mediaType: 'image',
  capabilities: ['generate'],
  backend: 'rayu',
  family: 'openai_images',
  defaultParams: { prompt_extend: true, watermark: false },
  isDefault: true,
}

// The updated catalog advertises edit-capable hosted image entries (Qwen Image
// 3.0, family dashscope_multimodal) with capabilities ["generate", "edit"];
// openai_images entries stay ["generate"].
const HOSTED_EDIT_MODEL: MediaModelEntry = {
  id: 'rayu-qwen-image-3.0-edit',
  label: 'Qwen Image 3.0 (edit)',
  mediaType: 'image',
  capabilities: ['generate', 'edit'],
  backend: 'rayu',
  family: 'dashscope_multimodal',
  defaultParams: { prompt_extend: true, watermark: false },
}

describe('hosted image edit bodies (openai_images / dashscope_multimodal)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-imgedit-'))
    isolateConfigDir()
    clearModelEnv()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    restoreModelEnv()
    restoreConfigDir()
  })

  function editBuilder(defaults: Record<string, unknown> = {}) {
    return withBuilder({ ...HOSTED_EDIT_MODEL, defaultParams: defaults })
  }

  test('dashscope_multimodal is a known request family', () => {
    expect(withBuilder(HOSTED_EDIT_MODEL).buildBody({ prompt: 'x' }).prompt).toBe('x')
  })

  test('a local PNG path becomes a data:image/png;base64 URL', () => {
    const p = join(dir, 'ref.png')
    writeFileSync(p, Buffer.from(TINY_PNG_B64, 'base64'))
    const body = editBuilder().buildBody({ prompt: 'x', input_image: p })
    expect(String(body.image)).toBe(`data:image/png;base64,${TINY_PNG_B64}`)
  })

  test('an https URL passes through unchanged', () => {
    const url = 'https://example.com/i.png'
    const body = editBuilder().buildBody({ prompt: 'x', input_image: url })
    expect(body.image).toBe(url)
  })

  test('an http:// reference URL is refused with an https-only message', () => {
    expect(() =>
      editBuilder().buildBody({ prompt: 'x', input_image: 'http://example.com/i.png' }),
    ).toThrow(/must use https/)
  })

  test('a local file over 12 MiB is refused before sending', () => {
    const p = join(dir, 'big.png')
    writeFileSync(p, Buffer.alloc(12 * 1024 * 1024 + 1, 0x89))
    expect(() => editBuilder().buildBody({ prompt: 'x', input_image: p })).toThrow(
      /too large/,
    )
  })

  test('a file at the decoded cap is refused when the ENCODED body would overflow', () => {
    // 12 MiB base64-inflates to EXACTLY 16 MiB — over the gateway body limit
    // once the data-URI prefix + JSON + prompt are added. Same ceiling the
    // video path enforces (shared helper).
    const p = join(dir, 'edge.png')
    writeFileSync(p, Buffer.alloc(12 * 1024 * 1024, 0x89))
    expect(() => editBuilder().buildBody({ prompt: 'x', input_image: p })).toThrow(
      /gateway request body/,
    )
  })

  test('an unreadable local path errors clearly', () => {
    expect(() =>
      editBuilder().buildBody({ prompt: 'x', input_image: join(dir, 'gone.png') }),
    ).toThrow(/not found or unreadable/)
  })

  test('defaultParams cannot smuggle image or mask', () => {
    // Routing/edit keys are stripped from the defaults; the caller's image is
    // added AFTER the spread, so a rogue default cannot smuggle one when the
    // caller supplied none — nor override the one they did.
    const smuggled = editBuilder({
      image: 'https://evil.example/smuggled.png',
      mask: 'https://evil.example/m.png',
    }).buildBody({ prompt: 'x' })
    expect('image' in smuggled).toBe(false)
    expect('mask' in smuggled).toBe(false)

    const caller = editBuilder({
      image: 'https://evil.example/smuggled.png',
    }).buildBody({ prompt: 'x', input_image: 'https://ok.example/i.png' })
    expect(caller.image).toBe('https://ok.example/i.png')
  })

  test('a generate request never carries an edit field', () => {
    // No input_image, no leaked base64 `image` param — the hosted body stays
    // exactly the generation shape.
    const body = editBuilder().buildBody({ prompt: 'x', image: 'must-not-leak' })
    expect('image' in body).toBe(false)
  })
})

describe('openai_images family (Rayu-hosted)', () => {
  beforeEach(() => {
    isolateConfigDir()
    clearModelEnv()
  })
  afterEach(() => {
    restoreModelEnv()
    restoreConfigDir()
  })

  test('buildBody spreads defaults and never forwards an edit payload', () => {
    const m = withBuilder(HOSTED_IMAGE_MODEL)
    const body = m.buildBody({ prompt: 'a cat', image: 'must-not-leak' })
    expect(body.prompt).toBe('a cat')
    expect(body.n).toBe(1)
    // Dashboard defaults survive the merge...
    expect(body.prompt_extend).toBe(true)
    expect(body.watermark).toBe(false)
    // ...but generation never carries an edit field, even if one leaked in.
    expect('image' in body).toBe(false)
    expect('mask' in body).toBe(false)
    // No size hint -> omitted, so the gateway applies the model's default_size.
    expect('size' in body).toBe(false)
  })

  test('sizeFromParams maps width/height and aspect ratios', () => {
    expect(sizeFromParams({ prompt: 'x', width: 768, height: 512 })).toBe('768x512')
    expect(sizeFromParams({ prompt: 'x', aspect_ratio: '1:1' })).toBe('1024x1024')
    expect(sizeFromParams({ prompt: 'x', aspect_ratio: '16:9' })).toBe('1024x576')
    expect(sizeFromParams({ prompt: 'x', aspect_ratio: '9:16' })).toBe('576x1024')
    // Extreme ratios clamp the short side to 512.
    expect(sizeFromParams({ prompt: 'x', aspect_ratio: '4:1' })).toBe('1024x512')
    expect(sizeFromParams({ prompt: 'x', aspect_ratio: '1:4' })).toBe('512x1024')
    // No hint, or an unparseable one, is omitted rather than thrown.
    expect(sizeFromParams({ prompt: 'x' })).toBeUndefined()
    expect(sizeFromParams({ prompt: 'x', aspect_ratio: 'wide' })).toBeUndefined()
    expect(sizeFromParams({ prompt: 'x', aspect_ratio: '0:0' })).toBeUndefined()
  })

  test('buildBody forwards negative_prompt, seed, and the derived size', () => {
    const m = withBuilder(HOSTED_IMAGE_MODEL)
    const body = m.buildBody({
      prompt: 'x',
      aspect_ratio: '16:9',
      negative_prompt: 'blurry',
      seed: 7,
    })
    expect(body.size).toBe('1024x576')
    expect(body.negative_prompt).toBe('blurry')
    expect(body.seed).toBe(7)
  })

  test('defaultParams cannot smuggle in model or response_format', () => {
    // A dashboard row is admin-controlled data, not a routing surface: it must
    // never be able to replace the model the caller selected, nor change how the
    // gateway returns the bytes (a `url` reply is an extra host to trust).
    const rogue = withBuilder({
      ...HOSTED_IMAGE_MODEL,
      defaultParams: {
        model: 'some-other-upstream-model',
        response_format: 'url',
        stream: true,
        prompt_extend: true,
      },
    })
    const body = rogue.buildBody({ prompt: 'x' })
    expect('model' in body).toBe(false)
    expect('response_format' in body).toBe(false)
    // The gateway rejects an image `stream`, so a stray default would 400.
    expect('stream' in body).toBe(false)
    // Ordinary knobs still flow through.
    expect(body.prompt_extend).toBe(true)
  })
})

describe('generateRayuImage client (hosted)', () => {
  let cfgDir: string
  let savedOAuth: string | undefined

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
      features: { image_generation: { enabled: true } },
      allowedModels: free
        ? []
        : [{ code: HOSTED_IMAGE_MODEL.id, label: 'Qwen', creditMultiplier: 1 }],
      hostedModels: [
        { code: HOSTED_IMAGE_MODEL.id, label: 'Qwen', creditMultiplier: 1 },
      ],
      userId: null,
    }
  }

  /**
   * Replace fetch with a gateway handler. Session/entitlement/usage background
   * refreshes are answered with a harmless 404 and NOT recorded, so assertions
   * only ever see the image requests under test.
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

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'rayu-rayuimg-'))
    process.env.RAYU_CONFIG_DIR = cfgDir
    isolateAuthDir(cfgDir)
    savedOAuth = process.env.USE_RAYU_OAUTH
    process.env.USE_RAYU_OAUTH = 'true'
    writeSignedInSession()
    _setRayuEntitlementsForTesting(entitlements())
    _setFeatureUsageForTesting({ image_generation: { used: 0, limit: null } })
    _resetRayuImageAvailabilityForTesting()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    _resetRayuEntitlementsForTesting()
    _resetFeatureUsageForTesting()
    _resetRayuImageAvailabilityForTesting()
    rmSync(cfgDir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    restoreAuthDir()
    if (savedOAuth === undefined) delete process.env.USE_RAYU_OAUTH
    else process.env.USE_RAYU_OAUTH = savedOAuth
  })

  test('POSTs the OpenAI Images body with the JWT and decodes b64_json', async () => {
    const calls = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            created: 1,
            data: [{ b64_json: TINY_PNG_B64, revised_prompt: 'a cat' }],
            usage: { images: 1 },
            rayu: { images: 1, billableTokens: 1200, tokensPerCredit: 1000 },
          }),
          { status: 200 },
        ),
    )

    const out = await generateRayuImage({
      model: withBuilder(HOSTED_IMAGE_MODEL),
      params: { prompt: 'a cat', aspect_ratio: '16:9' },
    })

    expect(out.buffer.length).toBeGreaterThan(0)
    expect(out.mediaType).toBe('image/png')
    expect(out.modelId).toBe(HOSTED_IMAGE_MODEL.id)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/v1/images/generations')
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-token')
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body.model).toBe(HOSTED_IMAGE_MODEL.id)
    expect(body.prompt).toBe('a cat')
    expect(body.n).toBe(1)
    expect(body.size).toBe('1024x576')
    // The gateway inlines the bytes; it is what makes one round-trip enough.
    expect(body.response_format).toBe('b64_json')
    expect(body.prompt_extend).toBe(true)
  })

  test("counts the gateway's charge toward the turn's credits", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            created: 1,
            data: [{ b64_json: TINY_PNG_B64 }],
            rayu: { images: 1, billableTokens: 1200, tokensPerCredit: 1000 },
          }),
          { status: 200 },
        ),
    )
    const mark = markRayuCharges()
    await generateRayuImage({
      model: withBuilder(HOSTED_IMAGE_MODEL),
      params: { prompt: 'a cat' },
    })
    // 1200 billable tokens at 1000 per credit: what the turn line adds.
    expect(rayuCreditsSince(mark)).toBe(1.2)
  })

  test('an older gateway that reports no charge adds nothing', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }),
          { status: 200 },
        ),
    )
    const mark = markRayuCharges()
    await generateRayuImage({
      model: withBuilder(HOSTED_IMAGE_MODEL),
      params: { prompt: 'a cat' },
    })
    expect(rayuCreditsSince(mark)).toBeUndefined()
  })

  test('falls back to downloading data[0].url with redirect:error', async () => {
    const calls = mockFetch((url) => {
      if (url === 'https://images.example/generated.png') {
        return new Response(new Uint8Array(Buffer.from(TINY_PNG_B64, 'base64')), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      return new Response(
        JSON.stringify({
          created: 1,
          data: [{ url: 'https://images.example/generated.png' }],
        }),
        { status: 200 },
      )
    })

    const out = await generateRayuImage({
      model: withBuilder(HOSTED_IMAGE_MODEL),
      params: { prompt: 'x' },
    })

    expect(out.buffer.length).toBeGreaterThan(0)
    expect(out.mediaType).toBe('image/png')
    const download = calls.find((c) => c.url === 'https://images.example/generated.png')
    expect(download).toBeDefined()
    // Off-host redirects must be refused outright.
    expect(download?.init?.redirect).toBe('error')
  })

  test('maps a gateway {error:{message}} to a clear Error', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { message: 'image_generation is not enabled for this plan' },
          }),
          { status: 403 },
        ),
    )
    await expect(
      generateRayuImage({
        model: withBuilder(HOSTED_IMAGE_MODEL),
        params: { prompt: 'x' },
      }),
    ).rejects.toThrow(/403.*image_generation/)
  })

  test('a plan with no hosted access throws the upgrade message first', async () => {
    _setRayuEntitlementsForTesting(entitlements({ free: true }))
    const calls = mockFetch(() => {
      throw new Error('must not reach the gateway')
    })
    await expect(
      generateRayuImage({
        model: withBuilder(HOSTED_IMAGE_MODEL),
        params: { prompt: 'x' },
      }),
    ).rejects.toThrow(/paid feature/i)
    expect(calls).toHaveLength(0)
  })

  test('a response with no image data is an error, not an empty buffer', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ created: 1, data: [] }), { status: 200 }),
    )
    await expect(
      generateRayuImage({
        model: withBuilder(HOSTED_IMAGE_MODEL),
        params: { prompt: 'x' },
      }),
    ).rejects.toThrow(/no image/)
  })

  test('the selected model and response_format survive hostile defaults', async () => {
    // The client sets both AFTER the family body spread, so even a builder that
    // somehow forwarded them cannot change which model is billed or how the
    // image comes back.
    const rogue = withBuilder({
      ...HOSTED_IMAGE_MODEL,
      id: 'rayu-selected-model',
      defaultParams: {
        model: 'hijacked/upstream-model',
        response_format: 'url',
      },
    })
    const calls = mockFetch(
      () =>
        new Response(
          JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }),
          { status: 200 },
        ),
    )

    const out = await generateRayuImage({ model: rogue, params: { prompt: 'x' } })

    expect(out.modelId).toBe('rayu-selected-model')
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body.model).toBe('rayu-selected-model')
    expect(body.response_format).toBe('b64_json')
  })

  test('the client timeout waits past the gateway 240s failover budget', () => {
    // Aborting before the gateway is done can bill an image the user never sees.
    expect(RAYU_IMAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(240_000)
  })
})

describe('hosted default selection', () => {
  test('skips an edit-only hosted entry', () => {
    const editOnly: MediaModelEntry = {
      id: 'rayu-edit-only',
      label: 'Hosted Edit',
      mediaType: 'image',
      capabilities: ['edit'],
      backend: 'rayu',
      family: 'openai_images',
      isDefault: true,
    }
    // The edit entry is FIRST and flagged default, but a plain generate request
    // cannot use it — picking it would send a request the gateway rejects.
    expect(
      selectHostedGenerateModel([editOnly, HOSTED_IMAGE_MODEL])?.id,
    ).toBe(HOSTED_IMAGE_MODEL.id)
  })

  test('prefers isDefault among generate-capable hosted entries', () => {
    const other: MediaModelEntry = {
      ...HOSTED_IMAGE_MODEL,
      id: 'rayu-other-generate',
      label: 'Other',
      isDefault: false,
    }
    const flagged: MediaModelEntry = { ...HOSTED_IMAGE_MODEL, id: 'rayu-flagged' }
    // Server order puts `other` first; the default flag still wins.
    expect(selectHostedGenerateModel([other, flagged])?.id).toBe('rayu-flagged')
  })

  test('falls back to server order when no hosted entry is flagged default', () => {
    const first: MediaModelEntry = {
      ...HOSTED_IMAGE_MODEL,
      id: 'rayu-first',
      isDefault: false,
    }
    const second: MediaModelEntry = {
      ...HOSTED_IMAGE_MODEL,
      id: 'rayu-second',
      isDefault: false,
    }
    expect(selectHostedGenerateModel([first, second])?.id).toBe('rayu-first')
  })

  test('ignores BYO models and yields undefined with no hosted generate model', () => {
    expect(selectHostedGenerateModel(IMAGE_CATALOG)).toBeUndefined()
    const editOnly: MediaModelEntry = {
      id: 'rayu-edit-only',
      label: 'Hosted Edit',
      mediaType: 'image',
      capabilities: ['edit'],
      backend: 'rayu',
      family: 'openai_images',
    }
    expect(selectHostedGenerateModel([...IMAGE_CATALOG, editOnly])).toBeUndefined()
  })
})

describe('ImageGenTool hosted routing', () => {
  let tmp: string
  let cfgDir: string
  let savedOAuth: string | undefined

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

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'rayu-imgrayu-'))
    cfgDir = mkdtempSync(join(tmpdir(), 'rayu-imgrayucfg-'))
    process.env.RAYU_CONFIG_DIR = cfgDir
    isolateAuthDir(cfgDir)
    savedOAuth = process.env.USE_RAYU_OAUTH
    process.env.USE_RAYU_OAUTH = 'true'
    // Hosted-only: no BYO key of any kind.
    delete process.env.NVIDIA_API_KEY
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    _resetRayuConfigCache()
    writeSignedInSession()
    _setRayuEntitlementsForTesting({
      plan: { code: 'pro', name: 'Pro', priceCents: 900, availability: 'public' },
      maxDailyTurns: null,
      features: { image_generation: { enabled: true } },
      allowedModels: [
        { code: HOSTED_IMAGE_MODEL.id, label: 'Qwen', creditMultiplier: 1 },
      ],
      hostedModels: [
        { code: HOSTED_IMAGE_MODEL.id, label: 'Qwen', creditMultiplier: 1 },
      ],
      userId: null,
    })
    _setFeatureUsageForTesting({ image_generation: { used: 0, limit: null } })
    _resetRayuImageAvailabilityForTesting()
    useCatalog([...IMAGE_CATALOG, HOSTED_IMAGE_MODEL])
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    _resetRayuEntitlementsForTesting()
    _resetFeatureUsageForTesting()
    _resetRayuImageAvailabilityForTesting()
    rmSync(tmp, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    restoreAuthDir()
    delete process.env.NVIDIA_API_KEY
    delete process.env.GOOGLE_CLOUD_PROJECT
    const v = await import('../src/services/api/gemini/vertexAuth.ts')
    v._setVertexTokenSourcesForTesting(null)
    v._resetVertexAuthCacheForTesting()
    if (savedOAuth === undefined) delete process.env.USE_RAYU_OAUTH
    else process.env.USE_RAYU_OAUTH = savedOAuth
  })

  test('isEnabled is true for a signed-in user with NO provider key', () => {
    expect(ImageGenTool.isEnabled()).toBe(true)
  })

  test('isEnabled stays false when signed out and no key exists', () => {
    rmSync(join(cfgDir, 'rayu-auth.json'), { force: true })
    delete process.env.USE_RAYU_OAUTH
    _resetRayuImageAvailabilityForTesting()
    expect(ImageGenTool.isEnabled()).toBe(false)
  })

  test('a hosted-only user generates through the gateway and saves a PNG', async () => {
    const calls = mockFetch((url) => {
      if (!url.includes('/v1/images/generations')) {
        throw new Error(`unexpected fetch: ${url}`)
      }
      return new Response(
        JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }),
        { status: 200 },
      )
    })

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        {
          prompt: 'a red apple',
          output_path: './hosted.png',
          width: 768,
          height: 512,
        },
        {
          abortController: new AbortController(),
          options: { isNonInteractiveSession: true },
        } as never,
      ),
    )

    expect(existsSync(join(tmp, 'hosted.png'))).toBe(true)
    // Atomic write: no temp sibling survives next to the result.
    const { readdirSync } = await import('fs')
    expect(readdirSync(tmp).filter((f) => f.includes('rayu-tmp'))).toHaveLength(0)
    expect(res.data.model).toBe(HOSTED_IMAGE_MODEL.id)
    expect(res.data.width).toBe(1)
    expect(res.data.height).toBe(1)
    // Every request went to the gateway — never a BYO host.
    expect(calls.length).toBe(1)
    expect(calls[0].url).toContain('/v1/images/generations')
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body.model).toBe(HOSTED_IMAGE_MODEL.id)
    expect(body.response_format).toBe('b64_json')
    expect(body.size).toBe('768x512')

    // The model sees the image inline next to the saved path.
    const block = ImageGenTool.mapToolResultToToolResultBlockParam(res.data, 'tid')
    const content = block.content as Array<{ type: string }>
    expect(content.some((b) => b.type === 'image')).toBe(true)
    expect(content.some((b) => b.type === 'text')).toBe(true)
  })

  test('/image-editor is offered to a signed-in user with no provider key', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd: any = (await import('../src/commands/image-editor.ts')).default
    expect(cmd.isEnabled()).toBe(true)
    expect(cmd.description).not.toMatch(/nvidia/i)
  })

  test('a generate-only hosted model refuses input_image by name', async () => {
    writeFileSync(join(tmp, 'in.png'), Buffer.from(TINY_PNG_B64, 'base64'))
    const calls = mockFetch(() => {
      throw new Error('must not reach the network')
    })

    // The remembered/default hosted entry (HOSTED_IMAGE_MODEL) is generate-only:
    // the refusal names it and tells the caller what to do — no silent swap to
    // an edit-capable hosted model.
    await expect(
      runWithCwdOverride(tmp, () =>
        ImageGenTool.call(
          {
            prompt: 'make it blue',
            input_image: './in.png',
            output_path: './out.png',
          },
          {
            abortController: new AbortController(),
            options: { isNonInteractiveSession: true },
          } as never,
        ),
      ),
    ).rejects.toThrow(
      'Hosted image model "rayu-qwen-image-3.0" is generate-only — pick a ' +
        'model that supports edit, or remove input_image.',
    )
    expect(calls).toHaveLength(0)
  })

  test('an edit-capable hosted model edits a local PNG via the gateway', async () => {
    useCatalog([...IMAGE_CATALOG, HOSTED_IMAGE_MODEL, HOSTED_EDIT_MODEL])
    writeFileSync(join(tmp, 'in.png'), Buffer.from(TINY_PNG_B64, 'base64'))
    const calls = mockFetch((url) => {
      if (!url.includes('/v1/images/generations')) {
        throw new Error(`unexpected fetch: ${url}`)
      }
      return new Response(
        JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }),
        { status: 200 },
      )
    })

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        {
          prompt: 'make it blue',
          model: HOSTED_EDIT_MODEL.id,
          input_image: './in.png',
          output_path: './edited.png',
        },
        {
          abortController: new AbortController(),
          options: { isNonInteractiveSession: true },
        } as never,
      ),
    )

    expect(res.data.model).toBe(HOSTED_EDIT_MODEL.id)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/v1/images/generations')
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body.model).toBe(HOSTED_EDIT_MODEL.id)
    expect(body.prompt).toBe('make it blue')
    expect(body.image).toBe(`data:image/png;base64,${TINY_PNG_B64}`)
    expect(body.response_format).toBe('b64_json')
  })

  test('an https input_image passes through verbatim to an edit-capable hosted model', async () => {
    useCatalog([...IMAGE_CATALOG, HOSTED_IMAGE_MODEL, HOSTED_EDIT_MODEL])
    const calls = mockFetch((url) => {
      if (!url.includes('/v1/images/generations')) {
        throw new Error(`unexpected fetch: ${url}`)
      }
      return new Response(
        JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }),
        { status: 200 },
      )
    })

    await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        {
          prompt: 'make it blue',
          model: HOSTED_EDIT_MODEL.id,
          input_image: 'https://example.com/in.png',
          output_path: './edited.png',
        },
        {
          abortController: new AbortController(),
          options: { isNonInteractiveSession: true },
        } as never,
      ),
    )

    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body.image).toBe('https://example.com/in.png')
  })

  // ── Stale-BYO fallback (remembered/default path only) ──────────────────────
  // The remembered selection is persisted across sessions, so it can outlive the
  // credentials it needs. It must fall back to hosted rather than fail.

  function gatewayImageMock(): Array<{ url: string; init?: RequestInit }> {
    return mockFetch((url) => {
      if (!url.includes('/v1/images/generations')) {
        throw new Error(`unexpected fetch: ${url}`)
      }
      return new Response(
        JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }),
        { status: 200 },
      )
    })
  }

  /** A call context that keeps the soft paid gate and output-path checks happy. */
  function ctx() {
    return {
      abortController: new AbortController(),
      options: { isNonInteractiveSession: true },
    } as never
  }

  /** Turn Vertex Imagen on for one test: a GCP project and a fake access token. */
  async function enableVertex(): Promise<void> {
    process.env.GOOGLE_CLOUD_PROJECT = 'test-proj'
    const v = await import('../src/services/api/gemini/vertexAuth.ts')
    v._resetVertexAuthCacheForTesting()
    v._setVertexTokenSourcesForTesting([
      async () => ({ token: 'tok', expiresAtMs: Date.now() + 3600_000 }),
    ])
  }

  /** Answers the gateway with a PNG and Vertex `:predict` with a PNG. */
  function gatewayOrVertexMock(): Array<{ url: string; init?: RequestInit }> {
    return mockFetch((url) => {
      if (url.includes('/v1/images/generations')) {
        return new Response(
          JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }),
          { status: 200 },
        )
      }
      if (url.includes('aiplatform.googleapis.com') && url.includes(':predict')) {
        return new Response(
          JSON.stringify({
            predictions: [{ bytesBase64Encoded: TINY_PNG_B64, mimeType: 'image/png' }],
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  test('a remembered retired NVIDIA model falls back to hosted', async () => {
    // An NVIDIA id saved by an older CLI is no longer servable; an NVIDIA key in
    // the environment must not revive it.
    process.env.NVIDIA_API_KEY = 'nv-x'
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.setImageModelSelection(RETIRED_NVIDIA_MODEL)
    cfg._resetRayuConfigCache()
    const calls = gatewayImageMock()

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        { prompt: 'a cat', output_path: './remembered.png' },
        ctx(),
      ),
    )

    expect(res.data.model).toBe(HOSTED_IMAGE_MODEL.id)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/v1/images/generations')
  })

  test('a remembered Vertex model with no Vertex credentials also falls back', async () => {
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.setImageModelSelection('imagen-4.0-generate-001')
    cfg._resetRayuConfigCache()
    const calls = gatewayImageMock()

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        { prompt: 'a cat', output_path: './vertex-remembered.png' },
        ctx(),
      ),
    )

    expect(res.data.model).toBe(HOSTED_IMAGE_MODEL.id)
    expect(calls[0].url).toContain('/v1/images/generations')
  })

  test('an EXPLICIT Vertex model is honoured, never swapped for the hosted default', async () => {
    await enableVertex()
    const calls = gatewayOrVertexMock()

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        { prompt: 'a cat', model: VERTEX_IMAGE_MODEL, output_path: './explicit.png' },
        ctx(),
      ),
    )

    expect(res.data.model).toBe(VERTEX_IMAGE_MODEL)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain(`/models/${VERTEX_IMAGE_MODEL}:predict`)
  })

  test('a remembered Vertex model is used when Vertex IS configured', async () => {
    await enableVertex()
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg.setImageModelSelection('imagen-4.0-fast-generate-001')
    cfg._resetRayuConfigCache()
    const calls = gatewayOrVertexMock()

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call({ prompt: 'a cat', output_path: './byo.png' }, ctx()),
    )

    expect(res.data.model).toBe('imagen-4.0-fast-generate-001')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('aiplatform.googleapis.com')
  })

  // ── Hosted is the DEFAULT for a signed-in user ─────────────────────────────
  // Regression: with nothing selected, a configured BYO backend used to win, so a
  // signed-in user never reached the gateway and generation failed on the BYO
  // backend instead.

  test('with nothing selected, the hosted model wins over configured Vertex', async () => {
    await enableVertex()
    process.env.NVIDIA_API_KEY = 'nv-x'
    const calls = gatewayOrVertexMock()

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call({ prompt: 'a cat', output_path: './default.png' }, ctx()),
    )

    expect(res.data.model).toBe(HOSTED_IMAGE_MODEL.id)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/v1/images/generations')
  })

  test('an edit with nothing selected uses the hosted edit model over Vertex', async () => {
    await enableVertex()
    useCatalog([...IMAGE_CATALOG, HOSTED_IMAGE_MODEL, HOSTED_EDIT_MODEL])
    writeFileSync(join(tmp, 'in.png'), Buffer.from(TINY_PNG_B64, 'base64'))
    const calls = gatewayOrVertexMock()

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        { prompt: 'make it blue', input_image: './in.png', output_path: './e.png' },
        ctx(),
      ),
    )

    expect(res.data.model).toBe(HOSTED_EDIT_MODEL.id)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body.model).toBe(HOSTED_EDIT_MODEL.id)
    expect(body.image).toBe(`data:image/png;base64,${TINY_PNG_B64}`)
  })

  test('with no hosted model for the operation, configured Vertex still serves it', async () => {
    await enableVertex()
    useCatalog([...IMAGE_CATALOG])
    const calls = gatewayOrVertexMock()

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call({ prompt: 'a cat', output_path: './byo-only.png' }, ctx()),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('aiplatform.googleapis.com')
    expect(res.data.model).toBe(VERTEX_IMAGE_MODEL)
  })

  test('a fallback catalog with no BYO backend names the CATALOG', async () => {
    // The gateway catalog fetch fails (offline / mid-deploy): ensureMediaModels
    // falls back to the BYO-only built-in list, which has no hosted entry to
    // select. The user's real problem is the catalog, so the error says so.
    _resetMediaModelsForTesting()
    const calls = mockFetch(() => new Response('{}', { status: 502 }))

    await expect(
      runWithCwdOverride(tmp, () =>
        ImageGenTool.call(
          { prompt: 'a cat', output_path: './offline.png' },
          ctx(),
        ),
      ),
    ).rejects.toThrow(/Rayu model catalog unavailable/)

    // Only the failed catalog fetch happened; no image request was attempted.
    expect(calls.every((c) => !c.url.includes('/v1/images/generations'))).toBe(
      true,
    )
    expect(calls.every((c) => !c.url.includes('nvidia.com'))).toBe(true)
  })

  test('a gateway catalog with no hosted entry errors clearly too', async () => {
    // Online, but the (gateway-sourced) catalog has only BYO models and the
    // user has no BYO backend: the hosted fallback has nothing to pick, and a
    // clear catalog error beats a misleading credentials error.
    useCatalog([...IMAGE_CATALOG])
    const calls = mockFetch(() => {
      throw new Error('must not reach the network')
    })

    await expect(
      runWithCwdOverride(tmp, () =>
        ImageGenTool.call(
          { prompt: 'a cat', output_path: './nohosted.png' },
          ctx(),
        ),
      ),
    ).rejects.toThrow(/Rayu model catalog unavailable/)
    expect(calls).toHaveLength(0)
  })

  test('PAYG: a funded top-up unlocks hosted gen on a feature-less plan', async () => {
    // The gateway serves image generation from a funded top-up even when the
    // plan lacks the image_generation feature (image_feature_allowed: plan
    // feature OR payg_available). The client must not block what the gateway
    // would serve and bill.
    _setRayuEntitlementsForTesting({
      plan: { code: 'free', name: 'Free', priceCents: 0, availability: 'public' },
      maxDailyTurns: null,
      features: { image_generation: { enabled: false } },
      allowedModels: [],
      hostedModels: [],
      topupBalance: 25,
      userId: null,
    })
    const calls = gatewayImageMock()

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        { prompt: 'a cat', output_path: './payg.png' },
        ctx(),
      ),
    )

    expect(res.data.model).toBe(HOSTED_IMAGE_MODEL.id)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/v1/images/generations')
  })

  // ── Gateway-only invariant: `backend` outranks `family`, always ──────────
  // A hostile or admin-edited catalog row may pair backend 'rayu' with a BYO
  // request family. The family picks the BODY SHAPE only — it must never pick
  // the client or the network target. These tests fail if a fallback path is
  // ever reintroduced that lets a rayu entry reach an NVIDIA/Vertex/fal host.

  const BYO_HOST_PATTERN =
    /ai\.api\.nvidia\.com|nvcf\.nvidia\.com|fal\.run|aiplatform\.googleapis\.com|storage\.googleapis\.com/i

  test('a backend:rayu entry with a retired NVIDIA family is refused before any request', async () => {
    // The family picks the BODY SHAPE only. FLUX is no longer a shape this CLI
    // can build, so the row fails with the named "update the CLI" error — it is
    // never sent to the gateway with a guessed body, and never to a BYO host.
    const hostile: MediaModelEntry = {
      id: 'rayu-hostile-flux',
      label: 'Hostile FLUX-shaped hosted row',
      mediaType: 'image',
      capabilities: ['generate'],
      backend: 'rayu',
      family: 'flux',
    }
    useCatalog([...IMAGE_CATALOG, HOSTED_IMAGE_MODEL, hostile])
    const calls = mockFetch((url) => {
      throw new Error(`unexpected fetch: ${url}`)
    })

    await expect(
      runWithCwdOverride(tmp, () =>
        ImageGenTool.call(
          { prompt: 'a cat', model: hostile.id, output_path: './hostile.png' },
          ctx(),
        ),
      ),
    ).rejects.toThrow(/request family "flux"/)
    expect(calls).toHaveLength(0)
  })

  test('a backend:rayu entry with a Vertex family still calls only the gateway', async () => {
    // The surviving BYO-looking family. Vertex builds its own body, so the hosted
    // client must still get a gateway body — and only the gateway may be called.
    const hostile: MediaModelEntry = {
      id: 'rayu-hostile-imagen',
      label: 'Hostile Imagen-shaped hosted row',
      mediaType: 'image',
      capabilities: ['generate'],
      backend: 'rayu',
      family: 'imagen',
    }
    await enableVertex()
    useCatalog([...IMAGE_CATALOG, HOSTED_IMAGE_MODEL, hostile])
    const calls = mockFetch((url) => {
      throw new Error(`unexpected fetch: ${url}`)
    })

    await expect(
      runWithCwdOverride(tmp, () =>
        ImageGenTool.call(
          { prompt: 'a cat', model: hostile.id, output_path: './hostile.png' },
          ctx(),
        ),
      ),
    ).rejects.toThrow(/built by vertexImageClient/)
    // Refused locally: never a Vertex (or any other BYO) URL.
    expect(calls.every((c) => !BYO_HOST_PATTERN.test(c.url))).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('a configured BYO backend cannot steal a rayu entry from the gateway', async () => {
    // The BYO-vs-hosted precedence question only exists on the remembered path;
    // an entry whose backend IS 'rayu' goes to the gateway whatever is configured.
    await enableVertex()
    process.env.NVIDIA_API_KEY = 'nv-x'
    const calls = mockFetch((url) => {
      if (url.includes('/v1/images/generations')) {
        return new Response(
          JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }),
          { status: 200 },
        )
      }
      throw new Error(`BYO client must not serve a rayu backend: ${url}`)
    })

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        {
          prompt: 'a cat',
          model: HOSTED_IMAGE_MODEL.id,
          output_path: './steal.png',
        },
        ctx(),
      ),
    )

    expect(res.data.model).toBe(HOSTED_IMAGE_MODEL.id)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/v1/images/generations')
  })

  test('the gateway POST pins the configured host and refuses redirects', async () => {
    const saved = process.env.RAYU_GATEWAY_URL
    process.env.RAYU_GATEWAY_URL = 'https://gateway.rayucode.test'
    try {
      const calls = mockFetch(() => {
        throw new Error('must not reach the network')
      })
      await expect(
        generateRayuImage({
          model: withBuilder(HOSTED_IMAGE_MODEL),
          params: { prompt: 'x' },
        }),
      ).rejects.toThrow(/must not reach the network/)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(
        'https://gateway.rayucode.test/v1/images/generations',
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
        generateRayuImage({
          model: withBuilder(HOSTED_IMAGE_MODEL),
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
      const calls = mockFetch(() =>
        new Response(
          JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }),
          { status: 200 },
        ),
      )
      const out = await generateRayuImage({
        model: withBuilder(HOSTED_IMAGE_MODEL),
        params: { prompt: 'x' },
      })
      expect(out.modelId).toBe(HOSTED_IMAGE_MODEL.id)
      expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/images/generations')
    } finally {
      if (saved === undefined) delete process.env.RAYU_GATEWAY_URL
      else process.env.RAYU_GATEWAY_URL = saved
    }
  })
})
