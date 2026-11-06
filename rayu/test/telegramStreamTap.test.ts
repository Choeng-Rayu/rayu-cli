/**
 * The headless stream tap: raw provider stream events become the same
 * startTurn / onTextDelta / endTurn sequence the REPL drives from its text buffer.
 */
import { describe, expect, test } from 'bun:test'

import {
  TelegramStreamTap,
  type TelegramTurnSink,
} from '../src/telegram/telegramStreamTap.js'

function harness(): {
  tap: TelegramStreamTap
  events: string[]
  deltas: string[]
} {
  const events: string[] = []
  const deltas: string[] = []
  const sink: TelegramTurnSink = {
    startTurn() {
      events.push('start')
    },
    onTextDelta(delta) {
      deltas.push(delta)
    },
    endTurn() {
      events.push('end')
    },
  }
  return { tap: new TelegramStreamTap(sink), events, deltas }
}

const textDelta = (text: string): unknown => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text },
})

describe('TelegramStreamTap', () => {
  test('starts one turn on the first text delta and appends every delta', () => {
    const h = harness()
    h.tap.onStreamEvent(textDelta('Hel'))
    h.tap.onStreamEvent(textDelta('lo'))
    expect(h.events).toEqual(['start'])
    expect(h.deltas).toEqual(['Hel', 'lo'])
  })

  test('thinking deltas neither open a mirror nor leak text', () => {
    const h = harness()
    h.tap.onStreamEvent({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'hmm' },
    })
    expect(h.events).toEqual([])
    expect(h.deltas).toEqual([])
    expect(h.tap.isOpen).toBe(false)
  })

  test('other stream events are ignored', () => {
    const h = harness()
    h.tap.onStreamEvent({ type: 'message_start', message: {} })
    h.tap.onStreamEvent({ type: 'content_block_start', index: 0 })
    h.tap.onStreamEvent({ type: 'message_stop' })
    expect(h.events).toEqual([])
  })

  test('an empty text delta does not open a turn', () => {
    const h = harness()
    h.tap.onStreamEvent(textDelta(''))
    expect(h.events).toEqual([])
    expect(h.tap.isOpen).toBe(false)
  })

  test('malformed events never throw', () => {
    const h = harness()
    for (const event of [null, 42, 'nope', {}, { type: 'content_block_delta' }, { type: 'content_block_delta', delta: null }]) {
      expect(() => h.tap.onStreamEvent(event)).not.toThrow()
    }
    expect(h.events).toEqual([])
  })

  test('end closes an open turn exactly once', async () => {
    const h = harness()
    h.tap.onStreamEvent(textDelta('x'))
    await h.tap.end()
    await h.tap.end()
    expect(h.events).toEqual(['start', 'end'])
    expect(h.tap.isOpen).toBe(false)
  })

  test('end on a turn with no text does nothing', async () => {
    const h = harness()
    await h.tap.end()
    expect(h.events).toEqual([])
  })

  test('a second message in the same turn opens a new mirror', async () => {
    const h = harness()
    h.tap.onStreamEvent(textDelta('first'))
    await h.tap.end()
    h.tap.onStreamEvent(textDelta('second'))
    expect(h.events).toEqual(['start', 'end', 'start'])
    expect(h.deltas).toEqual(['first', 'second'])
  })

  // ── the close/first-delta race ────────────────────────────────────────────────
  // `endTurn` finalizes with a network round trip and the sink clears its mirror only
  // after that. A delta arriving mid-close must not be appended to the dying mirror,
  // and must not open a new one that the close would then null out.
  test('deltas arriving during a close are buffered and replayed afterwards', async () => {
    const order: string[] = []
    let releaseClose: (() => void) | undefined
    const tap = new TelegramStreamTap({
      startTurn: () => order.push('start'),
      onTextDelta: d => order.push(`delta:${d}`),
      endTurn: () =>
        new Promise<void>(resolve => {
          order.push('end:begin')
          releaseClose = () => {
            order.push('end:done')
            resolve()
          }
        }),
    })

    tap.onStreamEvent(textDelta('A'))
    const closing = tap.end()
    // The next message's deltas arrive while the first is still finalizing.
    tap.onStreamEvent(textDelta('B1'))
    tap.onStreamEvent(textDelta('B2'))
    expect(order).toEqual(['start', 'delta:A', 'end:begin'])

    releaseClose?.()
    await closing
    // Replayed in order, after the close, through exactly one new startTurn.
    expect(order).toEqual([
      'start',
      'delta:A',
      'end:begin',
      'end:done',
      'start',
      'delta:B1B2',
    ])
  })

  test('a settled message while closing waits for that close instead of starting another', async () => {
    const order: string[] = []
    let releaseClose: (() => void) | undefined
    const tap = new TelegramStreamTap({
      startTurn: () => order.push('start'),
      onTextDelta: d => order.push(`delta:${d}`),
      endTurn: () =>
        new Promise<void>(resolve => {
          releaseClose = () => resolve()
        }),
    })

    tap.onStreamEvent(textDelta('A'))
    const first = tap.end()
    const second = tap.end() // a second settle before the first finished
    expect(second).toBe(first)
    releaseClose?.()
    await second
    expect(order.filter(e => e === 'start')).toHaveLength(1)
  })

  test('a failing close still lets the next message mirror', async () => {
    const events: string[] = []
    let calls = 0
    const tap = new TelegramStreamTap({
      startTurn: () => events.push('start'),
      onTextDelta: d => events.push(`delta:${d}`),
      endTurn: () => {
        calls += 1
        if (calls === 1) throw new Error('telegram down')
      },
    })
    tap.onStreamEvent(textDelta('A'))
    await tap.end() // must not reject
    tap.onStreamEvent(textDelta('B'))
    expect(events).toEqual(['start', 'delta:A', 'start', 'delta:B'])
  })
})
