// Live end-to-end smoke tests against the user's REAL configured providers
// (NVIDIA + Doubleword). Opt-in only: set RAYU_LIVE=1 to enable. Without it (or
// without configured creds) every case skips cleanly, so the default `bun test`
// stays hermetic and never consumes provider credits.
//
//   RAYU_LIVE=1 bun test test/liveSmoke.test.ts
//
// SECURITY: API keys are read from ~/.rayu/providers.json and sent only to the
// provider's configured baseURL. Keys are NEVER printed or asserted on.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createOpenAICompatibleClient } from '../src/services/api/openaiAdapter.ts'

type Provider = {
  id: string
  kind: string
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  fetchedModels?: string[]
}

const LIVE = /^(1|true|yes|on)$/i.test(process.env.RAYU_LIVE ?? '')

/** Resolve the config home the same way getClaudeConfigHomeDir() does. */
function configHome(): string {
  const env = process.env.RAYU_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  if (env) return env
  const rayu = join(homedir(), '.rayu')
  if (existsSync(rayu)) return rayu
  const claude = join(homedir(), '.claude')
  if (existsSync(claude)) return claude
  return rayu
}

function loadProviders(): Provider[] {
  try {
    const path = join(configHome(), 'providers.json')
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { providers?: Provider[] }
    return Array.isArray(cfg.providers) ? cfg.providers : []
  } catch {
    return []
  }
}

/** A configured, usable openai-compatible provider by id, or null. */
export function liveProvider(id: string): Provider | null {
  const p = loadProviders().find(
    x => x.id === id && x.kind === 'openai-compatible' && x.apiKey && x.baseURL,
  )
  return p ?? null
}

const nvidia = liveProvider('nvidia')
const doubleword = liveProvider('doubleword')

// A small/fast model id per provider (overridable) for cheap smoke calls.
const NVIDIA_FAST = process.env.RAYU_LIVE_NVIDIA_MODEL ?? 'meta/llama-3.1-8b-instruct'
const DW_FAST = process.env.RAYU_LIVE_DW_MODEL ?? 'Qwen/Qwen3.5-9B'
const NVIDIA_VISION = process.env.RAYU_LIVE_NVIDIA_VISION ?? 'meta/llama-3.2-11b-vision-instruct'
const DW_VISION = process.env.RAYU_LIVE_DW_VISION ?? 'Qwen/Qwen3-VL-30B-A3B-Instruct-FP8'
const NVIDIA_NONCHAT = process.env.RAYU_LIVE_NVIDIA_NONCHAT ?? 'baai/bge-m3'

/** Call chat/completions on a non-chat model id; returns the thrown error. */
export async function callNonChatModel(p: Provider, model: string): Promise<unknown> {
  const client = createOpenAICompatibleClient({ apiKey: p.apiKey!, baseURL: p.baseURL!, maxRetries: 0 })
  try {
    await client.beta.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    return null
  } catch (e) {
    return e
  }
}

/** Build a solid-color square PNG and return its base64 (no data: prefix). */
async function redPngBase64(): Promise<string> {
  // pngjs ships no type declarations; it's a test-only image generator.
  // @ts-expect-error no types for 'pngjs'
  const { PNG } = await import('pngjs')
  const png = new PNG({ width: 16, height: 16 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 220; png.data[i + 1] = 20; png.data[i + 2] = 20; png.data[i + 3] = 255
  }
  return (PNG as any).sync.write(png).toString('base64')
}

/** Send an image + question; returns the answer text. */
export async function visionOnce(p: Provider, model: string): Promise<string> {
  const client = createOpenAICompatibleClient({ apiKey: p.apiKey!, baseURL: p.baseURL!, maxRetries: 2 })
  const data = await redPngBase64()
  const msg: any = await client.beta.messages.create({
    model, max_tokens: 64,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'What color is this image? Answer in one word.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ] }],
  })
  return (msg.content as any[]).find(b => b.type === 'text')?.text ?? ''
}

export async function chatOnce(p: Provider, model: string): Promise<any> {
  const client = createOpenAICompatibleClient({ apiKey: p.apiKey!, baseURL: p.baseURL!, maxRetries: 2 })
  // 512 tokens: reasoning models (e.g. Qwen3.5) spend output budget on hidden
  // reasoning before the answer, so a tiny cap yields empty content.
  return client.beta.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
  }) as Promise<any>
}

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the weather for a city',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}

