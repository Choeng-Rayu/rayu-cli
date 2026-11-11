#!/usr/bin/env bun
/**
 * Identifier rename codemod — every `claude*` symbol → its Rayu equivalent.
 *
 * WHAT IT DOES
 *   Renames IDENTIFIERS ONLY (variables, parameters, functions, classes, types,
 *   interfaces, constants, object/type properties) whose text contains `claude`
 *   in any case. It never touches string literals, comments, import module
 *   specifiers, or file names — model IDs, URLs, env-var names, paths, and wire
 *   values therefore survive verbatim. Persisted data keys are renamed in a
 *   dedicated wave (4) and get migration code in wave 5; wire/prompt-coupled
 *   property names are kept via `keepNames` in the overrides file.
 *
 * HOW — AND WHY THIS SHAPE
 *   Inherits the architecture of scripts/codemod-features.ts: TypeScript
 *   compiler API for analysis, exact-offset text splices applied back-to-front
 *   (no AST re-print, so the diff contains only renamed tokens), dry-run first,
 *   per-wave application, hard refusals instead of guesses. That codemod's
 *   header documents a reverted 197-file big-bang; the same discipline applies.
 *
 *   The rename itself uses ts.LanguageService.findRenameLocations with
 *   findInStrings=false and findInComments=false — the compiler's own
 *   symbol-aware rename, so bindings, import/export aliases, destructuring,
 *   shorthand properties, and cross-module references all resolve correctly.
 *   Every returned span is asserted to be byte-identical to the old name before
 *   splicing; anything unexpected refuses the whole symbol.
 *
 *   Collision safety: before a symbol is accepted, its declaration scope is
 *   checked for an existing distinct symbol already holding the new name, and
 *   two symbols mapping to one name in the same container is a hard refusal.
 *   Refusals are resolved through scripts/rename-claude.overrides.json
 *   (explicitNames / explicitNamesByLocation / keepSymbols), never by hand.
 *
 * USAGE
 *   bun run scripts/codemod-rename-claude.ts --report          # inventory → scripts/rename-claude-plan.json
 *   bun run scripts/codemod-rename-claude.ts --check           # report + exit 1 on any refusal
 *   bun run scripts/codemod-rename-claude.ts --apply --wave 1  # apply one wave (clean tree required)
 *   bun run scripts/codemod-rename-claude.ts --apply --symbol getClaudeMds
 *
 *   Waves (declaration-file based): 1 leaves, 2 engine/services, 3 external
 *   agents, 4 persisted members (names only — values migrate in wave 5).
 */
import ts from 'typescript'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const OVERRIDES_PATH = resolve(ROOT, 'scripts/rename-claude.overrides.json')
const PLAN_PATH = resolve(ROOT, 'scripts/rename-claude-plan.json')

// ─────────────────────────────── pure helpers ─────────────────────────────────

export type Edit = { start: number; end: number; text: string }

/**
 * Case-preserving mechanical mapping, longest compounds first so `ClaudeCode`
 * becomes `RayuCode` (not `RayuCode` via two passes — same result, but the
 * ordering also keeps `CLAUDE_CODE` → `RAYU_CODE` intact).
 */
const NAME_RULES: Array<[RegExp, string]> = [
  [/ClaudeCode/g, 'RayuCode'],
  [/claudeCode/g, 'rayuCode'],
  [/CLAUDE_CODE/g, 'RAYU_CODE'],
  [/CLAUDEAI/g, 'RAYUAI'],
  [/ClaudeAi/g, 'RayuAi'],
  [/claudeAi/g, 'rayuAi'],
  [/Claude/g, 'Rayu'],
  [/CLAUDE/g, 'RAYU'],
  [/claude/g, 'rayu'],
]

export function mapIdentifierName(name: string): string {
  let out = name
  for (const [re, rep] of NAME_RULES) out = out.replace(re, rep)
  return out
}

export function isValidNewName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !/claude/i.test(name)
}

export function isExcludedFile(relFile: string, excludePrefixes: string[]): boolean {
  const norm = relFile.replace(/\\/g, '/')
  return excludePrefixes.some(p => norm.startsWith(p))
}

