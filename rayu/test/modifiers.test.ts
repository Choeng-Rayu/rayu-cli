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
  _setNativeModifiersForTesting,
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
  // Module-level cache and the opt-out env var are process-wide, so clear both
  // or an injected fake leaks into the next test.
  _setNativeModifiersForTesting(undefined)
  delete process.env.RAYU_DISABLE_NATIVE_MODIFIERS
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

/**
 * The real addon is absent in CI, so these inject a fake to reach the darwin
 * branches that a shipped macOS build with modifiers-napi present WOULD take.
 * That is the configuration where the original hang was worst: the module loads
 * fine and the native call itself misbehaves.
 */
describe('isModifierPressed with the native module present', () => {
  test('reports the native answer when the addon behaves', () => {
    setPlatform('darwin')
    _setNativeModifiersForTesting({
      isModifierPressed: (m: string) => m === 'shift',
    })

    expect(isModifierPressed('shift')).toBe(true)
    expect(isModifierPressed('command')).toBe(false)
  })

  test('coerces a non-boolean native return instead of leaking it', () => {
    setPlatform('darwin')
    _setNativeModifiersForTesting({
      // A misbehaving addon could hand back anything; callers branch on this
      // value, so it must be a real boolean.
      isModifierPressed: () => 'yes' as unknown as boolean,
    })

    expect(isModifierPressed('shift')).toBe(false)
  })

  test('a throwing native call degrades to false and is not retried', () => {
    setPlatform('darwin')
    let calls = 0
    _setNativeModifiersForTesting({
      isModifierPressed: () => {
        calls++
        throw new Error('native boom')
      },
    })

    expect(() => isModifierPressed('shift')).not.toThrow()
    expect(isModifierPressed('shift')).toBe(false)
    expect(isModifierPressed('shift')).toBe(false)
    // Stopped asking after the first failure — otherwise every Enter pays for
    // a throwing native call.
    expect(calls).toBe(1)
  })

  test('a slow native call is disabled after one offence (the Mode A freeze)', () => {
    setPlatform('darwin')
    let calls = 0
    _setNativeModifiersForTesting({
      isModifierPressed: () => {
        calls++
        // Block past the threshold, the way a TCC permission evaluation would.
        const until = performance.now() + 150
        while (performance.now() < until) {
          /* busy-wait: this is what stalls the single-threaded TUI */
        }
        return false
      },
    })

    expect(isModifierPressed('shift')).toBe(false)
    // The whole point: one sluggish keypress, not a permanently frozen session.
    expect(isModifierPressed('shift')).toBe(false)
    expect(isModifierPressed('shift')).toBe(false)
    expect(calls).toBe(1)
  })

  test('a fast native call keeps working across many presses', () => {
    setPlatform('darwin')
    let calls = 0
    _setNativeModifiersForTesting({
      isModifierPressed: () => {
        calls++
        return true
      },
    })

    for (let i = 0; i < 50; i++) {
      expect(isModifierPressed('shift')).toBe(true)
    }
    // Not disabled — the latency guard must not punish a healthy addon.
    expect(calls).toBe(50)
  })
})

describe('RAYU_DISABLE_NATIVE_MODIFIERS escape hatch', () => {
  test('skips the native path entirely when set', () => {
    setPlatform('darwin')
    process.env.RAYU_DISABLE_NATIVE_MODIFIERS = '1'
    // Clear the cache so the loader actually re-runs and observes the opt-out
    // (an injected fake would bypass the loader and defeat the point).
    _setNativeModifiersForTesting(undefined)

    expect(isModifierPressed('shift')).toBe(false)
    expect(() => prewarmModifiers()).not.toThrow()
  })

  test('without the opt-out the loader still degrades safely when absent', () => {
    setPlatform('darwin')
    delete process.env.RAYU_DISABLE_NATIVE_MODIFIERS
    _setNativeModifiersForTesting(undefined)

    // Same result here, but for a different reason (module missing rather than
    // user opt-out) — both must be non-throwing.
    expect(isModifierPressed('shift')).toBe(false)
  })
})
