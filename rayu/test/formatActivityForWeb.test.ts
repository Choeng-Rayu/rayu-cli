/**
 * formatActivityForWeb — REPL messages to studio transcript lines.
 *
 * The properties worth locking down are the ones a reader cannot verify by eye:
 * that streamed content is not ALSO mirrored here (which would show every answer
 * twice), that a tool failure stays distinguishable from a success, and that the
 * output is plain text rather than the Telegram HTML the neighbouring formatter emits.
 */

import { describe, expect, test } from 'bun:test'
import type { WrappedMessage } from '../src/telegram/formatActivity.js'
import {
  formatActivityForWeb,
  formatMessageForWeb,
} from '../src/webBridge/formatActivityForWeb.js'

function assistant(text: string): WrappedMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

describe('formatMessageForWeb', () => {
  test('renders assistant text as an assistant line', () => {
    expect(formatMessageForWeb(assistant('Done.'))).toEqual([
      { kind: 'assistant', summary: 'Done.' },
    ])
  })

  test('accepts the string-content shorthand', () => {
    const msg: WrappedMessage = { type: 'assistant', message: { content: 'hello' } }
    expect(formatMessageForWeb(msg)).toEqual([{ kind: 'assistant', summary: 'hello' }])
  })

  test('drops meta messages', () => {
    // Internal bookkeeping the user never sees locally either.
    expect(formatMessageForWeb({ ...assistant('x'), isMeta: true })).toEqual([])
  })

  test('drops thinking blocks', () => {
    // Thinking is relayed live as a `stream_delta` of type 'thinking'; repeating it as
    // settled activity would duplicate it in the transcript.
    const msg: WrappedMessage = {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    }
    expect(formatMessageForWeb(msg)).toEqual([])
  })

  test('drops empty and whitespace-only text', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   ' }] },
    }
    expect(formatMessageForWeb(msg)).toEqual([])
  })

  test('summarises a tool call by its most identifying argument', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la', timeout: 5 } }],
      },
    }
    // `command` over a JSON dump: the argument list is noise, the command is the point.
    expect(formatMessageForWeb(msg)).toEqual([{ kind: 'tool', summary: 'Bash ls -la' }])
  })

  test('falls back to JSON when no identifying field is present', () => {
    const msg: WrappedMessage = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Odd', input: { a: 1 } }] },
    }
    expect(formatMessageForWeb(msg)).toEqual([{ kind: 'tool', summary: 'Odd {"a":1}' }])
  })

  test('keeps a tool failure distinguishable from a success', () => {
    const ok: WrappedMessage = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'fine' }] },
    }
    const bad: WrappedMessage = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'boom', is_error: true }] },
    }
    // Losing this distinction would make a failed run look like a normal one.
    expect(formatMessageForWeb(ok)).toEqual([{ kind: 'tool_result', summary: 'fine' }])
    expect(formatMessageForWeb(bad)).toEqual([{ kind: 'tool_error', summary: 'boom' }])
  })

  test('flattens a block-array tool result', () => {
    const msg: WrappedMessage = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        ],
      },
    }
    expect(formatMessageForWeb(msg)).toEqual([{ kind: 'tool_result', summary: 'a\nb' }])
  })

  test('labels a user text block as a prompt', () => {
    const msg: WrappedMessage = {
      type: 'user',
      message: { content: [{ type: 'text', text: 'do it' }] },
    }
    expect(formatMessageForWeb(msg)).toEqual([{ kind: 'prompt', summary: 'do it' }])
  })

  test('emits plain text, never Telegram HTML', () => {
    // The studio renders these through <Markdown> WITHOUT the html prop, so escaped
    // entities would surface literally as `&lt;b&gt;`.
    const [line] = formatMessageForWeb(assistant('**bold** <b>x</b> & more'))
    expect(line?.summary).toBe('**bold** <b>x</b> & more')
  })

  test('truncates an enormous tool result and says so', () => {
    const msg: WrappedMessage = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'x'.repeat(10_000) }] },
    }
    const [line] = formatMessageForWeb(msg)
    expect(line?.summary.length).toBeLessThan(4_100)
    expect(line?.summary).toContain('[truncated]')
  })

  test('survives a circular tool input', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const msg: WrappedMessage = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Odd', input: circular }] },
    }
    // Tool input is arbitrary JSON from the model; a cycle must not throw on the
    // mirroring path.
    expect(() => formatMessageForWeb(msg)).not.toThrow()
  })
})

describe('formatActivityForWeb', () => {
  test('preserves order across a batch', () => {
    expect(formatActivityForWeb([assistant('one'), assistant('two')])).toEqual([
      { kind: 'assistant', summary: 'one' },
      { kind: 'assistant', summary: 'two' },
    ])
  })

  test('returns nothing for an empty batch', () => {
    expect(formatActivityForWeb([])).toEqual([])
  })
})