/** Apply edits back-to-front so earlier offsets stay valid. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  for (const e of ordered) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

export type Overrides = {
  excludeFiles: string[]
  keepNames: string[]
  keepSymbols: string[]
  explicitNames: Record<string, string>
  explicitNamesByLocation: Record<string, string>
  wave4Symbols: string[]
  wave3Globs: string[]
  wave2Globs: string[]
}

export function waveOf(declFile: string, symbolName: string, ov: Overrides): 1 | 2 | 3 | 4 {
  if (ov.wave4Symbols.includes(symbolName)) return 4
  const norm = declFile.replace(/\\/g, '/')
  const matches = (globs: string[]) =>
    globs.some(g => (g.endsWith('/') ? norm.startsWith(g) : norm === g))
  if (matches(ov.wave3Globs)) return 3
  if (matches(ov.wave2Globs)) return 2
  return 1
}

/**
 * Scope-collision check, factored out for tests: given the names already bound
 * in a container and the proposed renames, report conflicts.
 */
export function detectNameCollisions(
  existingNames: ReadonlySet<string>,
  proposed: ReadonlyArray<{ oldName: string; newName: string }>,
): string[] {
  const problems: string[] = []
  const seen = new Map<string, string>()
  for (const { oldName, newName } of proposed) {
    if (existingNames.has(newName) && newName !== oldName) {
      problems.push(`'${oldName}' → '${newName}' collides with an existing binding`)
    }
    const prev = seen.get(newName)
    if (prev !== undefined && prev !== oldName) {
      problems.push(`'${oldName}' and '${prev}' both map to '${newName}' in one scope`)
    }
    seen.set(newName, oldName)
  }
  return problems
}

// ─────────────────────────────── program setup ────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const REPORT = process.argv.includes('--report')
const CHECK = process.argv.includes('--check')
const APPLY = process.argv.includes('--apply')
const ALLOW_DIRTY = process.argv.includes('--allow-dirty')
const WAVE = argValue('--wave')
const SYMBOL = argValue('--symbol')

function loadOverrides(): Overrides {
  return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')) as Overrides
}

