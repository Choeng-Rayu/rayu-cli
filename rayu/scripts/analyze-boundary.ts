#!/usr/bin/env bun
/**
 * Boundary analyzer and core-purity gate — RAYU_CORE_MIGRATION_PLAN.md, Task 1.
 *
 * WHY THIS EXISTS
 * Earlier drafts of the migration plan sized the work with `grep`, and the counts
 * were wrong in both directions: `feature()` was reported in ~40 files (really
 * 196, because the sampling grep was truncated by a per-file match cap), and
 * `Bun.*` in ~250 places (really far fewer — one regex had conflated the 196
 * `bun:bundle` imports with the `Bun.*` property accesses, and a
 * case-insensitive match additionally counts `bun.lock`, `bun.sh` and ordinary
 * prose inside comments). Tool, flag and macro inventories were hand-listed and
 * therefore incomplete. Wrong counts drove wrong scope.
 *
 * Text search structurally cannot see:
 *   - tsconfig `paths` aliases (`src/*`, `@ant/*`, `color-diff-napi`),
 *   - re-export chains (`export … from`), which are real graph edges,
 *   - whether an import is TYPE-ONLY and therefore erased at runtime,
 *   - whether a `Bun.*` access sits inside a `typeof Bun !== 'undefined'` guard,
 *   - the difference between an unresolved import and an intentionally external
 *     one (Bun's `EXTERNAL` list in scripts/build.ts is invisible to tsc).
 *
 * The TypeScript compiler API can see all of it. So every move list, count and
 * purity verdict in the migration is COMPUTED here, never estimated.
 *
 * DESIGN NOTES
 * - `ts.createSourceFile` + an AST walk, NOT `ts.createProgram`. Only the import
 *   graph is needed; skipping the type checker keeps a full-repo run in seconds.
 * - `ts.resolveModuleName` per specifier, with the compiler's own resolution
 *   cache, so alias/extension/index resolution matches what tsc actually does.
 * - `EXTERNAL` and `STUB_ALIASES` are read out of scripts/build.ts's AST rather
 *   than duplicated here. build.ts calls `Bun.build()` at module scope, so it
 *   cannot be imported without triggering a build; parsing it keeps the two in
 *   lockstep with zero drift. A rename of either const is a hard error, not a
 *   silent degradation.
 * - rayu is built from PARTIAL source (see scripts/typecheck-baseline.ts): some
 *   imports point at modules that were never present. Those are reported as a
 *   distinct `missing-internal` category, not treated as analyzer failures.
 *
 * USAGE
 *   bun run scripts/analyze-boundary.ts                  # summary + purity verdict
 *   bun run scripts/analyze-boundary.ts --wave task11-query   # one wave, with paths
 *   bun run scripts/analyze-boundary.ts --why src/query.ts    # why is this impure
 *   bun run scripts/analyze-boundary.ts --json out.json  # full machine-readable dump
 *   bun run scripts/analyze-boundary.ts --update         # re-snapshot the gate baseline
 *
 * The gate follows the same shrink-only contract as the typecheck baseline: it
 * fails when a wave's impurity GROWS versus boundary-baseline.json. Most waves
 * start impure — that is the measurement, not a bug. Each extraction wave drives
 * its own number to zero.
 */
import ts from 'typescript'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { ENABLED_FEATURES } from './macroValues.ts'
import { EXTERNAL, STUB_ALIASES } from './bundleConfig.ts'

export const ROOT = resolve(import.meta.dir, '..')
const BASELINE_PATH = resolve(ROOT, 'boundary-baseline.json')
const TYPECHECK_BASELINE_PATH = resolve(ROOT, 'typecheck-baseline.json')

/** ROOT-relative, forward-slashed. The canonical key for every file in here. */
export function rel(absPath: string): string {
  return relative(ROOT, absPath).replace(/\\/g, '/')
}

// ───────────────────────────── specifier taxonomy ─────────────────────────────

export type SpecifierKind =
  /** A file inside this project (src/, stubs/, scripts/, test/). A real edge. */
  | 'internal'
  /** node: builtin — always available, never a portability problem. */
  | 'node-builtin'
  /** `bun`, `bun:bundle`, `bun:test`, … — available ONLY under the Bun runtime. */
  | 'bun-builtin'
  /** Resolved into node_modules, or declared in build.ts's EXTERNAL list. */
  | 'external'
  /**
   * Relative or path-aliased specifier that does not exist on disk. Expected:
   * rayu is built from partial source, so these are the TS2307s already
   * recorded in typecheck-baseline.json.
   */
  | 'missing-internal'
  /** Bare specifier that is neither installed nor declared external. */
  | 'missing-package'

/** Node builtins, without the `node:` prefix. Subpaths (`fs/promises`) count. */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
  'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl',
  'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

function isNodeBuiltin(spec: string): boolean {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec
  return NODE_BUILTINS.has(bare.split('/')[0])
}

/** `bun` and every `bun:*` virtual module. `bun:bundle` is the migration's target. */
function isBunBuiltin(spec: string): boolean {
  return spec === 'bun' || spec.startsWith('bun:')
}

// ─────────────────── UI classification (what must stay CLI-side) ──────────────

/**
 * Directories that are terminal UI by definition. Per the plan, `rayu/` keeps
 * entrypoints/, ink/, components/, screens/, hooks/ — everything else is a
 * candidate for core.
 */
const UI_DIRS = [
  'src/components/',
  'src/screens/',
  'src/hooks/',
  'src/ink/',
  'src/entrypoints/',
]

/** Package specifiers that make a file un-shippable in a non-terminal host. */
const UI_PACKAGES = new Set([
  'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime',
  'react-reconciler', 'react-devtools-core', 'ink', 'ink-testing-library',
])

function isReactSpecifier(spec: string): boolean {
  return spec === 'react' || spec.startsWith('react/') || spec === 'react-dom'
}

function isInkSpecifier(spec: string): boolean {
  return spec === 'ink' || spec.startsWith('ink-') || spec.startsWith('ink/')
}

function isUiPath(relPath: string): boolean {
  return UI_DIRS.some(d => relPath.startsWith(d))
}

// ─────────────────────────────── file-level facts ──────────────────────────────

export type ImportEdge = {
  /** The specifier exactly as written in source. */
  spec: string
  kind: SpecifierKind
  /** Resolved ROOT-relative path, for `internal` (and resolvable `external`). */
  resolved?: string
  /**
   * True when the import is erased at compile time (`import type`, or an import
   * whose every named binding is `type`-qualified, or a type-position
   * `import('x').T`). Type-only edges are NOT runtime dependencies, but they do
   * still have to resolve for a moved file to compile.
   */
  typeOnly: boolean
  /** `import()` / `require()` rather than a static top-level import. */
  dynamic: boolean
  line: number
}

export type BunGuard =
  /** Inside `if (typeof Bun !== 'undefined')`, a guarded ternary, or an `&&` chain. */
  | 'guarded'
  /** The access IS the guard, e.g. the `Bun.which` in `typeof Bun.which === 'function'`. */
  | 'guard-expression'
  /** Inside a try block — a ReferenceError would be caught, so it is survivable. */
  | 'try-guarded'
  /** Would throw a ReferenceError under plain Node. The only category that blocks. */
  | 'unguarded'

export type BunAccess = {
  /** e.g. `Bun.spawn`, `Bun.semver`. */
  expression: string
  guard: BunGuard
  line: number
}