/** Full tool loop: user -> assistant(tool_use) -> tool_result+text -> final. */
export async function toolRoundTrip(p: Provider, model: string): Promise<any> {
  const client = createOpenAICompatibleClient({ apiKey: p.apiKey!, baseURL: p.baseURL!, maxRetries: 2 })
  const ask = 'What is the weather in Paris? Use the get_weather tool.'
  const r1: any = await client.beta.messages.create({
    model, max_tokens: 512, tools: [WEATHER_TOOL],
    messages: [{ role: 'user', content: ask }],
  })
  const tu = (r1.content as any[]).find(b => b.type === 'tool_use')
  if (!tu) return { calledTool: false, r1 }
  // Turn 2 exercises the tool-result ordering fix (tool_result + trailing text).
  const r2: any = await client.beta.messages.create({
    model, max_tokens: 512, tools: [WEATHER_TOOL],
    messages: [
      { role: 'user', content: ask },
      { role: 'assistant', content: r1.content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: tu.id, content: '18 C and sunny' },
          { type: 'text', text: 'Summarize in one short sentence.' },
        ],
      },
    ],
  })
  const text = (r2.content as any[]).find(b => b.type === 'text')?.text ?? ''
  return { calledTool: true, toolName: tu.name, finalText: text }
}

/** Stream a prompt and collect thinking + text deltas (reasoning display). */
export async function streamReasoning(p: Provider, model: string): Promise<{ thinking: string; text: string }> {
  const client: any = createOpenAICompatibleClient({ apiKey: p.apiKey!, baseURL: p.baseURL!, maxRetries: 2 })
  const res: any = await client.beta.messages
    .create({ model, max_tokens: 1536, messages: [{ role: 'user', content: 'What is 2+2? Think briefly, then give the final answer.' }], stream: true })
    .withResponse()
  let thinking = '', text = ''
  for await (const e of res.data as AsyncIterable<any>) {
    if (e.delta?.type === 'thinking_delta') thinking += e.delta.thinking
    if (e.delta?.type === 'text_delta') text += e.delta.text
  }
  return { thinking, text }
}

describe('live smoke: NVIDIA', () => {
  test.skipIf(!LIVE || !nvidia)('chat returns text', async () => {
    const msg = await chatOnce(nvidia!, NVIDIA_FAST)
    expect(msg.type).toBe('message')
    const text = (msg.content as any[]).find(b => b.type === 'text')?.text ?? ''
    expect(text.length).toBeGreaterThan(0)
  }, 60_000)

  test.skipIf(!LIVE || !nvidia)('tool round-trip (ordering fix) yields a final answer', async () => {
    const r = await toolRoundTrip(nvidia!, NVIDIA_FAST)
    expect(r.calledTool).toBe(true)
    expect(r.toolName).toBe('get_weather')
    expect((r.finalText as string).length).toBeGreaterThan(0)
  }, 90_000)

  test.skipIf(!LIVE || !nvidia)('vision: describes an image (image_url passthrough)', async () => {
    const text = await visionOnce(nvidia!, NVIDIA_VISION)
    expect(text.length).toBeGreaterThan(0)
    expect(text.toLowerCase()).toContain('red')
  }, 90_000)

  test.skipIf(!LIVE || !nvidia)('streaming yields text (stream_options path)', async () => {
    const { text } = await streamReasoning(nvidia!, NVIDIA_FAST)
    expect(text.length).toBeGreaterThan(0)
  }, 90_000)

  test.skipIf(!LIVE || !nvidia)('non-chat model surfaces a normalized Anthropic API error', async () => {
    const { APIError } = await import('@anthropic-ai/sdk')
    const err: any = await callNonChatModel(nvidia!, NVIDIA_NONCHAT)
    expect(err).toBeInstanceOf(APIError)
    expect(typeof err.status).toBe('number')
    expect(err.status).toBeGreaterThanOrEqual(400)
  }, 60_000)
})

describe('live smoke: Doubleword', () => {
  test.skipIf(!LIVE || !doubleword)('chat returns text', async () => {
    const msg = await chatOnce(doubleword!, DW_FAST)
    expect(msg.type).toBe('message')
    const text = (msg.content as any[]).find(b => b.type === 'text')?.text ?? ''
    expect(text.length).toBeGreaterThan(0)
  }, 60_000)

  test.skipIf(!LIVE || !doubleword)('streaming surfaces reasoning (thinking) + answer', async () => {
    const { thinking, text } = await streamReasoning(doubleword!, DW_FAST)
    expect(thinking.length).toBeGreaterThan(0)
    expect(text.length).toBeGreaterThan(0)
  }, 90_000)

  test.skipIf(!LIVE || !doubleword)('tool round-trip yields a final answer', async () => {
    const r = await toolRoundTrip(doubleword!, DW_FAST)
    expect(r.calledTool).toBe(true)
    expect((r.finalText as string).length).toBeGreaterThan(0)
  }, 120_000)

  test.skipIf(!LIVE || !doubleword)('vision: describes an image', async () => {
    const text = await visionOnce(doubleword!, DW_VISION)
    expect(text.toLowerCase()).toContain('red')
  }, 120_000)
})
