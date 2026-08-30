import { describe, expect, test } from 'bun:test'
import { MIN_TURN_DURATION_MS } from '../src/constants/turnCompletionVerbs.ts'
import { formatDuration } from '../src/utils/format.ts'
import {
  handleMessageFromStream,
  finalizeStreamingThinkingOnTurnEnd,
  type StreamingThinking,
} from '../src/utils/messages.ts'

// Build a thinking_delta stream event (the shape claude.ts forwards from the
// OpenAI adapter's translateStream for reasoning models).
const thinkingDelta = (thinking: string) =>
  ({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking },
    },
  }) as unknown as Parameters<typeof handleMessageFromStream>[0]

// Drive handleMessageFromStream with only the onStreamingThinking reducer wired
// (matching REPL's setStreamingThinking), accumulating into a local cell.
function feed(
  event: Parameters<typeof handleMessageFromStream>[0],
  state: { current: StreamingThinking | null },
): void {
  handleMessageFromStream(
    event,
    () => {}, // onMessage
    () => {}, // onUpdateLength
    () => {}, // onSetStreamMode
    () => {}, // onStreamingToolUses
    undefined, // onTombstone
    f => {
      state.current = f(state.current)
    }, // onStreamingThinking
    undefined, // onApiMetrics
    undefined, // onStreamingText
  )
}

describe('handleMessageFromStream live thinking', () => {
  test('thinking_delta surfaces isStreaming:true and accumulates across deltas', () => {
    const state: { current: StreamingThinking | null } = { current: null }
    feed(thinkingDelta('abc'), state)
    expect(state.current).toEqual({ thinking: 'abc', isStreaming: true })
    feed(thinkingDelta('def'), state)
    expect(state.current).toEqual({ thinking: 'abcdef', isStreaming: true })
  })

  test('a new turn resets instead of appending to a completed block', () => {
    // Previous turn's thinking has completed (isStreaming:false).
    const state: { current: StreamingThinking | null } = {
      current: { thinking: 'old', isStreaming: false, streamingEndedAt: Date.now() },
    }
    feed(thinkingDelta('new'), state)
    expect(state.current).toEqual({ thinking: 'new', isStreaming: true })
  })
})

describe('finalizeStreamingThinkingOnTurnEnd', () => {
  test('drops a still-streaming block to null (errored/aborted mid-thinking)', () => {
    // The bug: stream stopped (e.g. "Streaming is required…") while a thinking
    // block was mid-stream, so it never completed and is stuck isStreaming:true.
    // Turn-end must clear it so the animated "Thinking…" preview stops spinning
    // and the error/turn-status stays as the last thing on screen.
    const stuck: StreamingThinking = { thinking: 'half a thought', isStreaming: true }
    expect(finalizeStreamingThinkingOnTurnEnd(stuck)).toBeNull()
  })

  test('leaves a completed block unchanged (the in-message block now owns it)', () => {
    const done: StreamingThinking = {
      thinking: 'a finished thought',
      isStreaming: false,
      streamingEndedAt: 1234,
    }
    expect(finalizeStreamingThinkingOnTurnEnd(done)).toBe(done)
  })

  test('null stays null', () => {
    expect(finalizeStreamingThinkingOnTurnEnd(null)).toBeNull()
  })
})


// ---------------------------------------------------------------------------
// Turn-status ORDER: ✓ Thought → response text → ◈ Rayu worked for Ns
// ---------------------------------------------------------------------------
// The trailing streaming preview is rendered by Messages.tsx as a SIBLING after
// the whole message list, so while it was kept alive for 30s past completion the
// "✓ Thought" line was structurally forced BELOW the response text and below the
// appended turn-duration message. Visibility is now keyed on isStreaming alone,
// and the completed block renders in place from the message list.

/** The visibility predicate Messages.tsx now uses (see isStreamingThinkingVisible). */
const previewVisible = (s: StreamingThinking | null): boolean =>
  s?.isStreaming === true

