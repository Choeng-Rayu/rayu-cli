// Which match tier fired, and whether curly-quote preservation applies.
//
// THE BUG THIS LOCKS DOWN
// preserveQuoteStyle gated on `oldString !== actualOldString` — i.e. "the match
// needed normalization, so the file must use curly typography". That inference is
// wrong for two of the four tiers: `whitespace` and `lenient` also return a
// differing string, for trailing spaces / no-break spaces / zero-width chars /
// stray CRs. When one of those matched and the matched region happened to contain
// ANY curly quote (a `’` in a nearby comment is enough), every `"` and `'` in
// new_string was rewritten to curly — and applyCurlySingleQuotes converts
// letter-flanked apostrophes, so `don't` became `don’t` and `'utf8'` became
// `‘utf8’`, written straight to disk as broken code.
import { describe, expect, test } from 'bun:test'
import {
  findActualString,
  findActualStringMatch,
  preserveQuoteStyle,
  resolveEditStrings,
} from '../src/tools/FileEditTool/utils.ts'

const CURLY_APOSTROPHE = '\u2019'
const LEFT_DOUBLE = '\u201C'
const RIGHT_DOUBLE = '\u201D'

describe('findActualStringMatch reports the tier that fired', () => {
  test('exact', () => {
    const match = findActualStringMatch('const a = 1\n', 'const a = 1')
    expect(match).toEqual({ matched: 'const a = 1', tier: 'exact' })
  })

  test('quotes — file has curly, model sent straight', () => {
    const file = `const msg = ${LEFT_DOUBLE}hello${RIGHT_DOUBLE}\n`
    const match = findActualStringMatch(file, 'const msg = "hello"')
    expect(match?.tier).toBe('quotes')
    // Returns the FILE bytes, not the normalized search text.
    expect(match?.matched).toBe(`const msg = ${LEFT_DOUBLE}hello${RIGHT_DOUBLE}`)
  })

  test('whitespace — file has trailing spaces the model could not see', () => {
    const match = findActualStringMatch('const a = 1   \nconst b = 2\n', 'const a = 1\nconst b = 2')
    expect(match?.tier).toBe('whitespace')
    expect(match?.matched).toBe('const a = 1   \nconst b = 2')
  })

  test('lenient — no-break space inside the line', () => {
    const match = findActualStringMatch('const\u00A0b = 2\n', 'const b = 2')
    expect(match?.tier).toBe('lenient')
    expect(match?.matched).toBe('const\u00A0b = 2')
  })

  test('null when genuinely absent', () => {
    expect(findActualStringMatch('alpha\n', 'gamma')).toBeNull()
  })

  test('findActualString still returns just the matched bytes', () => {
    expect(findActualString('const\u00A0b = 2\n', 'const b = 2')).toBe(
      'const\u00A0b = 2',
    )
    expect(findActualString('alpha\n', 'gamma')).toBeNull()
  })
})

describe('a whitespace/lenient match must NOT touch quotes in new_string', () => {
  // A multi-line old_string spanning a line that contains a curly apostrophe,
  // where ANOTHER line in the span carries trailing whitespace the model could
  // not see. Exact fails (trailing spaces), the quotes tier fails (spaces still
  // differ), so the whitespace tier matches — and the matched region contains a
  // `’`, which is exactly what used to trigger the rewrite.
  const file =
    `function f() {\n` +
    `  // it${CURLY_APOSTROPHE}s important   \n` +
    `  return 1\n` +
    `}\n`
  const oldString = `  // it${CURLY_APOSTROPHE}s important\n  return 1`

  test('whitespace tier fires, and the matched region does contain a curly quote', () => {
    const match = findActualStringMatch(file, oldString)
    expect(match?.tier).toBe('whitespace')
    expect(match?.matched).toContain(CURLY_APOSTROPHE)
    expect(match?.matched).toBe(
      `  // it${CURLY_APOSTROPHE}s important   \n  return 1`,
    )
  })

  test('new_string is byte-identical to what the model sent', () => {
    const newString = `  // it${CURLY_APOSTROPHE}s important\n  return 'utf8' // don't`

    const { actualNewString } = resolveEditStrings(file, oldString, newString)

    expect(actualNewString).toBe(newString)
    // The specific corruptions that used to land on disk.
    expect(actualNewString).toContain(`'utf8'`)
    expect(actualNewString).toContain(`don't`)
    expect(actualNewString).not.toContain('\u2018')
  })

  test('the old behaviour DID corrupt it (documents the regression)', () => {
    // Calling preserveQuoteStyle directly with a whitespace-tier match is what
    // the three call sites used to do. Kept as a live demonstration that the
    // corruption is real and that the tier gate is what prevents it.
    const newString = `  return 'utf8' // don't`
    const actualOld = findActualString(file, oldString)!
    const corrupted = preserveQuoteStyle(oldString, actualOld, newString)

    expect(corrupted).not.toBe(newString)
    expect(corrupted).toContain('\u2018utf8\u2019') // 'utf8' → ‘utf8’
    expect(corrupted).toContain(`don${CURLY_APOSTROPHE}t`) // don't → don’t
  })

  test('lenient tier with a curly apostrophe inside the matched region', () => {
    const nbspFile = `const s = 'it${CURLY_APOSTROPHE}s'\u00A0+ x\n`
    const nbspOld = `const s = 'it${CURLY_APOSTROPHE}s' + x`
    const match = findActualStringMatch(nbspFile, nbspOld)
    expect(match?.tier).toBe('lenient')
    expect(match?.matched).toContain(CURLY_APOSTROPHE)

    const newString = `const s = 'plain' + y // don't`
    const { actualNewString } = resolveEditStrings(nbspFile, nbspOld, newString)
    expect(actualNewString).toBe(newString)
  })

  test('exact tier never transforms', () => {
    const newString = `const a = 'y' // don't`
    const { actualNewString } = resolveEditStrings(
      "const a = 'x'\n",
      "const a = 'x'",
      newString,
    )
    expect(actualNewString).toBe(newString)
  })

  test('no match at all: falls back to the model input, untransformed', () => {
    const { actualOldString, actualNewString } = resolveEditStrings(
      'alpha\n',
      'gamma',
      `beta 'q'`,
    )
    expect(actualOldString).toBe('gamma')
    expect(actualNewString).toBe(`beta 'q'`)
  })
})

describe('a genuine curly-quote match still preserves the typography', () => {
  test('double quotes', () => {
    const file = `const msg = ${LEFT_DOUBLE}hello${RIGHT_DOUBLE}\n`
    const { actualOldString, actualNewString } = resolveEditStrings(
      file,
      'const msg = "hello"',
      'const msg = "goodbye"',
    )
    expect(actualOldString).toBe(`const msg = ${LEFT_DOUBLE}hello${RIGHT_DOUBLE}`)
    expect(actualNewString).toBe(
      `const msg = ${LEFT_DOUBLE}goodbye${RIGHT_DOUBLE}`,
    )
  })

  test('single quotes', () => {
    const file = `const s = \u2018a\u2019\n`
    const { actualNewString } = resolveEditStrings(
      file,
      "const s = 'a'",
      "const s = 'b'",
    )
    expect(actualNewString).toBe(`const s = \u2018b\u2019`)
  })
})
