#!/usr/bin/env bun
/**
 * De-brand audit gate: prove no unintended `claude` identifiers remain.
 *
 * Walks every Identifier in the rename program (tsconfig + .tsx tests) and
 * reports any whose text matches /claude/i, EXCEPT the documented keeps:
 *   - excluded trees (src/types/generated/**, un-use-code/**)
 *   - keepNames / keepSymbols from scripts/rename-claude.overrides.json
 *     (wire fields, env-name keys, data keys, legacy fixtures)
 *   - environment-variable accesses (process.env.CLAUDE_* / ANTHROPIC_*),
 *     which are external contracts, not identifiers we own
 *
 * String literals and comments are never Identifiers, so model IDs, URLs,
 * paths, and prose are out of scope by construction.
 *
 *   bun run scripts/audit-claude-identifiers.ts        # exit 1 on any violation
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isExcludedFile, type Overrides } from './codemod-rename-claude.ts'

const ROOT = resolve(import.meta.dir, '..')
const ov = JSON.parse(
  readFileSync(resolve(ROOT, 'scripts/rename-claude.overrides.json'), 'utf8'),
) as Overrides
const keepNames = new Set(ov.keepNames)
const keepSymbols = new Set(ov.keepSymbols)

function buildProgram(): ts.Program {
  const configPath = resolve(ROOT, 'tsconfig.typecheck.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: d => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      },
    },
  )
  if (!parsed) throw new Error('failed to parse tsconfig.typecheck.json')
  const tsxTests = ts.sys.readDirectory(resolve(ROOT, 'test'), ['.tsx'], ['node_modules'])
  const fileNames = [...new Set([...parsed.fileNames, ...tsxTests])]
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost(parsed.options),
    getSourceFile: (f, lang) => {
      const text = ts.sys.readFile(f)
      return text === undefined
        ? undefined
        : ts.createSourceFile(f, text, lang, true)
    },
  }
  return ts.createProgram(fileNames, parsed.options, host)
}

function rel(abs: string): string {
  return abs.replace(ROOT + '/', '').replace(/\\/g, '/')
}

/** True for `process.env.X` / `env.X` property accesses (external env names). */
function isEnvAccess(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!ts.isPropertyAccessExpression(parent) || parent.name !== node) return false
  const expr = parent.expression
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'env') return true
  if (ts.isIdentifier(expr) && /env/i.test(expr.text)) return true
  return false
}

const program = buildProgram()
const checker = program.getTypeChecker()
const violations: Array<{ file: string; line: number; name: string }> = []
let kept = 0
let envSkipped = 0

for (const sf of program.getSourceFiles()) {
  const rf = rel(sf.fileName)
  if (isExcludedFile(rf, ov.excludeFiles) || sf.isDeclarationFile) continue
  if (sf.fileName.includes('node_modules')) continue

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && /claude/i.test(node.text)) {
      const sym = checker.getSymbolAtLocation(node)
      const name = sym ? sym.getName() : node.text
      const decls = sym?.declarations ?? []
      const keptBySymbol =
        keepNames.has(name) ||
        decls.some(d => keepSymbols.has(`${rel(d.getSourceFile().fileName)}::${name}`)) ||
        keepSymbols.has(`${rf}::${node.text}`)
      if (keptBySymbol) {
        kept++
      } else if (!sym && (isEnvAccess(node) || /^(CLAUDE_|ANTHROPIC_)/.test(node.text))) {
        envSkipped++
      } else {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        violations.push({ file: rf, line: line + 1, name: node.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

console.log('claude identifier audit')
console.log(`  intentional keeps (wire/env/data/fixtures) : ${kept}`)
console.log(`  environment-variable accesses skipped      : ${envSkipped}`)
console.log(`  violations                                 : ${violations.length}`)

if (violations.length > 0) {
  console.error('\n✗ unintended claude identifiers remain:\n')
  for (const v of violations.slice(0, 100)) {
    console.error(`  ${v.file}:${v.line}  ${v.name}`)
  }
  if (violations.length > 100) console.error(`  …and ${violations.length - 100} more`)
  process.exit(1)
}

console.log('\n✓ no unintended claude identifiers remain in src/test/scripts.')
process.exit(0)