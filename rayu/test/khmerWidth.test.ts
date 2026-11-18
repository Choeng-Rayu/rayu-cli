// Regression tests for Khmer (complex-script) display width in the terminal
// renderer. Root cause of the input-overflow bug: Bun.stringWidth counts Khmer
// Mn combining marks (dependent vowels, coeng U+17D2, nikahit) as width 1, but
// terminals render them zero-width. The inflated width desynced Ink's cell
// model and cursor from the real terminal, so incremental writes landed past
// the input box / terminal edge.
//
// Expected widths below are ground truth measured against the real xterm.js
// emulator (VS Code's terminal) and glibc wcwidth: Khmer Mn marks = 0, Khmer Mc
// spacing vowels (U+17B6, U+17BE-17C5, U+17C7-17C8) = 1, base consonants = 1.
import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import Output from '../src/ink/output.ts'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
} from '../src/ink/screen.ts'
import { stringWidth } from '../src/ink/stringWidth.ts'
import { wrapAnsi } from '../src/ink/wrapAnsi.ts'
import { getGraphemeSegmenter } from '../src/utils/intl.ts'
import sliceAnsi from '../src/utils/sliceAnsi.ts'

const KHMER_SENTENCE = 'ភាសាខ្មែរជាភាសារបស់ប្រជាជនកម្ពុជា'
const KHMER_LONG =
  'ភាសាខ្មែរជាភាសារបស់ប្រជាជនកម្ពុជាដែលមានប្រវត្តិយូរណាស់មកហើយនៅក្នុងតំបន់អាស៊ីអាគ្នេយ៍'

const isKhmerMn = (cp: number) =>
  (cp >= 0x17b4 && cp <= 0x17b5) ||
  (cp >= 0x17b7 && cp <= 0x17bd) ||
  cp === 0x17c6 ||
  (cp >= 0x17c9 && cp <= 0x17d3) ||
  cp === 0x17dd

