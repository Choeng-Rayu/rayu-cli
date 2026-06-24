/**
 * RAM-aware V8 heap-limit re-exec shim.
 *
 * `--max-old-space-size` only takes effect at process startup; mutating
 * `process.env.NODE_OPTIONS` after V8 has initialized is inert (the previous
 * CLAUDE_CODE_REMOTE-gated code did exactly that and never raised the limit).
 * The shipped CLI therefore ran at Node's default old-space ceiling (~2.24 GB
 * on the affected host), which a long session could exhaust.
 *
 * This module re-execs the process ONCE, early, with a computed
 * `--max-old-space-size`, then forwards stdio / exit status. It is intentionally
 * conservative:
 *   - only for interactive (TTY) or CLAUDE_CODE_REMOTE sessions — one-shot
 *     `--print`/headless runs are short-lived and latency-sensitive, so they
 *     are not re-exec'd;
 *   - skipped under Bun (the compiled single-file binary uses JSC, where the
 *     V8 flag does not apply);
 *   - skipped when a max-old-space flag is already present, when already
 *     re-exec'd (sentinel), or when opted out via RAYU_NO_HEAP_REEXEC;
 *   - only raises the limit when the RAM-derived target is meaningfully higher
 *     than the current ceiling.
 *
 * Raising the ceiling is defense-in-depth: the dominant OOM (dev-reconciler
 * performance measures) is root-fixed at build time, but a higher limit gives
 * future slow leaks far more headroom AND lets the 1.5 GB auto-heapdump finish
 * serializing before any ceiling is hit (the captured snapshots showed the dump
 * being truncated by the crash).
 */
import { spawnSync } from 'node:child_process'
import { totalmem } from 'node:os'
import { getHeapStatistics } from 'node:v8'
import { isEnvTruthy } from './envUtils.js'

export const HEAP_REEXEC_SENTINEL = 'RAYU_HEAP_REEXEC'
/** Hard cap — never request more than this regardless of RAM. */
export const MAX_OLD_SPACE_MB_CAP = 8192
/** Below this, raising the limit isn't worth a re-exec on a tiny/constrained host. */
export const MIN_USEFUL_OLD_SPACE_MB = 2048
/** Only re-exec if the target beats the current ceiling by at least this margin. */
export const RAISE_MARGIN_MB = 256
const BYTES_PER_MB = 1024 * 1024

/**
 * Compute the desired `--max-old-space-size` (MB), or null if a re-exec isn't
 * worthwhile. Targets 75% of physical RAM, capped at MAX_OLD_SPACE_MB_CAP, and
 * only raises when meaningfully above the current ceiling.
 */
export function computeDesiredOldSpaceMB(
  totalRamBytes: number,
  currentLimitBytes: number,
): number | null {
  if (!Number.isFinite(totalRamBytes) || totalRamBytes <= 0) {
    return null
  }
  const totalMB = Math.floor(totalRamBytes / BYTES_PER_MB)
  const target = Math.min(Math.floor(totalMB * 0.75), MAX_OLD_SPACE_MB_CAP)
  if (target < MIN_USEFUL_OLD_SPACE_MB) {
    return null
  }
  const currentMB = Math.floor(currentLimitBytes / BYTES_PER_MB)
  if (target <= currentMB + RAISE_MARGIN_MB) {
    return null
  }
  return target
}

/** True if a max-old-space flag is already set via execArgv or NODE_OPTIONS. */
export function hasMaxOldSpaceFlag(
  execArgv: readonly string[],
  nodeOptions: string | undefined,
): boolean {
  if (
    execArgv.some(
      a =>
        a.startsWith('--max-old-space-size') ||
        a.startsWith('--max_old_space_size'),
    )
  ) {
    return true
  }
  return !!nodeOptions && /--max[-_]old[-_]space[-_]size/.test(nodeOptions)
}

/** Pure decision: should we re-exec to raise the heap limit? */
export function shouldReexecForHeap(opts: {
  sentinelSet: boolean
  isBun: boolean
  optOut: boolean
  hasFlag: boolean
  isInteractiveOrRemote: boolean
}): boolean {
  if (opts.sentinelSet) return false // already re-exec'd — avoid a loop
  if (opts.isBun) return false // JSC: the V8 flag does not apply
  if (opts.optOut) return false
  if (opts.hasFlag) return false // respect an explicit user/env flag
  return opts.isInteractiveOrRemote
}

/** Whether this invocation is an interactive TTY (or remote) session. */
function isInteractiveOrRemoteSession(argv: readonly string[]): boolean {
  if (process.env.CLAUDE_CODE_REMOTE === 'true') return true
  const headless = argv.includes('-p') || argv.includes('--print')
  return !!process.stdout.isTTY && !headless
}

/**
 * Re-exec the process once with a RAM-aware `--max-old-space-size`, then exit
 * forwarding the child's status. No-op when any guard condition fails. Must be
 * called as early as possible (before heavy module evaluation) so the launcher
 * parent does minimal wasted work.
 */
export function maybeReexecForHeapLimit(): void {
  const argv = process.argv.slice(2)

  // Never re-exec the instant fast paths.
  if (
    argv.length === 1 &&
    (argv[0] === '--version' || argv[0] === '-v' || argv[0] === '-V')
  ) {
    return
  }

  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  if (
    !shouldReexecForHeap({
      sentinelSet: process.env[HEAP_REEXEC_SENTINEL] === '1',
      isBun,
      optOut: isEnvTruthy(process.env.RAYU_NO_HEAP_REEXEC),
      hasFlag: hasMaxOldSpaceFlag(process.execArgv, process.env.NODE_OPTIONS),
      isInteractiveOrRemote: isInteractiveOrRemoteSession(argv),
    })
  ) {
    return
  }

  // Target derived from physical RAM vs the current V8 ceiling.
  const target = computeDesiredOldSpaceMB(
    totalmem(),
    getHeapStatistics().heap_size_limit,
  )
  if (target == null) {
    return
  }

  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${target}`, ...process.argv.slice(1)],
    {
      stdio: 'inherit',
      env: { ...process.env, [HEAP_REEXEC_SENTINEL]: '1' },
    },
  )

  if (typeof result.status === 'number') {
    // eslint-disable-next-line custom-rules/no-process-exit -- transparent launcher: forward child exit code
    process.exit(result.status)
  }
  // Killed by signal (or failed to spawn) — exit non-zero so callers notice.
  // eslint-disable-next-line custom-rules/no-process-exit -- transparent launcher
  process.exit(result.signal ? 1 : (result.error ? 1 : 0))
}
