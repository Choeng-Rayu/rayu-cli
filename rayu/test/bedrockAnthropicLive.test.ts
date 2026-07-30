// Live Bedrock check: drives the REAL provider registry against
// bedrock-runtime with a Bedrock API key. Skipped unless RAYU_TEST_BEDROCK_KEY
// is set, so CI and other developers are unaffected.
//
// Run: RAYU_TEST_BEDROCK_KEY=$(cat /tmp/.rayu-bedrock-key) bun test test/bedrockAnthropicLive.test.ts
import { describe, expect, test } from 'bun:test'

const KEY = process.env.RAYU_TEST_BEDROCK_KEY
const REGION = process.env.RAYU_TEST_BEDROCK_REGION || 'us-east-1'
const MODEL =
  process.env.RAYU_TEST_BEDROCK_MODEL ||
  'global.anthropic.claude-haiku-4-5-20251001-v1:0'

const maybe = KEY ? describe : describe.skip

maybe('live: Claude on Bedrock via the unified Anthropic client', () => {
  async function client() {
    const { buildClient } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    return (await buildClient(
      {
        id: 'bedrock',
        kind: 'bedrock',
        apiKey: KEY,
        awsRegion: REGION,
      },
      { maxRetries: 0, model: MODEL },
    )) as import('@anthropic-ai/sdk/index.js').default
  }

  test('non-streaming beta.messages.create returns native Anthropic content', async () => {
    const c = await client()
    const res = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    })
    expect(res.type).toBe('message')
    expect(res.role).toBe('assistant')
    const text = res.content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('')
    expect(text.length).toBeGreaterThan(0)
    // Native Anthropic usage shape (no translation layer).
    expect(typeof res.usage.input_tokens).toBe('number')
    expect(typeof res.usage.output_tokens).toBe('number')
  }, 60_000)

  test('streaming .withResponse() yields a valid Anthropic event sequence', async () => {
    const c = await client()
    const { data } = await c.beta.messages
      .create(
        {
          model: MODEL,
          max_tokens: 24,
          messages: [{ role: 'user', content: 'Count: one two three' }],
          stream: true,
        },
        {},
      )
      .withResponse()

    const types: string[] = []
    let text = ''
    for await (const ev of data) {
      types.push(ev.type)
      if (
        ev.type === 'content_block_delta' &&
        'delta' in ev &&
        ev.delta.type === 'text_delta'
      ) {
        text += ev.delta.text
      }
    }
    // The AWS event-stream frames must arrive as a well-formed Anthropic stream.
    expect(types[0]).toBe('message_start')
    expect(types).toContain('content_block_start')
    expect(types).toContain('content_block_delta')
    expect(types).toContain('message_delta')
    expect(types.at(-1)).toBe('message_stop')
    expect(text.length).toBeGreaterThan(0)
  }, 60_000)

  test('tool use round-trips over the rewritten transport', async () => {
    const c = await client()
    const res = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather for a city',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
      messages: [{ role: 'user', content: 'Use get_weather for Paris.' }],
    })
    const toolUse = res.content.find(b => b.type === 'tool_use')
    expect(toolUse).toBeDefined()
    expect((toolUse as { name?: string })?.name).toBe('get_weather')
  }, 60_000)

  test('the live model catalog contains BOTH Claude and non-Claude models', async () => {
    const { fetchProviderModels } = await import('../src/utils/rayuConfig.ts')
    const models = await fetchProviderModels({
      id: 'bedrock',
      kind: 'bedrock',
      apiKey: KEY,
      awsRegion: REGION,
    })
    expect(models.length).toBeGreaterThan(10)
    const claude = models.filter(m => /anthropic|claude/i.test(m))
    const other = models.filter(m => !/anthropic|claude/i.test(m))
    // This is the whole point of the unified Bedrock provider: ONE entry whose
    // catalog spans both wire formats.
    expect(claude.length).toBeGreaterThan(0)
    expect(other.length).toBeGreaterThan(0)
  }, 60_000)

  test('every catalogued non-Claude id is actually ACCEPTED by the chat endpoint', async () => {
    // Regression guard for a real bug: the control plane's
    // /foundation-models ids carry version suffixes (openai.gpt-oss-120b-1:0)
    // and a different vendor prefix (moonshot. vs moonshotai.) than the mantle
    // chat endpoint accepts — only 27 of its 34 flagged ids matched. Listing
    // those would 404 at chat time, so the catalog sources this half from
    // mantle's own /models. Here we prove a sample really invokes.
    const { fetchProviderModels } = await import('../src/utils/rayuConfig.ts')
    const { bedrockBaseURL } = await import('../src/utils/rayuProviders.ts')
    const models = await fetchProviderModels({
      id: 'bedrock',
      kind: 'bedrock',
      apiKey: KEY,
      awsRegion: REGION,
    })
    const sample = models
      .filter(m => !/anthropic|claude/i.test(m))
      .filter(m => /gpt-oss|deepseek|kimi|minimax/i.test(m))
      .slice(0, 3)
    expect(sample.length).toBeGreaterThan(0)
    for (const model of sample) {
      const res = await fetch(`${bedrockBaseURL(REGION)}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4,
        }),
      })
      // A 404/400 "model does not exist" would mean the catalog lists an id the
      // endpoint cannot serve.
      expect(
        res.status,
        `${model} was rejected with ${res.status}`,
      ).toBeLessThan(400)
    }
  }, 120_000)

  test('each catalog model resolves to the right wire format', async () => {
    const { fetchProviderModels } = await import('../src/utils/rayuConfig.ts')
    const { resolveWireFormat } = await import(
      '../src/services/api/providerRegistry.ts'
    )
    const provider = {
      id: 'bedrock',
      kind: 'bedrock' as const,
      apiKey: KEY,
      awsRegion: REGION,
    }
    const models = await fetchProviderModels(provider)
    for (const m of models) {
      const expected = /anthropic|claude/i.test(m)
        ? 'anthropic-messages'
        : 'openai-chat'
      expect<string>(resolveWireFormat(provider, m)).toBe(expected)
    }
  }, 60_000)
})
