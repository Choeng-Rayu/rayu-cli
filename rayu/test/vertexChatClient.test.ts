import { describe, expect, test } from 'bun:test'
import {
  buildVertexFetch,
  toVertexModelId,
} from '../src/services/api/gemini/vertexChatClient.ts'

describe('toVertexModelId', () => {
  test('prefixes a bare model id with google/', () => {
    expect(toVertexModelId('gemini-2.5-flash')).toBe('google/gemini-2.5-flash')
  })
  test('leaves an already-qualified id untouched', () => {
    expect(toVertexModelId('google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro')
    expect(toVertexModelId('publishers/google/models/gemini-2.5-pro')).toBe(
      'publishers/google/models/gemini-2.5-pro',
    )
  })
})

describe('buildVertexFetch', () => {
  test('injects a fresh Bearer token and rewrites the body model to google/<id>', async () => {
    let seenAuth: string | null = null
    let seenBody: any = null
    const innerFetch = async (_input: any, init?: any) => {
      seenAuth = new Headers(init?.headers).get('Authorization')
      seenBody = JSON.parse(init?.body as string)
      return new Response('{}', { status: 200 })
    }
    // Temporarily swap globalThis.fetch so the wrapper delegates to our stub.
    const original = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).fetch = innerFetch
    try {
      const vfetch = buildVertexFetch(async () => 'tok-123')
      await vfetch(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/x/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-2.5-flash', messages: [] }),
        },
      )
    } finally {
      globalThis.fetch = original
    }
    expect(seenAuth).toBe('Bearer tok-123')
    expect(seenBody.model).toBe('google/gemini-2.5-flash')
  })

  test('does not double-prefix an already-qualified model', async () => {
    let seenBody: any = null
    const original = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).fetch = async (_i: any, init?: any) => {
      seenBody = JSON.parse(init?.body as string)
      return new Response('{}', { status: 200 })
    }
    try {
      const vfetch = buildVertexFetch(async () => 'tok')
      await vfetch('https://x/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'google/gemini-2.5-pro' }),
      })
    } finally {
      globalThis.fetch = original
    }
    expect(seenBody.model).toBe('google/gemini-2.5-pro')
  })

  test('augments a 403 PERMISSION_DENIED with Vertex setup guidance', async () => {
    const original = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Vertex AI API has not been used in project 123 before or it is disabled.' } }),
        { status: 403 },
      )
    try {
      const vfetch = buildVertexFetch(async () => 'tok')
      const res = await vfetch('https://x/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'gemini-2.5-pro' }),
      })
      expect(res.status).toBe(403)
      const body = JSON.parse(await res.text())
      expect(body.error.message).toMatch(/Vertex AI API|roles\/aiplatform\.user/)
    } finally {
      globalThis.fetch = original
    }
  })

  test('passes through non-403 responses unchanged', async () => {
    const original = globalThis.fetch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).fetch = async () => new Response('{"ok":true}', { status: 200 })
    try {
      const vfetch = buildVertexFetch(async () => 'tok')
      const res = await vfetch('https://x/chat/completions', { method: 'POST', body: '{"model":"gemini-2.5-pro"}' })
      expect(res.status).toBe(200)
    } finally {
      globalThis.fetch = original
    }
  })
})
