/**
 * The sessions surface.
 *
 * ── WHY THIS REPLACED A DROPDOWN ───────────────────────────────────────────────
 *
 * Previous sessions used to live behind a header icon that opened a small floating panel. A
 * dropdown is the wrong control for a list you SCAN: it is short, it closes when the pointer
 * strays, and it has no room for the branch and worktree that are the only things
 * distinguishing two sessions in the same repository. This is a real surface — searchable,
 * grouped by recency, and navigable with the keyboard.
 *
 * ── GROUPING IS BY RECENCY, NOT BY DATE ────────────────────────────────────────
 *
 * "Today / Yesterday / Previous 7 Days / …" answers the question actually being asked, which
 * is "roughly when was I in this". Exact dates only help for sessions old enough that the
 * relative time stops being meaningful, which is what the Older bucket's absolute date is for.
 *
 * ── RESUMING IS DESTRUCTIVE, AND ASKS ONCE ─────────────────────────────────────
 *
 * Resuming replaces the engine child, so the current conversation is gone. A session with a
 * transcript therefore confirms on a second click; an empty one does not, because there is
 * nothing to lose and a prompt would be a speed bump. This is the behaviour the dropdown had
 * and it is preserved deliberately.
 */
import { useMemo, useState } from 'react'

import type { SessionListView, SessionSummaryView } from '../../shared/webviewProtocol.js'
import { SearchIcon } from './Icons.js'

export interface SessionsViewProps {
  list: SessionListView
  /** True when the transcript has content, so resuming would discard something. */
  hasActiveTranscript: boolean
  workspaceFolder: string
  onResume: (id: string) => void
  onRetry: () => void
}

/** Recency buckets, newest first. The boundaries are calendar days, not fixed durations. */
const GROUPS = [
  { key: 'today', title: 'Today' },
  { key: 'yesterday', title: 'Yesterday' },
  { key: 'week', title: 'Previous 7 Days' },
  { key: 'month', title: 'Previous 30 Days' },
  { key: 'older', title: 'Older' },
] as const

type GroupKey = (typeof GROUPS)[number]['key']

/**
 * Which bucket a timestamp falls in.
 *
 * Uses calendar boundaries rather than elapsed hours: something from 23:50 last night is
 * "Yesterday" at 00:10, not "Today", and a 24-hour window would get that wrong for exactly
 * the sessions a user is most likely to be looking for.
 *
 * Exported for test — the day boundaries are the whole of the logic.
 */
export function recencyGroup(epochMs: number, now = Date.now()): GroupKey {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const start = startOfToday.getTime()
  if (epochMs >= start) return 'today'
  if (epochMs >= start - 86_400_000) return 'yesterday'
  if (epochMs >= start - 7 * 86_400_000) return 'week'
  if (epochMs >= start - 30 * 86_400_000) return 'month'
  return 'older'
}

export function SessionsView({
  list,
  hasActiveTranscript,
  workspaceFolder,
  onResume,
  onRetry,
}: SessionsViewProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return list.sessions
    return list.sessions.filter(
      session =>
        session.label.toLowerCase().includes(q) ||
        (session.gitBranch?.toLowerCase().includes(q) ?? false) ||
        (session.cwd?.toLowerCase().includes(q) ?? false),
    )
  }, [list.sessions, query])

  const grouped = useMemo(() => {
    const buckets = new Map<GroupKey, SessionSummaryView[]>()
    for (const session of filtered) {
      const key = recencyGroup(session.lastModified)
      const bucket = buckets.get(key)
      if (bucket) bucket.push(session)
      else buckets.set(key, [session])
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => b.lastModified - a.lastModified)
    }
    return buckets
  }, [filtered])

  function choose(id: string): void {
    if (hasActiveTranscript && confirming !== id) {
      setConfirming(id)
      return
    }
    setConfirming(null)
    onResume(id)
  }

  return (
    <section className="rc-sessions" aria-label="Sessions">
      <div className="rc-sessions-search">
        <SearchIcon size={12} className="rc-search-icon" />
        <input
          className="rc-dropdown-search"
          type="text"
          placeholder="Search sessions…"
          aria-label="Search sessions"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </div>

      <div className="rc-sessions-body">
        {list.status === 'loading' && list.sessions.length === 0 ? (
          <p className="rc-dropdown-empty">Loading sessions…</p>
        ) : list.status === 'failed' ? (
          <div className="rc-dropdown-empty">
            {/* The stale list is still shown below when there is one: a real list that is a
                minute old beats an empty surface. */}
            <p className="rc-dropdown-error">{list.error ?? 'Could not read session history.'}</p>
            <button type="button" className="rc-button" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : null}

        {list.status !== 'loading' && list.sessions.length === 0 ? (
          <p className="rc-dropdown-empty">No previous sessions in this workspace yet.</p>
        ) : filtered.length === 0 && query.trim() ? (
          // Distinct from "none exist": the fix is to change the search, not to start working.
          <p className="rc-dropdown-empty">No session matches “{query}”.</p>
        ) : null}

        {GROUPS.map(group => {
          const sessions = grouped.get(group.key)
          if (!sessions || sessions.length === 0) return null
          return (
            <div key={group.key} className="rc-sessions-group">
              <h3 className="rc-sessions-group-title">{group.title}</h3>
              <ul className="rc-sessions-list">
                {sessions.map(session => (
                  <li key={session.id}>
                    <button
                      type="button"
                      className={`rc-session-row${
                        confirming === session.id ? ' rc-session-row-confirm' : ''
                      }`}
                      onClick={() => choose(session.id)}
                    >
                      <span className="rc-session-row-label">{session.label}</span>
                      <span className="rc-session-row-meta">
                        {group.key === 'older'
                          ? new Date(session.lastModified).toLocaleDateString()
                          : relativeTime(session.lastModified)}
                        {session.gitBranch ? ` · ${session.gitBranch}` : ''}
                        {/* Only for a different directory — i.e. another worktree. Otherwise
                            it is the workspace and adds nothing. */}
                        {session.cwd && session.cwd !== workspaceFolder
                          ? ` · ${shortenPath(session.cwd)}`
                          : ''}
                      </span>
                      {confirming === session.id ? (
                        <span className="rc-session-row-warn">
                          Click again to resume. The current conversation will be closed.
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Coarse buckets: the question is "how recent", not "exactly when". */
function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Keep the tail: the leaf directories are what identify a worktree. */
function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}
