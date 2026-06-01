import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React from 'react'
import { runWithCwdOverride } from '../src/utils/cwd.ts'
import {
  DEFAULT_IMAGE2VIDEO_MODEL,
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODELS,
  resolveVideoModel,
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

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// Minimal valid MP4 header (ftyp box)
const TINY_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
])

describe('video model registry', () => {
  test('default model is nvidia/cosmos-predict1-5b (NVCF backend)', () => {
    expect(DEFAULT_VIDEO_MODEL).toBe('nvidia/cosmos-predict1-5b')
    expect(VIDEO_MODELS[DEFAULT_VIDEO_MODEL].backend).toBe('nvcf')
    expect(VIDEO_MODELS[DEFAULT_VIDEO_MODEL].capability).toBe('text2video')
    expect(VIDEO_MODELS[DEFAULT_VIDEO_MODEL].nvcfFunctionId).toBe('eef816a3-3940-413b-93c9-513ae29f34f9')
  })

  test('cosmos-predict1-5b body uses Triton t2v format', () => {
    const body = VIDEO_MODELS[DEFAULT_VIDEO_MODEL].buildBody({ prompt: 'a river', seed: 42 }) as {
      inputs: Array<{ name: string; data: string[] }>
      outputs: Array<{ name: string }>
    }
    expect(body.inputs[0].name).toBe('command')
    expect(body.inputs[0].data[0]).toContain('t2v')
    expect(body.inputs[0].data[0]).toContain('a river')
    expect(body.inputs[0].data[0]).toContain('seed=42')
    expect(body.outputs[0].name).toBe('media')
  })

  test('cosmos3-nano has its own function ID', () => {
    expect(VIDEO_MODELS['nvidia/cosmos3-nano'].nvcfFunctionId).toBe('d09cd49d-d7f2-4361-928f-ea22af707249')
  })

  test('SVD body uses simple JSON with image field', () => {
    const body = VIDEO_MODELS['stabilityai/stable-video-diffusion'].buildBody({
      prompt: 'animate',
      image: 'QUJD',
    })
    expect(String(body.image)).toContain('data:image/png;base64,QUJD')
    expect(body.cfg_scale).toBeDefined()
  })

  test('resolveVideoModel falls back to cosmos-predict1-5b for both text and image', () => {
    expect(resolveVideoModel(undefined, false).id).toBe(DEFAULT_VIDEO_MODEL)
    expect(resolveVideoModel(undefined, true).id).toBe(DEFAULT_IMAGE2VIDEO_MODEL)
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
