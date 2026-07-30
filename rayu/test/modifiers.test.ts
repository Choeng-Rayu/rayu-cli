/**
 * Regression test for the macOS "frozen on Enter" hang.
 *
 * In Apple Terminal, useTextInput's handleEnter calls
 * isModifierPressed('shift') synchronously on EVERY Enter press, before
 * onSubmit() (src/hooks/useTextInput.ts:263). Apple Terminal cannot negotiate
 * the Kitty keyboard / modifyOtherKeys protocols, so it is the only terminal
 * that needs this native fallback to tell Shift+Enter from Enter.
 *
 * `modifiers-napi` is optional, is not a package.json dependency, and is listed
 * as `external` by all three bundlers — so on a normal install it is ABSENT and
 * require() throws MODULE_NOT_FOUND. Previously that throw was unguarded: every
 * Enter threw, the throw unwound the synchronous input dispatch into App.tsx's
 * handleReadable catch (which keeps stdin alive), and onSubmit() was never
 * reached. Typing worked, Enter did nothing — permanently, on macOS Terminal
 * only.
 *
 * These tests spoof process.platform to 'darwin' so the darwin-only branch is
 * actually executed on Linux/CI, with the native module genuinely missing —
 * exactly the shipped-install condition.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  type ModifierKey,
  isModifierPressed,
  prewarmModifiers,
} from '../src/utils/modifiers.js'

const REAL_PLATFORM = process.platform
const ALL_MODIFIERS: ModifierKey[] = ['shift', 'command', 'control', 'option']

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
}

afterEach(() => {
  setPlatform(REAL_PLATFORM)
})

describe('isModifierPressed on macOS without the optional native module', () => {
  test('returns false instead of throwing, so Enter can still submit', () => {
    setPlatform('darwin')
    // The assertion that matters: NOT throwing. A throw here is the hang.
    expect(() => isModifierPressed('shift')).not.toThrow()
    expect(isModifierPressed('shift')).toBe(false)
  })

  test('degrades the same way for every modifier', () => {
    setPlatform('darwin')
    for (const modifier of ALL_MODIFIERS) {
      expect(() => isModifierPressed(modifier)).not.toThrow()
      expect(isModifierPressed(modifier)).toBe(false)
    }
  })

  test('stays quiet across many presses (the failed load must be cached)', () => {
    setPlatform('darwin')
    for (let i = 0; i < 100; i++) {
      expect(isModifierPressed('shift')).toBe(false)
    }
  })

  test('prewarmModifiers never throws either', () => {
    setPlatform('darwin')
    expect(() => prewarmModifiers()).not.toThrow()
    // Idempotent: the internal guard means a second call is a no-op.
    expect(() => prewarmModifiers()).not.toThrow()
  })
})

describe('isModifierPressed off macOS', () => {
  test('short-circuits to false without touching the native module', () => {
    for (const platform of ['linux', 'win32']) {
      setPlatform(platform)
      expect(isModifierPressed('shift')).toBe(false)
      expect(() => prewarmModifiers()).not.toThrow()
    }
  })
})
