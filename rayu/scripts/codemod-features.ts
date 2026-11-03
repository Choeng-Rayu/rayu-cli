#!/usr/bin/env bun
/**
 * Task 4 codemod — `feature()` from `bun:bundle` → the `FEATURES.*` member form.
 *
 * WHAT IT DOES, PER FILE
 *   - removes `import { feature } from 'bun:bundle'` (all 197 are this exact
 *     form — no aliases, no namespace imports; verified before writing this);
 *   - rewrites every `feature('FLAG')` call to `FEATURES.FLAG`;
 *   - refuses the whole file and reports it if any `feature` reference is
 *     something else (a non-literal argument, a value passed around, a local
 *     shadow). It never guesses.
 *
 * WHY NOT ts-morph, WHICH THE PLAN SUGGESTS
 * ts-morph re-prints the files it edits, which would reformat 197 files and bury
 * a mechanical change in whitespace noise. This uses the same TypeScript
 * compiler API for the analysis but applies edits as exact-offset text splices,
 * so the diff contains only the intended lines. Same AST guarantee — the reason
 * the plan says "not sed" — with a reviewable diff. Note one call site spans
 * multiple lines with a trailing comma
 * (utils/permissions/yoloClassifier.ts: `feature(\n  'POWERSHELL_AUTO_MODE',\n)`),
 * which is why a line-oriented tool cannot do this at all.
 *
 * WHY `FEATURES.FLAG` AND NOT A FUNCTION CALL
 * Bun's dead-code elimination is load-bearing: 85 of the 89 flags are disabled
 * and their branches — including dynamic `import()`s of whole subsystems — are
 * dropped from dist/rayu.js. Measured behaviour:
 *   direct `import {feature} from 'bun:bundle'`   → eliminated ✓
 *   the same via a re-export shim                 → NOT eliminated ✗
 *   `FEATURES.FLAG` + a matching `--define`       → eliminated ✓
 * So the member form is the only shape that keeps elimination while removing the
 * Bun-only import. It mirrors how `MACRO.*` already works here.
 *
 * WHY THIS IS PER-WAVE AND NOT A BIG-BANG 197-FILE COMMIT
 *
 * The plan's Task 4 asked for one reviewable commit across all 197 files. That
 * was attempted and reverted, because `feature()`'s compile-time elimination is
 * doing a second, undocumented job: it is what lets rayu's PARTIAL source link.
 *
 * Concretely, `tools/ToolSearchTool/prompt.ts` contains
 *
 *     if (feature('KAIROS') && … && isReplBridgeActive()) { … }
 *
 * and imports `isReplBridgeActive` from `bootstrap/state.ts`, which does not
 * export it — an accepted entry in typecheck-baseline.json, because rayu was
 * derived from incomplete material. With `feature('KAIROS')` folded to `false`
 * at transpile time the whole `&&` chain disappears, the import becomes unused,
 * and Bun tree-shakes it. Rewrite the gate to any runtime-valued expression and
 * the import must resolve, giving
 * `SyntaxError: Export named 'isReplBridgeActive' not found`.
 *
 * Measured cost of the big-bang attempt: 67 failing tests, 36 module errors.
 *
 * So conversion is safe only for files whose imports all resolve. `--check`
 * reports that set, and the codemod REFUSES any file with an unresolvable
 * import. Pass an explicit list to convert a wave as it is extracted:
 *
 *   bun run scripts/codemod-features.ts --check          # what is safe today
 *   bun run scripts/codemod-features.ts --apply --files a.ts,b.ts
 *   bun run scripts/codemod-features.ts --apply --all-safe
 */
import ts from 'typescript'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { analyze, rel } from './analyze-boundary.ts'

const ROOT = resolve(import.meta.dir, '..')
const FLAGS_PATH = resolve(ROOT, 'feature-flags.json')
const APPLY = process.argv.includes('--apply')

/**
 * The global object the rewritten call sites read.
 *
 * Namespaced deliberately. A bare `FEATURES` is already used by at least one
 * bundled dependency (`FEATURES.join(...)` appears in dist/rayu.js), and since
 * `--define` is applied across every bundled module regardless of scope, a
 * dependency that ever wrote `FEATURES.<SOME_FLAG_NAME>` would have that
 * expression silently replaced with a boolean. The prefix makes the collision
 * impossible rather than merely unlikely.
 */
const TABLE = 'RAYU_FEATURES'

type Edit = { start: number; end: number; text: string }

type FileResult = {
  file: string
  edits: Edit[]
  flags: string[]
  /** Reasons the file was refused, if any. */
  problems: string[]
}

