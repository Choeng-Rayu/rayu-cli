/**
 * Shows cumulative per-tool usage statistics for the session.
 *
 * Sorted by call count descending so the most-used tools appear first.
 * Each row shows: tool name, call count, and success rate.
 */
import React from 'react'

export interface ToolUsageStatsView {
  toolName: string
  callCount: number
  successCount: number
  failureCount: number
}

export function ToolStatsPanel({
  stats,
}: {
  stats: ToolUsageStatsView[]
}): JSX.Element | null {
  if (stats.length === 0) return null

  const sorted = [...stats].sort((a, b) => b.callCount - a.callCount)

  return (
    <div className="rc-tool-stats">
      <h3 className="rc-tool-stats-title">Tool Usage</h3>
      <ul className="rc-tool-stats-list">
        {sorted.map(stat => {
          const rate =
            stat.callCount > 0
              ? Math.round((stat.successCount / stat.callCount) * 100)
              : null
          return (
            <li key={stat.toolName} className="rc-tool-stats-row">
              <span className="rc-tool-stats-name">{stat.toolName}</span>
              <span className="rc-tool-stats-count">{stat.callCount}</span>
              {rate !== null && (
                <span
                  className={`rc-tool-stats-rate${stat.failureCount > 0 ? ' rc-tool-stats-rate--warn' : ''}`}
                >
                  {rate}%
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
