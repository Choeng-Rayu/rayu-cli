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
    RAYU_OAUTH_DEFAULT: string
    RAYU_API_URL: string
    RAYU_WEB_URL: string
    RAYU_GATEWAY_URL: string
  }

  /**
   * Build-gated feature flags for call sites that have been migrated off
   * `bun:bundle` (see scripts/codemod-features.ts). `scripts/build.ts` --defines
   * every flag in feature-flags.json to a boolean literal, so Bun evaluates and
   * eliminates `RAYU_FEATURES.FLAG` exactly as it did `feature('FLAG')`;
   * `scripts/preload.ts` installs the table for un-bundled runs.
   *
   * Namespaced because a bare `FEATURES` is already used by a bundled dependency
   * and `--define` is applied regardless of scope.
   *
   * Converting a call site is only safe once every import it keeps alive
   * resolves — see the note on `bun:bundle` below.
   */
  // eslint-disable-next-line no-var
  var RAYU_FEATURES: Record<string, boolean>
}

// Native Bun build-time module. `feature(flag)` is statically evaluated by the
// Bun bundler (defaults false). Declared here so `tsc` resolves the import.
//
// KEEP IT. It is not merely an optimisation. rayu is built from PARTIAL source,
// and Bun's compile-time elimination of `feature()` is what stops those gaps from
// becoming runtime link errors. Concretely: ToolSearchTool/prompt.ts has
// `if (feature('KAIROS') && ... && isReplBridgeActive())`, and `isReplBridgeActive`
// is imported from bootstrap/state.ts, which does not export it (an accepted
// entry in typecheck-baseline.json). With `feature('KAIROS')` replaced by `false`
// at transpile time the whole `&&` chain folds away, the import becomes unused
// and is tree-shaken. Replace `feature()` with any runtime-valued expression and
// the import must link, producing
// `SyntaxError: Export named 'isReplBridgeActive' not found`.
// Measured: 67 test failures and 36 module errors. See
// scripts/codemod-features.ts, which is therefore per-wave, not big-bang.
declare module 'bun:bundle' {
  export function feature(flag: string): boolean
}

declare module 'qrcode' {
  export function toString(
    text: string,
    opts?: { type?: string; errorCorrectionLevel?: string },
  ): Promise<string>
}

export {}