export type FileFacts = {
  file: string
  imports: ImportEdge[]
  importsReact: boolean
  /** React imported as a VALUE (not `import type`) — a true runtime edge. */
  importsReactRuntime: boolean
  importsInk: boolean
  importsBunBundle: boolean
  /** Any `bun:*` module other than bun:bundle (e.g. bun:sqlite, bun:test). */
  importsOtherBunModule: boolean
  /**
   * The file contains JSX. tsconfig sets `jsx: "react-jsx"`, so JSX compiles to
   * `react/jsx-runtime` calls WITHOUT any explicit import — a React dependency
   * that no import-based scan can see. 29 .tsx files here have no `import
   * React`, so this is the difference between a correct move list and a wrong
   * one.
   */
  usesJsx: boolean
  bunAccesses: BunAccess[]
  uiPath: boolean
}

/** A file cannot live in core if any of these hold. */
export function impurityReasons(f: FileFacts, ignore?: ReadonlySet<string>): string[] {
  const reasons: string[] = []
  if (f.uiPath) reasons.push('ui-directory')
  if (f.importsReact) reasons.push('imports-react')
  if (f.usesJsx && !f.importsReact) reasons.push('uses-jsx')
  if (f.importsInk) reasons.push('imports-ink')
  if (f.importsBunBundle) reasons.push('imports-bun-bundle')
  // Any other `bun:*` virtual module is Bun-only too and would throw under the
  // plain-node runtime the extension uses. bun:bundle is listed separately
  // because Task 4 addresses it specifically.
  if (f.importsOtherBunModule) reasons.push('imports-bun-builtin')
  if (f.bunAccesses.some(a => a.guard === 'unguarded')) reasons.push('unguarded-bun')
  return ignore ? reasons.filter(r => !ignore.has(r)) : reasons
}

export function isPure(f: FileFacts, ignore?: ReadonlySet<string>): boolean {
  return impurityReasons(f, ignore).length === 0
}

// ──────────────────────────── build.ts static reads ───────────────────────────

export type BuildInputs = {
  /** Specifiers Bun leaves unbundled; absent at runtime is intentional. */
  external: string[]
  /** Specifiers Bun redirects to local stub files. */
  stubAliases: Record<string, string>
}

/**
 * The build inputs the analyzer needs, imported directly.
 *
 * These used to be parsed out of `scripts/build.ts`'s AST, because build.ts runs
 * `Bun.build()` at module scope and importing it would trigger a build. They now
 * live in `scripts/bundleConfig.ts`, which is side-effect free — it only exports
 * consts and factory functions — so a plain import is both simpler and
 * drift-proof by construction rather than by a rename guard.
 *
 * (The rename guard did its job on the way here: moving the consts made this
 * function throw with a message naming itself, which is how the move was caught.)
 */
export function readBuildInputs(): BuildInputs {
  return { external: EXTERNAL, stubAliases: STUB_ALIASES }
}

// ─────────────────────────── Bun.* guard classification ───────────────────────

/**
 * Names that mean "we are running under Bun" when they appear in a condition.
 * Both are verified in src/utils/bundledMode.ts to be exactly that predicate
 * (`process.versions.bun !== undefined`, and an embedded-files check that itself
 * begins with `typeof Bun !== 'undefined'`).
 */
const GUARD_PREDICATES = new Set(['isRunningWithBun', 'isInBundledMode'])

/** Does this subtree contain a runtime-is-Bun check? */
function hasBunGuardCheck(node: ts.Node, flagNames: ReadonlySet<string>): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    // typeof Bun !== 'undefined'
    if (
      ts.isTypeOfExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'Bun'
    ) {
      found = true
      return
    }
    // process.versions.bun
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === 'bun' &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'versions'
    ) {
      found = true
      return
    }
    // a module-scope flag const, or a known predicate call
    if (ts.isIdentifier(n) && (flagNames.has(n.text) || GUARD_PREDICATES.has(n.text))) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/**
 * Module-scope consts whose initializer is itself a Bun check, so that
 * `const HAS_BUN = typeof Bun !== 'undefined'` … `HAS_BUN ? Bun.x : y` is
 * recognised as guarded.
 */
function collectBunFlagNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      if (hasBunGuardCheck(decl.initializer, names)) names.add(decl.name.text)
    }
  }
  return names
}

/** Does this statement always leave the block (so what follows is guarded)? */
function alwaysExits(stmt: ts.Statement | undefined): boolean {
  if (!stmt) return false
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true
  if (ts.isBlock(stmt)) {
    return stmt.statements.some(s => ts.isReturnStatement(s) || ts.isThrowStatement(s))
  }
  return false
}

function classifyBunGuard(
  access: ts.Node,
  flagNames: ReadonlySet<string>,
): BunGuard {
  // `typeof Bun.stringWidth === 'function'` — the access is part of the guard.
  if (access.parent && ts.isTypeOfExpression(access.parent)) return 'guard-expression'

  let child: ts.Node = access
  let parent: ts.Node | undefined = access.parent
  let insideTry = false

  while (parent && !ts.isSourceFile(parent)) {
    // A && chain: `typeof Bun !== 'undefined' && Array.isArray(Bun.embeddedFiles)`
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === child &&
      hasBunGuardCheck(parent.left, flagNames)
    ) {
      return 'guarded'
    }

    // A ternary whose condition tests for Bun, access in either branch:
    //   typeof Bun !== 'undefined' ? Bun.hash(x) : fallback(x)
    //   typeof Bun === 'undefined' ? fallback(x) : Bun.hash(x)
    if (
      ts.isConditionalExpression(parent) &&
      (parent.whenTrue === child || parent.whenFalse === child) &&
      hasBunGuardCheck(parent.condition, flagNames)
    ) {
      return 'guarded'
    }

    // The dominant shape in this repo: if (typeof Bun !== 'undefined') { … }
    if (
      ts.isIfStatement(parent) &&
      (parent.thenStatement === child || parent.elseStatement === child) &&
      hasBunGuardCheck(parent.expression, flagNames)
    ) {
      return 'guarded'
    }

    // An earlier `if (…Bun check…) return/throw` in the same block guards the rest.
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const idx = (parent as ts.Block).statements.indexOf(child as ts.Statement)
      if (idx > 0) {
        for (let i = 0; i < idx; i++) {
          const prev = (parent as ts.Block).statements[i]
          if (
            ts.isIfStatement(prev) &&
            hasBunGuardCheck(prev.expression, flagNames) &&
            alwaysExits(prev.thenStatement)
          ) {
            return 'guarded'
          }
        }
      }
    }

    // A ReferenceError from an undefined `Bun` is a catchable runtime error.
    if (ts.isTryStatement(parent) && parent.tryBlock === child) insideTry = true

    child = parent
    parent = parent.parent
  }

  return insideTry ? 'try-guarded' : 'unguarded'
}

// ──────────────────────────────── the analyzer ────────────────────────────────

export type Analysis = {
  /** Every file tsconfig `include` covers, keyed ROOT-relative. */
  files: Map<string, FileFacts>
  /** Typecheck-baseline error count bucketed per file. */
  baselineErrors: Map<string, number>
  buildInputs: BuildInputs
}

type Resolver = (spec: string, containingFile: string) => ts.ResolvedModuleFull | undefined

