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
  isVertexImageModel,
  resolveModel,
  retainKnownImageModel,
  withBuilder,
} from '../src/tools/ImageGenTool/models.ts'
import { generateImage } from '../src/tools/ImageGenTool/nvidiaImageClient.ts'
import {
  ImageGenTool,
  resolveOutputPath,
} from '../src/tools/ImageGenTool/ImageGenTool.ts'

// A fetched-style catalog: exactly the shape services/rayuAuth/mediaModels.ts
// produces from GET /v1/models?media=image. Nothing about image models is
// hardcoded in the CLI any more, so every test drives the resolver with this.
const IMAGE_CATALOG: MediaModelEntry[] = [
  {
    id: 'black-forest-labs/flux.1-schnell',
    label: 'FLUX.1 Schnell',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'flux',
    defaultParams: { cfg_scale: 0, steps: 4 },
    isDefault: true,
  },
  {
    id: 'black-forest-labs/flux.1-dev',
    label: 'FLUX.1 Dev',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'flux',
    defaultParams: { cfg_scale: 3.5, steps: 50 },
  },
  {
    id: 'stabilityai/stable-diffusion-3.5-large',
    label: 'SD 3.5 Large',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'sd3',
    defaultParams: { cfg_scale: 4.5, steps: 50, aspect_ratio: '1:1' },
  },
  {
    id: 'black-forest-labs/flux.1-kontext-dev',
    label: 'FLUX.1 Kontext Dev',
    mediaType: 'image',
    capabilities: ['edit'],
    backend: 'nvidia',
    family: 'kontext',
    defaultParams: { cfg_scale: 3.5, steps: 30 },
    isDefault: true,
  },
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

const DEFAULT_IMAGE_MODEL = 'black-forest-labs/flux.1-schnell'
const DEFAULT_EDIT_MODEL = 'black-forest-labs/flux.1-kontext-dev'

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

  test('flux family maps the catalog defaultParams into the body', () => {
    const schnell = resolveModel(IMAGE_CATALOG, DEFAULT_IMAGE_MODEL, false)
    const body = schnell.buildBody({ prompt: 'cat' })
    expect(body.width).toBe(1024)
    // 4 steps / cfg 0 come from the CATALOG entry, not from CLI code — the same
    // family serves flux.1-dev with completely different numbers.
    expect(body.steps).toBe(4)
    expect(body.cfg_scale).toBe(0)
    expect(body.prompt).toBe('cat')
    expect('aspect_ratio' in body).toBe(false)

    const dev = resolveModel(IMAGE_CATALOG, 'black-forest-labs/flux.1-dev', false)
    const devBody = dev.buildBody({ prompt: 'cat' })
    expect(devBody.steps).toBe(50)
    expect(devBody.cfg_scale).toBe(3.5)
  })

  test('sd3 family emits aspect_ratio/negative_prompt', () => {
    const m = resolveModel(
      IMAGE_CATALOG,
      'stabilityai/stable-diffusion-3.5-large',
      false,
    )
    const body = m.buildBody({ prompt: 'cat', negative_prompt: 'blurry' })
    expect(body.aspect_ratio).toBe('1:1')
    expect(body.negative_prompt).toBe('blurry')
    expect('width' in body).toBe(false)
  })

  test('kontext family embeds the uploaded asset as a data URI', () => {
    const m = resolveModel(IMAGE_CATALOG, DEFAULT_EDIT_MODEL, true)
    const body = m.buildBody({
      prompt: 'add bg',
      imageAssetId: 'asset-123',
      imageMimeType: 'image/png',
    })
    expect(body.image).toBe('data:image/png;example_id,asset-123')
  })

  test('falls back to the catalog default flag by capability', () => {
    expect(resolveModel(IMAGE_CATALOG, undefined, false).id).toBe(DEFAULT_IMAGE_MODEL)
    expect(resolveModel(IMAGE_CATALOG, undefined, true).id).toBe(DEFAULT_EDIT_MODEL)
    expect(resolveModel(IMAGE_CATALOG, 'black-forest-labs/flux.1-dev', false).id).toBe(
      'black-forest-labs/flux.1-dev',
    )
    // editing with a non-edit model forces the default edit model
    expect(resolveModel(IMAGE_CATALOG, 'black-forest-labs/flux.1-dev', true).id).toBe(
      DEFAULT_EDIT_MODEL,
    )
  })

  test('a model added to the catalog is usable with NO CLI change', () => {
    const added: MediaModelEntry = {
      id: 'black-forest-labs/flux.2-turbo',
      label: 'FLUX.2 Turbo',
      mediaType: 'image',
      capabilities: ['generate'],
      backend: 'nvidia',
      // Reuses a known request shape, so only the catalog row is new.
      family: 'flux',
      defaultParams: { cfg_scale: 1.5, steps: 8 },
    }
    const m = resolveModel([...IMAGE_CATALOG, added], added.id, false)
    expect(m.id).toBe(added.id)
    expect(m.buildBody({ prompt: 'x' }).steps).toBe(8)
  })

  test('an unknown request family fails with an actionable, named error', () => {
    expect(() =>
      withBuilder({
        id: 'some/new-model',
        label: 'New',
        mediaType: 'image',
        capabilities: ['generate'],
        backend: 'nvidia',
        family: 'diffusion-x9',
      }),
    ).toThrow(/diffusion-x9/)
  })

  test('an empty catalog fails with a dashboard hint, not a crash', () => {
    expect(() => resolveModel([], undefined, false)).toThrow(/dashboard/i)
  })

  test('an UNKNOWN named model is an error, never a silent substitution', () => {
    // Generating with a different model than the one asked for is worse than
    // failing: the caller cannot tell it happened.
    expect(() => resolveModel(IMAGE_CATALOG, 'black-forest-labs/flux.9-imaginary', false))
      .toThrow(/Unknown image model "black-forest-labs\/flux\.9-imaginary"/)
  })

  test('a KNOWN model that cannot edit still falls back to the edit default', () => {
    // This fallback is deliberate — it is how input_image routes a generate-only
    // model to the editing model.
    expect(resolveModel(IMAGE_CATALOG, 'black-forest-labs/flux.1-dev', true).id).toBe(
      DEFAULT_EDIT_MODEL,
    )
  })

  test('a model served by another backend reports a routing bug', () => {
    expect(() =>
      resolveModel(IMAGE_CATALOG, 'imagen-4.0-generate-001', false, {
        backends: ['nvidia'],
      }),
    ).toThrow(/routing bug/)
  })

  test('a default is only ever picked from a servable backend', () => {
    // The NVIDIA client cannot POST to Vertex, so it must never resolve an Imagen
    // default even if the catalog marks one as default.
    expect(resolveModel(IMAGE_CATALOG, undefined, false, { backends: ['nvidia'] }).id)
      .toBe(DEFAULT_IMAGE_MODEL)
    expect(resolveModel(IMAGE_CATALOG, undefined, true, { backends: ['nvidia'] }).id)
      .toBe(DEFAULT_EDIT_MODEL)
    // Preference order decides when several servable backends have a model.
    expect(
      resolveModel(IMAGE_CATALOG, undefined, false, { backends: ['vertex', 'nvidia'] }).id,
    ).toBe('imagen-4.0-generate-001')
  })

  test('a backend with no usable model falls through to the next preference', () => {
    const nvidiaOnly = IMAGE_CATALOG.filter((m) => m.backend === 'nvidia')
    expect(
      resolveModel(nvidiaOnly, undefined, false, { backends: ['vertex', 'nvidia'] }).id,
    ).toBe(DEFAULT_IMAGE_MODEL)
  })

  test('NVIDIA_IMAGE_MODEL pins the default — but only to a servable model', () => {
    process.env.NVIDIA_IMAGE_MODEL = 'black-forest-labs/flux.1-dev'
    expect(resolveModel(IMAGE_CATALOG, undefined, false, { backends: ['nvidia'] }).id)
      .toBe('black-forest-labs/flux.1-dev')

    // An override naming a model this client cannot POST to is IGNORED, not
    // smuggled past the backend filter — that would mis-route the request.
    process.env.NVIDIA_IMAGE_MODEL = 'imagen-4.0-generate-001'
    expect(resolveModel(IMAGE_CATALOG, undefined, false, { backends: ['nvidia'] }).id)
      .toBe(DEFAULT_IMAGE_MODEL)

    // An override naming a model that no longer exists is ignored too.
    process.env.NVIDIA_IMAGE_MODEL = 'gone/forever'
    expect(resolveModel(IMAGE_CATALOG, undefined, false, { backends: ['nvidia'] }).id)
      .toBe(DEFAULT_IMAGE_MODEL)
  })

  test('an explicit model argument beats the env override', () => {
    process.env.NVIDIA_IMAGE_MODEL = 'black-forest-labs/flux.1-dev'
    expect(
      resolveModel(IMAGE_CATALOG, 'stabilityai/stable-diffusion-3.5-large', false, {
        backends: ['nvidia'],
      }).id,
    ).toBe('stabilityai/stable-diffusion-3.5-large')
  })

  test('retainKnownImageModel drops a stale remembered selection', () => {
    // A model chosen weeks ago via /model_image_generation and since removed must
    // not fail every generation — it is dropped so the default applies.
    expect(retainKnownImageModel(IMAGE_CATALOG, 'gone/forever')).toBeUndefined()
    expect(retainKnownImageModel(IMAGE_CATALOG, DEFAULT_IMAGE_MODEL)).toBe(
      DEFAULT_IMAGE_MODEL,
    )
    expect(retainKnownImageModel(IMAGE_CATALOG, undefined)).toBeUndefined()
    // A hand-written Vertex id is kept: the Vertex client honours it verbatim, so
    // a brand-new Google model works before the dashboard has it.
    expect(retainKnownImageModel(IMAGE_CATALOG, 'imagen-5.0-generate-001')).toBe(
      'imagen-5.0-generate-001',
    )
  })

  test('backend filter picks the per-backend default', () => {
    expect(defaultImageModelId(IMAGE_CATALOG, 'vertex', false)).toBe(
      'imagen-4.0-generate-001',
    )
    expect(defaultImageModelId(IMAGE_CATALOG, 'vertex', true)).toBe(
      'imagen-3.0-capability-001',
    )
    expect(defaultImageModelId(IMAGE_CATALOG, 'nvidia', false)).toBe(
      DEFAULT_IMAGE_MODEL,
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
    expect(isVertexImageModel(DEFAULT_IMAGE_MODEL, IMAGE_CATALOG)).toBe(false)
    expect(isVertexImageModel(undefined, IMAGE_CATALOG)).toBe(false)
  })
})

