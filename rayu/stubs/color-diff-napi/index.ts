// Stub for the unpublished native module `color-diff-napi` (Anthropic-internal).
// Syntax highlighting via the native module is unavailable in Rayu; callers
// already guard for a null/unavailable module, so these inert shapes are safe.
export type SyntaxTheme = Record<string, unknown>

export class ColorDiff {
  constructor(..._args: unknown[]) {}
}
export class ColorFile {
  constructor(..._args: unknown[]) {}
}

export function getSyntaxTheme(_themeName: string): SyntaxTheme {
  return {}
}
