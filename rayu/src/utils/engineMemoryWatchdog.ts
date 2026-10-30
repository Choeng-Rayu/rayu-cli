/**
 * A resident-memory limit for a long-lived engine process.
 *
 * WHY THIS EXISTS
 * The Rayucode extension runs one engine per open conversation, each a long-lived
 * headless process. Under Node it caps each one's V8 heap with `--max-old-space-size`,
 * so a runaway session kills only itself and the editor survives. The compiled engine
 * runs on Bun, which ignores that flag: without this, a session that grows without bound
 * could take the whole machine — and the editor with it — down.
 *
 * So the compiled engine watches its own resident memory and, when it stays above the
 * limit, exits with a dedicated code. The extension recognises the code, tells the user,
 * and resumes the same conversation from its transcript on the next message.
 *
 * Measured on linux-x64 (Bun 1.3.14): an idle compiled engine is ~190 MB resident and
 * ~230 MB after a tool-using turn, versus ~295 / ~310 MB for engine.mjs on Node. The
 * extension's default limit leaves a large margin over that (see
 * `src/vscode/host/engine/engineLaunch.ts`).
 *
 * Shared engine code with no dependencies, so the extension host can import the parser
 * without pulling in anything else.
 */

/** The limit, in MB, set by the extension host for a compiled engine. */
export const ENGINE_MEMORY_LIMIT_ENV = 'RAYU_ENGINE_MAX_MEMORY_MB'

/**
 * Parse a limit in MB; null for anything absent or not a bare positive integer.
 *
 * A regex rather than parseInt, because parseInt would silently accept "2048MB" and
 * "1.5" — and a limit that is not exactly what the operator typed is worse than none.
 */
export function parseMemoryLimitMB(raw: string | undefined): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const mb = Number.parseInt(trimmed, 10)
  return mb > 0 ? mb : null
}

export interface MemoryWatchdogOptions {
  limitMB: number
  /** How often to sample. Default 5 s: cheap, and far shorter than any real growth. */
  intervalMs?: number
  /**
   * Consecutive samples over the limit before acting. Default 2, so one transient
   * spike — a large tool output being parsed — does not end a session that would have
   * settled back down.
   */
  sustainedSamples?: number
  /** Injectable for tests. Defaults to `process.memoryUsage.rss()`. */
  readRssBytes?: () => number
  /** Called once, with the resident size that crossed the limit. */
  onLimit: (rssMB: number) => void
}

export interface MemoryWatchdog {
  /** Take one sample now. Exposed so tests need no timers. */
  check(): void
  stop(): void
}

const BYTES_PER_MB = 1024 * 1024

export function startMemoryWatchdog(options: MemoryWatchdogOptions): MemoryWatchdog {
  const readRss = options.readRssBytes ?? (() => process.memoryUsage.rss())
  const sustained = Math.max(1, options.sustainedSamples ?? 2)
  const limitBytes = options.limitMB * BYTES_PER_MB
  let over = 0
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const watchdog: MemoryWatchdog = {
    check() {
      if (stopped) return
      const rss = readRss()
      over = rss > limitBytes ? over + 1 : 0
      if (over < sustained) return
      watchdog.stop()
      options.onLimit(Math.round(rss / BYTES_PER_MB))
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
    },
  }
  timer = setInterval(() => watchdog.check(), options.intervalMs ?? 5_000)
  // Never the reason the process stays alive.
  timer.unref?.()
  return watchdog
}