describe('generateImage client', () => {
  // The client resolves its model from the fetched catalog, so install one — and
  // isolate the config dir so the user-bound cache never reads a real session.
  beforeEach(() => {
    isolateConfigDir()
    useCatalog()
  })
  afterEach(restoreConfigDir)

  test('decodes artifacts[0].base64 into a buffer', async () => {
    const b64 = Buffer.from('PNGDATA').toString('base64')
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ artifacts: [{ base64: b64, finishReason: 'SUCCESS' }] }), {
        status: 200,
      })) as unknown as typeof fetch
    const { buffer, mediaType } = await generateImage({
      params: { prompt: 'cat' },
      apiKey: 'test-key',
    })
    expect(buffer.toString()).toBe('PNGDATA')
    expect(mediaType).toBe('image/png')
  })

  test('throws clear error when no artifacts returned', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ artifacts: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(
      generateImage({ params: { prompt: 'cat' }, apiKey: 'k' }),
    ).rejects.toThrow(/no image/)
  })

  test('throws on non-OK HTTP status', async () => {
    globalThis.fetch = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    await expect(
      generateImage({ params: { prompt: 'cat' }, apiKey: 'k' }),
    ).rejects.toThrow(/403/)
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

describe('ImageGenTool.isEnabled', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-img-'))
    process.env.RAYU_CONFIG_DIR = dir
    delete process.env.NVIDIA_API_KEY
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.NVIDIA_API_KEY
  })

  test('false without a NVIDIA key, true once configured', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    _resetRayuConfigCache()
    expect(ImageGenTool.isEnabled()).toBe(false)
    process.env.NVIDIA_API_KEY = 'nv-x'
    _resetRayuConfigCache()
    expect(ImageGenTool.isEnabled()).toBe(true)
  })
})

