import wrapAnsiNpm from 'wrap-ansi'
import { hasKhmer } from './stringWidth.js'
import { wrapGraphemeAtomic } from './wrapGraphemeAtomic.js'

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

const wrapAnsiBun =
  typeof Bun !== 'undefined' && typeof Bun.wrapAnsi === 'function'
    ? Bun.wrapAnsi
    : null

const wrapAnsiDefault: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string = wrapAnsiBun ?? wrapAnsiNpm

// Khmer combining marks are zero-width in terminals but Bun.wrapAnsi counts
// them as cells, so it wraps at an inflated width and orphans coeng subscript
// clusters at line breaks. Route Khmer text through a grapheme-atomic wrapper
// that measures with the wcwidth-correct stringWidth. See wrapGraphemeAtomic.
const wrapAnsi: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string = (input, columns, options) =>
  hasKhmer(input)
    ? wrapGraphemeAtomic(input, columns, options)
    : wrapAnsiDefault(input, columns, options)

export { wrapAnsi }
