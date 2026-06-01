// Ambient declarations for Rayu-CLI build-time symbols.
// `MACRO` is inlined via `bun build --define` (and a dev-mode global); guarded
// with `typeof MACRO !== 'undefined'` in async contexts per upstream.

declare global {
  // eslint-disable-next-line no-var
  var MACRO: {
    VERSION: string
    BUILD_TIME: string
    PACKAGE_URL: string
    NATIVE_PACKAGE_URL: string
    FEEDBACK_CHANNEL: string
    ISSUES_EXPLAINER: string
    VERSION_CHANGELOG: string
  }
}

// Native Bun build-time module. `feature(flag)` is statically evaluated by the
// Bun bundler (defaults false). Declared here so `tsc` resolves the import.
declare module 'bun:bundle' {
  export function feature(flag: string): boolean
}

export {}
