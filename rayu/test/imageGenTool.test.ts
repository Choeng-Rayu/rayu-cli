import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React from 'react'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import {
  DEFAULT_EDIT_MODEL,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  resolveModel,
} from '../src/tools/ImageGenTool/models.ts'
import { generateImage } from '../src/tools/ImageGenTool/nvidiaImageClient.ts'
import {
  ImageGenTool,
  resolveOutputPath,
} from '../src/tools/ImageGenTool/ImageGenTool.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('image model registry', () => {
  test('flux mapper emits width/height/steps', () => {
    const body = IMAGE_MODELS[DEFAULT_IMAGE_MODEL].buildBody({ prompt: 'cat' })
    expect(body.width).toBe(1024)
    expect(body.steps).toBe(4)
    expect(body.prompt).toBe('cat')
    expect('aspect_ratio' in body).toBe(false)
  })

  test('SD mapper emits aspect_ratio/negative_prompt', () => {
    const body = IMAGE_MODELS[
      'stabilityai/stable-diffusion-3.5-large'
    ].buildBody({ prompt: 'cat', negative_prompt: 'blurry' })
    expect(body.aspect_ratio).toBe('1:1')
    expect(body.negative_prompt).toBe('blurry')
    expect('width' in body).toBe(false)
  })

  test('kontext mapper embeds input image as data URI', () => {
    const body = IMAGE_MODELS[DEFAULT_EDIT_MODEL].buildBody({
      prompt: 'add bg',
      imageAssetId: 'asset-123',
      imageMimeType: 'image/png',
    })
    expect(body.image).toBe('data:image/png;example_id,asset-123')
  })

  test('resolveModel falls back to defaults by capability', () => {
    expect(resolveModel(undefined, false).id).toBe(DEFAULT_IMAGE_MODEL)
    expect(resolveModel(undefined, true).id).toBe(DEFAULT_EDIT_MODEL)
    expect(resolveModel('black-forest-labs/flux.1-dev', false).id).toBe(
      'black-forest-labs/flux.1-dev',
    )
    // editing with a non-edit model forces the default edit model
    expect(resolveModel('black-forest-labs/flux.1-dev', true).id).toBe(
      DEFAULT_EDIT_MODEL,
    )
  })
})

describe('generateImage client', () => {
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
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rayu-imgcall-'))
    process.env.NVIDIA_API_KEY = 'nv-x'
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(tmp, { recursive: true, force: true })
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
