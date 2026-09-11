/**
 * How a turn's progress READS. One module, both bundles.
 *
 * In `shared/` for the same reason `permissionModes.ts` is: both sides need it, and it
 * must be testable without stubbing the editor. Dependency-free except for type imports,
 * so it is safe in the BROWSER bundle.
 *
 * ── THIS REPLACED FOUR SEPARATE DURATION FORMATTERS ────────────────────────────
 *
 * There were four: `formatDurationCompact` in the host's `sessionHandle`, `formatElapsed`
 * in `App.tsx`, `formatDuration` in `TranscriptEntryView.tsx`, and another `formatElapsed`
 * in `BackgroundTaskCenter.tsx`. They disagreed — one rounded seconds, one floored them,
 * one omitted the seconds component above an hour, one had no hour case at all — so the
 * same 90-second turn could be described three different ways in one panel. Anything that
 * renders a duration or a token count uses this.
 *
 * ── THE ARROWS ARE INPUT AND OUTPUT, AND NOTHING ELSE ──────────────────────────
 *
 * `↑` is tokens sent TO the provider, `↓` is tokens received FROM it. They are not
 * filesystem reads and writes, and they are not upload/download of files. See
 * `TurnTokenUsageView` for why input includes the cache figures.
 */
import type {
  TurnCompletionEntry,
  TurnPhaseView,
  TurnProgressView,
  TurnTokenUsageView,
} from './webviewProtocol.js'

/**
 * Compact duration: "45s", "7m 35s", "1h 2m".
 *
 * Seconds are FLOORED, not rounded: a turn that has run for 1.9s has not yet run for
 * two seconds, and rounding up makes a live counter appear to start at 1 before any
 * time has passed.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`
}

/**
 * Compact token count: "45", "1.2k", "12.8k", "128k".
 *
 * One decimal up to 100k and none above, because past that the extra digit stops carrying
 * information — "12.8k" is a useful distinction, "128.4k" is noise in a status line. A
 * trailing ".0" is dropped for the same reason: "2k" says exactly what "2.0k" says.
 */
export function formatTokenCount(tokens: number): string {
  const value = Math.max(0, Math.round(tokens))
  if (value < 1000) return `${value}`
  const thousands = value / 1000
  if (thousands >= 100) return `${Math.round(thousands)}k`
  const withDecimal = thousands.toFixed(1)
  return `${withDecimal.endsWith('.0') ? withDecimal.slice(0, -2) : withDecimal}k`
}

/** Phases in which the engine is no longer working. */
const TERMINAL_PHASES: ReadonlySet<TurnPhaseView> = new Set<TurnPhaseView>([
  'completed',
  'failed',
  'stopped',
])

export function isTerminalPhase(phase: TurnPhaseView): boolean {
  return TERMINAL_PHASES.has(phase)
}

/**
 * Phases in which the engine is BLOCKED on the user rather than working.
 *
 * Kept separate from the terminal set because the turn is still open — but presenting it
 * as "working" would be a lie the user cannot act on, and an animated spinner would imply
 * that waiting is enough.
 */
export function isWaitingPhase(phase: TurnPhaseView): boolean {
  return phase === 'waiting'
}

/**
 * The live status text, e.g. `Editing src/app.ts` or `Waiting for approval`.
 *
 * The host already resolved `label` from the phase, so this only appends the specific
 * thing being acted on when there is one. The tool's own label is preferred over its
 * name: "Editing src/app.ts" says more than "Editing Edit".
 */
export function describeTurnPhase(progress: TurnProgressView): string {
  const detail = progress.toolLabel?.trim() || progress.toolName?.trim()
  return detail ? `${progress.label} ${detail}` : progress.label
}

/** One rendered token figure, with the marker that says whether it is a measurement. */
export interface TokenReadout {
  direction: '↑' | '↓'
  /** Compact count, prefixed with `~` when it is an estimate rather than reported. */
  text: string
  estimated: boolean
  /** Long form for a tooltip / screen reader. */
  title: string
}

/**
 * Input and output readouts, omitting a side that has nothing to report.
 *
 * A zero is dropped rather than shown: "↓ 0" before the first response token reads as a
 * failure, whereas its absence correctly says "nothing yet". An ESTIMATED zero is dropped
 * for the same reason.
 */
export function tokenReadouts(usage: TurnTokenUsageView): TokenReadout[] {
  const readouts: TokenReadout[] = []
  if (usage.inputTokens > 0) {
    const cacheParts: string[] = []
    if (usage.cacheReadTokens) {
      cacheParts.push(`${formatTokenCount(usage.cacheReadTokens)} read from cache`)
    }
    if (usage.cacheCreationTokens) {
      cacheParts.push(`${formatTokenCount(usage.cacheCreationTokens)} written to cache`)
    }
    readouts.push({
      direction: '↑',
      text: `${usage.inputEstimated ? '~' : ''}${formatTokenCount(usage.inputTokens)}`,
      estimated: usage.inputEstimated,
      title:
        `${usage.inputTokens.toLocaleString()} input tokens sent to the provider` +
        (cacheParts.length > 0 ? ` (includes ${cacheParts.join(' and ')})` : '') +
        (usage.inputEstimated ? '. Estimated until the provider reports usage.' : '.'),
    })
  }
  if (usage.outputTokens > 0) {
    readouts.push({
      direction: '↓',
      text: `${usage.outputEstimated ? '~' : ''}${formatTokenCount(usage.outputTokens)}`,
      estimated: usage.outputEstimated,
      title:
        `${usage.outputTokens.toLocaleString()} output tokens received from the provider` +
        (usage.outputEstimated
          ? '. Estimated from streamed text at four characters per token; replaced by the exact count when the turn ends.'
          : '.'),
    })
  }
  return readouts
}

/** Glyph and wording for a finished turn. */
export function describeCompletion(completion: TurnCompletionEntry): {
  glyph: string
  /** e.g. "Completed in 1m 23s" */
  text: string
  tone: 'success' | 'error' | 'neutral'
} {
  const duration = formatDuration(completion.durationMs)
  switch (completion.outcome) {
    case 'completed':
      return { glyph: '\u2713', text: `Completed in ${duration}`, tone: 'success' }
    case 'failed':
      return { glyph: '!', text: `Failed after ${duration}`, tone: 'error' }
    case 'stopped':
      return { glyph: '\u25a0', text: `Stopped after ${duration}`, tone: 'neutral' }
  }
}
