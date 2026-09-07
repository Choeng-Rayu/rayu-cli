#!/usr/bin/env bun
/**
 * Build the library surface the Rayucode extension imports.
 *
 * Emits, from `src/entrypoints/library.ts`:
 *   dist/rayu-lib.js                              — ESM bundle, Node target
 *   dist/types/entrypoints/library.d.ts (+ tree)   — declarations
 *
 * The bundle uses `sharedBuildOptions()` — the SAME define map, feature list,
 * stub aliases and externals as `dist/rayu.js`. That is not tidiness: rayu is
 * built from partial source, and several `require()`d modules only disappear
 * because a feature gate or `process.env.USER_TYPE` folds to a constant. Drop one
 * define and the build fails with `Could not resolve "./tools/REPLTool/REPLTool.js"`.
 *
 * Declarations come from `tsconfig.lib.json` (`emitDeclarationOnly`, rootDir src). `tsc` reports the project's
 * accepted baseline errors (1557 of them, see scripts/typecheck-baseline.ts) but
 * still emits, because emit is only withheld under `noEmitOnError`. Those errors
 * are gated separately by `bun run typecheck:ci`; this script must not re-police
 * them or it would fail on pre-existing debt.
 *
 *   bun run build:lib
 */
import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { sharedBuildOptions } from './bundleConfig.ts'

const ROOT = resolve(import.meta.dir, '..')
const ENTRY = 'src/entrypoints/library.ts'
const OUT_JS = 'dist/rayu-lib.js'
const TYPES_DIR = resolve(ROOT, 'dist/types')

// ── 1. the bundle ────────────────────────────────────────────────────────────

const result = await Bun.build({
  ...sharedBuildOptions(),
  entrypoints: [ENTRY],
  outdir: 'dist',
  naming: 'rayu-lib.js',
})

if (!result.success) {
  console.error(`✗ failed to bundle ${ENTRY}:\n`)
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const bundled = await Bun.file(resolve(ROOT, OUT_JS)).text()

// ── 2. the surface must not have dragged in the terminal UI ──────────────────
//
// A fast structural check at build time, so a widened barrel fails here rather
// than shipping megabytes. test/libraryBundle.test.ts asserts the same properties
// plus a size budget.
const leaks: string[] = []
if (/from\s*"react"|require\("react"\)/.test(bundled)) leaks.push('react')
if (/jsx-runtime/.test(bundled)) leaks.push('react/jsx-runtime')
if (/from\s*"bun:|require\("bun:/.test(bundled)) leaks.push('a bun: specifier')

if (leaks.length > 0) {
  console.error(
    `✗ ${OUT_JS} pulled in ${leaks.join(', ')}.\n\n` +
      `  An export added to ${ENTRY} reaches the Ink/React UI, which cannot run in\n` +
      `  the extension host. Find the edge with:\n` +
      `      bun run scripts/analyze-boundary.ts --cut-candidates\n` +
      `  and either narrow the export or cut the edge first.`,
  )
  process.exit(1)
}

// ── 3. declarations ──────────────────────────────────────────────────────────

if (existsSync(TYPES_DIR)) rmSync(TYPES_DIR, { recursive: true, force: true })

const tsc = Bun.spawnSync(
  ['./node_modules/.bin/tsc', '-p', 'tsconfig.lib.json', '--pretty', 'false'],
  { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
)

const declared = existsSync(resolve(TYPES_DIR, 'entrypoints/library.d.ts'))
if (!declared) {
  const output = tsc.stdout.toString() + tsc.stderr.toString()
  console.error('✗ tsc emitted no declaration for the library entry:\n')
  console.error(output.split('\n').slice(0, 20).join('\n'))
  process.exit(1)
}

const kb = (bundled.length / 1024).toFixed(0)
console.log(
  `Built ${OUT_JS} (${kb} KB, no react/ink) + dist/types/entrypoints/library.d.ts`,
)
