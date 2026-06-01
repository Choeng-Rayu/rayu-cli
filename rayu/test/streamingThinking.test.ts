import { describe, expect, test } from 'bun:test'
import {
  handleMessageFromStream,
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
