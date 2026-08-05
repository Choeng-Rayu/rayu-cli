import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'

export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

/**
 * A modifier-state read is a couple of syscalls; anything past this is a sign
 * the native side is blocking (TCC permission evaluation, run-loop wait) and
 * must not be allowed to run again on the Enter path.
 */
const SLOW_NATIVE_CALL_MS = 100

/**
 * Native macOS modifier-state reader, used only to emulate Shift+Enter in
 * Apple Terminal (which cannot negotiate the Kitty keyboard / modifyOtherKeys
 * protocols, so Shift+Enter is indistinguishable from Enter on the wire — see
 * src/ink/terminal.ts EXTENDED_KEYS_TERMINALS, which deliberately omits it).
 *
 * `modifiers-napi` is OPTIONAL and is deliberately NOT bundled: all three
 * bundlers list it in their `external` array (scripts/build.ts,
 * build-binaries.ts, build-native.ts) so it survives as a runtime require and
 * is resolved from disk only if present. It is not a package.json dependency,
 * so on a normal install it is ABSENT and the require throws
 * MODULE_NOT_FOUND. The contract documented in build.ts is "absent → caught by
 * guards", so every access must degrade to "no modifier pressed" rather than
 * throw.
 *
 * Why this matters (regression this file guards against): isModifierPressed()
 * is called synchronously from useTextInput's handleEnter on EVERY Enter press
 * in Apple Terminal, before onSubmit(). An unguarded require there threw on
 * each keypress; the throw unwound the whole synchronous input dispatch into
 * App.tsx's `handleReadable` catch, which keeps stdin alive but means
 * onSubmit() is never reached. Typing kept working while Enter did nothing —
 * a permanent, macOS-Terminal-only "frozen on Enter" hang. Linux/Windows never
 * saw it because of the darwin check below, and iTerm/kitty/WezTerm/ghostty
 * never saw it because the caller short-circuits on env.terminal.
 */
type ModifiersNative = {
  prewarm?: () => void
  isModifierPressed?: (modifier: string) => boolean
}

// undefined = load not attempted yet; null = attempted and unavailable.
// Caching the failure keeps a missing module from costing a throwing
// module-resolution on every single keystroke.
let nativeModule: ModifiersNative | null | undefined
let prewarmed = false

/**
 * Resolve the optional native module once. Returns null when it is missing or
 * fails to initialize — never throws.
 */
function loadNativeModifiers(): ModifiersNative | null {
  if (nativeModule !== undefined) {
    return nativeModule
  }
  // Escape hatch. This is a synchronous native call on the Enter key path, so
  // if it ever misbehaves on a user's machine (see the latency guard in
  // isModifierPressed) they need a way to switch it off that does not involve
  // downgrading. Setting this only costs Shift+Enter-for-newline in Apple
  // Terminal; `\` + Enter still inserts a newline everywhere.
  if (isEnvTruthy(process.env.RAYU_DISABLE_NATIVE_MODIFIERS)) {
    nativeModule = null
    return nativeModule
  }
  try {
    // Kept as require() on purpose: a static import would defeat the
    // `external` config above and make the bundle depend on a module that
    // isn't shipped.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require('modifiers-napi') as ModifiersNative
  } catch {
    // Not installed for this platform/build — expected on every normal install.
    nativeModule = null
  }
  return nativeModule
}

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  const native = loadNativeModifiers()
  if (typeof native?.prewarm !== 'function') {
    return
  }
  try {
    native.prewarm()
  } catch {
    // Ignore errors during prewarm
  }
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 *
 * Returns false — "not pressed" — whenever the answer cannot be determined
 * (non-darwin, module absent, opt-out set, native call failed or was too slow).
 * Callers treat this as a plain keypress, which is the safe default.
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  const native = loadNativeModifiers()
  if (typeof native?.isModifierPressed !== 'function') {
    return false
  }

  const startedAt = performance.now()
  try {
    return native.isModifierPressed(modifier) === true
  } catch {
    // A native call that throws once will throw again on the next keystroke;
    // stop asking rather than paying for it on every Enter.
    nativeModule = null
    return false
  } finally {
    // Latency guard. Reading global modifier state should take microseconds.
    // If it doesn't, the native side is doing something expensive on the main
    // thread — on macOS that means a TCC (Input Monitoring / Accessibility)
    // permission evaluation, or waiting on a run loop a CLI process does not
    // run. Because this call sits on the synchronous Enter path, a slow call
    // stalls the entire single-threaded TUI: no input, no renders, no API
    // dispatch. Disabling after the first offence turns a permanently frozen
    // session into exactly one sluggish keypress.
    const elapsedMs = performance.now() - startedAt
    if (elapsedMs > SLOW_NATIVE_CALL_MS) {
      nativeModule = null
      logForDebugging(
        `modifiers: native isModifierPressed took ${elapsedMs.toFixed(0)}ms ` +
          `(> ${SLOW_NATIVE_CALL_MS}ms); disabling native modifier detection ` +
          `for this session. Set RAYU_DISABLE_NATIVE_MODIFIERS=1 to skip it ` +
          `permanently.`,
        { level: 'warn' },
      )
    }
  }
}

/**
 * Test-only: seed or reset the cached native module.
 *
 * Pass a fake to exercise the darwin branch (the real addon is absent in CI, so
 * there is otherwise no way to cover the success, throwing, or slow-call
 * paths), or `undefined` to forget the cache so the next call re-resolves.
 */
export function _setNativeModifiersForTesting(
  module: ModifiersNative | null | undefined,
): void {
  nativeModule = module
  prewarmed = false
}