// 1x1 transparent PNG (valid IHDR so pngDimensions works).
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('ImageGenTool.call', () => {
  let tmp: string
  let cfgDir: string
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'rayu-imgcall-'))
    cfgDir = mkdtempSync(join(tmpdir(), 'rayu-imgcfg-'))
    process.env.RAYU_CONFIG_DIR = cfgDir // isolate from the dev's real ~/.rayu
    process.env.NVIDIA_API_KEY = 'nv-x'
    // Ensure no Vertex/genai signals leak in and flip image routing to Vertex.
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    _resetRayuConfigCache()
    // Pin the model catalog so the test never reaches the gateway or a cached
    // file on the dev's machine.
    useCatalog()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(tmp, { recursive: true, force: true })
    rmSync(cfgDir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.NVIDIA_API_KEY
  })

  test('saves the image to disk and returns an inline image block', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ artifacts: [{ base64: TINY_PNG_B64, finishReason: 'SUCCESS' }] }),
        { status: 200 },
      )) as unknown as typeof fetch

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        { prompt: 'a cat', output_path: './out.png' } as never,
        {
          abortController: new AbortController(),
          options: { isNonInteractiveSession: true },
        } as never,
      ),
    )

    expect(existsSync(join(tmp, 'out.png'))).toBe(true)
    expect(res.data.width).toBe(1)
    expect(res.data.height).toBe(1)

    const block = ImageGenTool.mapToolResultToToolResultBlockParam(
      res.data,
      'tid',
    )
    const content = block.content as Array<{ type: string }>
    expect(content.some(b => b.type === 'image')).toBe(true)
    expect(content.some(b => b.type === 'text')).toBe(true)
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

  test('input_image routes to the edit model and embeds the image', async () => {
    writeFileSync(join(tmp, 'in.png'), Buffer.from(TINY_PNG_B64, 'base64'))
    let captured: { url: string; body: Record<string, unknown> } = {
      url: '',
      body: {},
    }
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('/assets')) {
        return new Response(
          JSON.stringify({ assetId: 'asset-456', uploadUrl: 'https://s3-upload-url' }),
          { status: 200 },
        )
      }
      if (url.includes('s3-upload-url')) {
        return new Response('', { status: 200 })
      }
      captured = { url, body: JSON.parse(init?.body as string) }
      return new Response(
        JSON.stringify({ artifacts: [{ base64: TINY_PNG_B64, finishReason: 'SUCCESS' }] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const res = await runWithCwdOverride(tmp, () =>
      ImageGenTool.call(
        { prompt: 'add blue bg', input_image: './in.png', output_path: './out.png' } as never,
        {
          abortController: new AbortController(),
          options: { isNonInteractiveSession: true },
        } as never,
      ),
    )

    expect(captured.url).toContain('flux.1-kontext-dev')
    expect(String(captured.body.image)).toContain('data:image/png;example_id,asset-456')
    expect(res.data.model).toBe('black-forest-labs/flux.1-kontext-dev')
  })
})

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
    delete process.env.NVIDIA_API_KEY
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.NVIDIA_API_KEY
  })

  test('is a prompt command whose prompt invokes GenerateImage', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd: any = (await import('../src/commands/generate-image.ts')).default
    expect(cmd.name).toBe('generate-image')
    expect(cmd.type).toBe('prompt')
    const blocks = await cmd.getPromptForCommand('a red sports car')
    expect(blocks[0].text).toContain('a red sports car')
    expect(blocks[0].text).toContain('GenerateImage')
  })

  test('is gated on a configured NVIDIA key', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd: any = (await import('../src/commands/generate-image.ts')).default
    _resetRayuConfigCache()
    expect(cmd.isEnabled()).toBe(false)
    process.env.NVIDIA_API_KEY = 'nv-x'
    _resetRayuConfigCache()
    expect(cmd.isEnabled()).toBe(true)
  })
})
