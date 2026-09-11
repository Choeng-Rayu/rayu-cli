/**
 * ANSI escape sequences → styled segments.
 *
 * ── WHY THIS EXISTS WHEN THE ENGINE RUNS WITH `NO_COLOR` ───────────────────────
 *
 * Tool subprocesses inherit `NO_COLOR=1` / `FORCE_COLOR=0` from the engine, so most
 * output arrives plain — and that MATCHES the terminal, which pipes tool output too.
 * See `host/engine/engineProcess.ts` for why forcing colour on would be a divergence
 * rather than parity.
 *
 * Escapes still arrive when the user asks for them explicitly — `ls --color=always`,
 * `git -c color.ui=always`, a test runner with a `--colors` flag — or when a file simply
 * contains them. Before this, those rendered as literal `[0;32m` noise wrapped around
 * every line, which is strictly worse than either colour or plain text: it corrupts
 * output the user asked to see.
 *
 * ── A PARSER, NOT A TERMINAL EMULATOR ──────────────────────────────────────────
 *
 * SGR (`ESC[…m`) is interpreted; every other escape sequence is STRIPPED. Cursor
 * movement, screen clearing and scroll regions describe mutations of a grid that a
 * `<pre>` does not have, and honouring them would mean implementing a terminal. A
 * progress bar that repaints itself via `\r` and cursor-up is therefore shown as the
 * successive lines it wrote, which is also what a piped log file contains.
 *
 * ── OUTPUT IS DATA, NOT HTML ───────────────────────────────────────────────────
 *
 * Returns segments for React to render as elements. Building an HTML string here would
 * put tool output — the least trustworthy text in the panel, since it is whatever a
 * command printed — one `dangerouslySetInnerHTML` away from executing. There is no
 * escaping step to get wrong because nothing is ever concatenated into markup.
 */

/** A run of text sharing one set of attributes. */
export interface AnsiSegment {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** Reduced-emphasis text. Rendered with opacity rather than a colour. */
  dim?: boolean
  /** Strikethrough. */
  strike?: boolean
  /** Foreground, as a CSS colour value. Undefined means the inherited colour. */
  color?: string
  /** Background, as a CSS colour value. */
  background?: string
  /** Reverse video: the renderer swaps foreground and background. */
  inverse?: boolean
}

/**
 * The 8 base colours and their bright variants, mapped to VS Code's own terminal theme
 * keys.
 *
 * Deliberately theme variables rather than fixed hex: a fixed palette that looks right in
 * a dark theme is unreadable in a light one, and the user has already told the editor
 * which colours their terminal should use. These are the same keys VS Code's integrated
 * terminal reads, so coloured output in the panel matches coloured output in the terminal
 * beside it.
 */
const BASE_COLORS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const

function themeColor(index: number, bright: boolean): string {
  const name = BASE_COLORS[index] ?? 'white'
  return `var(--vscode-terminal-ansi${bright ? 'Bright' : ''}${name[0]!.toUpperCase()}${name.slice(1)})`
}

/**
 * The xterm 256-colour cube and greyscale ramp, as CSS `rgb()`.
 *
 * Indices 0–15 defer to the theme; 16–231 are a 6×6×6 cube and 232–255 a 24-step grey
 * ramp, both defined by the xterm spec rather than by any theme, so they are computed.
 */
function indexedColor(index: number): string {
  if (index < 8) return themeColor(index, false)
  if (index < 16) return themeColor(index - 8, true)
  if (index < 232) {
    const value = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(value / 36)] ?? 0
    const g = steps[Math.floor((value % 36) / 6)] ?? 0
    const b = steps[value % 6] ?? 0
    return `rgb(${r}, ${g}, ${b})`
  }
  const grey = 8 + (index - 232) * 10
  return `rgb(${grey}, ${grey}, ${grey})`
}

/** Attributes carried across segments until reset or overridden. */
type Style = Omit<AnsiSegment, 'text'>

/**
 * Apply one SGR parameter list to the running style.
 *
 * Consumes several parameters at once for the extended-colour forms (`38;5;n`,
 * `38;2;r;g;b`), which is why this walks an index rather than iterating: the parameters
 * after a `38` belong to it, and treating them as independent codes would set unrelated
 * attributes from a colour's own digits.
 */
