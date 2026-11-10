import { describe, expect, test } from 'bun:test'

import {
  NEWLINE_SEQUENCE,
  SHIFT_RETURN_BINDING,
  decideKeyMapAction,
  keypathComponent,
  parseBuiltInKeyMap,
} from '../src/commands/terminalSetup/appleTerminalKeyMap.js'
import { InputEvent } from '../src/ink/events/input-event.js'
import { INITIAL_STATE, parseMultipleKeypresses } from '../src/ink/parse-keypress.js'

describe('Terminal.app Shift+Return key map', () => {
  test('binds Shift+Return ($000D) to ESC CR', () => {
    expect(SHIFT_RETURN_BINDING).toBe('$000D')
    expect(NEWLINE_SEQUENCE).toBe('\x1b\r')
  })

  test('ESC CR is not Enter, so it cannot submit the prompt', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, NEWLINE_SEQUENCE)
    expect(keys).toHaveLength(1)
    const parsed = keys[0]!
    expect(parsed.kind).toBe('key')
    if (parsed.kind !== 'key') return
    const event = new InputEvent(parsed)
    // useTextInput decides submit-vs-newline on key.return: a plain Return
    // submits, while ESC CR falls through to the text branch where \r is
    // inserted as \n.
    expect(event.key.return).toBe(false)
    expect(event.key.shift).toBe(false)
    expect(event.key.meta).toBe(false)
    expect(event.input).toBe('\r')
  })
})

describe('keypathComponent', () => {
  test('passes ordinary and spaced profile names through', () => {
    expect(keypathComponent('Basic')).toBe('Basic')
    expect(keypathComponent('Red Sands')).toBe('Red Sands')
  })

  test('escapes dots, which separate plutil path components', () => {
    expect(keypathComponent('My.Profile')).toBe('My\\.Profile')
  })

  test('rejects names plutil cannot address', () => {
    expect(keypathComponent('@home')).toBeNull()
    expect(keypathComponent('back\\slash')).toBeNull()
    expect(keypathComponent('')).toBeNull()
  })
})

describe('parseBuiltInKeyMap', () => {
  test('accepts a dictionary of string bindings', () => {
    const json = JSON.stringify({ F1: '\x1bOP', '\u0001': 'x' })
    expect(parseBuiltInKeyMap(json)).toBe(json)
  })

  test('rejects JSON that plutil -insert -json could not seed with', () => {
    expect(parseBuiltInKeyMap('not json')).toBeNull()
    expect(parseBuiltInKeyMap('[]')).toBeNull()
    expect(parseBuiltInKeyMap('{}')).toBeNull()
    expect(parseBuiltInKeyMap('"text"')).toBeNull()
    expect(parseBuiltInKeyMap(JSON.stringify({ F1: 1 }))).toBeNull()
  })

  test('rejects a map that already binds Shift+Return', () => {
    expect(
      parseBuiltInKeyMap(
        JSON.stringify({ F1: '\x1bOP', [SHIFT_RETURN_BINDING]: 'x' }),
      ),
    ).toBeNull()
  })
})

describe('decideKeyMapAction', () => {
  test('seeds a profile that has no key map of its own', () => {
    expect(decideKeyMapAction(null, null)).toEqual({ action: 'seed' })
  })

  test('inserts Shift+Return into an existing key map', () => {
    expect(decideKeyMapAction('dictionary', null)).toEqual({ action: 'insert' })
  })

  test('leaves an already-correct mapping alone', () => {
    expect(
      decideKeyMapAction('dictionary', {
        kind: 'string',
        value: NEWLINE_SEQUENCE,
      }),
    ).toEqual({ action: 'already' })
  })

  test('never replaces a mapping that sends something else', () => {
    expect(
      decideKeyMapAction('dictionary', { kind: 'string', value: 'x' }),
    ).toEqual({ action: 'conflict', value: 'x' })
    expect(
      decideKeyMapAction('dictionary', { kind: 'boolean', value: null }),
    ).toEqual({ action: 'conflict', value: 'boolean' })
  })

  test('treats a non-dictionary key map as a conflict', () => {
    expect(decideKeyMapAction('string', null)).toEqual({
      action: 'conflict',
      value: 'string',
    })
  })
})
