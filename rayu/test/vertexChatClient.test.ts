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
})