function parse(absPath: string): { sf: ts.SourceFile; text: string } {
  const text = readFileSync(absPath, 'utf8')
  return {
    sf: ts.createSourceFile(
      absPath,
      text,
      ts.ScriptTarget.ESNext,
      true,
      absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
    text,
  }
}

function planFile(absPath: string): FileResult {
  const { sf, text } = parse(absPath)
  const edits: Edit[] = []
  const flags = new Set<string>()
  const problems: string[] = []

  // The local name `feature` is bound to, plus the import statement to delete.
  let importDecl: ts.ImportDeclaration | undefined
  let localName: string | undefined

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteralLike(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== 'bun:bundle') continue

    const bindings = stmt.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) {
      problems.push('bun:bundle imported in an unexpected form (not named imports)')
      continue
    }
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text
      if (imported !== 'feature') {
        problems.push(`bun:bundle exports something other than feature: ${imported}`)
      } else {
        localName = el.name.text
      }
    }
    if (bindings.elements.length !== 1) {
      problems.push(`expected exactly one named import, found ${bindings.elements.length}`)
    }
    importDecl = stmt
  }

  if (!importDecl || !localName) {
    return { file: rel(absPath), edits: [], flags: [], problems }
  }

  // Every reference to the bound name must be a call with one string literal.
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === localName) {
      const parent = node.parent
      const isCallee = ts.isCallExpression(parent) && parent.expression === node
      if (!isCallee) {
        // Skip the import specifier itself; anything else is a real problem.
        if (!ts.isImportSpecifier(parent)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          problems.push(
            `line ${line + 1}: \`${localName}\` used as a value, not called — cannot rewrite`,
          )
        }
        return
      }

      const call = parent
      const arg = call.arguments[0]
      if (call.arguments.length !== 1 || !arg || !ts.isStringLiteralLike(arg)) {
        const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf))
        problems.push(
          `line ${line + 1}: feature() argument is not a single string literal — cannot rewrite`,
        )
        return
      }

      const flag = arg.text
      if (!/^[A-Z][A-Z0-9_]*$/.test(flag)) {
        const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf))
        problems.push(`line ${line + 1}: flag "${flag}" is not a valid property name`)
        return
      }

      flags.add(flag)
      // Replace the whole call expression, which covers the multi-line and
      // trailing-comma forms without any string surgery.
      edits.push({ start: call.getStart(sf), end: call.getEnd(), text: `${TABLE}.${flag}` })
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (problems.length === 0) {
    // Delete the import including its trailing newline, so no blank line is left.
    const start = importDecl.getStart(sf)
    let end = importDecl.getEnd()
    while (end < text.length && (text[end] === '\r' || text[end] === '\n')) {
      end++
      if (text[end - 1] === '\n') break
    }
    // When the import was the first line AND a blank line followed it, removing
    // only the import leaves the file starting with a blank line. Consume it.
    if (start === 0) {
      while (end < text.length && (text[end] === '\r' || text[end] === '\n')) {
        end++
        if (text[end - 1] === '\n') break
      }
    }
    edits.push({ start, end, text: '' })
  }

  return { file: rel(absPath), edits, flags: [...flags], problems }
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  // Apply back to front so earlier offsets stay valid.
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  for (const e of ordered) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

// ─────────────────────────────────── run ──────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const analysis = analyze()
const only = argValue('--files')
  ?.split(',')
  .map(s => s.trim())
  .filter(Boolean)
const ALL_SAFE = process.argv.includes('--all-safe')

const candidates = [...analysis.files.values()].filter(
  f => f.importsBunBundle && f.file.startsWith('src/'),
)

/**
 * A file is safe to convert only if nothing it references is missing.
 *
 * Two independent sources of truth, because the first alone is not enough:
 *
 *   1. the import graph — a specifier that resolves to no file at all;
 *   2. typecheck-baseline.json — the accepted type errors, filtered to the codes
 *      that mean "this reference does not exist":
 *        TS2307 cannot find module            (160 in the baseline)
 *        TS2305 module has no exported member ( 44)
 *        TS2304 cannot find name              ( 15)
 *
 * (2) is what the first attempt at this codemod missed. `bootstrap/state.ts`
 * exists and resolves perfectly; it simply does not export `isReplBridgeActive`.
 * A module-resolution check sees nothing wrong, while the emitted code still
 * fails to LINK once the feature gate stops folding the reference away.
 */
const LINK_ERROR_CODES = new Set(['TS2307', 'TS2305', 'TS2304', 'TS2724', 'TS2614'])

/** Per-file count of baseline errors whose code means a missing reference. */
function loadLinkGaps(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const raw: Record<string, number> = JSON.parse(
    readFileSync(resolve(ROOT, 'typecheck-baseline.json'), 'utf8'),
  )
  for (const sig of Object.keys(raw)) {
    const i1 = sig.indexOf('|')
    const i2 = sig.indexOf('|', i1 + 1)
    if (i1 < 0 || i2 < 0) continue
    const file = sig.slice(0, i1).replace(/\\/g, '/')
    const code = sig.slice(i1 + 1, i2)
    if (!LINK_ERROR_CODES.has(code)) continue
    const message = sig.slice(i2 + 1)
    out.set(file, [...(out.get(file) ?? []), `${code}: ${message.slice(0, 90)}`])
  }
  return out
}

