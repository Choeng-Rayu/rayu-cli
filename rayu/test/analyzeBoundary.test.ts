/**
 * Tests for the core-boundary analyzer (RAYU_CORE_MIGRATION_PLAN.md, Task 1).
 *
 * These pin the findings the migration's scope is derived from. The plan's
 * earlier numbers came from greps and hand-listing and were wrong in nine
 * places; the point of these assertions is that the next wrong number fails a
 * test instead of shipping as a plan.
 *
 * Two kinds of assertion, deliberately mixed:
 *  - EXACT counts, where the number is the finding (636 react importers, 197
 *    bun:bundle importers, zero unguarded Bun.* in src/). If the source changes
 *    these legitimately, the number here is updated in the same commit as the
 *    plan — that is the intended friction.
 *  - STRUCTURAL invariants, where the property matters more than the count
 *    (QueryEngine.ts is React-free; the analyzer sees re-export and aliased
 *    edges at all).
 *
 * The analysis is computed once and shared: it parses ~2400 files.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  analyze,
  baselineDebtShape,
  closureOf,
  cutCandidates,
  expandEntries,
  impurityReasons,
  isPure,
  movability,
  readBuildInputs,
  reportWave,
  repoTotals,
  stronglyConnectedComponents,
  WAVES,
  type Analysis,
} from '../scripts/analyze-boundary.ts'

let analysis: Analysis

// 60s, not the 5s default: analyze() parses ~2400 files with the TypeScript
// compiler API. It takes ~4s alone, which is comfortably under the default until
// the full suite runs it in parallel with 174 other files and it tips over.
beforeAll(() => {
  analysis = analyze()
}, 60_000)

describe('analyzer sees the graph tsc sees', () => {
  test('parses the whole tsconfig include set', () => {
    // src/ plus scripts/ and test/. The plan's counts were src-only, which is
    // why every total is reported per scope.
    expect(analysis.files.size).toBeGreaterThan(2000)
    const src = [...analysis.files.keys()].filter(f => f.startsWith('src/'))
    // 2189 before src/entrypoints/library.ts (the barrel the Rayucode extension
    // imports) and src/entrypoints/vscodeHost.ts (the engine it spawns).
    expect(src.length).toBe(2191)
  })

  test('resolves tsconfig path aliases, not just relative imports', () => {
    // src/constants/prompts.ts:27 imports 'src/commands.js' via the `src/*`
    // alias. A relative-path regex misses this edge entirely, and it is the
    // edge that drags the whole application into the "pure leaves" wave.
    const prompts = analysis.files.get('src/constants/prompts.ts')
    expect(prompts).toBeDefined()
    const aliased = prompts?.imports.find(i => i.spec === 'src/commands.js')
    expect(aliased).toBeDefined()
    expect(aliased?.kind).toBe('internal')
    expect(aliased?.resolved).toBe('src/commands.ts')
  })

  test('follows re-export edges', () => {
    // utils/path.ts re-exports sanitizePath from sessionStoragePortable. An
    // `export … from` is a real dependency; import-only scans drop it.
    const path = analysis.files.get('src/utils/path.ts')
    const reexport = path?.imports.find(
      i => i.resolved === 'src/utils/sessionStoragePortable.ts',
    )
    expect(reexport).toBeDefined()
  })

  test('distinguishes type-only from runtime imports', () => {
    // This distinction decides whether an edge can be fixed by moving a type or
    // requires untangling runtime code, so it must actually work.
    const anyTypeOnly = [...analysis.files.values()].some(f =>
      f.imports.some(i => i.typeOnly),
    )
    const anyRuntime = [...analysis.files.values()].some(f =>
      f.imports.some(i => !i.typeOnly),
    )
    expect(anyTypeOnly).toBe(true)
    expect(anyRuntime).toBe(true)
  })

  test('reports unresolvable imports as a category, not a crash', () => {
    // rayu is built from partial source; missing modules are expected and are
    // already recorded in typecheck-baseline.json as TS2307.
    const missing = [...analysis.files.values()].flatMap(f =>
      f.imports.filter(i => i.kind === 'missing-internal'),
    )
    expect(missing.length).toBeGreaterThan(0)
  })
})

describe('React coupling', () => {
  test('exactly 636 files in src/ import react', () => {
    // The plan's figure, now computed. Earlier drafts said 632 (two multi-line
    // imports and two gitignored skills/ files were missed by grep).
    expect(repoTotals(analysis).src.reactImporters).toBe(636)
  })

  test('the two non-src react importers are tests', () => {
    const totals = repoTotals(analysis)
    expect(totals.nonSrcReactImporters).toEqual([
      'test/imageGenTool.test.ts',
      'test/videoGenTool.test.ts',
    ])
  })

  test('QueryEngine, query, context and claudemd are React-free', () => {
    // The plan's four "confirmed UI-free" extraction targets. Note claudemd
    // lives at src/utils/claudemd.ts — the plan text said src/claudemd.ts,
    // which does not exist.
    for (const f of [
      'src/QueryEngine.ts',
      'src/query.ts',
      'src/context.ts',
      'src/utils/claudemd.ts',
    ]) {
      const facts = analysis.files.get(f)
      expect(facts, `${f} should be a project file`).toBeDefined()
      expect(facts?.importsReact, `${f} must not import react`).toBe(false)
      expect(facts?.usesJsx, `${f} must not contain JSX`).toBe(false)
    }
  })

  test('components/** is React-coupled', () => {
    const components = [...analysis.files.entries()].filter(([f]) =>
      f.startsWith('src/components/'),
    )
    expect(components.length).toBeGreaterThan(0)
    // Every component file is impure — most by importing react, all of them at
    // minimum by living in a UI directory.
    for (const [file, facts] of components) {
      expect(isPure(facts), `${file} must not be considered core-pure`).toBe(false)
    }
  })

  test('JSX without an explicit react import would be caught', () => {
    // tsconfig sets jsx: "react-jsx", so JSX needs no import to depend on
    // react/jsx-runtime. Today no file relies on that, but the detector must
    // stay wired or such a file would be misreported as pure.
    expect(repoTotals(analysis).all.jsxWithoutReactImport).toBe(0)
    const jsxFiles = [...analysis.files.values()].filter(f => f.usesJsx)
    expect(jsxFiles.length).toBeGreaterThan(0) // the detector is not dead code
    for (const f of jsxFiles) expect(f.importsReact).toBe(true)
  })

  test('nothing imports the ink npm package; ink coupling is the vendored fork', () => {
    // `ink` is a declared devDependency that no source file imports. A purity
    // gate keyed on the 'ink' SPECIFIER would pass on all 102 vendored files.
    const totals = repoTotals(analysis)
    expect(totals.all.inkPackageImporters).toBe(0)
    expect(totals.src.vendoredInkFiles).toBe(102)
  })
})

describe('bun:bundle and Bun.* portability', () => {
  test('62 files in src/ still import bun:bundle, down from 197', () => {
    // Started at 197 (the plan said 196; a direct grep also returns 197 — the
    // 198th textual match is a comment in utils/listSessionsImpl.ts saying the
    // module deliberately avoids bun:bundle, which AST analysis excludes and text
    // search does not).
    //
    // Task 4's codemod converted the 135 files it could prove safe. The
    // remaining 62 are BLOCKED, and not for want of effort: `feature()`'s
    // compile-time folding is what lets rayu's partial source link at all. See
    // the ripgrep/isReplBridgeActive test below and scripts/codemod-features.ts.
    expect(repoTotals(analysis).src.bunBundleImporters).toBe(62)
  })

  test('every remaining bun:bundle file has a link-level gap that blocks conversion', () => {
    // The gate, restated as an invariant: nothing is left un-converted for
    // arbitrary reasons. Each remaining file has an unresolvable import or an
    // accepted TS2307/TS2305/TS2304 in typecheck-baseline.json, so converting its
    // gate would turn a folded-away reference into a runtime SyntaxError.
    const baseline: Record<string, number> = JSON.parse(
      readFileSync(resolve(import.meta.dir, '..', 'typecheck-baseline.json'), 'utf8'),
    )
    const linkCodes = new Set(['TS2307', 'TS2305', 'TS2304', 'TS2724', 'TS2614'])
    const filesWithGaps = new Set<string>()
    for (const sig of Object.keys(baseline)) {
      const i1 = sig.indexOf('|')
      const i2 = sig.indexOf('|', i1 + 1)
      if (i1 < 0 || i2 < 0) continue
      if (linkCodes.has(sig.slice(i1 + 1, i2))) {
        filesWithGaps.add(sig.slice(0, i1).replace(/\\/g, '/'))
      }
    }

    const remaining = [...analysis.files.values()].filter(
      f => f.importsBunBundle && f.file.startsWith('src/'),
    )
    expect(remaining.length).toBe(62)
    for (const f of remaining) {
      const hasUnresolvedImport = f.imports.some(
        i => i.kind === 'missing-internal' || i.kind === 'missing-package',
      )
      expect(
        hasUnresolvedImport || filesWithGaps.has(f.file),
        `${f.file} still imports bun:bundle but has no link-level gap — it should have been converted`,
      ).toBe(true)
    }
  })

  test('src/ has zero unguarded Bun.* accesses', () => {
    // Task 5 is described as "near-no-op". Stronger than that: inside src/ every
    // Bun.* access is guarded, a guard expression, or inside try/catch.
    const totals = repoTotals(analysis)
    expect(totals.src.guardCounts.unguarded).toBe(0)
  })

  test('every unguarded Bun.* is in scripts/ or test/, which are Bun-only by design', () => {
    const unguarded = repoTotals(analysis).bunAccesses.filter(
      a => a.guard === 'unguarded',
    )
    expect(unguarded.length).toBeGreaterThan(0)
    for (const a of unguarded) {
      expect(
        a.file.startsWith('scripts/') || a.file.startsWith('test/'),
        `${a.file}:${a.line} ${a.expression} is unguarded outside scripts//test/`,
      ).toBe(true)
    }
  })

  test('ripgrep.ts:607 Bun.spawn is inside try/catch, not bare', () => {
    // The plan calls this site "unguarded"; it carries no typeof guard (and its
    // eslint-disable names a rule that does not exist in this repo — there is no
    // eslint config at all), but it does sit in a try block, so a ReferenceError
    // under plain node is caught. Recorded precisely so Task 5 does not "fix"
    // something that is already survivable.
    const ripgrep = analysis.files.get('src/utils/ripgrep.ts')
    const spawn = ripgrep?.bunAccesses.find(a => a.expression === 'Bun.spawn')
    expect(spawn).toBeDefined()
    expect(spawn?.guard).toBe('try-guarded')
  })

  test('the dominant guard shapes are all recognised', () => {
    // if (typeof Bun !== 'undefined') { … }
    const yaml = analysis.files.get('src/utils/yaml.ts')
    expect(yaml?.bunAccesses.every(a => a.guard === 'guarded')).toBe(true)

    // ternary: typeof Bun !== 'undefined' && typeof Bun.which === 'function' ? …
    const which = analysis.files.get('src/utils/which.ts')
    expect(which?.bunAccesses.length).toBeGreaterThan(0)
    expect(which?.bunAccesses.some(a => a.guard === 'unguarded')).toBe(false)

    // && chain: typeof Bun !== 'undefined' && Array.isArray(Bun.embeddedFiles)
    const bundled = analysis.files.get('src/utils/bundledMode.ts')
    expect(bundled?.bunAccesses.length).toBeGreaterThan(0)
    expect(bundled?.bunAccesses.every(a => a.guard === 'guarded')).toBe(true)
  })

  test('Bun.* counts come from the AST, so comments and bun.lock strings do not count', () => {
    // utils/generatedFiles.ts contains the strings 'bun.lockb'/'bun.lock' and
    // stackDetector.ts checks for bun.lock files. A case-insensitive regex for
    // `Bun\.` counts those; the AST does not.
    for (const f of ['src/utils/generatedFiles.ts', 'src/utils/stackDetector.ts']) {
      expect(analysis.files.get(f)?.bunAccesses.length, f).toBe(0)
    }
  })

  test("feature()'s compile-time folding is what lets the partial source link", () => {
    // The finding that forced Task 4 to be per-wave instead of one 197-file
    // commit, recorded as an executable fact rather than a comment.
    //
    // tools/ToolSearchTool/prompt.ts reads
    //     if (feature('KAIROS') && … && isReplBridgeActive()) { … }
    // and imports isReplBridgeActive from bootstrap/state.ts, which does not
    // export it. With feature('KAIROS') folded to false the whole && chain
    // disappears, the import goes unused, and Bun tree-shakes it. Convert the
    // gate to a runtime expression and the import must link:
    //     SyntaxError: Export named 'isReplBridgeActive' not found
    // Measured cost of ignoring this: 67 failing tests, 36 module errors.
    const prompt = analysis.files.get('src/tools/ToolSearchTool/prompt.ts')
    expect(prompt, 'the file must still exist for this fact to hold').toBeDefined()
    // It still imports bun:bundle, i.e. it was correctly left un-converted.
    expect(prompt?.importsBunBundle).toBe(true)
    // The import target resolves as a MODULE — which is why a resolution-only
    // check passes it and a baseline-code check is required.
    const stateImport = prompt?.imports.find(
      i => i.resolved === 'src/bootstrap/state.ts',
    )
    expect(stateImport?.kind).toBe('internal')
    // And bootstrap/state.ts genuinely does not export the name.
    const stateSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src/bootstrap/state.ts'),
      'utf8',
    )
    expect(stateSrc).not.toContain('isReplBridgeActive')
    // The gap is recorded as an accepted TS2305 for this file.
    const baseline: Record<string, number> = JSON.parse(
      readFileSync(resolve(import.meta.dir, '..', 'typecheck-baseline.json'), 'utf8'),
    )
    expect(
      Object.keys(baseline).some(
        k => k.startsWith('src/tools/ToolSearchTool/prompt.ts|TS2305|'),
      ),
    ).toBe(true)
  })
})

describe('build inputs come from one shared definition, not a copy', () => {
  test('EXTERNAL and STUB_ALIASES come from scripts/bundleConfig.ts', () => {
    const { external, stubAliases } = readBuildInputs()
    // 5 native modules + 7 optional OTEL exporters.
    expect(external.length).toBe(12)
    expect(external).toContain('sharp')
    expect(external).toContain('@opentelemetry/exporter-prometheus')
    expect(Object.keys(stubAliases).length).toBe(7)
    expect(stubAliases['color-diff-napi']).toBe('stubs/color-diff-napi/index.ts')
  })

  test('specifiers in EXTERNAL are never reported as missing packages', () => {
    // These are unbundled on purpose and may be absent at runtime; misreporting
    // them as unresolved would bury the real missing-module signal.
    const external = new Set(readBuildInputs().external)
    for (const facts of analysis.files.values()) {
      for (const edge of facts.imports) {
        if (external.has(edge.spec)) {
          expect(
            edge.kind,
            `${facts.file}: ${edge.spec} should be external`,
          ).toBe('external')
        }
      }
    }
  })

  test('stub files are reached through path aliases but stay outside the program', () => {
    // tsconfig maps @ant/* → stubs/ant/*, but `include` does not cover stubs/,
    // so these resolve to real files the analyzer has no facts for. They are
    // recorded separately rather than counted as closure members — otherwise a
    // caller reads undefined facts for them.
    const wave = WAVES.find(w => w.id === 'cli-entrypoint')!
    const closure = closureOf(analysis, expandEntries(analysis, wave))
    expect(closure.outsideProgram.size).toBeGreaterThan(0)
    for (const f of closure.outsideProgram) {
      expect(f.startsWith('stubs/') || f.endsWith('.d.ts'), f).toBe(true)
    }
    for (const f of closure.members) {
      expect(analysis.files.has(f), `${f} is a member so it must have facts`).toBe(true)
    }
  })

  test('@ant/claude-for-chrome-mcp is never imported, confirming Task 13 reduced scope', () => {
    // The plan states this stub has no import at all, which is why the @ant
    // aliases are a non-issue for npm consumption. Verified rather than assumed.
    const stubAliases = readBuildInputs().stubAliases
    expect(Object.keys(stubAliases)).toContain('@ant/claude-for-chrome-mcp')
    const importers = [...analysis.files.values()].filter(f =>
      f.imports.some(i => i.spec.startsWith('@ant/claude-for-chrome-mcp')),
    )
    expect(importers.map(f => f.file)).toEqual([])
  })
})

describe('the plan\'s wave definitions, checked against disk', () => {
  test('every wave entry glob matches at least one real file', () => {
    // expandEntries throws if a glob goes stale, so a renamed file fails loudly
    // instead of silently shrinking a wave's scope.
    for (const wave of WAVES) {
      expect(() => expandEntries(analysis, wave), wave.id).not.toThrow()
      expect(expandEntries(analysis, wave).length, wave.id).toBeGreaterThan(0)
    }
  })

  test('Task 10 excludes exactly the two React-coupled MCP files', () => {
    const wave = WAVES.find(w => w.id === 'task10-context-mcp')
    expect(wave).toBeDefined()
    const entries = expandEntries(analysis, wave!)
    expect(entries).not.toContain('src/services/mcp/useManageMCPConnections.ts')
    expect(entries).not.toContain('src/services/mcp/MCPConnectionManager.tsx')
    // …and the rest of services/mcp IS included.
    expect(entries).toContain('src/services/mcp/config.ts')
    expect(entries).toContain('src/services/mcp/client.ts')
  })

  test('services/mcp contains exactly 2 React-coupled files', () => {
    // The plan's figure. Both are the ones Task 10 excludes.
    const reactCoupled = [...analysis.files.entries()]
      .filter(([f]) => f.startsWith('src/services/mcp/'))
      .filter(([, facts]) => facts.importsReact || facts.usesJsx)
      .map(([f]) => f)
      .sort()
    expect(reactCoupled).toEqual([
      'src/services/mcp/MCPConnectionManager.tsx',
      'src/services/mcp/useManageMCPConnections.ts',
    ])
  })

  test('the "pure leaves" wave is not pure — 16 of its entries reach the whole app', () => {
    // The finding that invalidates Task 6 as written. utils/path.ts, json.ts and
    // which.ts are called "dependency-free" in the plan; each one reaches the
    // React UI transitively.
    const wave = WAVES.find(w => w.id === 'task6-pure-leaves')!
    const notLeaves: string[] = []
    for (const entry of expandEntries(analysis, wave)) {
      const closure = closureOf(analysis, [entry])
      if (closure.members.size > 100) notLeaves.push(entry)
    }
    expect(notLeaves).toContain('src/utils/path.ts')
    expect(notLeaves).toContain('src/utils/json.ts')
    expect(notLeaves).toContain('src/utils/which.ts')
    expect(notLeaves).toContain('src/constants/prompts.ts')
    expect(notLeaves.length).toBe(16)
  })

  test('the genuine leaves are pure and tiny', () => {
    // These are what Task 6 can actually move.
    for (const f of [
      'src/constants/apiLimits.ts',
      'src/constants/errorIds.ts',
      'src/types/ids.ts',
      'src/utils/uuid.ts',
    ]) {
      const closure = closureOf(analysis, [f])
      expect(closure.members.size, f).toBeLessThanOrEqual(4)
      for (const m of closure.members) {
        expect(isPure(analysis.files.get(m)!), `${f} → ${m}`).toBe(true)
      }
    }
  })

  test('betas.ts and permissions.ts were leaves blocked only by bun:bundle, and are now free', () => {
    // Before Task 4 both were true leaves (closure of 1) whose ONLY impurity was
    // `imports-bun-bundle`. That is why Task 4 had to precede Task 6 rather than
    // follow it. The codemod converted both, so they are now pure AND movable —
    // the prediction and the outcome, in one assertion.
    for (const f of ['src/constants/betas.ts', 'src/types/permissions.ts']) {
      const facts = analysis.files.get(f)!
      expect(impurityReasons(facts), f).toEqual([])
      expect(isPure(facts), f).toBe(true)
      expect(closureOf(analysis, [f]).members.size, f).toBeLessThanOrEqual(2)
    }
    const move = movability(analysis)
    expect(move.movable.has('src/constants/betas.ts')).toBe(true)
    expect(move.movable.has('src/types/permissions.ts')).toBe(true)
  })
})

describe('the structural blocker: one giant import cycle', () => {
  test('src/ is dominated by a single strongly connected component', () => {
    // This is why every Phase B wave reports a ~2043-file closure: they are all
    // the same cycle. A file inside it cannot be extracted alone.
    const sccs = stronglyConnectedComponents(analysis)
    const biggest = sccs[0]
    expect(biggest.length).toBeGreaterThan(1500)
    // It contains the UI, which is what makes it a blocker rather than a smell.
    expect(biggest).toContain('src/screens/REPL.tsx')
    // …and the subsystems Phase B wants to extract.
    expect(biggest).toContain('src/tools.ts')
    expect(biggest).toContain('src/query.ts')
    expect(biggest).toContain('src/commands.ts')
  })

  test('cycle membership, not file count, is what blocks each wave', () => {
    const sccs = stronglyConnectedComponents(analysis)
    const biggest = new Set(sccs[0])
    for (const id of ['task8b-registry', 'task11-query', 'task10-context-mcp']) {
      const wave = WAVES.find(w => w.id === id)!
      const entries = expandEntries(analysis, wave)
      expect(
        entries.some(e => biggest.has(e)),
        `${id} should have at least one entry inside the big cycle`,
      ).toBe(true)
    }
  })
})

describe('movability is computed, and Task 4 did not unblock the boundary', () => {
  test('a set of files is movable to core today', () => {
    // 293 before Task 4's codemod, 303 after. The projection made before doing
    // the work predicted exactly 303.
    const move = movability(analysis)
    expect(move.movable.size).toBe(303)
    // Sanity: everything called movable really is pure with a pure closure.
    for (const f of move.movable) {
      expect(isPure(analysis.files.get(f)!), f).toBe(true)
    }
  })

  test('Task 4 made ~91 files pure yet moved the boundary by only 10', () => {
    // Measured before and after, because the intuitive read — "bun:bundle is the
    // blocker, so the codemod unblocks everything" — is wrong. Files freed from
    // bun:bundle are still trapped in the 1618-file cycle with the UI.
    //   impure themselves : 902 → 811   (91 files became pure)
    //   movable           : 293 → 303   (+10)
    // 813 now: src/entrypoints/{library,vscodeHost}.ts both live under a UI
    // directory (src/entrypoints/) and so count as impure by location. Neither is
    // imported by anything in src/ — they are build entrypoints.
    const move = movability(analysis)
    expect(move.impure.size).toBe(813)
    expect(move.movable.size).toBe(303)
    // The remaining 62 bun:bundle files would add little even if convertible.
    const ifRestConverted = movability(analysis, 'src/', new Set(['imports-bun-bundle']))
    expect(ifRestConverted.movable.size - move.movable.size).toBeLessThan(30)
  })

  test('repointing type-only edges is worth more than the codemod was', () => {
    // Several top blockers are imported 100% type-only (state/AppState.tsx 32/32,
    // hooks/useCanUseTool.tsx 17/17, entrypoints/sdk/controlTypes.ts 15/15), so
    // the dependency is compile-time only and the type can move to a leaf.
    const now = movability(analysis)
    const withTypesMoved = movability(
      analysis,
      'src/',
      new Set(['imports-bun-bundle', 'imports-bun-builtin']),
      true,
    )
    expect(withTypesMoved.movable.size).toBeGreaterThan(now.movable.size + 30)
  })

  test('the codemod removed the two largest hubs from the cut list', () => {
    // Before: utils/log.ts (145 pure importers) and utils/slowOperations.ts (142)
    // topped the ranking, both impure ONLY via bun:bundle. Both were converted,
    // so both are now pure and no longer appear at all.
    const cuts = cutCandidates(analysis)
    const targets = cuts.map(c => c.target)
    expect(targets).not.toContain('src/utils/log.ts')
    expect(targets).not.toContain('src/utils/slowOperations.ts')
    expect(isPure(analysis.files.get('src/utils/log.ts')!)).toBe(true)
    expect(isPure(analysis.files.get('src/utils/slowOperations.ts')!)).toBe(true)
  })

  test('the highest-leverage cut targets are identified and ranked', () => {
    const cuts = cutCandidates(analysis)
    expect(cuts.length).toBeGreaterThan(0)
    // Ranked descending by how many pure files depend on the impure target.
    for (let i = 1; i < cuts.length; i++) {
      expect(cuts[i - 1].pureImporters).toBeGreaterThanOrEqual(cuts[i].pureImporters)
    }
    // commands.ts is now the most-depended-on impure module, and it is one of the
    // 62 that cannot be converted — 101 of its 116 importer edges are type-only,
    // so the cheap fix is to relocate the types it exports, not to convert it.
    expect(cuts[0].target).toBe('src/commands.ts')
    expect(cuts[0].reasons).toEqual(['imports-bun-bundle'])
    expect(cuts[0].typeOnlyEdges).toBeGreaterThan(cuts[0].pureImporters * 0.8)
  })
})

describe('type debt is bucketed per file', () => {
  test('signatures and error counts are reported separately', () => {
    // The plan cites "983 accepted typecheck errors"; 983 is the SIGNATURE
    // count. Per-wave debt must be summed by error count.
    const debt = baselineDebtShape()
    // 983 / 1557 / 315 when first measured. The counts moved after a clean
    // `bun install`: the previous node_modules held a stale, undeclared
    // @aws-sdk/credential-providers and @anthropic-ai/bedrock-sdk (a condition
    // services/api/providerRegistry.ts documents), and removing them traded 3 new
    // TS2307s for 8 fewer errors elsewhere.
    expect(debt.signatures).toBe(981)
    expect(debt.errors).toBe(1552)
    expect(debt.files).toBe(317)
  })

  test('per-file buckets survive messages containing the separator', () => {
    // Keys are `<file>|<CODE>|<message>` and messages can contain '|', so the
    // key is split on the first two separators only.
    const perFile = analysis.baselineErrors
    expect(perFile.size).toBe(317)
    for (const file of perFile.keys()) {
      expect(file).not.toContain('|')
      expect(file.endsWith('.ts') || file.endsWith('.tsx')).toBe(true)
    }
  })

  test('each wave reports the type debt it would inherit', () => {
    const report = reportWave(analysis, WAVES.find(w => w.id === 'task11-query')!)
    expect(report.baselineErrors).toBeGreaterThan(0)
    expect(report.closureSize).toBeGreaterThan(report.entryCount)
  })
})
