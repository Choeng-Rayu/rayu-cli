import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetCodeAssistProjectCacheForTesting,
  buildCodeAssistBody,
  createCodeAssistClient,
  ensureCodeAssistProject,
  parseSSEResponses,
  pickOnboardTier,
  projectIdFromOnboard,
} from '../src/services/api/gemini/codeAssistClient.ts'

const realFetch = globalThis.fetch
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-ca-'))
  process.env.RAYU_CONFIG_DIR = dir
  _resetCodeAssistProjectCacheForTesting()
})
afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
})

describe('helpers', () => {
  test('projectIdFromOnboard handles string and object', () => {
    expect(projectIdFromOnboard({ response: { cloudaicompanionProject: 'p1' } })).toBe('p1')
    expect(projectIdFromOnboard({ response: { cloudaicompanionProject: { id: 'p2' } } })).toBe('p2')
    expect(projectIdFromOnboard({})).toBeUndefined()
  })
  test('pickOnboardTier prefers default tier', () => {
    expect(pickOnboardTier({ allowedTiers: [{ id: 'a' }, { id: 'free-tier', isDefault: true }] })).toBe('free-tier')
    expect(pickOnboardTier({})).toBe('free-tier')
  })
})

describe('buildCodeAssistBody', () => {
  test('wraps as { model, project, request }', () => {
    const body = buildCodeAssistBody(
      { model: 'models/gemini-3.5-flash', max_tokens: 50, system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      'proj-123',
    ) as any
    expect(body.model).toBe('gemini-3.5-flash')
    expect(body.project).toBe('proj-123')
    expect(body.request.contents[0].parts[0].text).toBe('hi')
    expect(body.request.systemInstruction.parts[0].text).toBe('sys')
    expect(body.request.generationConfig.maxOutputTokens).toBe(50)
  })
})

describe('ensureCodeAssistProject', () => {
  test('uses cloudaicompanionProject from loadCodeAssist', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('loadCodeAssist')) {
        return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-load' }), { status: 200 })
      }
      throw new Error('should not onboard')
    }) as unknown as typeof fetch
    expect(await ensureCodeAssistProject('tok')).toBe('proj-load')
  })

  test('onboards when no project is present, polling until done', async () => {
    let onboardCalls = 0
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('loadCodeAssist')) {
        return new Response(JSON.stringify({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }), { status: 200 })
      }
      if (u.includes('onboardUser')) {
        onboardCalls++
        if (onboardCalls < 2) return new Response(JSON.stringify({ done: false }), { status: 200 })
        return new Response(
          JSON.stringify({ done: true, response: { cloudaicompanionProject: { id: 'proj-onboard' } } }),
          { status: 200 },
        )
      }
      throw new Error('unexpected')
    }) as unknown as typeof fetch
    expect(await ensureCodeAssistProject('tok')).toBe('proj-onboard')
    expect(onboardCalls).toBeGreaterThanOrEqual(2)
  })
})

describe('parseSSEResponses', () => {
  test('extracts chunk.response objects from data: lines', async () => {
    const sse =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"A"}]}}]}}\n\n' +
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"B"}]}}]}}\n\n' +
      'data: [DONE]\n'
    const body = new Response(sse).body as ReadableStream<Uint8Array>
    const out: any[] = []
    for await (const r of parseSSEResponses(body)) out.push(r)
    expect(out).toHaveLength(2)
    expect(out[0].candidates[0].content.parts[0].text).toBe('A')
  })
})

describe('createCodeAssistClient', () => {
  test('non-streaming round-trip (onboard + generateContent)', async () => {
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('loadCodeAssist')) return new Response(JSON.stringify({ cloudaicompanionProject: 'p' }), { status: 200 })
      if (u.includes('generateContent')) {
        return new Response(
          JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'hello' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } } }),
          { status: 200 },
        )
      }
      throw new Error('unexpected ' + u)
    }) as unknown as typeof fetch
    const client = createCodeAssistClient({ getToken: async () => 'tok' }) as any
    const msg = await client.beta.messages.create({
      model: 'gemini-3.5-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(msg.content[0].text).toBe('hello')
  })
})