function makeResolver(options: ts.CompilerOptions): Resolver {
  const cache = ts.createModuleResolutionCache(ROOT, s => s, options)
  return (spec, containingFile) =>
    ts.resolveModuleName(spec, containingFile, options, ts.sys, cache)
      .resolvedModule
}

/** True when every named binding is `type`-qualified, so nothing survives emit. */
function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false // `import 'side-effect'` — a runtime edge
  if (clause.isTypeOnly) return true
  if (clause.name) return false // a default binding is a value
  const named = clause.namedBindings
  if (named && ts.isNamedImports(named)) {
    return named.elements.length > 0 && named.elements.every(e => e.isTypeOnly)
  }
  return false
}

function collectFileFacts(
  absPath: string,
  options: ts.CompilerOptions,
  resolve_: Resolver,
  buildInputs: BuildInputs,
): FileFacts {
  const relPath = rel(absPath)
  const sf = ts.createSourceFile(
    absPath,
    readFileSync(absPath, 'utf8'),
    ts.ScriptTarget.ESNext,
    /* setParentNodes — required for the guard ancestor walk */ true,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const externalSet = new Set(buildInputs.external)
  const flagNames = collectBunFlagNames(sf)
  const imports: ImportEdge[] = []
  const bunAccesses: BunAccess[] = []
  let usesJsx = false

  const lineOf = (n: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  const addEdge = (
    specNode: ts.Expression,
    typeOnly: boolean,
    dynamic: boolean,
    at: ts.Node,
  ): void => {
    if (!ts.isStringLiteralLike(specNode)) return // computed — cannot be followed
    const spec = specNode.text

    let kind: SpecifierKind
    let resolvedRel: string | undefined

    if (isBunBuiltin(spec)) {
      kind = 'bun-builtin'
    } else if (isNodeBuiltin(spec)) {
      kind = 'node-builtin'
    } else {
      const resolved = resolve_(spec, absPath)
      if (resolved) {
        const r = rel(resolved.resolvedFileName)
        if (r.startsWith('node_modules/') || r.startsWith('..')) {
          kind = 'external'
        } else {
          kind = 'internal'
          resolvedRel = r
        }
      } else if (externalSet.has(spec)) {
        // Declared external in build.ts — unbundled on purpose, may be absent.
        kind = 'external'
      } else if (spec.startsWith('.') || spec.startsWith('src/') || spec.startsWith('@ant/')) {
        kind = 'missing-internal'
      } else {
        kind = 'missing-package'
      }
    }

    imports.push({ spec, kind, resolved: resolvedRel, typeOnly, dynamic, line: lineOf(at) })
  }

  const visit = (node: ts.Node): void => {
    // import … from 'x'   /   import 'x'
    if (ts.isImportDeclaration(node)) {
      addEdge(node.moduleSpecifier, importClauseIsTypeOnly(node.importClause), false, node)
    }
    // export … from 'x'  — a real graph edge that regex-based scans miss
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      addEdge(node.moduleSpecifier, node.isTypeOnly, false, node)
    }
    // import x = require('y')
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addEdge(node.moduleReference.expression, node.isTypeOnly, false, node)
    }
    // typeof import('x') / import('x').T in a type position
    else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        addEdge(node.argument.literal, true, true, node)
      }
    } else if (ts.isCallExpression(node)) {
      // await import('x')
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
        addEdge(node.arguments[0], false, true, node)
      }
      // require('x') — used by the lazy non-Bun fallbacks in utils/*.ts
      else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments[0]
      ) {
        addEdge(node.arguments[0], false, true, node)
      }
    }

    // Bun.<prop> and Bun['prop'] — AST-based, so comments and 'bun.lock' strings
    // cannot inflate the count the way a regex does.
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Bun'
    ) {
      const prop = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : '<computed>'
      bunAccesses.push({
        expression: `Bun.${prop}`,
        guard: classifyBunGuard(node, flagNames),
        line: lineOf(node),
      })
    }

    // JSX compiles to react/jsx-runtime under `jsx: "react-jsx"` with no import
    // to find, so the syntax itself is the dependency.
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      usesJsx = true
    }

    ts.forEachChild(node, visit)
  }
  visit(sf)

  return {
    file: relPath,
    imports,
    importsReact: imports.some(i => isReactSpecifier(i.spec)),
    importsReactRuntime: imports.some(i => isReactSpecifier(i.spec) && !i.typeOnly),
    importsInk: imports.some(i => isInkSpecifier(i.spec)),
    importsBunBundle: imports.some(i => i.spec === 'bun:bundle'),
    importsOtherBunModule: imports.some(
      i => i.kind === 'bun-builtin' && i.spec !== 'bun:bundle',
    ),
    usesJsx,
    bunAccesses,
    uiPath: isUiPath(relPath),
  }
}

/** Bucket typecheck-baseline.json's error counts per file. */
export function loadBaselineErrors(): Map<string, number> {
  const out = new Map<string, number>()
  if (!existsSync(TYPECHECK_BASELINE_PATH)) return out
  const raw: Record<string, number> = JSON.parse(
    readFileSync(TYPECHECK_BASELINE_PATH, 'utf8'),
  )
  for (const [sig, count] of Object.entries(raw)) {
    // Keys are `<file>|<TSCODE>|<message>`; messages can themselves contain
    // '|', so split on the FIRST two separators only.
    const i1 = sig.indexOf('|')
    if (i1 < 0) continue
    const file = sig.slice(0, i1).replace(/\\/g, '/')
    out.set(file, (out.get(file) ?? 0) + count)
  }
  return out
}

/**
 * The shape of the accepted type debt.
 *
 * Reported as three separate numbers because they get conflated: the migration
 * plan cites "983 accepted typecheck errors", but 983 is the number of error
 * SIGNATURES in typecheck-baseline.json. The error COUNT is 1557, spread over
 * 315 files. Per-wave debt has to be summed by count, not by signature.
 */
export function baselineDebtShape(): {
  signatures: number
  errors: number
  files: number
} {
  if (!existsSync(TYPECHECK_BASELINE_PATH)) return { signatures: 0, errors: 0, files: 0 }
  const raw: Record<string, number> = JSON.parse(
    readFileSync(TYPECHECK_BASELINE_PATH, 'utf8'),
  )
  const perFile = loadBaselineErrors()
  return {
    signatures: Object.keys(raw).length,
    errors: Object.values(raw).reduce((a, b) => a + b, 0),
    files: perFile.size,
  }
}

