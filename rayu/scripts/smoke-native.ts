#!/usr/bin/env bun
/**
 * Smoke-test a compiled Rayu CLI executable: `bun run scripts/smoke-native.ts <binary>`.
 *
 * Two checks, because one is not enough:
 *   --version  must print this package's version. cli.tsx answers it on a fast
 *              path BEFORE the rest of the program loads, so on its own it proves
 *              only that the executable starts.
 *   --help     must exit 0 and print the usage text. This loads main.tsx and its
 *              whole module graph, which is where a missing build define fails —
 *              the `ReferenceError: RAYU_FEATURES is not defined` that shipped in
 *              the native binaries passed `--version` and failed here.
 *
 * Both run from an empty temporary directory with a temporary config home, so a
 * bunfig.toml or .env in the caller's directory cannot mask a broken build and the
 * caller's ~/.rayu is never touched.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pkg from '../package.json' with { type: 'json' }

const TIMEOUT_MS = 60_000

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function run(binary: string, args: string[], cwd: string): RunResult {
  const result = Bun.spawnSync([binary, ...args], {
    cwd,
    env: { ...process.env, RAYU_CONFIG_DIR: join(cwd, 'config'), NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: TIMEOUT_MS,
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function check(label: string, ok: boolean, result: RunResult): boolean {
  if (ok) {
    console.log(`✓ ${label}`)
    return true
  }
  console.error(`✗ ${label} (exit ${result.exitCode})`)
  console.error(result.stdout.slice(-2000))
  console.error(result.stderr.slice(-2000))
  return false
}

function main(): void {
  const arg = process.argv[2]
  if (!arg) {
    console.error('usage: bun run scripts/smoke-native.ts <binary>')
    process.exit(2)
  }
  const binary = resolve(arg)
  const cwd = mkdtempSync(join(tmpdir(), 'rayu-smoke-'))
  try {
    const version = run(binary, ['--version'], cwd)
    const versionOk = check(
      `--version reports ${pkg.version}`,
      version.exitCode === 0 && version.stdout.trim().startsWith(pkg.version),
      version,
    )
    const help = run(binary, ['--help'], cwd)
    const helpOk = check(
      '--help loads the full program',
      help.exitCode === 0 && help.stdout.includes('Usage:'),
      help,
    )
    if (!versionOk || !helpOk) process.exit(1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

main()
