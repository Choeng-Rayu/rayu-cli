/**
 * Cumulative per-tool usage statistics, computed from the transcript the webview already
 * holds.
 *
 * Kept host-free and pure so the Stats tab can derive its numbers without a new protocol
 * message: the transcript is the same data the chat renders, and the panel is the only
 * consumer. Sorting stays with the panel — this returns the tools in first-seen order.
 */
import type { TranscriptEntry } from './webviewProtocol.js'

export interface ToolUsageStatsView {
  toolName: string
  /** Every call, including one still running. */
  callCount: number
  /** Calls whose result arrived successfully. */
  successCount: number
  /** Calls whose result was an error. */
  failureCount: number
}

/**
 * Group `kind: 'tool'` entries by tool name.
 *
 * A running call counts toward `callCount` only: it has neither succeeded nor failed, and
 * counting it as either would move the success rate while the tool is still working.
 */
export function toolUsageStats(entries: readonly TranscriptEntry[]): ToolUsageStatsView[] {
  const byName = new Map<string, ToolUsageStatsView>()
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue
    let stats = byName.get(entry.name)
    if (!stats) {
      stats = { toolName: entry.name, callCount: 0, successCount: 0, failureCount: 0 }
      byName.set(entry.name, stats)
    }
    stats.callCount += 1
    if (entry.status === 'done') stats.successCount += 1
    else if (entry.status === 'error') stats.failureCount += 1
  }
  return [...byName.values()]
}
