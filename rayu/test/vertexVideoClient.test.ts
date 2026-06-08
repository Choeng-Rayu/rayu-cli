import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildVeoBody,
  extractVideoBase64,
  generateVertexVideo,
} from '../src/tools/VideoGenTool/vertexVideoClient.ts'
import {
  DEFAULT_VERTEX_VIDEO_MODEL,
  VIDEO_MODELS,
  isVertexVideoModel,
} from '../src/tools/VideoGenTool/models.ts'

let savedProject: string | undefined
beforeEach(() => {
  savedProject = process.env.GOOGLE_CLOUD_PROJECT
  process.env.GOOGLE_CLOUD_PROJECT = 'test-proj'
})
afterEach(async () => {
  if (savedProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT
  else process.env.GOOGLE_CLOUD_PROJECT = savedProject
  const v = await import('../src/services/api/gemini/vertexAuth.ts')
  v._resetVertexAuthCacheForTesting()
})

describe('isVertexVideoModel', () => {
  test('detects veo models', () => {
    expect(isVertexVideoModel('veo-3.1-generate-001')).toBe(true)
    expect(isVertexVideoModel('nvidia/cosmos-predict1-5b')).toBe(false)
    expect(isVertexVideoModel(undefined)).toBe(false)
  })
})

describe('buildVeoBody', () => {
  test('text2video: instances[{prompt}] + parameters', () => {
    const body = buildVeoBody({ prompt: 'a dog running', aspect_ratio: '16:9', duration: '8' }) as any
    expect(body.instances[0].prompt).toBe('a dog running')
    expect(body.parameters.aspectRatio).toBe('16:9')
    expect(body.parameters.durationSeconds).toBe(8)
  })
  test('image2video: includes base64 image', () => {
    const body = buildVeoBody({ prompt: 'animate', image: 'IMG64' }) as any
    expect(body.instances[0].image.bytesBase64Encoded).toBe('IMG64')
  })
})

describe('extractVideoBase64', () => {
  test('reads response.videos[0].bytesBase64Encoded', () => {
    expect(
      extractVideoBase64({ response: { videos: [{ bytesBase64Encoded: 'AAA' }] } }),
    ).toBe('AAA')
  })
  test('reads generatedSamples fallback', () => {
    expect(
      extractVideoBase64({
        response: { generatedSamples: [{ video: { encodedVideo: 'BBB' } }] },
      }),
    ).toBe('BBB')
  })
  test('returns null when absent', () => {
    expect(extractVideoBase64({ response: {} })).toBeNull()
  })
})

describe('generateVertexVideo polling', () => {
  test('kicks off operation then polls until done and decodes the mp4', async () => {
    const v = await import('../src/services/api/gemini/vertexAuth.ts')
    v._resetVertexAuthCacheForTesting()
    v._setVertexTokenSourcesForTesting([
      async () => ({ token: 'tok', expiresAtMs: Date.now() + 3600_000 }),
    ])
    const mp4 = Buffer.from('fake-mp4-bytes').toString('base64')
    let calls = 0
    const original = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).fetch = async (input: any) => {
      const url = String(input)
      calls++
      if (url.includes(':predictLongRunning')) {
        return new Response(JSON.stringify({ name: 'operations/op1' }), { status: 200 })
      }
      if (url.includes(':fetchPredictOperation')) {
        // First poll: not done; second poll: done with the video.
        if (calls < 3) return new Response(JSON.stringify({ done: false }), { status: 200 })
        return new Response(
          JSON.stringify({ done: true, response: { videos: [{ bytesBase64Encoded: mp4 }] } }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }
    try {
      const r = await generateVertexVideo({
        modelId: 'veo-3.1-generate-001',
        params: { prompt: 'a kite' },
        _pollIntervalMs: 0,
      })
      expect(r.mediaType).toBe('video/mp4')
      expect(r.buffer.toString('utf8')).toBe('fake-mp4-bytes')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('generateVertexVideo region + 404 handling', () => {
  let dir: string
  let savedProj: string | undefined
  let savedLoc: string | undefined
  const original = globalThis.fetch

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-veo-'))
    process.env.RAYU_CONFIG_DIR = dir
    savedProj = process.env.GOOGLE_CLOUD_PROJECT
    savedLoc = process.env.GOOGLE_CLOUD_LOCATION
    process.env.GOOGLE_CLOUD_PROJECT = 'test-proj'
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
    const v = await import('../src/services/api/gemini/vertexAuth.ts')
    v._resetVertexAuthCacheForTesting()
    v._setVertexTokenSourcesForTesting([
      async () => ({ token: 'tok', expiresAtMs: Date.now() + 3600_000 }),
    ])
  })
  afterEach(async () => {
    globalThis.fetch = original
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    if (savedProj === undefined) delete process.env.GOOGLE_CLOUD_PROJECT
    else process.env.GOOGLE_CLOUD_PROJECT = savedProj
    if (savedLoc === undefined) delete process.env.GOOGLE_CLOUD_LOCATION
    else process.env.GOOGLE_CLOUD_LOCATION = savedLoc
    const v = await import('../src/services/api/gemini/vertexAuth.ts')
    v._setVertexTokenSourcesForTesting(null)
    v._resetVertexAuthCacheForTesting()
  })

  test('remaps a non-Veo region (asia-southeast1) to us-central1 in the request URL', async () => {
    process.env.GOOGLE_CLOUD_LOCATION = 'asia-southeast1'
    const cfg = await import('../src/utils/rayuConfig.ts')
    cfg._resetRayuConfigCache()
    const mp4 = Buffer.from('vid').toString('base64')
    let startUrl = ''
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      if (url.includes(':predictLongRunning')) {
        startUrl = url
        return new Response(JSON.stringify({ name: 'operations/op1' }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ done: true, response: { videos: [{ bytesBase64Encoded: mp4 }] } }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    await generateVertexVideo({ params: { prompt: 'x' }, _pollIntervalMs: 0 })
    expect(startUrl.startsWith('https://us-central1-aiplatform.googleapis.com/')).toBe(true)
    expect(startUrl).not.toContain('asia-southeast1')
  })

  test('404 on kickoff is augmented with the GA-migration hint', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 404, message: 'Publisher Model veo-x was not found' } }),
        { status: 404 },
      )) as unknown as typeof fetch
    await expect(
      generateVertexVideo({ modelId: 'veo-x', params: { prompt: 'x' }, _pollIntervalMs: 0 }),
    ).rejects.toThrow(/veo-3\.1-generate-001|retired|GA/)
  })
})

describe('Vertex Veo registry is GA-only (regression)', () => {
  test('default model is a GA id (…-001, never …-preview)', () => {
    expect(DEFAULT_VERTEX_VIDEO_MODEL).toBe('veo-3.1-generate-001')
    expect(DEFAULT_VERTEX_VIDEO_MODEL.endsWith('-preview')).toBe(false)
  })
  test('every vertex-backed video model id ends with -001', () => {
    const vertexIds = Object.values(VIDEO_MODELS)
      .filter(m => m.backend === 'vertex')
      .map(m => m.id)
    expect(vertexIds.length).toBeGreaterThan(0)
    for (const id of vertexIds) {
      expect(id.endsWith('-001')).toBe(true)
      expect(id).not.toContain('preview')
    }
  })
})