export function analyze(): Analysis {
  const configPath = resolve(ROOT, 'tsconfig.json')
  const read = ts.readConfigFile(configPath, p => ts.sys.readFile(p))
  if (read.error) {
    throw new Error(
      `tsconfig.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
    )
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, configPath)
  const fatal = parsed.errors.filter(e => e.category === ts.DiagnosticCategory.Error)
  if (fatal.length > 0) {
    throw new Error(
      `tsconfig.json: ${fatal
        .map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'))
        .join('; ')}`,
    )
  }

  const buildInputs = readBuildInputs()
  const resolver = makeResolver(parsed.options)
  const files = new Map<string, FileFacts>()

  for (const abs of parsed.fileNames) {
    const relPath = rel(abs)
    // Only project sources. `include` already scopes this, but a declaration
    // file dragged in by `types` would otherwise skew the counts.
    if (relPath.startsWith('..') || relPath.startsWith('node_modules/')) continue
    if (relPath.endsWith('.d.ts')) continue
    files.set(relPath, collectFileFacts(abs, parsed.options, resolver, buildInputs))
  }

  return { files, baselineErrors: loadBaselineErrors(), buildInputs }
}

// ────────────────────────────── closure traversal ─────────────────────────────

export type Closure = {
  /** Every reachable internal file that the analyzer has facts for. */
  members: Set<string>
  /**
   * Resolved project-internal files that tsconfig `include` does NOT cover, so
   * no facts exist for them: the `stubs/` tree (reached through the `@ant/*` and
   * `color-diff-napi` path aliases) and `.d.ts` declaration files. They are real
   * edges and are reported, but they are not classifiable as pure or impure, so
   * keeping them out of `members` is what stops a caller from reading undefined
   * facts.
   */
  outsideProgram: Set<string>
  /** Shortest import path from an entry to each member, for explaining a verdict. */
  pathTo: Map<string, string[]>
  /** Specifiers that could not be resolved, grouped by kind. */
  missing: { spec: string; from: string; kind: SpecifierKind; line: number }[]
  externalPackages: Set<string>
  bunBuiltins: Set<string>
}

export type ClosureOptions = {
  /** Follow type-only edges too. Default true: a moved file must still compile. */
  followTypeOnly?: boolean
}

/**
 * Breadth-first walk so `pathTo` holds a SHORTEST path — the most useful form
 * when explaining "how does this wave reach react".
 */
export function closureOf(
  analysis: Analysis,
  entries: string[],
  opts: ClosureOptions = {},
): Closure {
  const followTypeOnly = opts.followTypeOnly ?? true
  const members = new Set<string>()
  const outsideProgram = new Set<string>()
  const pathTo = new Map<string, string[]>()
  const missing: Closure['missing'] = []
  const externalPackages = new Set<string>()
  const bunBuiltins = new Set<string>()

  const queue: string[] = []
  for (const e of entries) {
    if (members.has(e)) continue
    members.add(e)
    pathTo.set(e, [e])
    queue.push(e)
  }

  while (queue.length > 0) {
    const current = queue.shift() as string
    const facts = analysis.files.get(current)
    if (!facts) continue

    for (const edge of facts.imports) {
      if (edge.typeOnly && !followTypeOnly) continue

      switch (edge.kind) {
        case 'internal': {
          const next = edge.resolved as string
          // Reachable but outside the program (stubs/, .d.ts): a real edge with
          // no facts to judge, so it is recorded separately.
          if (!analysis.files.has(next)) {
            outsideProgram.add(next)
            break
          }
          if (members.has(next)) break
          members.add(next)
          pathTo.set(next, [...(pathTo.get(current) as string[]), next])
          queue.push(next)
          break
        }
        case 'external':
          externalPackages.add(edge.spec)
          break
        case 'bun-builtin':
          bunBuiltins.add(edge.spec)
          break
        case 'missing-internal':
        case 'missing-package':
          missing.push({ spec: edge.spec, from: current, kind: edge.kind, line: edge.line })
          break
        case 'node-builtin':
          break
      }
    }
  }

  return { members, outsideProgram, pathTo, missing, externalPackages, bunBuiltins }
}

// ─────────────────────── strongly connected components (cycles) ───────────────

/**
 * Tarjan's SCC over the internal import graph, iterative so a ~2000-deep chain
 * cannot blow the JS stack.
 *
 * WHY THIS MATTERS MORE THAN ANY OTHER NUMBER HERE: every Phase B wave reports a
 * closure of ~2043 files, and they are not 2043 DIFFERENT files per wave — they
 * are the same single giant cycle. A file inside that cycle cannot be moved to
 * core on its own at any cost, because following its imports leads back to
 * itself through the UI. Cycles have to be broken before anything inside them
 * moves; that is a design change, not a file move.
 */
export function stronglyConnectedComponents(analysis: Analysis): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  let counter = 0

  const successors = (file: string): string[] => {
    const facts = analysis.files.get(file)
    if (!facts) return []
    const next: string[] = []
    for (const e of facts.imports) {
      if (e.kind === 'internal' && e.resolved && analysis.files.has(e.resolved)) {
        next.push(e.resolved)
      }
    }
    return next
  }

  for (const root of analysis.files.keys()) {
    if (index.has(root)) continue

    // Explicit work stack: each frame is a node plus its next-successor cursor.
    const work: { node: string; succ: string[]; i: number }[] = []
    index.set(root, counter)
    low.set(root, counter)
    counter++
    stack.push(root)
    onStack.add(root)
    work.push({ node: root, succ: successors(root), i: 0 })

    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (frame.i < frame.succ.length) {
        const w = frame.succ[frame.i++]
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter)
          counter++
          stack.push(w)
          onStack.add(w)
          work.push({ node: w, succ: successors(w), i: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(w) as number))
        }
      } else {
        work.pop()
        const parent = work[work.length - 1]
        if (parent) {
          low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number))
        }
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = []
          for (;;) {
            const w = stack.pop() as string
            onStack.delete(w)
            component.push(w)
            if (w === frame.node) break
          }
          out.push(component.sort())
        }
      }
    }
  }

  return out.sort((a, b) => b.length - a.length)
}

// ─────────────────────────────── movability ───────────────────────────────────

export type Movability = {
  /**
   * Files that could be moved to core TODAY: the file is pure, and so is every
   * file in its transitive closure, and nothing in that closure has an
   * unresolvable import (core must build with 0 errors per plan Task 2).
   */
  movable: Set<string>
  /** Pure closure, but something in it fails to resolve — blocked on partial source. */
  blockedByMissing: Set<string>
  /** The file itself is pure but its closure is not. Blocked on other files moving. */
  blockedByDependency: Set<string>
  /** The file itself is impure. */
  impure: Set<string>
}

/**
 * Fixpoint rather than per-file closure walks: a file is movable iff it is pure
 * and every internal import is movable. Iterating to stability handles the
 * cycles correctly (a cycle containing anything impure is entirely unmovable)
 * and runs in a fraction of the time 2189 separate closure walks would take.
 */
export function movability(
  analysis: Analysis,
  scope = 'src/',
  ignore?: ReadonlySet<string>,
  /**
   * Treat type-only imports as non-blocking. A type-only edge is erased at
   * runtime, so a file importing only a TYPE from a React module has no runtime
   * dependency on React — the edge can be satisfied by relocating the type to a
   * leaf module instead of moving the implementation. Setting this measures the
   * boundary that is reachable by moving types, which is far cheaper than
   * untangling runtime dependencies.
   */
  ignoreTypeOnlyEdges = false,
): Movability {
  const candidates = [...analysis.files.keys()].filter(f => f.startsWith(scope))
  const impure = new Set<string>()
  const movable = new Set<string>()

  for (const f of candidates) {
    const facts = analysis.files.get(f) as FileFacts
    if (isPure(facts, ignore)) movable.add(f)
    else impure.add(f)
  }

  // Track why a file was rejected so the report can distinguish "waiting on a
  // dependency" from "waiting on a module that does not exist".
  const missingBlocked = new Set<string>()

  let changed = true
  while (changed) {
    changed = false
    for (const f of [...movable]) {
      const facts = analysis.files.get(f) as FileFacts
      for (const e of facts.imports) {
        if (ignoreTypeOnlyEdges && e.typeOnly) continue
        if (e.kind === 'missing-internal' || e.kind === 'missing-package') {
          movable.delete(f)
          missingBlocked.add(f)
          changed = true
          break
        }
        if (e.kind === 'internal' && e.resolved && !movable.has(e.resolved)) {
          movable.delete(f)
          changed = true
          break
        }
      }
    }
  }

  const blockedByMissing = new Set<string>()
  const blockedByDependency = new Set<string>()
  for (const f of candidates) {
    if (movable.has(f) || impure.has(f)) continue
    if (missingBlocked.has(f)) blockedByMissing.add(f)
    else blockedByDependency.add(f)
  }

  return { movable, blockedByMissing, blockedByDependency, impure }
}

