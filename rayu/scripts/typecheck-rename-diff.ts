#!/usr/bin/env bun
/**
 * Rename-wave typecheck gate.
 *
 * Proves a rename wave introduced NO new type errors: the current tsc error
 * multiset must equal the committed baseline's multiset after mapping every
 * baseline message through the rename plan (old identifier → new identifier).
 * Run this BEFORE `bun run typecheck:update` — regenerating the baseline first
 * would silently launder a real regression into the new normal.
 *
 *   bun run scripts/typecheck-rename-diff.ts
 *
 * Exit 0: current errors == mapped baseline (renames only).
 * Exit 1: new errors appeared (or mapped-baseline errors vanished unexpectedly).
 * Exit 2: tsc/config failure.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const BASELINE_PATH = resolve(ROOT, 'typecheck-baseline.json')
const PLAN_PATH = resolve(ROOT, 'scripts/rename-claude-plan.json')

// Same signature shape as scripts/typecheck-baseline.ts (file|code|message).
const ERROR_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/

function runTsc(): { output: string; exitCode: number } {
  const proc = Bun.spawnSync(
    ['./node_modules/.bin/tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.typecheck.json'],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    output: proc.stdout.toString() + proc.stderr.toString(),
    exitCode: proc.exitCode ?? 0,
  }
}

function collectCounts(output: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const raw of output.split('\n')) {
    const m = ERROR_RE.exec(raw.trimEnd())
    if (!m) continue
    const sig = `${m[1].replace(/\\/g, '/')}|${m[4]}|${m[5]}`
    counts.set(sig, (counts.get(sig) ?? 0) + 1)
  }
  return counts
}

type PlanEntry = { symbol: string; newName: string; status: string }

function buildMessageMapper(): (message: string) => string {
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8')) as { entries: PlanEntry[] }
  const pairs = plan.entries
    .filter(e => (e.status === 'rename' || e.status === 'override') && e.symbol !== e.newName)
    .map(e => [e.symbol, e.newName] as const)
    // Longest first so a shorter name never eats a prefix of a longer one.
    .sort((a, b) => b[0].length - a[0].length)
  if (pairs.length === 0) return m => m
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b(${pairs.map(([old]) => escape(old)).join('|')})\\b`, 'g')
  const map = new Map(pairs)
  return message => message.replace(re, m => map.get(m) ?? m)
}

const { output, exitCode } = runTsc()
const current = collectCounts(output)
const currentTotal = [...current.values()].reduce((a, b) => a + b, 0)
if (currentTotal === 0 && exitCode !== 0) {
  console.error('✗ tsc produced no parseable output (config/compiler error?):\n')
  console.error(output.split('\n').slice(0, 20).join('\n'))
  process.exit(2)
}

const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const mapMessage = buildMessageMapper()

// Map each baseline signature's message through the rename plan. File paths are
// unchanged by this codemod (no file renames), so only the message is mapped.
const mapped = new Map<string, number>()
for (const [sig, n] of Object.entries(baseline)) {
  const i1 = sig.indexOf('|')
  const i2 = sig.indexOf('|', i1 + 1)
  const file = sig.slice(0, i1)
  const code = sig.slice(i1 + 1, i2)
  const message = sig.slice(i2 + 1)
  const key = `${file}|${code}|${mapMessage(message)}`
  mapped.set(key, (mapped.get(key) ?? 0) + n)
}

const added: string[] = []
for (const [sig, n] of current) {
  const allowed = mapped.get(sig) ?? 0
  if (n > allowed) {
    for (let i = 0; i < n - allowed; i++) added.push(sig)
  }
}
const removed: string[] = []
for (const [sig, n] of mapped) {
  const now = current.get(sig) ?? 0
  if (now < n) {
    for (let i = 0; i < n - now; i++) removed.push(sig)
  }
}

if (added.length > 0 || removed.length > 0) {
  if (added.length > 0) {
    console.error(`\n✗ ${added.length} NEW type error(s) not explained by the rename plan:\n`)
    for (const s of added.slice(0, 40)) console.error(`  ${s.replace(/\|/g, '  ')}`)
    if (added.length > 40) console.error(`  …and ${added.length - 40} more`)
  }
  if (removed.length > 0) {
    console.error(`\n✗ ${removed.length} mapped-baseline error(s) vanished — a message changed in a way the plan does not cover:\n`)
    for (const s of removed.slice(0, 40)) console.error(`  ${s.replace(/\|/g, '  ')}`)
    if (removed.length > 40) console.error(`  …and ${removed.length - 40} more`)
  }
  console.error('\nInvestigate before running typecheck:update.')
  process.exit(1)
}

console.log(
  `✓ rename-diff clean: ${currentTotal} current error(s) exactly match the baseline mapped through the rename plan.`,
)
process.exit(0)