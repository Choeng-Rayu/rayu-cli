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
 * ── RESUMING IS NO LONGER DESTRUCTIVE ─────────────────────────────────────────
 *
 * It used to replace the panel's only engine, so a session with a transcript confirmed on a
 * second click. The panel now holds several conversations open at once, so resuming OPENS one
 * and leaves the current one running — there is nothing to lose and therefore nothing to
 * confirm. Open conversations are listed above the history under "Open now", where switching
 * costs nothing at all.
 */
import { useMemo, useState } from 'react'

import type {
  LiveSessionView,
  SessionListView,
  SessionSummaryView,
} from '../../shared/webviewProtocol.js'
import { CloseIcon, SearchIcon } from './Icons.js'

export interface SessionsViewProps {
  list: SessionListView
  /** Conversations the panel is holding open, newest activity first. */
  liveSessions: readonly LiveSessionView[]
  /** Which live session is on screen, so the row can say "current". */
  activeSessionKey: string
  workspaceFolder: string
  onResume: (id: string) => void
  /** Bring an already-open conversation to the front. Nothing is spawned or stopped. */
  onSwitch: (key: string) => void
  /** Close an open conversation and stop its engine. */
  onClose: (key: string) => void
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
  liveSessions,
  activeSessionKey,
  workspaceFolder,
  onResume,
  onSwitch,
  onClose,
  onRetry,
}: SessionsViewProps): JSX.Element {
  const [query, setQuery] = useState('')

  /** Live sessions the search should keep. Matched on label only — they have no branch. */
  const visibleLive = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return liveSessions
    return liveSessions.filter(item => item.label.toLowerCase().includes(q))
  }, [liveSessions, query])

  /**
   * History rows for sessions that are ALSO open in the panel are hidden.
   *
   * The same conversation would otherwise appear twice — once as "open and running", once as
   * a history row that offers to resume it — and the resume row would be the destructive
   * option. Correlation is by label because a live session's engine id is not known until its
   * child reports one, and the label is what the user reads either way.
   */
  const liveLabels = useMemo(
    () => new Set(liveSessions.map(item => item.label)),
    [liveSessions],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const withoutLive = list.sessions.filter(session => !liveLabels.has(session.label))
    if (!q) return withoutLive
    return withoutLive.filter(
      session =>
        session.label.toLowerCase().includes(q) ||
        (session.gitBranch?.toLowerCase().includes(q) ?? false) ||
        (session.cwd?.toLowerCase().includes(q) ?? false),
    )
  }, [list.sessions, liveLabels, query])

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

  /**
   * Resuming is no longer destructive, so it no longer confirms.
   *
   * It used to replace the only engine there was, which is why a second click was required.
   * Now it OPENS another conversation and leaves the current one running, so a confirmation
   * would be a speed bump guarding nothing — and, worse, would still be claiming that the
   * current conversation is about to be closed.
   */
  function choose(id: string): void {
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
        {/*
          ── OPEN CONVERSATIONS COME FIRST ────────────────────────────────────────
          They are the ones with work in flight, and switching to one is free and lossless
          where resuming a history row costs an engine spawn. Putting them under a date
          heading would bury "the thing you started two minutes ago" among files.
        */}
        {visibleLive.length > 0 ? (
          <div className="rc-sessions-group">
            <h3 className="rc-sessions-group-title">Open now</h3>
            <ul className="rc-sessions-list">
              {visibleLive.map(item => (
                <li key={item.key} className="rc-session-live-row">
                  <button
                    type="button"
                    className={`rc-session-row${
                      item.key === activeSessionKey ? ' rc-session-row-active' : ''
                    }`}
                    aria-current={item.key === activeSessionKey}
                    onClick={() => onSwitch(item.key)}
                  >
                    <span className="rc-session-row-label">
                      {/* A running conversation is marked while the panel shows another one:
                          that is the fact the previous behaviour destroyed. */}
                      {item.running ? (
                        <span className="rc-progress-glyph" aria-hidden="true" />
                      ) : null}
                      {item.label}
                    </span>
                    <span className="rc-session-row-meta">
                      {item.key === activeSessionKey
                        ? 'On screen'
                        : item.running
                          ? 'Running'
                          : 'Idle'}
                      {/* Surfaced because a blocked session cannot advance until the user
                          comes back to it, and nothing else on screen would say so. */}
                      {item.pendingApprovals > 0
                        ? ` · ${item.pendingApprovals} waiting for approval`
                        : ''}
                      {item.model ? ` · ${item.model}` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="rc-session-close"
                    title="Close this conversation and stop its engine"
                    aria-label={`Close ${item.label}`}
                    onClick={() => onClose(item.key)}
                  >
                    <CloseIcon size={10} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

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
                      className="rc-session-row rc-session-row-history"
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
