import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  bareVertexModel,
  buildVertexGenaiBody,
  createVertexGenaiClient,
} from '../src/services/api/gemini/vertexGenaiClient.ts'
import { _setVertexTokenSourcesForTesting } from '../src/services/api/gemini/vertexAuth.ts'

const realFetch = globalThis.fetch
let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-vgenai-'))
  process.env.RAYU_CONFIG_DIR = dir
  const v = await import('../src/services/api/gemini/vertexAuth.ts')
  v._resetVertexAuthCacheForTesting()
  v._setVertexTokenSourcesForTesting([
    async () => ({ token: 'tok-123', expiresAtMs: Date.now() + 3600_000 }),
  ])
})
afterEach(async () => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  const v = await import('../src/services/api/gemini/vertexAuth.ts')
  v._setVertexTokenSourcesForTesting(null)
  v._resetVertexAuthCacheForTesting()
})

describe('bareVertexModel', () => {
  test('strips models/ and google/ prefixes', () => {
    expect(bareVertexModel('gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(bareVertexModel('models/gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview')
    expect(bareVertexModel('google/gemini-2.5-pro')).toBe('gemini-2.5-pro')
  })
})

describe('buildVertexGenaiBody', () => {
  test('native shape: contents/systemInstruction/tools/generationConfig, no wrapper, sanitized schema', () => {
    const body = buildVertexGenaiBody({
      model: 'gemini-2.5-flash',
      max_tokens: 100,
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', description: 'r', input_schema: { $schema: 'x', type: 'object', additionalProperties: false, properties: { p: { type: 'string' } } } }],
    }) as any
    expect(body.contents[0].parts[0].text).toBe('hi')
    expect(body.systemInstruction.parts[0].text).toBe('be helpful')
    expect(body.generationConfig.maxOutputTokens).toBe(100)
    // no Code-Assist wrapper fields
    expect(body.model).toBeUndefined()
    expect(body.project).toBeUndefined()
    expect(body.request).toBeUndefined()
    // tool schema sanitized (no $schema / additionalProperties)
    const params = body.tools[0].functionDeclarations[0].parameters
    expect(params.$schema).toBeUndefined()
    expect(params.additionalProperties).toBeUndefined()
    expect(params.properties.p.type).toBe('string')
  })
})

describe('createVertexGenaiClient', () => {
  test('non-streaming hits the native :generateContent URL with the bare model id', async () => {
    let seenUrl = ''
    let seenAuth = ''
    let seenProjHdr = ''
    globalThis.fetch = (async (url: any, init?: any) => {
      seenUrl = String(url)
      seenAuth = new Headers(init?.headers).get('Authorization') ?? ''
      seenProjHdr = new Headers(init?.headers).get('x-goog-user-project') ?? ''
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const client = createVertexGenaiClient({ id: 'gemini-vertex', gcpProject: 'proj-x', gcpRegion: 'global' }, 0) as any
    const msg = await client.beta.messages.create({
      model: 'models/gemini-3.5-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(msg.content[0].text).toBe('hello')
    expect(seenUrl).toBe('https://aiplatform.googleapis.com/v1beta1/projects/proj-x/locations/global/publishers/google/models/gemini-3.5-flash:generateContent')
    expect(seenAuth).toBe('Bearer tok-123')
    expect(seenProjHdr).toBe('proj-x')
  })

  test('regional host for non-global region', async () => {
    let seenUrl = ''
    globalThis.fetch = (async (url: any) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const client = createVertexGenaiClient({ id: 'gemini-vertex', gcpProject: 'p', gcpRegion: 'us-central1' }, 0) as any
    await client.beta.messages.create({ model: 'gemini-2.5-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
    expect(seenUrl.startsWith('https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/us-central1/')).toBe(true)
  })

  test('streaming parses native SSE chunks into Anthropic events', async () => {
    const sse =
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n'
    globalThis.fetch = (async () => new Response(sse, { status: 200 })) as unknown as typeof fetch
    const client = createVertexGenaiClient({ id: 'gemini-vertex', gcpProject: 'p', gcpRegion: 'global' }, 0) as any
    const { data } = await client.beta.messages.create({ model: 'gemini-2.5-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }).withResponse()
    const events: any[] = []
    for await (const e of data) events.push(e)
    expect(events[0].type).toBe('message_start')
    expect(events.filter(e => e.type === 'content_block_delta').map(e => e.delta.text).join('')).toBe('Hello')
  })

  test('403 is rewritten with Vertex setup guidance', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Vertex AI API has not been used in project 1 before or it is disabled.' } }), { status: 403 })) as unknown as typeof fetch
    const client = createVertexGenaiClient({ id: 'gemini-vertex', gcpProject: 'p', gcpRegion: 'global' }, 0) as any
    await expect(
      client.beta.messages.create({ model: 'gemini-2.5-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/Vertex AI API|roles\/aiplatform\.user/)
  })

  test('404 is rewritten with region/model guidance', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 404, message: 'Publisher Model gemini-3-flash was not found' } }), { status: 404 })) as unknown as typeof fetch
    const client = createVertexGenaiClient({ id: 'gemini-vertex', gcpProject: 'p', gcpRegion: 'asia-southeast1' }, 0) as any
    await expect(
      client.beta.messages.create({ model: 'gemini-3-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/global|gemini-2\.5/)
  })

  test('missing project throws a clear error', async () => {
    const prev = process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GOOGLE_CLOUD_PROJECT
    try {
      const client = createVertexGenaiClient({ id: 'gemini-vertex' }, 0) as any
      await expect(
        client.beta.messages.create({ model: 'gemini-2.5-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow(/No GCP project/)
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_CLOUD_PROJECT
      else process.env.GOOGLE_CLOUD_PROJECT = prev
    }
  })
})
