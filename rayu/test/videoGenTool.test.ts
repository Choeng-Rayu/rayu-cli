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
import { generateVideo } from '../src/tools/VideoGenTool/nvidiaVideoClient.ts'
import {
  VideoGenTool,
  resolveOutputPath,
} from '../src/tools/VideoGenTool/VideoGenTool.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('video model registry', () => {
  test('text2world mapper emits frames/fps/seed', () => {
    const body = VIDEO_MODELS[DEFAULT_VIDEO_MODEL].buildBody({ prompt: 'a river' })
    expect(body.num_frames).toBe(57)
    expect(body.fps).toBe(24)
    expect(body.prompt).toBe('a river')
  })

  test('video2world mapper embeds input image as data URI', () => {
    const body = VIDEO_MODELS[DEFAULT_IMAGE2VIDEO_MODEL].buildBody({
      prompt: 'pan left',
      image: 'QUJD',
    })
    expect(body.image).toBe('data:image/png;base64,QUJD')
  })

  test('resolveVideoModel falls back to defaults by capability', () => {
    expect(resolveVideoModel(undefined, false).id).toBe(DEFAULT_VIDEO_MODEL)
    expect(resolveVideoModel(undefined, true).id).toBe(DEFAULT_IMAGE2VIDEO_MODEL)
    // image2video with a non-image2video model forces the default i2v model
    expect(resolveVideoModel(DEFAULT_VIDEO_MODEL, true).id).toBe(
      DEFAULT_IMAGE2VIDEO_MODEL,
    )
  })
})

describe('generateVideo client', () => {
  test('decodes a synchronous base64 video into a buffer', async () => {
    const b64 = Buffer.from('MP4DATA').toString('base64')
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ artifacts: [{ base64: b64, finishReason: 'SUCCESS' }] }), {
        status: 200,
      })) as unknown as typeof fetch
    const { buffer, mediaType } = await generateVideo({
      params: { prompt: 'a river' },
      apiKey: 'test-key',
    })
    expect(buffer.toString()).toBe('MP4DATA')
    expect(mediaType).toBe('video/mp4')
  })

  test('handles the async 202 + poll pattern', async () => {
    const b64 = Buffer.from('ASYNCMP4').toString('base64')
    let calls = 0
    globalThis.fetch = (async (url: string) => {
      calls++
      if (calls === 1) {
        // submit → 202 with a request id
        return new Response('', { status: 202, headers: { 'NVCF-REQID': 'req-1' } })
      }
      // poll → status host returns the finished video
      expect(url).toContain('/pexec/status/req-1')
      return new Response(JSON.stringify({ video: b64 }), { status: 200 })
    }) as unknown as typeof fetch

    const { buffer } = await generateVideo({
      params: { prompt: 'a river' },
      apiKey: 'k',
      _pollIntervalMs: 0,
    })
    expect(buffer.toString()).toBe('ASYNCMP4')
    expect(calls).toBe(2)
  })

  test('throws clear error when no video returned', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ artifacts: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(
      generateVideo({ params: { prompt: 'x' }, apiKey: 'k' }),
    ).rejects.toThrow(/no video/)
  })

  test('throws on non-OK HTTP status', async () => {
    globalThis.fetch = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    await expect(
      generateVideo({ params: { prompt: 'x' }, apiKey: 'k' }),
    ).rejects.toThrow(/403/)
  })
})

describe('VideoGenTool scaffold', () => {
  test('schema rejects empty prompt, accepts valid prompt', () => {
    expect(VideoGenTool.inputSchema.safeParse({ prompt: '' }).success).toBe(false)
    expect(VideoGenTool.inputSchema.safeParse({ prompt: 'a river' }).success).toBe(
      true,
    )
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
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    delete process.env.NVIDIA_API_KEY
  })

  test('false without a NVIDIA key, true once configured', async () => {
    const { _resetRayuConfigCache } = await import('../src/utils/rayuConfig.ts')
    _resetRayuConfigCache()
    expect(VideoGenTool.isEnabled()).toBe(false)
    process.env.NVIDIA_API_KEY = 'nv-x'
    _resetRayuConfigCache()
    expect(VideoGenTool.isEnabled()).toBe(true)
  })
})

describe('VideoGenTool.call', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rayu-vidcall-'))
    process.env.NVIDIA_API_KEY = 'nv-x'
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(tmp, { recursive: true, force: true })
    delete process.env.NVIDIA_API_KEY
  })

  test('saves the mp4 to disk and returns a text result block', async () => {
    const b64 = Buffer.from('MP4BYTES').toString('base64')
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ artifacts: [{ base64: b64, finishReason: 'SUCCESS' }] }),
        { status: 200 },
      )) as unknown as typeof fetch

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
    delete process.env.NVIDIA_API_KEY
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
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

  test('is gated on a configured NVIDIA key', async () => {
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
