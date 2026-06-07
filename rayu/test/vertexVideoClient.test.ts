import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildVeoBody,
  extractVideoBase64,
  generateVertexVideo,
} from '../src/tools/VideoGenTool/vertexVideoClient.ts'
import { isVertexVideoModel } from '../src/tools/VideoGenTool/models.ts'

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
    expect(isVertexVideoModel('veo-3.1-generate-preview')).toBe(true)
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
        modelId: 'veo-3.1-generate-preview',
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
