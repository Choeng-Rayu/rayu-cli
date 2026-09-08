/**
 * Previous-session picker.
 *
 * ── RESUMING DISCARDS THE CURRENT CONVERSATION ──────────────────────────────────
 *
 * Resuming replaces the engine child, so whatever is on screen is gone. That is a
 * destructive action from the user's point of view, so a session with a transcript asks
 * for confirmation first. An empty session does not — there is nothing to lose, and a
 * prompt there would be a speed bump with no purpose.
 *
 * ── WHAT EACH ROW SHOWS AND WHY ─────────────────────────────────────────────────
 *
 * The label is the CLI's own precedence (custom /title → summary → first prompt → short
 * id), so a session is recognisable by the same name in both surfaces. Relative time
 * answers "is this the one I was just in". The branch and, for worktrees, the directory
 * are what distinguish otherwise identical-looking sessions in the same repository.
 */
import { useEffect, useRef, useState } from 'react'

import type { SessionSummaryView } from '../../shared/webviewProtocol.js'

export interface SessionHistoryProps {
  sessions: SessionSummaryView[] | undefined
  /** True when the transcript has content, so resuming would discard something. */
  hasActiveTranscript: boolean
  workspaceFolder: string
  onOpen: () => void
  onResume: (id: string) => void
}

export function SessionHistory({
  sessions,
  hasActiveTranscript,
  workspaceFolder,
  onOpen,
  onResume,
}: SessionHistoryProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const container = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDocument(event: MouseEvent): void {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false)
        // Drop a half-made decision on close. Reopening should not resurface a
        // confirmation the user walked away from.
        setConfirming(null)
      }
    }
    document.addEventListener('mousedown', onDocument)
    return () => document.removeEventListener('mousedown', onDocument)
  }, [open])

  const filtered = (sessions ?? []).filter(s => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      s.label.toLowerCase().includes(q) ||
      (s.gitBranch?.toLowerCase().includes(q) ?? false)
    )
  })

  function choose(id: string): void {
    // Confirm only when there is something to lose.
    if (hasActiveTranscript && confirming !== id) {
      setConfirming(id)
      return
    }
    setOpen(false)
    setConfirming(null)
    onResume(id)
  }

  return (
    <div className="rc-dropdown" ref={container}>
      <button
        type="button"
        className="rc-icon-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Previous sessions"
        onClick={() => {
          const next = !open
          setOpen(next)
          // Refetch on every open: sessions accumulate from the CLI and other windows
          // while the panel sits idle, so a cached list goes stale invisibly.
          if (next) onOpen()
        }}
      >
        <HistoryIcon />
      </button>

      {open ? (
        <div
          className="rc-dropdown-panel rc-dropdown-panel-below"
          role="dialog"
          aria-label="Previous sessions"
        >
          <input
            className="rc-dropdown-search"
            type="text"
            placeholder="Search sessions…"
            aria-label="Search previous sessions"
            value={query}
            /* eslint-disable-next-line jsx-a11y/no-autofocus -- the panel is an
               explicitly opened dialog whose only purpose is this search */
            autoFocus
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
              }
            }}
          />

          {/* `undefined` means the list has not arrived, `[]` means there are none.
              Collapsing them would show "no sessions" during a load. */}
          {sessions === undefined ? (
            <p className="rc-dropdown-empty">Loading sessions…</p>
          ) : filtered.length === 0 ? (
            <p className="rc-dropdown-empty">
              {query.trim() ? 'No matching sessions.' : 'No previous sessions here yet.'}
            </p>
          ) : (
            <ul className="rc-dropdown-list" role="listbox">
              {filtered.map(session => (
                <li key={session.id} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={`rc-dropdown-item${
                      confirming === session.id ? ' rc-dropdown-item-confirm' : ''
                    }`}
                    onClick={() => choose(session.id)}
                  >
                    <span className="rc-dropdown-label">{session.label}</span>
                    <span className="rc-dropdown-detail">
                      {relativeTime(session.lastModified)}
                      {session.gitBranch ? ` · ${session.gitBranch}` : ''}
                      {/* Shown only for a different directory — i.e. another worktree.
                          Otherwise it is the workspace and adds nothing. */}
                      {session.cwd && session.cwd !== workspaceFolder
                        ? ` · ${shortenPath(session.cwd)}`
                        : ''}
                    </span>
                    {confirming === session.id ? (
                      <span className="rc-dropdown-warn">
                        Click again to resume. The current conversation will be closed.
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
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
  if (days < 30) return `${days}d ago`
  return new Date(epochMs).toLocaleDateString()
}

/** Keep the tail: the leaf directories are what identify a worktree. */
function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

function HistoryIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" role="presentation">
      <path d="M8 2a6 6 0 1 0 5.65 8h-1.1A4.9 4.9 0 1 1 8 3.1c1.3 0 2.47.51 3.34 1.34L9.5 6.3h4.2V2.1l-1.5 1.48A5.98 5.98 0 0 0 8 2zm-.5 3v3.3l2.6 1.55.5-.83-2.1-1.25V5h-1z" />
    </svg>
  )
}
