import { describe, expect, test } from 'bun:test'
import { KiroEventType, type KiroEvent } from '../src/services/api/kiro/eventStream.ts'
import {
  toBetaMessageFromKiro,
  translateKiroStream,
} from '../src/services/api/kiro/translateStream.ts'

async function* asStream(events: KiroEvent[]): AsyncGenerator<KiroEvent> {
  for (const e of events) yield e
}

const SAMPLE: KiroEvent[] = [
  { type: KiroEventType.ReasoningContent, thinkingText: 'let me think' },
  { type: KiroEventType.ReasoningContent, signature: 'sig123' },
  { type: KiroEventType.AssistantResponse, content: 'Hello', modelId: 'claude-sonnet-4.6' },
  { type: KiroEventType.AssistantResponse, content: ' world' },
  { type: KiroEventType.ToolUse, toolUseId: 'tu_1', toolName: 'Read', toolInput: '{"path":"a.ts"}', toolStop: true },
  { type: KiroEventType.Metadata, inputTokens: 12, outputTokens: 7 },
]

describe('kiro translateKiroStream', () => {
  test('emits a well-formed Anthropic event sequence', async () => {
    const out: Array<{ type: string } & Record<string, unknown>> = []
    for await (const ev of translateKiroStream(asStream(SAMPLE), 'claude-sonnet-4.6')) {
      out.push(ev)
    }
    expect(out[0]!.type).toBe('message_start')
    expect(out[out.length - 1]!.type).toBe('message_stop')

    // thinking block
    const thinkingStart = out.find(e => e.type === 'content_block_start' && (e.content_block as { type: string }).type === 'thinking')
    expect(thinkingStart).toBeDefined()
    expect(out.some(e => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'thinking_delta')).toBe(true)
    expect(out.some(e => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'signature_delta')).toBe(true)

    // text block
    expect(out.some(e => e.type === 'content_block_delta' && (e.delta as { type: string; text?: string }).type === 'text_delta')).toBe(true)

    // tool_use block + input_json_delta
    const toolStart = out.find(e => e.type === 'content_block_start' && (e.content_block as { type: string }).type === 'tool_use')
    expect((toolStart!.content_block as { name: string; id: string }).name).toBe('Read')
    expect((toolStart!.content_block as { id: string }).id).toBe('tu_1')
    expect(out.some(e => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'input_json_delta')).toBe(true)

    // message_delta: stop_reason tool_use + usage
    const md = out.find(e => e.type === 'message_delta')!
    expect((md.delta as { stop_reason: string }).stop_reason).toBe('tool_use')
    expect((md.usage as { input_tokens: number }).input_tokens).toBe(12)

    // every content_block_start has a matching content_block_stop
    const starts = out.filter(e => e.type === 'content_block_start').length
    const stops = out.filter(e => e.type === 'content_block_stop').length
    expect(starts).toBe(stops)
  })

  test('throws on an exception event', async () => {
    const events = [{ type: KiroEventType.Exception, errorMessage: 'boom' }] as KiroEvent[]
    await expect(
      (async () => {
        for await (const _ of translateKiroStream(asStream(events), 'm')) {
          void _
        }
      })(),
    ).rejects.toThrow(/boom/)
  })
})

describe('kiro toBetaMessageFromKiro', () => {
  test('assembles thinking + text + tool_use into a BetaMessage', () => {
    const msg = toBetaMessageFromKiro(SAMPLE, 'claude-sonnet-4.6')
    const content = msg.content as Array<Record<string, unknown>>
    expect(content[0]!.type).toBe('thinking')
    expect(content[0]!.thinking).toBe('let me think')
    expect(content[0]!.signature).toBe('sig123')
    expect(content[1]!.type).toBe('text')
    expect(content[1]!.text).toBe('Hello world')
    expect(content[2]!.type).toBe('tool_use')
    expect(content[2]!.name).toBe('Read')
    expect(content[2]!.input).toEqual({ path: 'a.ts' })
    expect(msg.stop_reason).toBe('tool_use')
    expect((msg.usage as { input_tokens: number }).input_tokens).toBe(12)
  })
})

describe('kiro inline <thinking> extraction (current Kiro behaviour)', () => {
  test('streaming: leading <thinking>…</thinking> becomes a thinking block + clean text', async () => {
    const events: KiroEvent[] = [
      {
        type: KiroEventType.AssistantResponse,
        content: '<thinking>\nLet me compute 47*89.\n</thinking>\n\nThe answer is 4183.',
      },
    ]
    const out: Array<{ type: string } & Record<string, unknown>> = []
    for await (const ev of translateKiroStream(asStream(events), 'claude-sonnet-4.6')) out.push(ev)

    const thinkingText = out
      .filter(e => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'thinking_delta')
      .map(e => (e.delta as { thinking: string }).thinking)
      .join('')
    const text = out
      .filter(e => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'text_delta')
      .map(e => (e.delta as { text: string }).text)
      .join('')
    expect(thinkingText).toContain('Let me compute 47*89.')
    expect(text).toContain('The answer is 4183.')
    expect(text).not.toContain('<thinking>')
    expect(text).not.toContain('</thinking>')
    // matching start/stop
    expect(out.filter(e => e.type === 'content_block_start').length).toBe(
      out.filter(e => e.type === 'content_block_stop').length,
    )
  })

  test('streaming: tags split across chunk boundaries', async () => {
    const chunks = ['<thin', 'king>rea', 'soning', '</thin', 'king>ans', 'wer']
    const events: KiroEvent[] = chunks.map(c => ({ type: KiroEventType.AssistantResponse, content: c }))
    const out: Array<{ type: string } & Record<string, unknown>> = []
    for await (const ev of translateKiroStream(asStream(events), 'm')) out.push(ev)
    const thinking = out
      .filter(e => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'thinking_delta')
      .map(e => (e.delta as { thinking: string }).thinking)
      .join('')
    const text = out
      .filter(e => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'text_delta')
      .map(e => (e.delta as { text: string }).text)
      .join('')
    expect(thinking).toBe('reasoning')
    expect(text).toBe('answer')
  })

  test('plain text (no thinking) passes through unchanged', async () => {
    const events: KiroEvent[] = [{ type: KiroEventType.AssistantResponse, content: 'just an answer' }]
    const out: Array<{ type: string } & Record<string, unknown>> = []
    for await (const ev of translateKiroStream(asStream(events), 'm')) out.push(ev)
    expect(out.some(e => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'thinking_delta')).toBe(false)
    const text = out
      .filter(e => e.type === 'content_block_delta' && (e.delta as { type: string }).type === 'text_delta')
      .map(e => (e.delta as { text: string }).text)
      .join('')
    expect(text).toBe('just an answer')
  })

  test('non-streaming: inline <thinking> splits into thinking + text blocks', () => {
    const events: KiroEvent[] = [
      { type: KiroEventType.AssistantResponse, content: '<thinking>reasoning here</thinking>\n\nfinal answer' },
    ]
    const msg = toBetaMessageFromKiro(events, 'claude-sonnet-4.6')
    const content = msg.content as Array<Record<string, unknown>>
    expect(content[0]!.type).toBe('thinking')
    expect(content[0]!.thinking).toBe('reasoning here')
    expect(content[1]!.type).toBe('text')
    expect((content[1]!.text as string).trim()).toBe('final answer')
  })
})
