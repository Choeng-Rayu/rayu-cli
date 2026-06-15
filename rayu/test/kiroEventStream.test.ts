import { describe, expect, test } from 'bun:test'
import {
  KiroEventType,
  concatFrames,
  encodeKiroFrame,
  parseKiroEventStream,
  parseKiroEventStreamBytes,
} from '../src/services/api/kiro/eventStream.ts'

function bytesToStream(bytes: Uint8Array, chunkSize: number): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
      }
    },
  }
}

describe('kiro eventStream decoder', () => {
  test('decodes text + thinking + metadata frames', () => {
    const bytes = concatFrames(
      encodeKiroFrame(KiroEventType.ReasoningContent, { text: 'thinking…' }),
      encodeKiroFrame(KiroEventType.AssistantResponse, { content: 'Hello', modelId: 'claude-sonnet-4.6' }),
      encodeKiroFrame(KiroEventType.AssistantResponse, { content: ' world' }),
      encodeKiroFrame(KiroEventType.Metadata, {
        tokenUsage: { uncachedInputTokens: 10, cacheReadInputTokens: 2, outputTokens: 5, totalTokens: 17 },
      }),
    )
    const events = parseKiroEventStreamBytes(bytes)
    expect(events.map(e => e.type)).toEqual([
      KiroEventType.ReasoningContent,
      KiroEventType.AssistantResponse,
      KiroEventType.AssistantResponse,
      KiroEventType.Metadata,
    ])
    expect(events[0]!.thinkingText).toBe('thinking…')
    expect(events[1]!.content).toBe('Hello')
    expect(events[1]!.modelId).toBe('claude-sonnet-4.6')
    expect(events[3]!.inputTokens).toBe(12)
    expect(events[3]!.outputTokens).toBe(5)
  })

  test('accumulates streamed tool input across frames until stop', () => {
    const bytes = concatFrames(
      encodeKiroFrame(KiroEventType.ToolUse, { toolUseId: 'tu_1', name: 'Read', input: '{"path":' }),
      encodeKiroFrame(KiroEventType.ToolUse, { toolUseId: 'tu_1', input: '"/a.ts"}' }),
      encodeKiroFrame(KiroEventType.ToolUse, { toolUseId: 'tu_1', stop: true }),
    )
    const events = parseKiroEventStreamBytes(bytes)
    const tool = events.find(e => e.type === KiroEventType.ToolUse)!
    expect(tool.toolName).toBe('Read')
    expect(tool.toolUseId).toBe('tu_1')
    expect(tool.toolInput).toBe('{"path":"/a.ts"}')
    expect(tool.toolStop).toBe(true)
  })

  test('flushes an in-progress tool with no stop frame at EOF', () => {
    const bytes = concatFrames(
      encodeKiroFrame(KiroEventType.ToolUse, { toolUseId: 'tu_2', name: 'ExitPlanMode', input: '{}' }),
    )
    const events = parseKiroEventStreamBytes(bytes)
    expect(events.filter(e => e.type === KiroEventType.ToolUse)).toHaveLength(1)
    expect(events[0]!.toolName).toBe('ExitPlanMode')
  })

  test('surfaces exception frames', () => {
    const bytes = encodeKiroFrame('ThrottlingException', { message: 'rate limited' }, 'exception')
    const events = parseKiroEventStreamBytes(bytes)
    expect(events[0]!.type).toBe(KiroEventType.Exception)
    expect(events[0]!.errorMessage).toBe('rate limited')
  })

  test('streaming parser handles frames split across arbitrary chunk boundaries', async () => {
    const bytes = concatFrames(
      encodeKiroFrame(KiroEventType.AssistantResponse, { content: 'abc' }),
      encodeKiroFrame(KiroEventType.AssistantResponse, { content: 'def' }),
    )
    const out: string[] = []
    for await (const ev of parseKiroEventStream(bytesToStream(bytes, 3))) {
      if (ev.type === KiroEventType.AssistantResponse) out.push(ev.content ?? '')
    }
    expect(out.join('')).toBe('abcdef')
  })

  test('throws on a corrupted prelude CRC', () => {
    const bytes = encodeKiroFrame(KiroEventType.AssistantResponse, { content: 'x' })
    bytes[8] ^= 0xff // corrupt prelude CRC
    expect(() => parseKiroEventStreamBytes(bytes)).toThrow(/prelude CRC/)
  })
})
