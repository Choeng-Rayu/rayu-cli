/**
 * Contracts behind the panel's streaming performance work.
 *
 *  - MessageCoalescer: per-token host→webview messages merge per frame without
 *    changing what the reducer ends up with, and never reorder around a
 *    structural message.
 *  - sameBlockProps: an unchanged transcript row is recognised as unchanged even
 *    though its `tools`/`thinking` arrays are rebuilt every render.
 *  - NdjsonReader: a large frame delivered in pipe-sized chunks is scanned once,
 *    and the frame ceiling still holds.
 */
import { describe, expect, test } from 'bun:test'

import { MessageCoalescer } from '../src/vscode/host/panel/messageCoalescer.js'
import {
  MAX_FRAME_BYTES,
  NdjsonReader,
  type NdjsonFrameError,
} from '../src/vscode/host/engine/ndjsonReader.js'
import type {
  HostToWebviewEnvelope,
  HostToWebviewMessage,
  ThinkingEntryView,
  TurnProgressView,
} from '../src/vscode/shared/webviewProtocol.js'
import { sameBlockProps } from '../src/vscode/webview/blockProps.js'

function recorder(): { sent: HostToWebviewEnvelope[]; coalescer: MessageCoalescer } {
  const sent: HostToWebviewEnvelope[] = []
  return { sent, coalescer: new MessageCoalescer(envelope => sent.push(envelope), 1_000) }
}

/** What the webview would dispatch, in order, after unwrapping batches. */
function unwrap(sent: readonly HostToWebviewEnvelope[]): HostToWebviewMessage[] {
  return sent.flatMap(envelope => (envelope.type === 'batch' ? envelope.messages : [envelope]))
}

function thinking(text: string): ThinkingEntryView {
  return {
    entryId: 'thinking-a-0',
    sourceMessageId: 'a',
    blockIndex: 0,
    text,
    streaming: true,
    startTime: 0,
    truncated: false,
  }
}

const progress = (label: string) => ({ label }) as unknown as TurnProgressView