const linkGaps = loadLinkGaps()

function unresolvableImports(file: string): string[] {
  const problems: string[] = [...(linkGaps.get(file) ?? [])]
  const facts = analysis.files.get(file)
  if (facts) {
    for (const i of facts.imports) {
      if (i.kind === 'missing-internal' || i.kind === 'missing-package') {
        problems.push(`unresolved import ${i.spec} (line ${i.line})`)
      }
    }
  }
  return problems
}

const safe = candidates.filter(f => unresolvableImports(f.file).length === 0)
const unsafe = candidates.filter(f => unresolvableImports(f.file).length > 0)

console.log(`Task 4 codemod — feature() → ${TABLE}.*\n`)
console.log(`  files importing bun:bundle in src/ : ${candidates.length}`)
console.log(`  …with every import resolvable      : ${safe.length}  (convertible)`)
console.log(`  …with an unresolvable import       : ${unsafe.length}  (BLOCKED — see header)`)

let selected = safe
if (only) {
  const wanted = new Set(only)
  selected = candidates.filter(f => wanted.has(f.file))
  const blocked = selected.filter(f => unresolvableImports(f.file).length > 0)
  if (blocked.length > 0) {
    console.error('\n✗ refusing: these files have imports that only link because a feature gate folds away:')
    for (const f of blocked) {
      console.error(`  ${f.file}`)
      for (const u of unresolvableImports(f.file)) console.error(`      ${u}`)
    }
    console.error(
      '\nConverting them turns an accepted type error into a runtime SyntaxError.\n' +
        'The missing modules have to exist first.',
    )
    process.exit(1)
  }
  const unknown = only.filter(f => !candidates.some(c => c.file === f))
  if (unknown.length > 0) {
    console.error(`\n✗ not a bun:bundle importer under src/: ${unknown.join(', ')}`)
    process.exit(2)
  }
} else if (!ALL_SAFE && APPLY) {
  console.error(
    '\n✗ --apply needs a scope: pass --files a.ts,b.ts for one wave, or --all-safe\n' +
      '  to convert every file whose imports resolve.',
  )
  process.exit(2)
}

const results = selected.map(f => planFile(resolve(ROOT, f.file)))
const refused = results.filter(r => r.problems.length > 0)
const actionable = results.filter(r => r.problems.length === 0 && r.edits.length > 0)
const allFlags = new Set<string>()
// The committed inventory must cover EVERY flag in src/, converted or not, so
// build.ts can define them all.
for (const f of candidates) {
  for (const flag of planFile(resolve(ROOT, f.file)).flags) allFlags.add(flag)
}

let callSites = 0
for (const r of actionable) callSites += r.edits.length - 1 // minus the import removal

console.log(`\n  selected files                     : ${selected.length}`)
console.log(`  rewritable                         : ${actionable.length}`)
console.log(`  feature() call sites in selection  : ${callSites}`)
console.log(`  distinct flags across all of src/   : ${allFlags.size}`)
console.log(`  refused (unexpected shapes)         : ${refused.length}`)

if (refused.length > 0) {
  console.log('\nRefused (left untouched — fix by hand or extend this codemod):')
  for (const r of refused) {
    console.log(`  ${r.file}`)
    for (const p of r.problems) console.log(`      ${p}`)
  }
}

if (unsafe.length > 0 && !only) {
  console.log('\nBlocked by unresolvable imports (partial source):')
  for (const f of unsafe.slice(0, 15)) {
    console.log(`  ${f.file}`)
    for (const u of unresolvableImports(f.file).slice(0, 3)) console.log(`      ${u}`)
  }
  if (unsafe.length > 15) console.log(`  …and ${unsafe.length - 15} more`)
}

if (!APPLY) {
  console.log(
    `\nDry run. --apply --files <list> converts one wave; --apply --all-safe converts all ${safe.length} safe files.`,
  )
  process.exit(0)
}

for (const r of actionable) {
  const abs = resolve(ROOT, r.file)
  writeFileSync(abs, applyEdits(readFileSync(abs, 'utf8'), r.edits))
}

// The committed flag inventory build.ts turns into --define entries. Generated
// rather than hand-listed, following the typecheck-baseline.json convention: a
// drift test asserts it still matches what src/ actually references.
writeFileSync(FLAGS_PATH, JSON.stringify([...allFlags].sort(), null, 2) + '\n')

console.log(`\n✓ rewrote ${actionable.length} file(s); ${allFlags.size} flags → ${relative(ROOT, FLAGS_PATH)}`)
process.exit(0)
