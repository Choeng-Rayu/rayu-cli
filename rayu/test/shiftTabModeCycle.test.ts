/**
 * Regression test: Shift+Tab must cycle permission modes on Windows.
 *
 * The mode-cycle chord used to be platform-gated:
 *
 *   const MODE_CYCLE_KEY = SUPPORTS_TERMINAL_VT_MODE ? 'shift+tab' : 'meta+m'
 *
 * On Windows the gate depends on the RUNTIME version, and the published binary
 * is a Node script (`bin: dist/rayu.js`, `engines.node >= 18`). Node 18 / 20 /
 * 22.16 / 23 / 24.1 therefore took the `meta+m` branch, where `shift+tab` was
 * never registered at all — so the chord resolved to no action and pressing it
 * did nothing, which is the reported bug.
 *
 * The parser was never the problem: Shift+Tab arrives as ESC[Z (FN_KEY_RE '[Z'
 * → isShiftKey) or, with Kitty keyboard reporting, as CSI-u ESC[9;2u
 * (keycodeToName(9) → 'tab'), and both decode to {tab, shift} on every
 * platform. Only the registered binding differed.
 *
 * These tests drive the real parser + resolver through BOTH gate outcomes, so
 * they fail on Linux CI too — not just on a Windows machine.
 */
import { describe, expect, test } from 'bun:test'
import { InputEvent } from '../src/ink/events/input-event.ts'
import { INITIAL_STATE, parseMultipleKeypresses } from '../src/ink/parse-keypress.ts'
import { modeCycleBindings } from '../src/keybindings/defaultBindings.ts'
import { parseBindings } from '../src/keybindings/parser.ts'
import {
  getBindingDisplayText,
  resolveKey,
} from '../src/keybindings/resolver.ts'

/** Feed raw terminal bytes through the real parser, as stdin would deliver them. */
function press(sequence: string): InputEvent {
  const [keys] = parseMultipleKeypresses(INITIAL_STATE, sequence)
  const key = keys[0]
  if (!key || key.kind !== 'key') {
    throw new Error(`expected a keypress for ${JSON.stringify(sequence)}`)
  }
  return new InputEvent(key)
}

// What the prompt registers: Chat bindings plus plain Tab for autocomplete.
function chatBindings(supportsTerminalVtMode: boolean) {
  return parseBindings([
    {
      context: 'Chat',
      bindings: {
        tab: 'autocomplete:accept',
        ...modeCycleBindings(supportsTerminalVtMode),
      },
    },
    { context: 'Global', bindings: {} },
  ])
}

const ACTIVE_CONTEXTS = ['Chat', 'Global']
const SHIFT_TAB_ESC = '\x1b[Z'
const SHIFT_TAB_CSI_U = '\x1b[9;2u'
const ALT_M = '\x1bm'
const PLAIN_TAB = '\t'

function resolve(sequence: string, vt: boolean) {
  const event = press(sequence)
  return resolveKey(
    event.input,
    event.key,
    ACTIVE_CONTEXTS,
    chatBindings(vt),
  )
}

describe('Shift+Tab cycles permission modes', () => {
  test('works when the terminal supports VT input mode', () => {
    expect(resolve(SHIFT_TAB_ESC, true)).toEqual({
      type: 'match',
      action: 'chat:cycleMode',
    })
  })

  test('works when it does NOT (Windows on Node < 22.17: the reported bug)', () => {
    // Before the fix this was { type: 'none' } — the chord was simply unbound.
    expect(resolve(SHIFT_TAB_ESC, false)).toEqual({
      type: 'match',
      action: 'chat:cycleMode',
    })
  })

  test('works as a Kitty CSI-u sequence on both branches', () => {
    expect(resolve(SHIFT_TAB_CSI_U, true)).toEqual({
      type: 'match',
      action: 'chat:cycleMode',
    })
    expect(resolve(SHIFT_TAB_CSI_U, false)).toEqual({
      type: 'match',
      action: 'chat:cycleMode',
    })
  })

  test('the meta+m alias survives only where VT mode is unavailable', () => {
    expect(resolve(ALT_M, false)).toEqual({
      type: 'match',
      action: 'chat:cycleMode',
    })
    expect(resolve(ALT_M, true)).toEqual({ type: 'none' })
  })

  test('plain Tab still autocompletes — the cycle binding must not shadow it', () => {
    for (const vt of [true, false]) {
      expect(resolve(PLAIN_TAB, vt)).toEqual({
        type: 'match',
        action: 'autocomplete:accept',
      })
    }
  })

  test('the UI hint keeps advertising shift+tab on both branches', () => {
    for (const vt of [true, false]) {
      expect(getBindingDisplayText('chat:cycleMode', 'Chat', chatBindings(vt))).toBe(
        'shift+tab',
      )
    }
  })
})
