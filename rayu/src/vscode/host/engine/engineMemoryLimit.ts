/**
 * The per-engine memory limit — how big each conversation's engine may grow before it
 * stops itself, so a runaway session cannot take the editor down with it.
 *
 * WHY THIS EXISTS
 * The CLI's launcher re-execs itself with a RAM-aware `--max-old-space-size`
 * (utils/heapLimitReexec.ts), but that path deliberately skips headless runs — and the
 * engine IS headless (`--print`), so it ran at the runtime's DEFAULT ceiling with up to
 * MAX_LIVE_SESSIONS of them alive at once. On a machine with modest RAM, a session that
 * grows large (huge tool outputs, a pathological context) could drag the whole system
 * down, and the process the OOM killer takes is as likely to be VS Code itself as the
 * engine — the "editor reloads / shuts down on long runs" failure users reported.
 *
 * With a limit the blast radius flips: an engine stops ITSELF, the panel says so, and
 * the next message resumes the conversation from its transcript while the editor
 * survives.
 *
 * TWO RUNTIMES, TWO MECHANISMS, ONE NUMBER
 *   script (engine.mjs on Node)  `--max-old-space-size` through NODE_OPTIONS: V8 caps
 *                                the JavaScript heap and the process dies at it.
 *   native (compiled, on Bun)    Bun ignores that flag, so the engine watches its own
 *                                RESIDENT size against RAYU_ENGINE_MAX_MEMORY_MB and exits
 *                                with a dedicated code (src/utils/engineMemoryWatchdog.ts).
 * Resident size includes the runtime itself — measured at ~190 MB idle and ~230 MB after
 * a tool-using turn on linux-x64 — so heap-sized figures (the RAM default and
 * RAYU_ENGINE_MAX_OLD_SPACE_MB) get NATIVE_RSS_ALLOWANCE_MB added for a compiled engine.
 * The `rayucode.engine.maxMemoryMB` setting is applied as written to either runtime.
 *
 * Free of `vscode` imports so every rule here is unit-testable.
 */
import { totalmem } from 'node:os'

import {
  ENGINE_MEMORY_LIMIT_ENV,
  parseMemoryLimitMB,
} from '../../../utils/engineMemoryWatchdog.js'

/**
 * Env var on the EXTENSION HOST that overrides the default, in MB of heap. Set it in the
 * environment VS Code is launched from, e.g. RAYU_ENGINE_MAX_OLD_SPACE_MB=3072.
 */
export const ENGINE_HEAP_CAP_ENV = 'RAYU_ENGINE_MAX_OLD_SPACE_MB'

/** The VS Code setting for the limit, in MB. */
export const MEMORY_LIMIT_SETTING = 'rayucode.engine.maxMemoryMB'

/**
 * Headroom over a heap-sized figure for a compiled engine's resident size: the runtime,
 * JIT code and I/O buffers that are not JavaScript heap. Measured idle overhead is under
 * 200 MB, so 512 MB leaves room for a busy session without masking a real leak.
 */
export const NATIVE_RSS_ALLOWANCE_MB = 512

/** The smallest limit the setting accepts; below it an engine cannot do useful work. */
export const MIN_MEMORY_LIMIT_MB = 512

export type MemoryLimitSource = 'setting' | 'environment' | 'default'

export interface MemoryLimit {
  /** The limit as applied to this runtime: heap MB for script, resident MB for native. */
  mb: number
  source: MemoryLimitSource
}

/** Parses the heap-cap env value; null for anything absent or not a bare positive integer. */
export function parseEngineHeapCapMB(raw: string | undefined): number | null {
  return parseMemoryLimitMB(raw)
}

const MAX_LIVE_SESSIONS_FOR_CAP = 4
const DEFAULT_CAP_MIN_MB = 512
const DEFAULT_CAP_MAX_MB = 4096
const BYTES_PER_MB = 1024 * 1024

/**
 * The default per-engine HEAP cap.
 *
 * Targets 50% of physical RAM divided by MAX_LIVE_SESSIONS (4), so 4 engines at full cap
 * consume at most 50% of RAM, leaving headroom for VS Code, the extension host and the
 * OS. Capped at 4 GB (more than any single session needs) and floored at 512 MB (below
 * which the engine cannot do useful work — such a machine gets no default limit at all).
 * Returns null where totalmem() is unavailable or nonsensical.
 */
export function computeDefaultEngineHeapCapMB(
  totalBytes: number = totalmem(),
): number | null {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
  const totalMB = Math.floor(totalBytes / BYTES_PER_MB)
  const perChild = Math.floor((totalMB * 0.5) / MAX_LIVE_SESSIONS_FOR_CAP)
  if (perChild < DEFAULT_CAP_MIN_MB) return null
  return Math.min(perChild, DEFAULT_CAP_MAX_MB)
}

/** A setting value is used only when it is a whole number of at least the minimum. */
function settingLimitMB(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_MEMORY_LIMIT_MB
    ? value
    : null
}

export interface MemoryLimitInput {
  runtime: 'script' | 'native'
  /** `rayucode.engine.maxMemoryMB`, as read. */
  settingMB?: unknown
  hostEnv: Readonly<Record<string, string | undefined>>
  totalBytes?: number
}

/** The limit for one engine: the setting, then RAYU_ENGINE_MAX_OLD_SPACE_MB, then the RAM default. */
export function resolveMemoryLimit(input: MemoryLimitInput): MemoryLimit | null {
  const fromSetting = settingLimitMB(input.settingMB)
  if (fromSetting !== null) return { mb: fromSetting, source: 'setting' }
  const allowance = input.runtime === 'native' ? NATIVE_RSS_ALLOWANCE_MB : 0
  const fromEnv = parseEngineHeapCapMB(input.hostEnv[ENGINE_HEAP_CAP_ENV])
  if (fromEnv !== null) return { mb: fromEnv + allowance, source: 'environment' }
  const fallback = computeDefaultEngineHeapCapMB(input.totalBytes)
  return fallback === null ? null : { mb: fallback + allowance, source: 'default' }
}

/**
 * Apply a limit to one spawn's environment, in place.
 *
 * Script: `--max-old-space-size` through NODE_OPTIONS, because it only takes effect at
 * V8 startup; an explicit flag already in NODE_OPTIONS wins. Native: the watchdog's
 * variable, which the engine reads and then removes from its own environment.
 */
export function applyMemoryLimit(
  env: Record<string, string | undefined>,
  runtime: 'script' | 'native',
  limitMB: number,
): void {
  if (runtime === 'native') {
    env[ENGINE_MEMORY_LIMIT_ENV] = String(limitMB)
    return
  }
  if (/--max[-_]old[-_]space[-_]size/.test(env.NODE_OPTIONS ?? '')) return
  const flag = `--max-old-space-size=${limitMB}`
  env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${flag}` : flag
}