/**
 * The edges to cut, ranked.
 *
 * Within the big cycle, most files are themselves pure — they are trapped only
 * because they import something impure that imports back. This ranks the impure
 * TARGETS by how many otherwise-pure files depend on them. Fixing the top few
 * (inject instead of import, split a module, move a type to a leaf) is what
 * collapses the cycle and makes whole subsystems extractable. Without this the
 * only visible option is "move 1618 files at once", which is not a plan.
 */
export type CutCandidate = {
  /** The impure file being imported. */
  target: string
  reasons: string[]
  /** How many pure files import it. */
  pureImporters: number
  /** How many of those edges are type-only, i.e. removable with `import type`. */
  typeOnlyEdges: number
  examples: string[]
}

export function cutCandidates(analysis: Analysis, scope = 'src/'): CutCandidate[] {
  const byTarget = new Map<string, { total: number; typeOnly: number; from: string[] }>()

  for (const [file, facts] of analysis.files) {
    if (!file.startsWith(scope)) continue
    if (!isPure(facts)) continue // only count edges FROM would-be-core files
    for (const e of facts.imports) {
      if (e.kind !== 'internal' || !e.resolved) continue
      const targetFacts = analysis.files.get(e.resolved)
      if (!targetFacts || isPure(targetFacts)) continue
      const entry = byTarget.get(e.resolved) ?? { total: 0, typeOnly: 0, from: [] }
      entry.total++
      if (e.typeOnly) entry.typeOnly++
      if (entry.from.length < 5) entry.from.push(file)
      byTarget.set(e.resolved, entry)
    }
  }

  return [...byTarget.entries()]
    .map(([target, v]) => ({
      target,
      reasons: impurityReasons(analysis.files.get(target) as FileFacts),
      pureImporters: v.total,
      typeOnlyEdges: v.typeOnly,
      examples: v.from,
    }))
    .sort((a, b) => b.pureImporters - a.pureImporters || a.target.localeCompare(b.target))
}

/**
 * Files whose ONLY impurity is where they sit: under a UI directory, but
 * importing no React and using no Bun-only API. These are utility modules that
 * are UI by filesystem location and nothing else, so the fix is `git mv`, not a
 * rewrite — the cheapest class of fix in the whole migration and invisible to
 * any path-based heuristic used on its own.
 */
export function uiByLocationOnly(analysis: Analysis): string[] {
  const out: string[] = []
  for (const [file, facts] of analysis.files) {
    if (!file.startsWith('src/')) continue
    const reasons = impurityReasons(facts)
    if (reasons.length === 1 && reasons[0] === 'ui-directory') out.push(file)
  }
  return out.sort()
}

// ──────────────────────────── migration wave definitions ──────────────────────

export type WaveSpec = {
  id: string
  /** The plan task this wave implements. */
  task: string
  /** Globs, ROOT-relative. Every glob MUST match at least one file. */
  entries: string[]
  /** Globs to subtract, with the reason recorded in the plan. */
  exclude?: string[]
  note?: string
}

/**
 * The Phase B waves from RAYU_CORE_MIGRATION_PLAN.md §6.
 *
 * NOTE — two paths in the plan text were wrong and are corrected here against
 * disk: `claudemd.ts` lives at src/utils/claudemd.ts (not src/claudemd.ts), and
 * `utils/mcp/*` holds only two files; the bulk of MCP is src/services/mcp/.
 * Every glob is validated at run time, so a path that stops matching fails the
 * analyzer instead of silently shrinking a wave.
 */
export const WAVES: WaveSpec[] = [
  {
    id: 'task6-pure-leaves',
    task: 'Task 6 — pure leaves',
    entries: [
      'src/types/**/*.ts',
      'src/constants/**/*.ts',
      'src/utils/path.ts',
      'src/utils/hash.ts',
      'src/utils/semver.ts',
      'src/utils/yaml.ts',
      'src/utils/json.ts',
      'src/utils/which.ts',
      'src/utils/uuid.ts',
      'src/utils/errors.ts',
    ],
  },
  {
    id: 'task7-config-auth',
    task: 'Task 7 — config, endpoints, credential backends',
    entries: [
      'src/utils/rayuConfig.ts',
      'src/utils/config.ts',
      'src/utils/rayuProviders.ts',
      'src/constants/oauth.ts',
      'src/constants/product.ts',
      'src/services/rayuAuth/**/*.ts',
    ],
  },
  {
    id: 'task8a-tools',
    task: 'Task 8a — tool logic',
    entries: ['src/Tool.ts', 'src/tools/**/*Tool.ts'],
  },
  {
    id: 'task8b-registry',
    task: 'Task 8b — the tools.ts registry',
    entries: ['src/tools.ts'],
  },
  {
    id: 'task9-commands',
    task: 'Task 9 — command registry',
    entries: ['src/commands.ts', 'src/commands/**/*.ts'],
  },
  {
    id: 'task10-context-mcp',
    task: 'Task 10 — context and MCP',
    entries: [
      'src/utils/analyzeContext.ts',
      'src/context.ts',
      'src/utils/claudemd.ts',
      'src/utils/mcp/**/*.ts',
      'src/services/mcp/**/*.ts',
    ],
    // Plan §6 Task 10: the connection lifecycle is a 1049-line React hook plus a
    // thin provider. That is a rewrite, not a split, so it stays CLI-side.
    exclude: [
      'src/services/mcp/useManageMCPConnections.ts',
      'src/services/mcp/MCPConnectionManager.tsx',
    ],
    note: 'excludes useManageMCPConnections.ts + MCPConnectionManager.tsx (plan §6 Task 10)',
  },
  {
    id: 'task11-query',
    task: 'Task 11 — query engine and session',
    entries: [
      'src/QueryEngine.ts',
      'src/query.ts',
      'src/utils/messages.ts',
      'src/utils/sessionStorage.ts',
      'src/utils/sessionStoragePortable.ts',
    ],
  },
  {
    id: 'cli-entrypoint',
    task: 'reference — the CLI bundle root (expected impure: it owns the Ink UI)',
    entries: ['src/entrypoints/cli.tsx'],
  },
]

/** Minimal glob support: `**` (any depth) and `*` (one segment). */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` swallows the slash so `a/**/*.ts` also matches `a/b.ts`
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`)
}

export function expandEntries(analysis: Analysis, wave: WaveSpec): string[] {
  const all = [...analysis.files.keys()]
  const excluded = new Set<string>()
  for (const g of wave.exclude ?? []) {
    const re = globToRegExp(g)
    for (const f of all) if (re.test(f)) excluded.add(f)
  }

  const picked = new Set<string>()
  for (const g of wave.entries) {
    const re = globToRegExp(g)
    const hits = all.filter(f => re.test(f))
    if (hits.length === 0) {
      throw new Error(
        `wave "${wave.id}": entry glob "${g}" matched no file. The source moved ` +
          `or was renamed — fix WAVES rather than letting the wave silently shrink.`,
      )
    }
    for (const h of hits) if (!excluded.has(h)) picked.add(h)
  }
  return [...picked].sort()
}

