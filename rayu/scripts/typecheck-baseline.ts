#!/usr/bin/env bun
/**
 * Type-error baseline gate.
 *
 * rayu is built from a PARTIAL source: a number of modules (whole type files and
 * runtime subsystems) were never present in the material rayu was derived from,
 * so `tsc` reports a large set of structurally-unfixable errors. None of them
 * affect the Bun build (scripts/build.ts) or the runtime — they are a dev-only
 * signal. This gate records those known errors as a committed baseline and fails
 * ONLY when a NEW type error is introduced.
 *
 * Result: full strict typechecking on every file (no exclusions, no lost
 * coverage) + real regression protection, without needing the missing modules.
 *
 *   bun run typecheck:ci      # exits non-zero iff new errors vs the baseline
 *   bun run typecheck:update  # re-snapshot the baseline (after intended changes)
 *
 * Error "signatures" deliberately ignore line/column so the baseline tolerates
 * code moving around. A regression is reported when a (file, TS-code, message)
 * appears MORE times than the baseline allows, or is entirely new — so fixing an
 * old error and adding a different one in the same file is still caught.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const BASELINE_PATH = resolve(ROOT, 'typecheck-baseline.json')
const UPDATE = process.argv.includes('--update')

// e.g.  src/components/Messages.tsx(58,5): error TS2339: Property 'x' ...
const ERROR_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/

function runTsc(): { output: string; exitCode: number } {
  const proc = Bun.spawnSync(
    [
      './node_modules/.bin/tsc',
      '--noEmit',
      '--pretty',
      'false',
      '-p',
      'tsconfig.typecheck.json',
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    output: proc.stdout.toString() + proc.stderr.toString(),
    exitCode: proc.exitCode ?? 0,
  }
}

function collectCounts(output: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const raw of output.split('\n')) {
    const m = ERROR_RE.exec(raw.trimEnd())
    if (!m) continue
    const file = m[1].replace(/\\/g, '/')
    const code = m[4]
    const message = m[5]
    const sig = `${file}|${code}|${message}`
    counts[sig] = (counts[sig] ?? 0) + 1
  }
  return counts
}

const { output, exitCode } = runTsc()
const counts = collectCounts(output)
const total = Object.values(counts).reduce((a, b) => a + b, 0)

// Guard: tsc produced no parseable errors but exited abnormally → likely a
// config/compiler failure, not a clean tree. Surface it instead of silently
// reporting "all clear".
if (total === 0 && exitCode !== 0) {
  console.error('✗ tsc did not produce parseable output (config/compiler error?):\n')
  console.error(output.split('\n').slice(0, 20).join('\n'))
  process.exit(2)
}

if (UPDATE) {
  const sorted = Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  )
  writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + '\n')
  console.log(
    `✓ Baseline updated: ${total} known errors across ${Object.keys(counts).length} signatures.`,
  )
  process.exit(0)
}

if (!existsSync(BASELINE_PATH)) {
  console.error(
    `No baseline found at ${BASELINE_PATH}.\nCreate it once with: bun run typecheck:update`,
  )
  process.exit(2)
}

const baseline: Record<string, number> = JSON.parse(
  readFileSync(BASELINE_PATH, 'utf8'),
)
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0)

const newErrors: string[] = []
for (const [sig, n] of Object.entries(counts)) {
  const allowed = baseline[sig] ?? 0
  if (n > allowed) {
    const [file, code, message] = sig.split('|')
    for (let i = 0; i < n - allowed; i++) {
      newErrors.push(`${file}: ${code}: ${message}`)
    }
  }
}

if (newErrors.length > 0) {
  console.error(
    `\n✗ ${newErrors.length} NEW type error(s) introduced (not in the baseline):\n`,
  )
  for (const e of newErrors.slice(0, 50)) console.error(`  ${e}`)
  if (newErrors.length > 50) {
    console.error(`  …and ${newErrors.length - 50} more`)
  }
  console.error(
    `\nFix them, or — if intentional — re-snapshot with: bun run typecheck:update`,
  )
  process.exit(1)
}

const fixed = baselineTotal - total
console.log(
  `✓ No new type errors. ${total} known baseline error(s)` +
    (fixed > 0
      ? `; ${fixed} fewer than baseline — run "bun run typecheck:update" to lock in the improvement.`
      : '.'),
)
process.exit(0)