function applySgr(style: Style, params: number[]): Style {
  let next: Style = { ...style }

  for (let i = 0; i < params.length; i += 1) {
    const code = params[i]!

    if (code === 0) {
      next = {}
      continue
    }
    if (code === 1) { next.bold = true; continue }
    if (code === 2) { next.dim = true; continue }
    if (code === 3) { next.italic = true; continue }
    if (code === 4) { next.underline = true; continue }
    if (code === 7) { next.inverse = true; continue }
    if (code === 9) { next.strike = true; continue }
    // 21/22 both end bold; 22 also ends dim.
    if (code === 21 || code === 22) { delete next.bold; delete next.dim; continue }
    if (code === 23) { delete next.italic; continue }
    if (code === 24) { delete next.underline; continue }
    if (code === 27) { delete next.inverse; continue }
    if (code === 29) { delete next.strike; continue }

    if (code >= 30 && code <= 37) { next.color = themeColor(code - 30, false); continue }
    if (code === 39) { delete next.color; continue }
    if (code >= 40 && code <= 47) { next.background = themeColor(code - 40, false); continue }
    if (code === 49) { delete next.background; continue }
    if (code >= 90 && code <= 97) { next.color = themeColor(code - 90, true); continue }
    if (code >= 100 && code <= 107) { next.background = themeColor(code - 100, true); continue }

    // Extended colour: `38;5;n` (indexed) or `38;2;r;g;b` (truecolour). 48 is the same
    // for background. A malformed sequence consumes what it can and stops, rather than
    // letting the remaining digits be read as unrelated attributes.
    if (code === 38 || code === 48) {
      const isForeground = code === 38
      const mode = params[i + 1]
      if (mode === 5 && params.length > i + 2) {
        const value = indexedColor(params[i + 2]!)
        if (isForeground) next.color = value
        else next.background = value
        i += 2
        continue
      }
      if (mode === 2 && params.length > i + 4) {
        const value = `rgb(${params[i + 2]!}, ${params[i + 3]!}, ${params[i + 4]!})`
        if (isForeground) next.color = value
        else next.background = value
        i += 4
        continue
      }
      break
    }
    // Any other code — blink, font selection, ideogram attributes — is ignored rather
    // than approximated. Nothing in tool output depends on them.
  }

  return next
}

/**
 * Matches one escape sequence.
 *
 * Two alternatives, in this order:
 *   CSI  `ESC [ params letter`   — SGR when the letter is `m`, otherwise stripped.
 *   other `ESC` + one byte or an OSC string terminated by BEL or ST.
 *
 * OSC is matched explicitly because its payload can contain `[` and letters, so the CSI
 * branch would end it early and leak the remainder of a window title into the output.
 */
const ESCAPE = /\u001B(?:\[([0-9;]*)([A-Za-z])|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g

/** True when the text contains anything this module would act on. */
export function hasAnsi(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\u001B/.test(text)
}

/**
 * Split text into styled segments.
 *
 * Text with no escapes returns exactly one unstyled segment, so a caller can use this
 * unconditionally without checking `hasAnsi` first — the common case costs one regex miss
 * and one array allocation.
 *
 * Empty runs between adjacent escapes are dropped: `ESC[1mESC[31m` is two sequences with
 * nothing between them, and emitting an empty segment for it would add a DOM node per
 * escape in heavily-coloured output.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  if (!hasAnsi(text)) return [{ text }]

  const segments: AnsiSegment[] = []
  let style: Style = {}
  let cursor = 0

  ESCAPE.lastIndex = 0
  let match = ESCAPE.exec(text)
  while (match !== null) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), ...style })
    }
    cursor = match.index + match[0].length

    // Only SGR changes style. Every other sequence is consumed and discarded — see the
    // header for why cursor movement is not emulated.
    if (match[2] === 'm') {
      const raw = match[1] ?? ''
      // A bare `ESC[m` is a reset, as is `ESC[0m`.
      const params = raw === ''
        ? [0]
        : raw.split(';').map(part => (part === '' ? 0 : Number(part)))
      style = applySgr(style, params.filter(Number.isFinite))
    }

    match = ESCAPE.exec(text)
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), ...style })
  }

  // Everything was escapes. Return one empty segment rather than an empty array so
  // callers never have to special-case "parsed to nothing".
  return segments.length > 0 ? segments : [{ text: '' }]
}

/** Drop every escape sequence, leaving readable text. For copy actions and search. */
export function stripAnsi(text: string): string {
  if (!hasAnsi(text)) return text
  return parseAnsi(text)
    .map(segment => segment.text)
    .join('')
}
