// Inline-image rendering for terminals that support it. Builds the escape
// sequence for the active terminal (iTerm2 OSC 1337 or the Kitty graphics
// protocol), or returns null when unsupported so the caller falls back to
// printing the saved file path.

const ESC = '\x1b'
const BEL = '\x07'

/** iTerm2 / WezTerm support the iTerm2 inline-image protocol. */
function supportsIterm(): boolean {
  return (
    process.env.TERM_PROGRAM === 'iTerm.app' ||
    process.env.TERM_PROGRAM === 'WezTerm' ||
    !!process.env.ITERM_SESSION_ID
  )
}

/** Kitty / Ghostty support the Kitty graphics protocol. */
function supportsKitty(): boolean {
  return (
    process.env.TERM === 'xterm-kitty' ||
    !!process.env.KITTY_WINDOW_ID ||
    process.env.TERM === 'xterm-ghostty' ||
    process.env.TERM_PROGRAM === 'ghostty'
  )
}

/** iTerm2 inline image: OSC 1337 File=inline=1:<base64> BEL. */
export function itermImageSequence(b64: string): string {
  const bytes = Buffer.byteLength(b64, 'base64')
  return `${ESC}]1337;File=inline=1;size=${bytes}:${b64}${BEL}`
}

/** Kitty graphics protocol: transmit+display a PNG (f=100) in base64 chunks. */
export function kittyImageSequence(b64: string): string {
  const CHUNK = 4096
  if (b64.length <= CHUNK) return `${ESC}_Ga=T,f=100;${b64}${ESC}\\`
  let out = ''
  for (let i = 0; i < b64.length; i += CHUNK) {
    const chunk = b64.slice(i, i + CHUNK)
    const more = i + CHUNK < b64.length ? 1 : 0
    const control = i === 0 ? `a=T,f=100,m=${more}` : `m=${more}`
    out += `${ESC}_G${control};${chunk}${ESC}\\`
  }
  return out
}

/** Escape sequence to render the image in the active terminal, or null. */
export function buildTerminalImage(b64: string): string | null {
  if (supportsKitty()) return kittyImageSequence(b64)
  if (supportsIterm()) return itermImageSequence(b64)
  return null
}

/** Best-effort: render the image in the user's terminal. Returns true if emitted. */
export function displayImageInTerminal(b64: string): boolean {
  try {
    if (!process.stdout.isTTY) return false
    const seq = buildTerminalImage(b64)
    if (!seq) return false
    process.stdout.write(`\n${seq}\n`)
    return true
  } catch {
    return false
  }
}
