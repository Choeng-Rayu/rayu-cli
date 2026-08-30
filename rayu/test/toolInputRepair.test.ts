// Malformed tool-argument JSON recovery.
//
// These are the shapes OpenAI-compatible providers actually emit instead of
// strict JSON. Before repairToolArgumentsJSON they all degraded to `{}` in
// normalizeContentFromAPI, so the tool ran with empty input and reported a
// schema error naming the wrong problem.
import { describe, expect, test } from 'bun:test'
import {
  getToolInputParseFailure,
  repairToolArgumentsJSON,
  TOOL_INPUT_PARSE_FAILURE_KEY,
  toolInputJSONErrorMessage,
} from '../src/utils/toolInputRepair.ts'

describe('valid JSON is never touched', () => {
  const cases: Array<[string, string]> = [
    ['object', '{"file_path":"/a.ts","old_string":"x","new_string":"y"}'],
    ['nested', '{"a":{"b":[1,2,{"c":"d"}]}}'],
    ['escaped newlines', '{"old_string":"line1\\nline2"}'],
    ['escaped quotes', '{"old_string":"say \\"hi\\""}'],
    ['empty object', '{}'],
    ['array', '[1,2,3]'],
    ['string containing a fence', '{"new_string":"```js\\ncode\\n```"}'],
    ['string containing a trailing comma', '{"new_string":"a, }"}'],
  ]

  for (const [name, raw] of cases) {
    test(`${name}: parses on the first attempt with repaired:false`, () => {
      const result = repairToolArgumentsJSON(raw)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.repaired).toBe(false)
      expect(result.stages).toEqual([])
      // Byte-identical semantics: re-serializing must round-trip.
      expect(result.value).toEqual(JSON.parse(raw))
    })
  }
})

describe('repairs the shapes weak models actually produce', () => {
  test('markdown code fence wrapper', () => {
    const result = repairToolArgumentsJSON(
      '```json\n{"file_path":"/a.ts","old_string":"x","new_string":"y"}\n```',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repaired).toBe(true)
    expect(result.value).toEqual({
      file_path: '/a.ts',
      old_string: 'x',
      new_string: 'y',
    })
  })

  test('bare fence with no language tag', () => {
    const result = repairToolArgumentsJSON('```\n{"a":1}\n```')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ a: 1 })
  })

  test('prose wrapped around the object', () => {
    const result = repairToolArgumentsJSON(
      'Here are the arguments: {"a":1,"b":"}"} — hope that helps!',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The `}` inside the string value must not end the scan early.
    expect(result.value).toEqual({ a: 1, b: '}' })
  })

  test('raw newline inside a string (multi-line old_string)', () => {
    const raw = '{"old_string":"const a = 1\nconst b = 2","new_string":"z"}'
    const result = repairToolArgumentsJSON(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repaired).toBe(true)
    expect(result.value).toEqual({
      old_string: 'const a = 1\nconst b = 2',
      new_string: 'z',
    })
  })

  test('raw tab inside a string is preserved as a tab', () => {
    const result = repairToolArgumentsJSON('{"old_string":"a\tb"}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ old_string: 'a\tb' })
  })

  test('structural whitespace between tokens is left alone', () => {
    const result = repairToolArgumentsJSON('{\n  "a" : 1 ,\n  "b" : 2\n}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ a: 1, b: 2 })
  })

  test('trailing comma before a closing brace', () => {
    const result = repairToolArgumentsJSON('{"a":1,"b":2,}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repaired).toBe(true)
    expect(result.value).toEqual({ a: 1, b: 2 })
  })

  test('trailing comma before a closing bracket', () => {
    const result = repairToolArgumentsJSON('{"a":[1,2,]}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ a: [1, 2] })
  })

  test('output truncated mid-string keeps what arrived', () => {
    const result = repairToolArgumentsJSON(
      '{"file_path":"/a.ts","old_string":"const a = ',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repaired).toBe(true)
    expect(result.value).toEqual({
      file_path: '/a.ts',
      old_string: 'const a = ',
    })
  })

  test('output truncated after a key drops the dangling key', () => {
    const result = repairToolArgumentsJSON('{"file_path":"/a.ts","old_string":')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ file_path: '/a.ts' })
  })

  test('output truncated with unclosed nesting', () => {
    const result = repairToolArgumentsJSON('{"a":{"b":[1,2')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ a: { b: [1, 2] } })
  })

  test('fence AND raw newline together', () => {
    const result = repairToolArgumentsJSON(
      '```json\n{"old_string":"a\nb","new_string":"c"}\n```',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ old_string: 'a\nb', new_string: 'c' })
  })
})

describe('gives up honestly rather than guessing', () => {
  test('empty input', () => {
    const result = repairToolArgumentsJSON('')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('empty')
  })

  test('whitespace-only input', () => {
    expect(repairToolArgumentsJSON('   \n  ').ok).toBe(false)
  })

  test('plain prose with no JSON at all', () => {
    const result = repairToolArgumentsJSON('I could not decide what to send.')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not valid JSON')
  })

  test('oversized input fails fast instead of scanning', () => {
    const result = repairToolArgumentsJSON('x'.repeat(9 * 1024 * 1024))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('too large')
  })
})

describe('the failure marker and its message', () => {
  test('the marker key is readable off an input object', () => {
    const input = { [TOOL_INPUT_PARSE_FAILURE_KEY]: 'boom' }
    expect(getToolInputParseFailure(input)).toBe('boom')
  })

  test('a normal input carries no marker', () => {
    expect(getToolInputParseFailure({ file_path: '/a.ts' })).toBeUndefined()
    expect(getToolInputParseFailure(undefined)).toBeUndefined()
    expect(getToolInputParseFailure('a string')).toBeUndefined()
  })

  test('the message names the tool, the cause, and the fix', () => {
    const message = toolInputJSONErrorMessage(
      'Edit',
      '{"old_string":"a\nb"',
      'unexpected token',
    )
    expect(message).toContain('Edit')
    expect(message).toContain('unexpected token')
    expect(message).toContain('No action was taken')
    // The two mistakes that actually cause this.
    expect(message).toContain('\\n')
    expect(message).toContain('markdown code fence')
    // And what was received, so a truncation is distinguishable from a quoting bug.
    expect(message).toContain('Received:')
  })

  test('the received preview is bounded', () => {
    const message = toolInputJSONErrorMessage('Edit', 'y'.repeat(5000), 'why')
    expect(message.length).toBeLessThan(1500)
    expect(message).toContain('…')
  })
})
