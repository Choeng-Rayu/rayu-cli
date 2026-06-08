import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _resetCodeAssistProjectCacheForTesting,
  buildCodeAssistBody,
  createCodeAssistClient,
  ensureCodeAssistProject,
  parseRetryDelayMs,
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
  test('pickOnboardTier prefers default tier, else legacy (paid) — never free by default', () => {
    expect(pickOnboardTier({ allowedTiers: [{ id: 'a' }, { id: 'free-tier', isDefault: true }] })).toBe('free-tier')
    expect(pickOnboardTier({})).toBe('legacy-tier')
  })
  test('parseRetryDelayMs reads RetryInfo retryDelay and "reset after Ns"', () => {
    expect(parseRetryDelayMs('"retryDelay": "2s"')).toBe(2000)
    expect(parseRetryDelayMs('quota will reset after 53s.')).toBe(53000)
    expect(parseRetryDelayMs('resets in ~2s')).toBe(2000)
    expect(parseRetryDelayMs('no delay here')).toBeNull()
  })
})

describe('buildCodeAssistBody', () => {
  test('wraps as { model, project, user_prompt_id, request{…, session_id} }', () => {
    const body = buildCodeAssistBody(
      { model: 'models/gemini-3.5-flash', max_tokens: 50, system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      'proj-123',
    ) as any
    expect(body.model).toBe('gemini-3.5-flash')
    expect(body.project).toBe('proj-123')
    expect(typeof body.user_prompt_id).toBe('string')
    expect(body.user_prompt_id.length).toBeGreaterThan(0)
    expect(typeof body.request.session_id).toBe('string')
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

  test('paid account (currentTier present) uses the server project without onboarding', async () => {
    let onboarded = false
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('loadCodeAssist')) {
        return new Response(
          JSON.stringify({ currentTier: { id: 'legacy-tier' }, cloudaicompanionProject: 'paid-proj' }),
          { status: 200 },
        )
      }
      if (u.includes('onboardUser')) {
        onboarded = true
        return new Response(JSON.stringify({ done: true }), { status: 200 })
      }
      throw new Error('unexpected')
    }) as unknown as typeof fetch
    expect(await ensureCodeAssistProject('tok')).toBe('paid-proj')
    expect(onboarded).toBe(false)
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

  test('429 quota error is rewritten with actionable guidance', async () => {
    const prev = process.env.RAYU_GEMINI_MAX_WAIT_S
    process.env.RAYU_GEMINI_MAX_WAIT_S = '0' // fail fast (no waiting) for the test
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('loadCodeAssist')) return new Response(JSON.stringify({ cloudaicompanionProject: 'p' }), { status: 200 })
      return new Response(
        JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You have exhausted your capacity on this model. Your quota will reset after 53s.' } }),
        { status: 429 },
      )
    }) as unknown as typeof fetch
    const client = createCodeAssistClient({ getToken: async () => 'tok' }) as any
    try {
      await expect(
        client.beta.messages.create({
        model: 'gemini-3.1-pro-preview',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/rate limit reached.*gemini-2\.5-flash/s)
    } finally {
      if (prev === undefined) delete process.env.RAYU_GEMINI_MAX_WAIT_S
      else process.env.RAYU_GEMINI_MAX_WAIT_S = prev
    }
  })

  test('short 429 throttle is retried transparently then succeeds', async () => {
    let genCalls = 0
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('loadCodeAssist')) return new Response(JSON.stringify({ cloudaicompanionProject: 'p' }), { status: 200 })
      if (u.includes('generateContent')) {
        genCalls++
        if (genCalls === 1) {
          return new Response(
            JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'reset after 0s', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }] } }),
            { status: 429 },
          )
        }
        return new Response(
          JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } }),
          { status: 200 },
        )
      }
      throw new Error('unexpected ' + u)
    }) as unknown as typeof fetch
    const client = createCodeAssistClient({ getToken: async () => 'tok' }) as any
    const msg = await client.beta.messages.create({
      model: 'gemini-2.5-pro',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(msg.content[0].text).toBe('ok')
    expect(genCalls).toBe(2)
  })
})
