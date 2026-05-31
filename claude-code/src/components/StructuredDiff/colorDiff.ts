import {
  ColorDiff,
  ColorFile,
  getSyntaxTheme as nativeGetSyntaxTheme,
  type SyntaxTheme,
} from 'color-diff-napi'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

export type ColorModuleUnavailableReason = 'env' | 'unavailable'

/**
 * Returns a static reason why the color-diff module is unavailable, or null if available.
 * 'env'         = disabled via CLAUDE_CODE_SYNTAX_HIGHLIGHT
 * 'unavailable' = Rayu: the native `color-diff-napi` module is a no-op stub
 *                 (the real Rust module wasn't part of the source tree), so the
 *                 native color renderer is unavailable and callers fall back to
 *                 their plain-text rendering path.
 */
export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT)) {
    return 'env'
  }
  return 'unavailable'
}

export function expectColorDiff(): typeof ColorDiff | null {
  return getColorModuleUnavailableReason() === null ? ColorDiff : null
}

export function expectColorFile(): typeof ColorFile | null {
  return getColorModuleUnavailableReason() === null ? ColorFile : null
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  return getColorModuleUnavailableReason() === null
    ? nativeGetSyntaxTheme(themeName)
    : null
}
