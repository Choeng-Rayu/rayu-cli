import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { getGraphemeSegmenter } from '../utils/intl.js'
import { stringWidth } from './stringWidth.js'

type WrapOptions = {
  hard?: boolean
  trim?: boolean
}

// A code is an "end code" if its code equals its endCode (e.g. hyperlink close).
function isEndCode(code: AnsiCode): boolean {
  return code.code === code.endCode
}

function startCodes(codes: AnsiCode[]): AnsiCode[] {
  return reduceAnsiCodes(codes).filter(c => !isEndCode(c))
}

const KHMER_COENG = '\u17d2'

type Item =
  | { kind: 'ansi'; ansi: AnsiCode }
  | { kind: 'control'; code: string }
  | { kind: 'text'; value: string }

/**
 * Tokenize a line into ANSI codes and grapheme-atomic text units, keeping Khmer
 * coeng stacks intact across token boundaries.
 *
 * Intl.Segmenter (and ansi-tokenize) split a coeng stack like ខ្មែរ into
 * ខ្ + មែ + រ, breaking after the coeng marker U+17D2. Wrapping between those
 * pieces would strand the subscript consonant on the next line. Merge any text
 * unit ending in U+17D2 with the following unit so the whole stack wraps as one
 * piece. Merged text stays a contiguous substring, so offset mapping and
 * per-grapheme cell allocation downstream are unaffected.
 */
function buildItems(line: string): Item[] {
  const items: Item[] = []
  for (const token of tokenize(line)) {
    if (token.type === 'ansi') {
      items.push({ kind: 'ansi', ansi: token })
      continue
    }
    if (token.type === 'control') {
      items.push({ kind: 'control', code: token.code })
      continue
    }
    for (const { segment } of getGraphemeSegmenter().segment(token.value)) {
      const last = items[items.length - 1]
      if (last?.kind === 'text' && last.value.endsWith(KHMER_COENG)) {
        last.value += segment
      } else {
        items.push({ kind: 'text', value: segment })
      }
    }
  }
  return items
}

/**
 * Grapheme-atomic hard wrap with correct display width and ANSI preservation.
 *
 * Used for scripts (Khmer) where Bun.wrapAnsi miscounts zero-width combining
 * marks: it wraps at an inflated width AND breaks inside coeng subscript
 * clusters, orphaning a mark at the start of the next line. npm wrap-ansi is
 * grapheme-atomic but its string-width undercounts Khmer spacing vowels, so it
 * wraps too late and overflows the terminal. This wrapper measures with the
 * shared stringWidth (wcwidth-correct) and never splits a grapheme cluster, so
 * every line fits `columns` real terminal cells and no mark is orphaned.
 *
 * ANSI styles are closed at each break and re-opened on the continuation line,
 * mirroring sliceAnsi/wrap-ansi so styled text reconstructs identically.
 */
export function wrapGraphemeAtomic(
  text: string,
  columns: number,
  options: WrapOptions = {},
): string {
  const trim = options.trim !== false
  return text
    .split('\n')
    .map(line => wrapLine(line, columns, trim))
    .join('\n')
}

function wrapLine(line: string, columns: number, trim: boolean): string {
  if (columns < 1) return line

  const rows: string[] = ['']
  let visible = 0
  let atRowStart = true
  const active: AnsiCode[] = []

  for (const item of buildItems(line)) {
    if (item.kind === 'ansi') {
      active.push(item.ansi)
      rows[rows.length - 1] += item.ansi.code
      continue
    }
    if (item.kind === 'control') {
      rows[rows.length - 1] += item.code
      continue
    }

    const segment = item.value
    // Trim leading whitespace on each row when requested (wrap-ansi parity).
    if (trim && atRowStart && /^\s+$/.test(segment)) continue

    const width = stringWidth(segment)
    if (visible + width > columns && visible > 0) {
      const open = startCodes(active)
      rows[rows.length - 1] += ansiCodesToString(undoAnsiCodes(open))
      rows.push(ansiCodesToString(open))
      visible = 0
      atRowStart = true
      if (trim && /^\s+$/.test(segment)) continue
    }

    rows[rows.length - 1] += segment
    visible += width
    if (width > 0) atRowStart = false
  }

  return rows.join('\n')
}
