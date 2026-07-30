import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  VERTEX_ANTHROPIC_VERSION,
  curatedVertexClaudeModels,
  curatedVertexMaasModels,
  isVertexMaasModelId,
  makeVertexAnthropicFetch,
  toVertexRequestBody,
  vertexAnthropicBaseURL,
  vertexAnthropicHost,
  vertexAnthropicPath,
} from '../src/services/api/gemini/vertexAnthropic.ts'
import type { RayuProvider } from '../src/utils/rayuConfig.ts'

// Task 9: ONE Vertex provider serving THREE wire formats per model —
// Gemini (GenAI), Claude (Anthropic Messages) and MaaS (OpenAI Chat).
//
// GROUNDING for the Claude path: the OFFICIAL @anthropic-ai/vertex-sdk in
// node_modules. src/client.ts shows the host mapping (:90-101), the request
// rewrite (:163-181: anthropic_version injected, `model` removed from the body,
// path → publishers/anthropic/models/{model}:{rawPredict|streamRawPredict}) and
// the version constant 'vertex-2023-10-16' (:12). It extends BaseAnthropic with
// no custom stream decoder, so streamRawPredict returns standard Anthropic SSE
// (unlike Bedrock, which needs event-stream transcoding).
//
// NOT live-verified: no GCP credentials were available.

describe('host + path construction', () => {
  test('the region → host mapping matches the official SDK', () => {
    // global and the us/eu multi-regions use distinct hosts, not a {region}- prefix.
    expect(vertexAnthropicHost('global')).toBe('aiplatform.googleapis.com')
    expect(vertexAnthropicHost('us')).toBe('aiplatform.us.rep.googleapis.com')
    expect(vertexAnthropicHost('eu')).toBe('aiplatform.eu.rep.googleapis.com')
    expect(vertexAnthropicHost('us-central1')).toBe(
      'us-central1-aiplatform.googleapis.com',
    )
    // Empty region falls back to the SDK's own default behavior.
    expect(vertexAnthropicHost('')).toBe('aiplatform.googleapis.com')
  })

  test('the base URL carries the /v1 prefix the SDK uses', () => {
    expect(vertexAnthropicBaseURL('us-central1')).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1',
    )
  })

  test('streaming and non-streaming use different publisher specifiers', () => {
    expect(
      vertexAnthropicPath('p1', 'us-central1', 'claude-sonnet-4-5@20250929', false),
    ).toBe(
      '/v1/projects/p1/locations/us-central1/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict',
    )
    expect(
      vertexAnthropicPath('p1', 'global', 'claude-sonnet-4-5@20250929', true),
    ).toBe(
      '/v1/projects/p1/locations/global/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict',
    )
  })
})

describe('request body translation', () => {
  test('moves the model into the path and injects the Vertex anthropic_version', () => {
    const { body, model, stream } = toVertexRequestBody(
      JSON.stringify({
        model: 'claude-sonnet-4-5@20250929',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(model).toBe('claude-sonnet-4-5@20250929')
    expect(stream).toBe(false)
    const parsed = JSON.parse(body) as Record<string, unknown>
    // Vertex rejects a `model` field in the body — it lives in the path.
    expect('model' in parsed).toBe(false)
    // Note this differs from Bedrock's 'bedrock-2023-05-31'.
    expect(parsed.anthropic_version).toBe(VERTEX_ANTHROPIC_VERSION)
    expect(parsed.anthropic_version).toBe('vertex-2023-10-16')
    expect(parsed.max_tokens).toBe(16)
  })

  test('stream:true selects the streaming specifier', () => {
    const { stream } = toVertexRequestBody(
      JSON.stringify({ model: 'claude-opus-4@20250514', stream: true, messages: [] }),
    )
    expect(stream).toBe(true)
  })
})

describe('the Vertex fetch wrapper', () => {
  function capturingFetch(response = new Response('{}', {
    headers: { 'content-type': 'application/json' },
  })) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const f = (async (input: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      return response
    }) as unknown as typeof fetch
    return { f, calls }
  }

  test('rewrites /v1/messages onto the anthropic publisher path with an OAuth bearer', async () => {
    const { f, calls } = capturingFetch()
    const vertexFetch = makeVertexAnthropicFetch({
      project: 'my-project',
      region: 'us-central1',
      getToken: async () => 'ya29.token',
      inner: f,
    })
    await vertexFetch(
      'https://us-central1-aiplatform.googleapis.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5@20250929',
          messages: [],
          max_tokens: 8,
        }),
        headers: { 'x-api-key': 'should-be-removed', 'anthropic-version': '2023-06-01' },
      },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict',
    )
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('authorization')).toBe('Bearer ya29.token')
    // Publisher endpoints bill against a quota project.
    expect(headers.get('x-goog-user-project')).toBe('my-project')
    // Anthropic-only headers Vertex does not accept are stripped.
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('anthropic-version')).toBeNull()
    expect(calls[0]!.init.redirect).toBe('error')
  })

  test('a streaming request targets streamRawPredict', async () => {
    const { f, calls } = capturingFetch()
    const vertexFetch = makeVertexAnthropicFetch({
      project: 'p',
      region: 'global',
      getToken: async () => 't',
      inner: f,
    })
    await vertexFetch('https://aiplatform.googleapis.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4@20250514', stream: true, messages: [] }),
    })
    expect(calls[0]!.url).toContain(':streamRawPredict')
  })

  test('SECURITY: refuses to send the OAuth token to an unexpected host', async () => {
    const { f, calls } = capturingFetch()
    const vertexFetch = makeVertexAnthropicFetch({
      project: 'p',
      region: 'us-central1',
      getToken: async () => 't',
      inner: f,
    })
    await expect(
      vertexFetch('https://evil.example/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-opus-4@20250514', messages: [] }),
      }),
    ).rejects.toThrow(/unexpected host/)
    expect(calls).toHaveLength(0)
  })

  test('a missing GCP project raises an actionable error rather than a bad URL', async () => {
    const { f } = capturingFetch()
    const vertexFetch = makeVertexAnthropicFetch({
      project: '',
      region: 'global',
      getToken: async () => 't',
      inner: f,
    })
    await expect(
      vertexFetch('https://aiplatform.googleapis.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-opus-4@20250514', messages: [] }),
      }),
    ).rejects.toThrow(/GCP project/)
  })

  test('a non-Messages request passes through unchanged', async () => {
    const { f, calls } = capturingFetch()
    const vertexFetch = makeVertexAnthropicFetch({
      project: 'p',
      region: 'global',
      getToken: async () => 't',
      inner: f,
    })
    await vertexFetch('https://aiplatform.googleapis.com/v1/models', {
      method: 'GET',
    })
    expect(calls[0]!.url).toBe('https://aiplatform.googleapis.com/v1/models')
  })
})

