import { describe, expect, test } from 'bun:test'
import { coalesceEphemeralProgressMessages } from '../src/utils/progressCoalescing.js'

// Minimal message-shaped fixtures (the helper is structural — it only reads
// `type`, `parentToolUseID`, and `data.type`).
type TestMsg =
  | { type: 'progress'; parentToolUseID: string; data: { type: string }; uuid: string }
  | { type: 'assistant'; uuid: string }
  | { type: 'user'; uuid: string }

let seq = 0
function bashProgress(tool: string): TestMsg {
  return { type: 'progress', parentToolUseID: tool, data: { type: 'bash_progress' }, uuid: `p${seq++}` }
}
function other(type: 'assistant' | 'user'): TestMsg {
  return { type, uuid: `m${seq++}` }
}
function progressCount(msgs: TestMsg[]): number {
  return msgs.filter(m => m.type === 'progress').length
}

describe('coalesceEphemeralProgressMessages', () => {
  test('consecutive ticks for one tool collapse to a single progress message', () => {
    let msgs: TestMsg[] = []
    for (let i = 0; i < 1000; i++) {
      msgs = coalesceEphemeralProgressMessages(msgs, bashProgress('A'))
    }
    expect(msgs.length).toBe(1)
    expect(progressCount(msgs)).toBe(1)
    // The retained tick is the latest one (rendering shows the last tick).
    expect((msgs[0] as { uuid: string }).uuid).toBe('p999')
  })

  test('the latest tick is kept at the end (fast-path replace-in-place)', () => {
    let msgs: TestMsg[] = [other('assistant')]
    msgs = coalesceEphemeralProgressMessages(msgs, bashProgress('A'))
    msgs = coalesceEphemeralProgressMessages(msgs, bashProgress('A'))
    expect(msgs.length).toBe(2)
    expect(msgs[0]!.type).toBe('assistant')
    expect(msgs[1]!.type).toBe('progress')
  })

  test('REGRESSION: two concurrent ephemeral streams stay bounded (no 13k+ blowup)', () => {
    // Before the fix, coalescing only checked oldMessages.at(-1); alternating
    // ticks from two tools made the last element never match, so every tick
    // appended → unbounded growth → OOM. Now bounded to one per (tool, type).
    let msgs: TestMsg[] = []
    for (let i = 0; i < 5000; i++) {
      msgs = coalesceEphemeralProgressMessages(msgs, bashProgress('A'))
      msgs = coalesceEphemeralProgressMessages(msgs, bashProgress('B'))
    }
    expect(progressCount(msgs)).toBe(2) // one for A, one for B
    expect(msgs.length).toBe(2)
  })

  test('REGRESSION: ticks interleaved with non-progress messages stay bounded', () => {
    // A non-progress message between every tick defeats the at(-1) fast path.
    let msgs: TestMsg[] = []
    for (let i = 0; i < 5000; i++) {
      msgs = coalesceEphemeralProgressMessages(msgs, bashProgress('A'))
      msgs.push(other('user')) // simulate an interleaved message each tick
    }
    // Exactly one progress survives; the 5000 interleaved user messages remain.
    expect(progressCount(msgs)).toBe(1)
  })

  test('different tools are not merged with each other', () => {
    let msgs: TestMsg[] = []
    msgs = coalesceEphemeralProgressMessages(msgs, bashProgress('A'))
    msgs = coalesceEphemeralProgressMessages(msgs, bashProgress('B'))
    expect(progressCount(msgs)).toBe(2)
  })
})
