import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

// Regression guard for a bundle-ONLY failure mode.
//
// Files that emit JSX get the automatic-runtime factories (`jsx`, `jsxs`,
// `jsxDEV`, `Fragment`) injected as module-scope imports. If such a file also
// declares its OWN binding with one of those names, Bun's bundler renames the
// local and the injected import to the SAME identifier, so the factory call
// site compiles to a call on the local:
//
//   let jsx420;                            // was: let jsx: React.ReactNode
//   jsx({ ... })  ->  jsx420(Component, …) // TypeError: jsx420 is not a function
//
// `bun run dev` transpiles per-file and never collides, so the break only ever
// showed up in `dist/rayu.js`. That is exactly how bash mode (`!cmd`) shipped
// broken: processBashCommand.tsx had `let jsx: React.ReactNode`, the throw
// happened before its try/catch, and the turn produced zero messages — spinner
// flash, then nothing rendered.
//
// Names are checked as declarations only; using them as object PROPERTIES
// (`setToolJSX({ jsx })`) is fine and stays allowed.
const RESERVED = ['jsx', 'jsxs', 'jsxDEV', 'Fragment']

// `let jsx`, `const jsx =`, `var jsx`, and destructuring/param positions that
// introduce a same-named binding.
const DECL = new RegExp(
  String.raw`(?:^|[;{}(,]|\b(?:let|const|var|function)\s+)\s*(?:${RESERVED.join('|')})\s*(?:[=:,)]|$)`,
)
const DECL_KEYWORD = new RegExp(
  String.raw`\b(?:let|const|var)\s+(?:${RESERVED.join('|')})\b`,
)

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (full.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

describe('JSX automatic-runtime identifier collisions', () => {
  test('no .tsx file declares a local named jsx/jsxs/jsxDEV/Fragment', () => {
    const root = join(import.meta.dir, '..', 'src')
    const offenders: string[] = []

    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8')
      // Only files that actually emit JSX get the runtime import injected.
      if (!/<[A-Za-z][\w.]*[\s/>]|<>/.test(source)) continue

      source.split('\n').forEach((line, i) => {
        // Skip the generated inline sourcemap trailer and import lines.
        if (line.startsWith('//# sourceMappingURL=')) return
        if (/^\s*import\b/.test(line)) return
        if (DECL_KEYWORD.test(line)) {
          offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })

  test('the collision pattern is actually detected (self-check)', () => {
    expect(DECL_KEYWORD.test('  let jsx: React.ReactNode')).toBe(true)
    expect(DECL_KEYWORD.test('  const Fragment = 1')).toBe(true)
    // Property shorthand and renamed locals must NOT trip the guard.
    expect(DECL_KEYWORD.test('  setToolJSX({ jsx, shouldHidePromptInput })')).toBe(
      false,
    )
    expect(DECL_KEYWORD.test('  let progressJsx: React.ReactNode')).toBe(false)
    expect(DECL).toBeDefined()
  })
})