describe('model family detection', () => {
  test('MaaS ids are recognized by publisher prefix or -maas suffix', () => {
    for (const m of [
      'meta/llama-3.3-70b-instruct-maas',
      'mistralai/mistral-large-2411',
      'qwen/qwen3-next-80b-a3b-instruct-maas',
      'deepseek-ai/deepseek-v3',
    ]) {
      expect(isVertexMaasModelId(m)).toBe(true)
    }
    // Gemini and Claude ids never carry either marker.
    for (const m of [
      'gemini-3.5-flash',
      'gemini-2.5-pro',
      'claude-sonnet-4-5@20250929',
    ]) {
      expect(isVertexMaasModelId(m)).toBe(false)
    }
  })

  test('the curated sets are env-overridable', () => {
    const prevC = process.env.VERTEX_CLAUDE_MODELS
    const prevM = process.env.VERTEX_MAAS_MODELS
    try {
      expect(curatedVertexClaudeModels()).toContain('claude-sonnet-4-5@20250929')
      expect(curatedVertexMaasModels().length).toBeGreaterThan(0)
      process.env.VERTEX_CLAUDE_MODELS = 'claude-x@1, claude-y@2'
      process.env.VERTEX_MAAS_MODELS = 'meta/custom-maas'
      expect(curatedVertexClaudeModels()).toEqual(['claude-x@1', 'claude-y@2'])
      expect(curatedVertexMaasModels()).toEqual(['meta/custom-maas'])
    } finally {
      if (prevC === undefined) delete process.env.VERTEX_CLAUDE_MODELS
      else process.env.VERTEX_CLAUDE_MODELS = prevC
      if (prevM === undefined) delete process.env.VERTEX_MAAS_MODELS
      else process.env.VERTEX_MAAS_MODELS = prevM
    }
  })
})

describe('catalog merge', () => {
  let dir: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rayu-vertex-'))
    process.env.RAYU_CONFIG_DIR = dir
    process.env.RAYU_DIAGNOSTICS_NO_FILE = '1'
    ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  })
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RAYU_CONFIG_DIR
    ;(await import('../src/utils/rayuConfig.ts'))._resetRayuConfigCache()
  })

  test('the catalog spans all three families and every id routes correctly', async () => {
    // The Gemini half needs no network here: with no credentials the live listing
    // fails and falls back to the curated Gemini set, which is exactly the
    // no-credentials path a user without ADC would hit.
    const { fetchProviderModels } = await import('../src/utils/rayuConfig.ts')
    const { resolveWireFormat } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    const provider: RayuProvider = {
      id: 'gemini-vertex',
      kind: 'vertex',
      gcpProject: 'my-project',
      gcpRegion: 'global',
    }
    const models = await fetchProviderModels(provider)
    const byFormat = { genai: 0, 'anthropic-messages': 0, 'openai-chat': 0 }
    for (const m of models) {
      const f = resolveWireFormat(provider, m) as keyof typeof byFormat
      if (f in byFormat) byFormat[f] += 1
    }
    // All three families present in ONE provider's catalog.
    expect(byFormat['anthropic-messages']).toBeGreaterThan(0)
    expect(byFormat['openai-chat']).toBeGreaterThan(0)
    expect(byFormat.genai).toBeGreaterThan(0)
    // No duplicates.
    expect(new Set(models).size).toBe(models.length)
  }, 30_000)
})