describe('MessageCoalescer', () => {
  test('per-token deltas for one entry arrive as one concatenated delta', () => {
    const { sent, coalescer } = recorder()
    for (const delta of ['Hel', 'lo, ', 'world']) {
      coalescer.post({ type: 'appendPartial', id: 'a', kind: 'text', delta })
    }
    expect(sent).toHaveLength(0)
    coalescer.flush()
    expect(unwrap(sent)).toEqual([
      { type: 'appendPartial', id: 'a', kind: 'text', delta: 'Hello, world' },
    ])
  })

  test('snapshots keep only their newest value, delivered as one batch', () => {
    const { sent, coalescer } = recorder()
    coalescer.post({ type: 'setTurnProgress', progress: progress('one') })
    coalescer.post({ type: 'updateThinking', thinking: thinking('a') })
    coalescer.post({ type: 'setTurnProgress', progress: progress('two') })
    coalescer.post({ type: 'updateThinking', thinking: thinking('ab') })
    coalescer.post({ type: 'appendToolOutput', id: 't', text: 'tail 1' })
    coalescer.post({ type: 'appendToolOutput', id: 't', text: 'tail 2' })
    coalescer.flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.type).toBe('batch')
    expect(unwrap(sent)).toEqual([
      { type: 'setTurnProgress', progress: progress('two') },
      { type: 'updateThinking', thinking: thinking('ab') },
      { type: 'appendToolOutput', id: 't', text: 'tail 2' },
    ])
  })

  test('a structural message flushes everything held before it, in order', () => {
    const { sent, coalescer } = recorder()
    coalescer.post({ type: 'appendPartial', id: 'a', kind: 'text', delta: 'final words' })
    coalescer.post({ type: 'completeMessage', id: 'a' })
    expect(unwrap(sent)).toEqual([
      { type: 'appendPartial', id: 'a', kind: 'text', delta: 'final words' },
      { type: 'completeMessage', id: 'a' },
    ])
  })

  test('deltas for different entries or kinds are never merged together', () => {
    const { sent, coalescer } = recorder()
    coalescer.post({ type: 'appendPartial', id: 'a', kind: 'text', delta: 'x' })
    coalescer.post({ type: 'appendPartial', id: 'b', kind: 'text', delta: 'y' })
    coalescer.post({ type: 'appendPartial', id: 'a', kind: 'thinking', delta: 'z' })
    coalescer.flush()
    expect(unwrap(sent)).toHaveLength(3)
  })

  test('the window flushes on its own', async () => {
    const sent: HostToWebviewEnvelope[] = []
    const coalescer = new MessageCoalescer(envelope => sent.push(envelope), 5)
    coalescer.post({ type: 'appendPartial', id: 'a', kind: 'text', delta: 'x' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(unwrap(sent)).toEqual([{ type: 'appendPartial', id: 'a', kind: 'text', delta: 'x' }])
  })

  test('clear drops held messages for a view that went away', () => {
    const { sent, coalescer } = recorder()
    coalescer.post({ type: 'appendPartial', id: 'a', kind: 'text', delta: 'x' })
    coalescer.clear()
    coalescer.flush()
    expect(sent).toHaveLength(0)
  })
})

describe('sameBlockProps', () => {
  const entry = { id: 'e', kind: 'tool' }
  const onToggle = () => {}

  test('rebuilt arrays with the same members are equal', () => {
    expect(
      sameBlockProps(
        { tools: [entry], onToggle, detailed: false },
        { tools: [entry], onToggle, detailed: false },
      ),
    ).toBe(true)
  })

  test('a replaced member, a changed scalar or a different prop set is not', () => {
    expect(sameBlockProps({ tools: [entry] }, { tools: [{ ...entry }] })).toBe(false)
    expect(sameBlockProps({ tools: [entry] }, { tools: [entry, entry] })).toBe(false)
    expect(sameBlockProps({ detailed: false }, { detailed: true })).toBe(false)
    expect(sameBlockProps({ a: undefined }, { b: undefined })).toBe(false)
  })
})

describe('NdjsonReader with large frames', () => {
  test('a 16 MiB frame in 64 KiB chunks parses once and quickly', () => {
    const frames: unknown[] = []
    const reader = new NdjsonReader({
      onFrame: frame => frames.push(frame),
      onError: error => {
        throw error
      },
    })
    const text = 'x'.repeat(16 * 1024 * 1024)
    const payload = `${JSON.stringify({ text })}\n{"id":2}\n`
    const started = performance.now()
    for (let i = 0; i < payload.length; i += 64 * 1024) {
      reader.push(payload.slice(i, i + 64 * 1024))
    }
    const elapsed = performance.now() - started

    expect(frames).toHaveLength(2)
    expect((frames[0] as { text: string }).text.length).toBe(text.length)
    expect(frames[1]).toEqual({ id: 2 })
    // Quadratic rescanning took ~650 ms here; linear is a few tens of ms. Generous
    // headroom so a slow CI machine cannot make this flaky.
    expect(elapsed).toBeLessThan(400)
  })

  test('a stream that never sends a newline still hits the ceiling', () => {
    let error: NdjsonFrameError | null = null
    const frames: unknown[] = []
    const reader = new NdjsonReader({
      onFrame: frame => frames.push(frame),
      onError: e => {
        error = e
      },
    })
    const chunk = 'y'.repeat(8 * 1024 * 1024)
    for (let sent = 0; sent <= MAX_FRAME_BYTES && error === null; sent += chunk.length) {
      reader.push(chunk)
    }
    expect((error as NdjsonFrameError | null)?.kind).toBe('frame-too-large')
    reader.push('\n{"id":1}\n')
    expect(frames).toHaveLength(0)
  })
})


describe('NdjsonReader when a frame handler throws', () => {
  function throwingOnce(): { reader: NdjsonReader; seen: unknown[] } {
    const seen: unknown[] = []
    let first = true
    const reader = new NdjsonReader({
      onFrame: frame => {
        if (first) {
          first = false
          throw new Error('handler bug')
        }
        seen.push(frame)
      },
      onError: error => {
        throw error
      },
    })
    return { reader, seen }
  }

  test('the error surfaces, and the frames after it in the chunk are not lost', () => {
    const { reader, seen } = throwingOnce()
    expect(() => reader.push('{"id":1}\n{"id":2}\n{"id":3}\n')).toThrow('handler bug')
    reader.push('{"id":4}\n')
    // One of the frames after a bad one may be the response the panel is waiting on.
    expect(seen).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }])
  })

  test('frames left behind are delivered by end() when no more data arrives', () => {
    const { reader, seen } = throwingOnce()
    expect(() => reader.push('{"id":1}\n{"id":2}\n{"id":3}')).toThrow('handler bug')
    reader.end()
    expect(seen).toEqual([{ id: 2 }, { id: 3 }])
  })
})