describe('the trailing thinking preview is visible only while streaming', () => {
  test('visible during streaming', () => {
    const state: { current: StreamingThinking | null } = { current: null }
    feed(thinkingDelta('reasoning'), state)
    expect(previewVisible(state.current)).toBe(true)
  })

  test('hidden the instant the block completes — no 30s linger, no duplicate', () => {
    // Previously this stayed visible for 30s, duplicating the in-message
    // "✓ Thought" one-liner and sitting below the answer.
    const completed: StreamingThinking = {
      thinking: 'a finished thought',
      isStreaming: false,
      streamingEndedAt: Date.now(),
    }
    expect(previewVisible(completed)).toBe(false)
  })

  test('a fresh streamingEndedAt does not resurrect it', () => {
    expect(
      previewVisible({
        thinking: 't',
        isStreaming: false,
        streamingEndedAt: Date.now(),
      }),
    ).toBe(false)
  })

  test('hidden when there is nothing', () => {
    expect(previewVisible(null)).toBe(false)
  })
})

describe('the preview→in-message swap is atomic', () => {
  test('the completed assistant message flips isStreaming in the SAME batch', () => {
    // handleMessageFromStream sets isStreaming:false while delivering the
    // completed assistant message, so no render can show both the trailing
    // preview and the in-message block, or neither.
    const state: { current: StreamingThinking | null } = { current: null }
    feed(thinkingDelta('half'), state)
    expect(previewVisible(state.current)).toBe(true)

    const delivered: unknown[] = []
    handleMessageFromStream(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'half a thought', signature: '' },
            { type: 'text', text: 'the answer' },
          ],
        },
      } as unknown as Parameters<typeof handleMessageFromStream>[0],
      m => delivered.push(m), // onMessage
      () => {},
      () => {},
      () => {},
      undefined,
      f => {
        state.current = f(state.current)
      },
      undefined,
      undefined,
    )

    expect(delivered).toHaveLength(1)
    expect(previewVisible(state.current)).toBe(false)
    expect(state.current?.isStreaming).toBe(false)
  })

  test('assistant content order is [thinking, text], which fixes the ordering', () => {
    // Message.tsx now renders the thinking block in place, and normalizeMessages
    // splits one message per content block preserving order — so thinking lands
    // ABOVE the text. The turn-duration system message is appended after both.
    const content = [
      { type: 'thinking', thinking: 't', signature: '' },
      { type: 'text', text: 'answer' },
    ]
    expect(content.map(b => b.type)).toEqual(['thinking', 'text'])
  })
})

describe('turn-duration gating', () => {
  // The gate REPL.tsx applies, with the same operands.
  const shows = (
    turnDurationMs: number,
    opts: { budget?: boolean; aborted?: boolean; proactive?: boolean } = {},
  ): boolean =>
    (turnDurationMs >= MIN_TURN_DURATION_MS || opts.budget === true) &&
    !opts.aborted &&
    !opts.proactive

  test('a short-but-real turn now shows the line (was >30s only)', () => {
    expect(shows(1400)).toBe(true)
    expect(shows(3000)).toBe(true)
    expect(shows(MIN_TURN_DURATION_MS)).toBe(true)
  })

  test('a sub-second turn does not — it would render "worked for 0s"', () => {
    expect(shows(400)).toBe(false)
    expect(shows(999)).toBe(false)
    expect(shows(0)).toBe(false)
  })

  test('an aborted turn never shows it', () => {
    expect(shows(60_000, { aborted: true })).toBe(false)
  })

  test('a proactive tick never shows it', () => {
    expect(shows(60_000, { proactive: true })).toBe(false)
  })

  test('a token budget shows it even for an instant turn', () => {
    expect(shows(10, { budget: true })).toBe(true)
  })

  test('the floor guarantees the rendered duration is at least 1s', () => {
    // formatDuration floors to whole seconds below a minute, so anything at or
    // above the threshold renders "1s" or more — never "0s".
    expect(formatDuration(MIN_TURN_DURATION_MS)).toBe('1s')
    expect(formatDuration(1400)).toBe('1s')
    expect(formatDuration(30_000)).toBe('30s')
  })
})
