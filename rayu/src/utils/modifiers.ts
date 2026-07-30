export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

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
 * (non-darwin, module absent, native call failed). Callers treat this as a
 * plain keypress, which is the safe default.
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  const native = loadNativeModifiers()
  if (typeof native?.isModifierPressed !== 'function') {
    return false
  }
  try {
    return native.isModifierPressed(modifier) === true
  } catch {
    return false
  }
}