describe('Khmer stringWidth matches terminal cell advance', () => {
  const cases: [string, number][] = [
    ['ក', 1], // base consonant
    ['កា', 2], // base + Mc spacing vowel (ា advances a cell)
    ['ខ្', 1], // base + coeng (Mn, zero-width)
    ['ញុំ', 1], // base + two Mn marks
    ['ខ្ញុំ', 2], // coeng stack: ខ្ + ញុំ
    ['ខ្មែរ', 4], // ខ្(1) + មែ(2) + រ(1)
    ['ស្តី', 2],
    ['ប្រជា', 4],
    [KHMER_SENTENCE, 28],
  ]
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text)} -> ${expected} cells`, () => {
      expect(stringWidth(text)).toBe(expected)
    })
  }

  test('Khmer Mn marks are zero-width, Mc spacing vowels are not', () => {
    expect(stringWidth('\u17bb')).toBe(0) // ុ Mn
    expect(stringWidth('\u17c6')).toBe(0) // ំ Mn
    expect(stringWidth('\u17d2')).toBe(0) // ្ coeng Mn
    expect(stringWidth('\u17b6')).toBe(1) // ា Mc
    expect(stringWidth('\u17c1')).toBe(1) // េ Mc
    expect(stringWidth('\u17c4')).toBe(1) // ោ Mc
  })

  test('non-Khmer widths are unchanged', () => {
    expect(stringWidth('hello')).toBe(5)
    expect(stringWidth('你好')).toBe(4)
    expect(stringWidth('👨‍👩‍👧‍👦')).toBe(2)
    expect(stringWidth('भा')).toBe(1)
    expect(stringWidth('⚠')).toBe(1)
  })

  test('mixed Khmer + emoji sums correctly', () => {
    expect(stringWidth('ខ្ញុំ👍')).toBe(4) // 2 + 2
  })
})

describe('Khmer cell model matches terminal (no Wide-bucket desync)', () => {
  // The overflow came from writeLineToScreen bucketing any width>=2 grapheme
  // into a 2-cell Wide slot. With corrected widths every Khmer cluster is 1 or 2
  // cells, so the model's occupied cells must equal the real terminal width.
  function modelCells(line: string, columns: number): number {
    const stylePool = new StylePool()
    const screen = createScreen(columns, 1, stylePool, new CharPool(), new HyperlinkPool())
    const out = new Output({ width: columns, height: 1, stylePool, screen })
    out.write(0, 0, line)
    const scr = out.get()
    let cells = 0
    for (let x = 0; x < columns; x++) {
      const cell = cellAt(scr, x, 0)
      if (!cell || cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
      if (cell.char.trim() === '') continue
      cells += cell.width === CellWidth.Wide ? 2 : 1
    }
    return cells
  }

  for (const line of [KHMER_SENTENCE, 'ខ្ញុំឈ្មោះរាយុ', 'ខ្មែរក្រុមប្រជាជន']) {
    test(`model cells == terminal width for ${JSON.stringify(line)}`, () => {
      const width = stringWidth(line)
      expect(modelCells(line, width + 4)).toBe(width)
    })
  }

  test('every Khmer grapheme cluster fits the Narrow/Wide cell buckets (<=2)', () => {
    for (const { segment } of getGraphemeSegmenter().segment(KHMER_LONG)) {
      expect(stringWidth(segment)).toBeLessThanOrEqual(2)
    }
  })
})

describe('Khmer wrapping fits the terminal and keeps clusters intact', () => {
  for (const columns of [10, 20, 40]) {
    test(`hard wrap @${columns}: every line fits, no orphan/dangling coeng`, () => {
      const lines = wrapAnsi(KHMER_LONG, columns, { hard: true, trim: false }).split('\n')
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(columns)
        expect(isKhmerMn(line.codePointAt(0) ?? 0)).toBe(false) // no orphaned mark
        expect(line.endsWith('\u17d2')).toBe(false) // no split coeng stack
      }
      expect(stripAnsi(lines.join(''))).toBe(KHMER_LONG) // content preserved
    })
  }

  test('ANSI styles are preserved and reopened across breaks', () => {
    const styled = `\u001b[31m${KHMER_LONG.slice(0, 15)}\u001b[0m\u001b[1m\u001b[32m${KHMER_LONG.slice(15)}\u001b[0m`
    const wrapped = wrapAnsi(styled, 12, { hard: true, trim: false })
    expect(stripAnsi(wrapped).replace(/\n/g, '')).toBe(KHMER_LONG)
    for (const line of wrapped.split('\n').slice(1)) {
      expect(line.startsWith('\u001b[')).toBe(true)
    }
    for (const line of wrapped.split('\n')) {
      expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(12)
    }
  })

  test('mixed Khmer + emoji + CJK + ASCII wraps without overflow', () => {
    const mixed = 'ខ្ញុំ👍你好 hello ភាសាខ្មែរ🎉世界'
    const lines = wrapAnsi(mixed, 10, { hard: true, trim: false }).split('\n')
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(10)
    expect(lines.join('')).toBe(mixed)
  })

  test('existing newlines are preserved', () => {
    expect(wrapAnsi('កា\nខ្ញុំ', 40, { hard: true, trim: false })).toBe('កា\nខ្ញុំ')
  })

  test('non-Khmer text still wraps via the default path', () => {
    const lines = wrapAnsi('the quick brown fox jumps over the lazy dog', 20, {
      hard: true,
      trim: false,
    }).split('\n')
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(20)
  })
})

describe('Khmer sliceAnsi cuts at real cell boundaries (no overshoot)', () => {
  test('width-3 cluster មោះ slices to fit the requested cells', () => {
    expect(stringWidth(sliceAnsi('មោះ', 0, 1))).toBeLessThanOrEqual(1)
    expect(stringWidth(sliceAnsi('មោះ', 0, 2))).toBeLessThanOrEqual(2)
    expect(sliceAnsi('មោះ', 0, 3)).toBe('មោះ')
  })

  test('width-2 cluster កា can be cut to 1 cell', () => {
    expect(sliceAnsi('កា', 0, 1)).toBe('ក')
    expect(sliceAnsi('កា', 0, 2)).toBe('កា')
  })

  test('every prefix slice fits its width and never orphans a leading mark', () => {
    for (const text of [KHMER_SENTENCE, 'ខ្ញុំឈ្មោះរាយុ', 'មោះកាខ្មែរ']) {
      const total = stringWidth(text)
      for (let end = 0; end <= total; end++) {
        const slice = sliceAnsi(text, 0, end)
        expect(stringWidth(slice)).toBeLessThanOrEqual(end)
        if (slice.length > 0) {
          expect(isKhmerMn(slice.codePointAt(0)!)).toBe(false)
        }
      }
      expect(sliceAnsi(text, 0, total)).toBe(text)
    }
  })

  test('non-Khmer slicing is unchanged', () => {
    expect(sliceAnsi('hello world', 0, 5)).toBe('hello')
    expect(sliceAnsi('你好世界', 0, 2)).toBe('你')
    expect(sliceAnsi('abc', 1, 3)).toBe('bc')
  })
})
