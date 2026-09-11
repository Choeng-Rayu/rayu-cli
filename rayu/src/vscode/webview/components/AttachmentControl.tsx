/**
 * Attach the panel to a Rayu CLI session running in this workspace.
 *
 * ── WHAT ATTACHING MEANS HERE ──────────────────────────────────────────────────
 *
 * The panel mirrors a session that is running in a terminal: its streamed answers, its
 * completed tool calls and its permission cards appear here, and a prompt typed here is
 * queued there. The terminal keeps working the whole time — this is a second window onto
 * one conversation, not a handover.
 *
 * Permission cards are the reason this matters: a card raised by the CLI can be answered
 * from whichever surface the user is looking at. Answering in one place removes it from
 * the others, because the session announces the resolution to every attached interface.
 */
import { useEffect, useRef, useState } from 'react'

import type {
  AttachableSessionView,
  AttachmentView,
} from '../../shared/webviewProtocol.js'
import { LinkIcon } from './Icons.js'

export interface AttachmentControlProps {
  attachment: AttachmentView
  onList: () => void
  onAttach: (pid: number) => void
  onDetach: () => void
}

export function AttachmentControl({
  attachment,
  onList,
  onAttach,
  onDetach,
}: AttachmentControlProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDocument(event: MouseEvent): void {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocument)
    return () => document.removeEventListener('mousedown', onDocument)
  }, [open])

  const attached = attachment.attached

  return (
    <div className="rc-dropdown" ref={container}>
      <button
        type="button"
        className={`rc-icon-button${attached ? ' rc-icon-button-on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          attached
            ? `Mirroring the CLI session ${describe(attached)}. Click to manage.`
            : 'Attach to a Rayu CLI session running in this folder'
        }
        onClick={() => {
          const next = !open
          setOpen(next)
          // Refetch on open: sessions start and exit while the panel sits idle, so a
          // cached list is stale in a way the user cannot see.
          if (next) onList()
        }}
      >
        <LinkIcon />
      </button>

      {open ? (
        <div
          className="rc-dropdown-panel rc-dropdown-panel-below"
          role="dialog"
          aria-label="Attach to a CLI session"
        >
          {attachment.error ? (
            <p className="rc-dropdown-empty" role="alert">
              {attachment.error}
            </p>
          ) : null}

          {attached ? (
            <div className="rc-attach-current">
              <p className="rc-dropdown-label">Mirroring {describe(attached)}</p>
              <p className="rc-dropdown-detail">
                Prompts you send here are queued in that session. The terminal keeps
                working normally.
              </p>
              <button type="button" className="rc-button" onClick={() => {
                setOpen(false)
                onDetach()
              }}>
                Stop mirroring
              </button>
            </div>
          ) : attachment.available === undefined ? (
            <p className="rc-dropdown-empty">Looking for running sessions…</p>
          ) : attachment.available.length === 0 ? (
            <p className="rc-dropdown-empty">
              No Rayu CLI sessions are running in this folder. Start one with{' '}
              <code>rayu</code> in a terminal.
            </p>
          ) : (
            <ul className="rc-dropdown-list" role="listbox">
              {attachment.available.map(session => (
                <li key={session.pid} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="rc-dropdown-item"
                    onClick={() => {
                      setOpen(false)
                      onAttach(session.pid)
                    }}
                  >
                    <span className="rc-dropdown-label">{describe(session)}</span>
                    <span className="rc-dropdown-detail">
                      {statusLabel(session)}
                      {' · started '}
                      {new Date(session.startedAt).toLocaleTimeString()}
                    </span>
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

/** The CLI's own /name when set, else the pid — which is what `/sessions` shows. */
function describe(session: AttachableSessionView): string {
  return session.name?.trim() || `session ${session.pid}`
}

/**
 * `waiting` is called out with WHAT it is waiting for, because that is the case where
 * attaching has immediate value: there is a card to answer.
 */
function statusLabel(session: AttachableSessionView): string {
  if (session.status === 'waiting') {
    return session.waitingFor ? `waiting: ${session.waitingFor}` : 'waiting for input'
  }
  if (session.status === 'busy') return 'working'
  if (session.status === 'idle') return 'idle'
  return 'status unknown'
}

