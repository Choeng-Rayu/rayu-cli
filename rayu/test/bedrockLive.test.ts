import { describe, expect, test } from 'bun:test'

// Live smoke test. Only runs when BEDROCK_LIVE_TOKEN is set, so CI without
// credentials stays green. Exercises the REAL fetch + adapter code paths.
const TOKEN = process.env.BEDROCK_LIVE_TOKEN
const REGION = process.env.BEDROCK_LIVE_REGION ?? 'us-west-2'
const maybe = TOKEN ? describe : describe.skip

maybe('bedrock live (BEDROCK_LIVE_TOKEN set)', () => {
  test('fetchProviderModels returns only ON_DEMAND chat ids (no inference-profile prefixes)', async () => {
    const { fetchProviderModels } = await import('../src/utils/rayuConfig.ts')
    const { bedrockBaseURL } = await import('../src/utils/rayuProviders.ts')
    const models = await fetchProviderModels({
      id: 'bedrock',
      kind: 'bedrock',
      apiKey: TOKEN!,
      awsRegion: REGION,
      baseURL: bedrockBaseURL(REGION),
    })
    expect(models.length).toBeGreaterThan(10)
    expect(models.some(m => m.startsWith('openai.gpt-oss'))).toBe(true)
    // ON_DEMAND only: no cross-region inference-profile geo prefixes, which the
    // OpenAI chat endpoint rejects (400/404).
    for (const m of models) {
      expect(m).not.toMatch(/^(us|eu|apac|au|global)\./)
    }
  })

  test('OpenAI adapter completes a chat turn against bedrock-runtime', async () => {
    const { createOpenAICompatibleClient } = await import(
      '../src/services/api/openaiAdapter.ts'
    )
    const { bedrockBaseURL } = await import('../src/utils/rayuProviders.ts')
    const client = createOpenAICompatibleClient({
      apiKey: TOKEN!,
      baseURL: bedrockBaseURL(REGION),
      maxRetries: 1,
      providerId: 'bedrock',
    }) as {
      beta: {
        messages: {
          create: (p: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>
        }
      }
    }
    const msg = await client.beta.messages.create({
      model: 'openai.gpt-oss-120b-1:0',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    })
    const text = msg.content.map(b => b.text ?? '').join('')
    expect(text.length).toBeGreaterThan(0)
  })

  test('anthropic-bedrock: fetchProviderModels lists Claude inference-profile ids', async () => {
    const { fetchProviderModels } = await import('../src/utils/rayuConfig.ts')
    const models = await fetchProviderModels({
      id: 'bedrock-anthropic',
      kind: 'bedrock',
      bedrockApi: 'anthropic',
      apiKey: TOKEN!,
      awsRegion: REGION,
    })
    expect(models.length).toBeGreaterThan(0)
    expect(models.some(m => /anthropic|claude/i.test(m))).toBe(true)
  })

  test('anthropic-bedrock: AnthropicBedrock SDK completes a Claude chat with the bearer token', async () => {
    const { fetchProviderModels } = await import('../src/utils/rayuConfig.ts')
    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    const models = await fetchProviderModels({
      id: 'bedrock-anthropic',
      kind: 'bedrock',
      bedrockApi: 'anthropic',
      apiKey: TOKEN!,
      awsRegion: REGION,
    })
    const model =
      models.find(m => /claude-sonnet-4-6/i.test(m)) ??
      models.find(m => /claude-sonnet-4-5/i.test(m)) ??
      models.find(m => /claude/i.test(m))
    if (!model) return // region may expose no Claude profiles for this key
    const client = new AnthropicBedrock({ apiKey: TOKEN!, awsRegion: REGION })
    const msg = await client.beta.messages.create({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    })
    const text = (msg.content as Array<{ type: string; text?: string }>)
      .map(b => b.text ?? '')
      .join('')
    expect(text.length).toBeGreaterThan(0)
  })
})