// ───────────────────────────────── reporting ──────────────────────────────────

export type WaveReport = {
  id: string
  task: string
  note?: string
  entryCount: number
  closureSize: number
  impure: { file: string; reasons: string[]; via: string[] }[]
  missingInternal: number
  missingPackage: number
  /** Reached files outside the tsconfig program (stubs/, .d.ts). */
  outsideProgram: string[]
  baselineErrors: number
  externalPackages: string[]
  bunBuiltins: string[]
}

export function reportWave(analysis: Analysis, wave: WaveSpec): WaveReport {
  const entries = expandEntries(analysis, wave)
  const closure = closureOf(analysis, entries)

  const impure: WaveReport['impure'] = []
  let baselineErrors = 0
  for (const file of [...closure.members].sort()) {
    baselineErrors += analysis.baselineErrors.get(file) ?? 0
    const facts = analysis.files.get(file)
    if (!facts) continue
    const reasons = impurityReasons(facts)
    if (reasons.length > 0) {
      impure.push({ file, reasons, via: closure.pathTo.get(file) ?? [file] })
    }
  }

  return {
    id: wave.id,
    task: wave.task,
    note: wave.note,
    entryCount: entries.length,
    closureSize: closure.members.size,
    impure,
    missingInternal: closure.missing.filter(m => m.kind === 'missing-internal').length,
    missingPackage: closure.missing.filter(m => m.kind === 'missing-package').length,
    outsideProgram: [...closure.outsideProgram].sort(),
    baselineErrors,
    externalPackages: [...closure.externalPackages].sort(),
    bunBuiltins: [...closure.bunBuiltins].sort(),
  }
}

/**
 * Counts are reported per SCOPE. The migration plan's figures were greps over
 * `rayu/src` only, while tsconfig `include` also covers scripts/ and test/.
 * Splitting them is what makes the analyzer's numbers comparable to the plan's
 * instead of mysteriously two higher.
 */
export type ScopeCounts = {
  files: number
  reactImporters: number
  reactRuntimeImporters: number
  /** Files importing the `ink` npm package. See the note in repoTotals(). */
  inkPackageImporters: number
  /** Files inside src/ink/ — the vendored Ink fork, which is the real coupling. */
  vendoredInkFiles: number
  bunBundleImporters: number
  /** Files using JSX with NO explicit react import — invisible to import scans. */
  jsxWithoutReactImport: number
  bunAccessTotal: number
  bunAccessFiles: number
  guardCounts: Record<BunGuard, number>
}

export type RepoTotals = {
  all: ScopeCounts
  src: ScopeCounts
  /** scripts/ + test/ — build tooling and tests, never candidates for core. */
  nonSrc: ScopeCounts
  /** Every non-src react importer, listed because the set is small enough to audit. */
  nonSrcReactImporters: string[]
  /** Every non-src bun:bundle importer, same reason. */
  nonSrcBunBundleImporters: string[]
  bunAccesses: { file: string; expression: string; line: number; guard: BunGuard }[]
  enabledFeatures: string[]
}

function emptyScope(): ScopeCounts {
  return {
    files: 0,
    reactImporters: 0,
    reactRuntimeImporters: 0,
    inkPackageImporters: 0,
    vendoredInkFiles: 0,
    bunBundleImporters: 0,
    jsxWithoutReactImport: 0,
    bunAccessTotal: 0,
    bunAccessFiles: 0,
    guardCounts: { guarded: 0, 'guard-expression': 0, 'try-guarded': 0, unguarded: 0 },
  }
}

function tally(scope: ScopeCounts, f: FileFacts): void {
  scope.files++
  if (f.importsReact) scope.reactImporters++
  if (f.importsReactRuntime) scope.reactRuntimeImporters++
  if (f.importsInk) scope.inkPackageImporters++
  if (f.file.startsWith('src/ink/')) scope.vendoredInkFiles++
  if (f.importsBunBundle) scope.bunBundleImporters++
  if (f.usesJsx && !f.importsReact) scope.jsxWithoutReactImport++
  if (f.bunAccesses.length > 0) {
    scope.bunAccessFiles++
    scope.bunAccessTotal += f.bunAccesses.length
    for (const a of f.bunAccesses) scope.guardCounts[a.guard]++
  }
}

export function repoTotals(analysis: Analysis): RepoTotals {
  const all = emptyScope()
  const src = emptyScope()
  const nonSrc = emptyScope()
  const nonSrcReactImporters: string[] = []
  const nonSrcBunBundleImporters: string[] = []
  const bunAccesses: RepoTotals['bunAccesses'] = []

  for (const facts of analysis.files.values()) {
    const inSrc = facts.file.startsWith('src/')
    tally(all, facts)
    tally(inSrc ? src : nonSrc, facts)
    if (!inSrc) {
      if (facts.importsReact) nonSrcReactImporters.push(facts.file)
      if (facts.importsBunBundle) nonSrcBunBundleImporters.push(facts.file)
    }
    for (const a of facts.bunAccesses) {
      bunAccesses.push({ file: facts.file, expression: a.expression, line: a.line, guard: a.guard })
    }
  }

  const byFile = (a: string, b: string) => a.localeCompare(b)
  return {
    all,
    src,
    nonSrc,
    nonSrcReactImporters: nonSrcReactImporters.sort(byFile),
    nonSrcBunBundleImporters: nonSrcBunBundleImporters.sort(byFile),
    bunAccesses: bunAccesses.sort(
      (a, b) => byFile(a.file, b.file) || a.line - b.line,
    ),
    enabledFeatures: [...ENABLED_FEATURES],
  }
}

/**
 * Per-entry closure sizes for one wave, largest first.
 *
 * This is how a wave's non-leaf entries get NAMED rather than guessed at. It is
 * the check that showed the plan's "pure leaves" wave is not pure: a single
 * entry, src/constants/prompts.ts, imports 'src/commands.js' through the
 * tsconfig `src/*` alias and so reaches the whole application.
 */
export function perEntryClosure(
  analysis: Analysis,
  wave: WaveSpec,
): { entry: string; closureSize: number; impure: number }[] {
  return expandEntries(analysis, wave)
    .map(entry => {
      const closure = closureOf(analysis, [entry])
      let impure = 0
      for (const m of closure.members) {
        const facts = analysis.files.get(m)
        if (facts && !isPure(facts)) impure++
      }
      return { entry, closureSize: closure.members.size, impure }
    })
    .sort((a, b) => b.closureSize - a.closureSize || a.entry.localeCompare(b.entry))
}

