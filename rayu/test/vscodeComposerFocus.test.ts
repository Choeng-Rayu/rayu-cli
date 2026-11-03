/**
 * The composer shows exactly ONE focus line: the card's border.
 *
 * Three lines used to stack on focus: the card border, a box-shadow ring on the card, and
 * the textarea's own outline from the global `textarea:focus-visible` base rule. In
 * high-contrast themes the textarea also got a second static border. These assertions read
 * the source stylesheet so a regression in any of those rules fails here.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const CSS_PATH = join(ROOT, 'src/vscode/webview/styles/copilot.css')

const HC = ':is(body.vscode-high-contrast, body.vscode-high-contrast-light)'

interface Rule {
  selectors: string[]
  body: string
}

/** Flat list of `selector { body }` rules; comments removed, `@container` wrappers skipped. */
function parseRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorText = match[1]!.trim()
    if (selectorText.startsWith('@')) continue
    // Split on top-level commas only: `:is(a, b)` keeps its inner comma.
    const selectors: string[] = []
    let depth = 0
    let current = ''
    for (const char of selectorText) {
      if (char === '(') depth++
      if (char === ')') depth--
      if (char === ',' && depth === 0) {
        selectors.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    selectors.push(current.trim())
    rules.push({ selectors: selectors.filter(Boolean), body: match[2]!.trim() })
  }
  return rules
}

const rules = parseRules(readFileSync(CSS_PATH, 'utf8'))
const withSelector = (selector: string): Rule[] =>
  rules.filter(rule => rule.selectors.includes(selector))

describe('composer focus: one line, owned by the card', () => {
  test('the textarea draws no outline on :focus or :focus-visible', () => {
    for (const selector of ['.rc-composer-input:focus', '.rc-composer-input:focus-visible']) {
      const found = withSelector(selector)
      expect(found.length, `${selector} rule is missing`).toBeGreaterThan(0)
      expect(found.some(rule => /(^|;)\s*outline:\s*none\s*(;|$)/.test(rule.body))).toBe(true)
    }
  })

  test('the card takes the focus border and no box-shadow ring', () => {
    const found = withSelector('.rc-composer-card:focus-within')
    expect(found.length, '.rc-composer-card:focus-within rule is missing').toBeGreaterThan(0)
    for (const rule of found) {
      expect(rule.body).not.toContain('box-shadow')
    }
    expect(found.some(rule => rule.body.includes('border-color: var(--vscode-focusBorder)'))).toBe(true)
  })

  test('the textarea itself never gets a box-shadow or border from a focus rule', () => {
    const inputRules = rules.filter(rule =>
      rule.selectors.some(selector => /^\.rc-composer-input(:focus|:focus-visible|:focus-within)?$/.test(selector)),
    )
    for (const rule of inputRules) {
      expect(rule.body).not.toContain('box-shadow')
    }
  })

  test('high-contrast themes restore the card focus border', () => {
    const found = withSelector(`${HC} .rc-composer-card:focus-within`)
    expect(found.length, 'HC .rc-composer-card:focus-within rule is missing').toBe(1)
    expect(found[0]!.body).toContain('border-color: var(--vscode-focusBorder)')
  })

  test('the HC static border list owns the card but not the textarea inside it', () => {
    const borderRules = rules.filter(rule => rule.body.includes('border: 1px solid var(--vscode-contrastBorder)'))
    expect(borderRules.some(rule => rule.selectors.includes(`${HC} .rc-composer-card`))).toBe(true)
    for (const rule of borderRules) {
      expect(rule.selectors).not.toContain(`${HC} .rc-composer-input`)
    }
  })
})