function buildLanguageService(): {
  service: ts.LanguageService
  program: ts.Program
  checker: ts.TypeChecker
} {
  const configPath = resolve(ROOT, 'tsconfig.typecheck.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  }
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
  // tsconfig includes test/**/*.ts but NOT .tsx — yet bun test runs those too.
  // Add them to the rename program so renames propagate into .tsx tests.
  // (The typecheck gate keeps using the tsconfig program, unchanged.)
  const tsxTests = ts.sys.readDirectory(resolve(ROOT, 'test'), ['.tsx'], ['node_modules'])
  const fileNames = [...new Set([...parsed.fileNames, ...tsxTests])]
  const versions = new Map<string, number>()
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: f => String(versions.get(f) ?? 0),
    getScriptSnapshot: f => {
      const text = ts.sys.readFile(f)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => ROOT,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  const service = ts.createLanguageService(host)
  const program = service.getProgram()
  if (!program) throw new Error('language service produced no program')
  return { service, program, checker: program.getTypeChecker() }
}

// ─────────────────────────────── discovery ────────────────────────────────────

type Status = 'rename' | 'override' | 'keep' | 'refused'

type Candidate = {
  symbol: ts.Symbol
  oldName: string
  newName: string
  /** First occurrence found — any reference works for findRenameLocations. */
  occFile: string
  occPos: number
  declFile: string
  declLine: number
  declNode: ts.Declaration | undefined
  wave: 1 | 2 | 3 | 4
  status: Status
  reason?: string
  edits: Map<string, Edit[]>
  refCount: number
}

function rel(abs: string): string {
  return relative(ROOT, abs).replace(/\\/g, '/')
}

function isSpecifier(d: ts.Declaration): boolean {
  return ts.isImportSpecifier(d) || ts.isExportSpecifier(d) || ts.isImportClause(d)
}

function discover(ov: Overrides): {
  candidates: Candidate[]
  unresolved: Array<{ file: string; line: number; name: string }>
  skippedExcluded: number
} {
  const { service, program, checker } = buildLanguageService()
  const keepNames = new Set(ov.keepNames)
  const keepSymbols = new Set(ov.keepSymbols)
  const bySymbol = new Map<ts.Symbol, Candidate>()
  const unresolved: Array<{ file: string; line: number; name: string }> = []
  let skippedExcluded = 0
  const textCache = new Map<string, string>()
  const textOf = (f: string): string => {
    let t = textCache.get(f)
    if (t === undefined) {
      t = readFileSync(f, 'utf8')
      textCache.set(f, t)
    }
    return t
  }

  for (const sf of program.getSourceFiles()) {
    const rf = rel(sf.fileName)
    if (isExcludedFile(rf, ov.excludeFiles) || sf.isDeclarationFile) continue
    if (sf.fileName.includes('node_modules')) continue

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && /claude/i.test(node.text)) {
        let sym = checker.getSymbolAtLocation(node)
        // Import/export aliases are not separate rename targets: resolve to the
        // canonical symbol so each export is renamed once (there are no explicit
        // `as claude*` local aliases in active source — verified; the only one
        // lives in the excluded generated tree).
        while (sym && sym.flags & ts.SymbolFlags.Alias) {
          sym = checker.getAliasedSymbol(sym)
        }
        if (!sym) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          unresolved.push({ file: rf, line: line + 1, name: node.text })
        } else if (!bySymbol.has(sym)) {
          const decls = sym.declarations ?? []
          const realDecls = decls.filter(d => !isSpecifier(d))
          const anchor = realDecls[0] ?? decls[0]
          const anchorFile = anchor ? rel(anchor.getSourceFile().fileName) : rf
          // Symbols declared only in excluded trees (generated protobuf) stay.
          if (
            decls.length > 0 &&
            decls.every(d => isExcludedFile(rel(d.getSourceFile().fileName), ov.excludeFiles))
          ) {
            skippedExcluded++
          } else {
            const oldName = sym.getName()
            const pos = node.getStart(sf)
            const { line } = sf.getLineAndCharacterOfPosition(pos)
            let status: Status = 'rename'
            let reason: string | undefined
            let newName =
              ov.explicitNamesByLocation[`${anchorFile}::${oldName}`] ??
              ov.explicitNames[oldName] ??
              mapIdentifierName(oldName)
            if (oldName !== newName && ov.explicitNames[oldName] === undefined &&
                ov.explicitNamesByLocation[`${anchorFile}::${oldName}`] === undefined) {
              status = 'rename'
            } else if (oldName !== newName) {
              status = 'override'
            }
            if (keepNames.has(oldName) || decls.some(d => keepSymbols.has(`${rel(d.getSourceFile().fileName)}::${oldName}`))) {
              status = 'keep'
              reason = 'wire/prompt-coupled or explicitly kept'
              newName = oldName
            } else if (!isValidNewName(newName)) {
              status = 'refused'
              reason = `mapped name '${newName}' is invalid`
            } else if (newName === oldName) {
              status = 'keep'
              reason = 'mapping produced no change'
            }
            bySymbol.set(sym, {
              symbol: sym,
              oldName,
              newName,
              occFile: sf.fileName,
              occPos: pos,
              declFile: anchorFile,
              declLine: anchor
                ? anchor.getSourceFile().getLineAndCharacterOfPosition(anchor.getStart()).line + 1
                : line + 1,
              declNode: anchor,
              wave: waveOf(anchorFile, oldName, ov),
              status,
              reason,
              edits: new Map(),
              refCount: 0,
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  // ── per-symbol rename locations + collision checks ──
  const candidates = [...bySymbol.values()]
  const containerNewNames = new Map<string, Map<string, string>>()

  for (const c of candidates) {
    if (c.status === 'keep' || c.status === 'refused') continue

    const locations = service.findRenameLocations(c.occFile, c.occPos, false, false, true)
    if (!locations || locations.length === 0) {
      c.status = 'refused'
      c.reason = 'findRenameLocations returned nothing'
      continue
    }
    let bad = false
    for (const loc of locations) {
      const lr = rel(loc.fileName)
      if (isExcludedFile(lr, ov.excludeFiles) || loc.fileName.includes('node_modules')) {
        c.status = 'refused'
        c.reason = `rename would touch excluded file ${lr}`
        bad = true
        break
      }
      const text = textOf(loc.fileName)
      const span = text.slice(loc.textSpan.start, loc.textSpan.start + loc.textSpan.length)
      if (span !== c.oldName) {
        c.status = 'refused'
        c.reason = `span '${span}' ≠ '${c.oldName}' in ${lr}`
        bad = true
        break
      }
      const list = c.edits.get(loc.fileName) ?? []
      list.push({
        start: loc.textSpan.start,
        end: loc.textSpan.start + loc.textSpan.length,
        text: (loc.prefixText ?? '') + c.newName + (loc.suffixText ?? ''),
      })
      c.edits.set(loc.fileName, list)
    }
    if (bad) continue
    c.refCount = locations.length

    // Collision: an existing distinct binding already holds the new name.
    if (c.declNode) {
      // Object-literal / type-literal / interface / class members are not scope
      // bindings, so getSymbolsInScope misses them — check siblings directly.
      const memberContainer = c.declNode.parent
      if (
        memberContainer &&
        (ts.isObjectLiteralExpression(memberContainer) ||
          ts.isTypeLiteralNode(memberContainer) ||
          ts.isInterfaceDeclaration(memberContainer) ||
          ts.isClassDeclaration(memberContainer))
      ) {
        const siblings =
          ts.isObjectLiteralExpression(memberContainer)
            ? memberContainer.properties
            : memberContainer.members
        for (const m of siblings ?? []) {
          if (m === c.declNode || !m.name) continue
          if (ts.isIdentifier(m.name) && m.name.text === c.newName) {
            c.status = 'refused'
            c.reason = `sibling member already named '${c.newName}' (${c.declFile}:${c.declLine})`
            break
          }
        }
      }
      // Property names (object/type/interface/class members) cannot collide
      // with enclosing-scope variables — only with siblings (checked above).
      const isPropertyDecl =
        ts.isPropertyAssignment(c.declNode) ||
        ts.isPropertySignature(c.declNode) ||
        ts.isPropertyDeclaration(c.declNode) ||
        ts.isShorthandPropertyAssignment(c.declNode) ||
        ts.isEnumMember(c.declNode)
      const scopeSymbols = isPropertyDecl
        ? []
        : checker.getSymbolsInScope(
            c.declNode,
            ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace,
          )
      for (const s of scopeSymbols) {
        if (s.name !== c.newName || s === c.symbol) continue
        const resolved = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s
        if (resolved === c.symbol) continue
        c.status = 'refused'
        c.reason = `scope already binds '${c.newName}' (${c.declFile}:${c.declLine})`
        break
      }
      // Collision: two symbols mapping to one name in the same container.
      if (c.status !== 'refused') {
        let container: ts.Node = c.declNode
        while (
          container.parent &&
          !ts.isSourceFile(container) &&
          !ts.isClassDeclaration(container) &&
          !ts.isInterfaceDeclaration(container) &&
          !ts.isFunctionDeclaration(container) &&
          !ts.isFunctionExpression(container) &&
          !ts.isArrowFunction(container) &&
          !ts.isBlock(container) &&
          !ts.isModuleDeclaration(container) &&
          !ts.isTypeLiteralNode(container) &&
          !ts.isObjectLiteralExpression(container)
        ) {
          container = container.parent
        }
        const key = `${container.getSourceFile().fileName}:${container.pos}`
        const m = containerNewNames.get(key) ?? new Map<string, string>()
        const prev = m.get(c.newName)
        if (prev !== undefined && prev !== c.oldName) {
          c.status = 'refused'
          c.reason = `'${prev}' also maps to '${c.newName}' in the same container`
        } else {
          m.set(c.newName, c.oldName)
        }
        containerNewNames.set(key, m)
      }
    }
  }

  return { candidates, unresolved, skippedExcluded }
}

// ─────────────────────────────────── run ──────────────────────────────────────

function gitTreeClean(): boolean {
  return execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim() === ''
}

function main(): void {
  const ov = loadOverrides()
  if (!REPORT && !CHECK && !APPLY) {
    console.error('usage: --report | --check | --apply (--wave N | --symbol NAME) [--allow-dirty]')
    process.exit(2)
  }
  console.log('claude → rayu identifier rename codemod\n')
  const { candidates, unresolved, skippedExcluded } = discover(ov)

  const entries = candidates
    .map(c => ({
      symbol: c.oldName,
      newName: c.newName,
      declFile: c.declFile,
      line: c.declLine,
      wave: c.wave,
      refs: c.refCount,
      status: c.status,
      ...(c.reason ? { reason: c.reason } : {}),
    }))
    .sort((a, b) => a.declFile.localeCompare(b.declFile) || a.line - b.line)

  const counts = { rename: 0, override: 0, keep: 0, refused: 0 }
  for (const e of entries) counts[e.status]++
  const byWave: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  for (const e of entries) if (e.status === 'rename' || e.status === 'override') byWave[e.wave]++

  writeFileSync(
    PLAN_PATH,
    JSON.stringify(
      {
        summary: { ...counts, byWave, unresolved: unresolved.length, skippedExcluded },
        entries,
        unresolved,
      },
      null,
      2,
    ) + '\n',
  )

  console.log(`  candidates            : ${entries.length}`)
  console.log(`  rename (mechanical)   : ${counts.rename}`)
  console.log(`  override (role-based) : ${counts.override}`)
  console.log(`  keep (wire-coupled)   : ${counts.keep}`)
  console.log(`  refused               : ${counts.refused}`)
  console.log(`  per wave (renameable) : ${JSON.stringify(byWave)}`)
  console.log(`  unresolved references : ${unresolved.length} (pre-existing dead refs, skipped)`)
  console.log(`  symbols in excluded trees : ${skippedExcluded}`)
  console.log(`\n  plan → ${rel(PLAN_PATH)}`)

  const refused = entries.filter(e => e.status === 'refused')
  if (refused.length > 0) {
    console.log('\nRefused (resolve via overrides, never by hand):')
    for (const e of refused) console.log(`  ${e.declFile}:${e.line}  ${e.symbol} → ${e.newName}  — ${e.reason}`)
  }
  if (unresolved.length > 0 && unresolved.length <= 40) {
    console.log('\nUnresolved (no symbol — left untouched):')
    for (const u of unresolved) console.log(`  ${u.file}:${u.line}  ${u.name}`)
  }

  if (CHECK) {
    process.exit(refused.length > 0 ? 1 : 0)
  }
  if (!APPLY) process.exit(0)

  // ── apply ──
  if (!ALLOW_DIRTY && !gitTreeClean()) {
    console.error('\n✗ refusing --apply: working tree is not clean (commit tooling/overrides first, or pass --allow-dirty)')
    process.exit(1)
  }
  let selected = candidates.filter(c => c.status === 'rename' || c.status === 'override')
  if (WAVE !== undefined) {
    const w = Number(WAVE)
    if (![1, 2, 3, 4].includes(w)) {
      console.error(`✗ invalid --wave '${WAVE}' (expected 1-4)`)
      process.exit(2)
    }
    selected = selected.filter(c => c.wave === w)
  } else if (SYMBOL !== undefined) {
    selected = selected.filter(c => c.oldName === SYMBOL)
    if (selected.length === 0) {
      console.error(`✗ symbol '${SYMBOL}' not found among renameable candidates`)
      process.exit(2)
    }
  } else {
    console.error('✗ --apply needs --wave N or --symbol NAME')
    process.exit(2)
  }
  if (selected.some(c => c.status === 'refused')) {
    console.error('✗ selection contains refused symbols — resolve overrides first')
    process.exit(1)
  }

  const perFile = new Map<string, Map<string, { edit: Edit; oldName: string; newName: string }[]>>()
  let editCount = 0
  for (const c of selected) {
    for (const [file, edits] of c.edits) {
      let spans = perFile.get(file)
      if (!spans) {
        spans = new Map()
        perFile.set(file, spans)
      }
      for (const e of edits) {
        const key = `${e.start}:${e.end}`
        const list = spans.get(key) ?? []
        list.push({ edit: e, oldName: c.oldName, newName: c.newName })
        spans.set(key, list)
      }
    }
  }
  // Resolve each span. A shorthand property and its variable (or a destructured
  // key and its local) can both target the same identifier:
  //   - identical edits → dedupe;
  //   - prefix/suffix variants of ONE old→new pair ('old: new' / 'new: old') →
  //     key AND value are both being renamed, so the plain new name is correct;
  //   - anything else → real conflict, abort without writing.
  const resolvedFiles = new Map<string, Edit[]>()
  for (const [file, spans] of perFile) {
    const out: Edit[] = []
    for (const [key, entries] of spans) {
      const texts = new Set(entries.map(e => e.edit.text))
      let edit: Edit
      if (texts.size === 1) {
        edit = entries[0].edit
      } else {
        const olds = new Set(entries.map(e => e.oldName))
        const news = new Set(entries.map(e => e.newName))
        const collapsible =
          olds.size === 1 &&
          news.size === 1 &&
          [...texts].every(t => {
            const o = [...olds][0]
            const n = [...news][0]
            return t === `${o}: ${n}` || t === `${n}: ${o}`
          })
        if (!collapsible) {
          console.error(`✗ conflicting edits on the same span in ${rel(file)} at ${key} (${[...texts].map(t => `'${t}'`).join(' vs ')}) — aborting, nothing written`)
          process.exit(1)
        }
        const { start, end } = entries[0].edit
        edit = { start, end, text: [...news][0] }
      }
      out.push(edit)
    }
    const sorted = out.sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) {
        console.error(`✗ overlapping edits in ${rel(file)} at ${sorted[i].start} — aborting, nothing written`)
        process.exit(1)
      }
    }
    resolvedFiles.set(file, sorted)
    editCount += sorted.length
  }
  for (const [file, edits] of resolvedFiles) {
    writeFileSync(file, applyEdits(readFileSync(file, 'utf8'), edits))
  }
  console.log(`\n✓ applied ${selected.length} symbol(s), ${editCount} edit(s) across ${resolvedFiles.size} file(s)`)
  process.exit(0)
}

if (import.meta.main) main()