// ─────────────────────────────────── the CLI ──────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function main(): void {
  const UPDATE = process.argv.includes('--update')
  const waveFilter = argValue('--wave')
  const whyFile = argValue('--why')
  const jsonOut = argValue('--json')
  const perEntry = argValue('--per-entry')

  const analysis = analyze()
  const totals = repoTotals(analysis)

  const row = (label: string, s: ScopeCounts, pick: (c: ScopeCounts) => number) =>
    `  ${label.padEnd(46)}: ${String(pick(totals.src)).padStart(6)} ${String(pick(totals.nonSrc)).padStart(8)} ${String(pick(totals.all)).padStart(7)}`

  console.log('Boundary analysis — rayu/src → src/core\n')
  console.log(`  ${''.padEnd(46)}    src  non-src    all`)
  console.log(row('files (tsconfig include, .d.ts excluded)', totals.src, c => c.files))
  console.log(row("import 'react' (any)", totals.src, c => c.reactImporters))
  console.log(row("import 'react' (runtime, not type-only)", totals.src, c => c.reactRuntimeImporters))
  console.log(row("import 'ink' npm package", totals.src, c => c.inkPackageImporters))
  console.log(row('files in src/ink/ (vendored Ink fork)', totals.src, c => c.vendoredInkFiles))
  console.log(row("import 'bun:bundle'", totals.src, c => c.bunBundleImporters))
  console.log(row('JSX with no react import (react-jsx runtime)', totals.src, c => c.jsxWithoutReactImport))
  console.log(row('Bun.* accesses', totals.src, c => c.bunAccessTotal))
  console.log(row('  …in N files', totals.src, c => c.bunAccessFiles))
  console.log(row('  …guarded', totals.src, c => c.guardCounts.guarded))
  console.log(row('  …guard expression', totals.src, c => c.guardCounts['guard-expression']))
  console.log(row('  …try-guarded', totals.src, c => c.guardCounts['try-guarded']))
  console.log(row('  …UNGUARDED', totals.src, c => c.guardCounts.unguarded))
  console.log(`\n  enabled feature flags        : ${totals.enabledFeatures.join(', ')}`)
  console.log(`  build.ts EXTERNAL specifiers : ${analysis.buildInputs.external.length}`)
  console.log(`  build.ts STUB_ALIASES        : ${Object.keys(analysis.buildInputs.stubAliases).length}`)

  const debt = baselineDebtShape()
  console.log(
    `  accepted type debt           : ${debt.errors} errors / ${debt.signatures} signatures / ${debt.files} files`,
  )

  // The npm `ink` package is a declared devDependency that nothing imports; the
  // terminal UI is the 102-file vendored fork in src/ink/. Say so, because a
  // purity gate keyed on the `ink` SPECIFIER would silently pass on all of it.
  if (totals.all.inkPackageImporters === 0 && totals.all.vendoredInkFiles > 0) {
    console.log(
      `\n  note: nothing imports the 'ink' npm package. Ink coupling is entirely` +
        `\n        src/ink/ (${totals.all.vendoredInkFiles} files, a vendored fork), so purity is keyed on` +
        `\n        that path plus 'react', not on an 'ink' specifier.`,
    )
  }

  if (totals.nonSrcReactImporters.length > 0) {
    console.log(
      `\n  non-src react importers (excluded from the plan's src-only count):\n` +
        totals.nonSrcReactImporters.map(f => `        ${f}`).join('\n'),
    )
  }
  if (totals.nonSrcBunBundleImporters.length > 0) {
    console.log(
      `  non-src bun:bundle importers:\n` +
        totals.nonSrcBunBundleImporters.map(f => `        ${f}`).join('\n'),
    )
  }

  const unguarded = totals.bunAccesses.filter(a => a.guard === 'unguarded')
  const tryGuarded = totals.bunAccesses.filter(a => a.guard === 'try-guarded')
  if (unguarded.length > 0) {
    console.log('\nUnguarded Bun.* (must be guarded, kept CLI-side, or justified):')
    for (const u of unguarded) console.log(`  ${u.file}:${u.line}  ${u.expression}`)
  }
  if (tryGuarded.length > 0) {
    console.log('\nBun.* inside try/catch (a ReferenceError under node is caught, so survivable):')
    for (const u of tryGuarded) console.log(`  ${u.file}:${u.line}  ${u.expression}`)
  }

  // --why: explain one file's status and who pulls it in.
  if (whyFile) {
    const key = whyFile.replace(/\\/g, '/')
    const facts = analysis.files.get(key)
    if (!facts) {
      console.error(`\n✗ ${key} is not a project file the analyzer sees.`)
      process.exit(2)
    }
    const reasons = impurityReasons(facts)
    console.log(`\n${key}`)
    console.log(`  verdict          : ${reasons.length === 0 ? 'PURE' : 'IMPURE'}`)
    if (reasons.length > 0) console.log(`  reasons          : ${reasons.join(', ')}`)
    console.log(`  imports          : ${facts.imports.length}`)
    console.log(`  baseline errors  : ${analysis.baselineErrors.get(key) ?? 0}`)
    for (const a of facts.bunAccesses) {
      console.log(`  Bun access       : ${a.expression} (${a.guard}) at line ${a.line}`)
    }
    const importers = [...analysis.files.values()]
      .filter(f => f.imports.some(i => i.resolved === key))
      .map(f => f.file)
    console.log(`  imported by      : ${importers.length} file(s)`)
    for (const i of importers.slice(0, 20)) console.log(`      ${i}`)
    if (importers.length > 20) console.log(`      …and ${importers.length - 20} more`)
  }

  const waves = waveFilter ? WAVES.filter(w => w.id === waveFilter) : WAVES
  if (waveFilter && waves.length === 0) {
    console.error(`\n✗ unknown wave "${waveFilter}". Known: ${WAVES.map(w => w.id).join(', ')}`)
    process.exit(2)
  }

  // --per-entry: name the entries that blow a wave's closure open.
  if (perEntry) {
    const wave = WAVES.find(w => w.id === perEntry)
    if (!wave) {
      console.error(`\n✗ unknown wave "${perEntry}". Known: ${WAVES.map(w => w.id).join(', ')}`)
      process.exit(2)
    }
    console.log(`\nPer-entry closure for ${wave.id} (largest first):\n`)
    console.log(`  ${'closure'.padStart(8)} ${'impure'.padStart(7)}  entry`)
    for (const e of perEntryClosure(analysis, wave)) {
      console.log(
        `  ${String(e.closureSize).padStart(8)} ${String(e.impure).padStart(7)}  ${e.entry}`,
      )
    }
  }

  // ── what each Phase A task is actually worth, measured rather than guessed ──
  // Re-runs the movability fixpoint with one impurity reason treated as already
  // fixed. This is how Task 4's payoff is known BEFORE doing it, and verified
  // after: `imports-bun-bundle` is not merely the largest mechanical change, it
  // is the change that unblocks the boundary.
  const projections: { label: string; ignore: string[]; typesMoved?: boolean }[] = [
    { label: 'today', ignore: [] },
    { label: 'after Task 4 (bun:bundle → core feature())', ignore: ['imports-bun-bundle'] },
    {
      label: '+ all bun:* virtual modules',
      ignore: ['imports-bun-bundle', 'imports-bun-builtin'],
    },
    {
      label: '+ type-only edges repointed to leaf type modules',
      ignore: ['imports-bun-bundle', 'imports-bun-builtin'],
      typesMoved: true,
    },
  ]
  console.log('\nProjected movability per Phase A task:\n')
  console.log(`  ${'movable'.padStart(8)} ${'dep-blocked'.padStart(12)} ${'impure'.padStart(7)}  scenario`)
  for (const p of projections) {
    const m = movability(analysis, 'src/', new Set(p.ignore), p.typesMoved)
    console.log(
      `  ${String(m.movable.size).padStart(8)} ${String(m.blockedByDependency.size).padStart(12)} ` +
        `${String(m.impure.size).padStart(7)}  ${p.label}`,
    )
  }

  const reports = waves.map(w => reportWave(analysis, w))

  // ── the structural facts that explain every wave's closure size ──
  const sccs = stronglyConnectedComponents(analysis)
  const biggest = sccs[0] ?? []
  const cyclic = sccs.filter(c => c.length > 1)
  console.log('\nImport cycles (why every wave reports a similar closure):\n')
  console.log(`  cyclic components (size > 1)   : ${cyclic.length}`)
  console.log(`  files inside a cycle           : ${cyclic.reduce((n, c) => n + c.length, 0)}`)
  console.log(`  largest single cycle           : ${biggest.length} files`)
  if (biggest.length > 1) {
    const uiInBiggest = biggest.filter(f => {
      const facts = analysis.files.get(f)
      return facts ? !isPure(facts) : false
    }).length
    console.log(`    …of which impure (UI/Bun-only): ${uiInBiggest}`)
    console.log(
      `\n  A file inside that cycle cannot move to core on its own: following its\n` +
        `  imports leads back to itself through the UI. The cycle must be broken\n` +
        `  first — a design change, not a file move.`,
    )
  }

  const move = movability(analysis)
  console.log('\nMovable to core today (pure closure, every import resolvable):\n')
  console.log(`  movable now                    : ${move.movable.size}`)
  console.log(`  pure, but a dependency blocks  : ${move.blockedByDependency.size}`)
  console.log(`  pure, but an import is missing : ${move.blockedByMissing.size}`)
  console.log(`  impure themselves              : ${move.impure.size}`)

  const locationOnly = uiByLocationOnly(analysis)
  if (locationOnly.length > 0) {
    console.log(
      `\n  UI by location only (no react, no Bun-only API — relocate, do not rewrite): ${locationOnly.length}`,
    )
    for (const f of locationOnly.slice(0, 25)) console.log(`      ${f}`)
    if (locationOnly.length > 25) console.log(`      …and ${locationOnly.length - 25} more`)
  }

  if (process.argv.includes('--movable')) {
    const byDir = new Map<string, string[]>()
    for (const f of [...move.movable].sort()) {
      const dir = f.slice(0, f.lastIndexOf('/'))
      byDir.set(dir, [...(byDir.get(dir) ?? []), f])
    }
    console.log('\n  the move list, grouped by directory:')
    for (const [dir, files] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n    ${dir}/  (${files.length})`)
      for (const f of files) console.log(`      ${f.slice(dir.length + 1)}`)
    }
  }

  if (process.argv.includes('--cut-candidates')) {
    const cuts = cutCandidates(analysis)
    console.log(
      `\nEdges to cut, ranked — impure files that otherwise-pure files depend on:\n`,
    )
    console.log(`  ${'pure importers'.padStart(15)} ${'type-only'.padStart(10)}  target`)
    for (const c of cuts.slice(0, 30)) {
      console.log(
        `  ${String(c.pureImporters).padStart(15)} ${String(c.typeOnlyEdges).padStart(10)}  ${c.target}  [${c.reasons.join(', ')}]`,
      )
    }
    console.log(`\n  ${cuts.length} distinct impure targets imported by pure files.`)
    console.log(
      `  A target whose edges are all type-only is the cheapest possible fix:\n` +
        `  the import is already erased at runtime, so the dependency is only a\n` +
        `  compile-time one and the type can move to a leaf module.`,
    )
  }

  console.log('\nPer-wave closure (move lists are the closure minus what already moved):\n')
  const pad = (s: string, n: number) => s.padEnd(n)
  console.log(
    `  ${pad('wave', 22)} ${pad('entries', 8)} ${pad('closure', 8)} ${pad('impure', 7)} ${pad('missing', 8)} baseline`,
  )
  for (const r of reports) {
    console.log(
      `  ${pad(r.id, 22)} ${pad(String(r.entryCount), 8)} ${pad(String(r.closureSize), 8)} ` +
        `${pad(String(r.impure.length), 7)} ${pad(String(r.missingInternal + r.missingPackage), 8)} ${r.baselineErrors}`,
    )
  }

  if (waveFilter) {
    for (const r of reports) {
      console.log(`\n${r.task}`)
      if (r.note) console.log(`  note: ${r.note}`)
      console.log(`  closure: ${r.closureSize} file(s); impure: ${r.impure.length}`)
      console.log(`  external packages: ${r.externalPackages.length ? r.externalPackages.join(', ') : '(none)'}`)
      console.log(`  bun: specifiers  : ${r.bunBuiltins.length ? r.bunBuiltins.join(', ') : '(none)'}`)
      if (r.impure.length > 0) {
        console.log('\n  impure members, with the shortest path that pulls them in:')
        for (const i of r.impure.slice(0, 40)) {
          console.log(`    ${i.file}  [${i.reasons.join(', ')}]`)
          if (i.via.length > 1) console.log(`        via ${i.via.join(' → ')}`)
        }
        if (r.impure.length > 40) console.log(`    …and ${r.impure.length - 40} more`)
      }
    }
  }

  if (jsonOut) {
    writeFileSync(
      resolve(ROOT, jsonOut),
      JSON.stringify({ totals, waves: reports }, null, 2) + '\n',
    )
    console.log(`\n✓ wrote ${jsonOut}`)
  }

  // ── the gate: impurity must shrink, never grow (same contract as the
  //    typecheck baseline, which this repo already relies on) ──
  const current: Record<string, number> = {}
  for (const r of reports) current[r.id] = r.impure.length

  if (UPDATE) {
    if (waveFilter) {
      console.error('\n✗ --update requires a full run; drop --wave.')
      process.exit(2)
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n')
    console.log(`\n✓ boundary baseline updated (${Object.keys(current).length} waves).`)
    process.exit(0)
  }

  if (!existsSync(BASELINE_PATH)) {
    console.log(
      `\nNo boundary baseline at ${rel(BASELINE_PATH)}.` +
        `\nCreate it once with: bun run scripts/analyze-boundary.ts --update`,
    )
    process.exit(0)
  }

  const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const grew: string[] = []
  const shrank: string[] = []
  for (const [id, n] of Object.entries(current)) {
    const allowed = baseline[id]
    if (allowed === undefined) {
      grew.push(`${id}: new wave with ${n} impure file(s) and no baseline entry`)
    } else if (n > allowed) {
      grew.push(`${id}: ${n} impure, baseline allows ${allowed}`)
    } else if (n < allowed) {
      shrank.push(`${id}: ${n} impure, down from ${allowed}`)
    }
  }

  if (grew.length > 0) {
    console.error('\n✗ core boundary regressed:\n')
    for (const g of grew) console.error(`  ${g}`)
    console.error(
      '\nA wave reaching MORE UI/Bun-only code than before means an extraction ' +
        'went backwards.\nInvestigate with --wave <id>, or re-snapshot ' +
        'deliberately: bun run scripts/analyze-boundary.ts --update',
    )
    process.exit(1)
  }

  if (shrank.length > 0) {
    console.log('\n✓ boundary improved:')
    for (const s of shrank) console.log(`  ${s}`)
    console.log('  Lock it in: bun run scripts/analyze-boundary.ts --update')
  } else {
    console.log('\n✓ core boundary holds (no wave reaches more UI/Bun-only code than baseline).')
  }
  process.exit(0)
}

// Only run the CLI when executed directly, so tests can import the API.
if (import.meta.main) main()
