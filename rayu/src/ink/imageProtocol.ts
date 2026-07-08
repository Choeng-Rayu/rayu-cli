import { env } from '../utils/env.js'

/**
 * Inline image protocols this renderer knows how to speak. `'none'` means
 * the terminal has no known inline-image support and callers should fall
 * back to Unicode block-art.
 */
export type ImageProtocol = 'kitty' | 'iterm2' | 'none'

/**
 * Terminals that support the Kitty Graphics Protocol (APC `_G` sequences).
 * kitty itself, plus terminals that have adopted the same protocol.
 */
const KITTY_PROTOCOL_TERMINALS = new Set([
  'kitty',
  'ghostty',
  'WezTerm',
  'konsole',
])

/**
 * Terminals that support iTerm2's inline image protocol (OSC 1337 File=).
 * iTerm2 itself, plus WezTerm which implements both protocols.
 */
const ITERM2_PROTOCOL_TERMINALS = new Set(['iTerm.app', 'WezTerm'])

/**
 * Detects which inline-image protocol (if any) the current terminal
 * supports, using the same env-var heuristics as `env.terminal` /
 * `isSynchronizedOutputSupported()` in ./terminal.ts.
 *
 * Kitty protocol is preferred when a terminal supports both (WezTerm) since
 * it has broader adoption (kitty, Ghostty, Konsole, WezTerm) and a simpler
 * transmission format for our one-shot, non-interactive use case.
 *
 * Not a TTY (piped output, --print mode, CI) never supports inline images —
 * the escape sequences would corrupt non-terminal output streams.
 */
export function getImageProtocol(): ImageProtocol {
  if (!process.stdout.isTTY) return 'none'

  const terminal = env.terminal
  if (!terminal) return 'none'

  if (KITTY_PROTOCOL_TERMINALS.has(terminal)) return 'kitty'
  if (ITERM2_PROTOCOL_TERMINALS.has(terminal)) return 'iterm2'

  return 'none'
}

/** True if the current terminal supports any known inline-image protocol. */
export function supportsInlineImages(): boolean {
  return getImageProtocol() !== 'none'
}
