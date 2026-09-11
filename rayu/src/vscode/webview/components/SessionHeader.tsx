/**
 * The panel's own header.
 *
 * ── IT DOES NOT REPEAT WHAT VS CODE ALREADY SHOWS ──────────────────────────────
 *
 * The previous header led with the word "Rayucode" and carried the version, the signed-in
 * account, the context gauge, the attachment control and the history dropdown. VS Code
 * already renders the view's title directly above it, so the name was duplicated furniture,
 * and the rest competed for a strip narrower than a sidebar. What belongs here is what
 * changes as you work: which conversation this is, and what it is doing.
 *
 * Identity, version, provider setup, MCP connections and sign-out moved into the overflow
 * menu. They are settings and facts, consulted rarely — and two of them (MCP status and
 * sign-out) previously had NO surface at all despite the protocol supporting them, so the
 * capability existed and could not be reached.
 *
 * ── THE STATUS PILL IS DERIVED, NOT REPORTED ───────────────────────────────────
 *
 * There is no "session status" on the wire, and there should not be: it is a function of
 * facts the panel already holds. `waiting` outranks `working` because an approval blocks the
 * turn — describing a blocked session as working is the one reading that would mislead.
 */
import { useEffect, useRef, useState } from 'react'

import type {
  McpServerView,
  TranscriptEntry,
  TurnProgressView,
} from '../../shared/webviewProtocol.js'
import { isTerminalPhase, isWaitingPhase } from '../../shared/turnProgress.js'
import {
  BackIcon,
  EllipsisIcon,
  HistoryIcon,
  ListIcon,
  PlugIcon,
  PlusIcon,
  RayuMark,
  SignOutIcon,
} from './Icons.js'

export type SessionStatus = 'idle' | 'working' | 'waiting' | 'completed' | 'failed'

/**
 * Derive the session's status from what the panel already knows.
 *
 * Exported for test: the precedence is the whole of the logic, and it is the kind of thing
 * that looks obviously right and is quietly wrong for the blocked case.
 */
export function deriveSessionStatus(
  turnRunning: boolean,
  progress: TurnProgressView | null,
  pendingApprovals: number,
): SessionStatus {
  // Blocked on the user outranks everything else: the turn cannot advance until they answer.
  if (pendingApprovals > 0) return 'waiting'
  if (turnRunning) return progress && isWaitingPhase(progress.phase) ? 'waiting' : 'working'
  if (progress && isTerminalPhase(progress.phase)) {
    return progress.phase === 'completed' ? 'completed' : 'failed'
  }
  return 'idle'
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'Ready',
  working: 'Working',
  waiting: 'Waiting for you',
  completed: 'Done',
  failed: 'Failed',
}

/**
 * A title for the conversation.
 *
 * Derived from the first prompt rather than added to the protocol, because the host has no
 * title for a live session either — the CLI's own fallback chain ends at the first prompt for
 * exactly the same reason. Trimmed to a single line: a pasted multi-line prompt would
 * otherwise stretch the header to the height of the paste.
 */
export function deriveSessionTitle(entries: readonly TranscriptEntry[]): string | null {
  const firstPrompt = entries.find(entry => entry.kind === 'prompt')
  if (!firstPrompt || firstPrompt.kind !== 'prompt') return null
  const line = firstPrompt.text.split('\n').map(l => l.trim()).find(Boolean)
  if (!line) return null
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

export interface SessionHeaderProps {
  ready: boolean
  signedOut: boolean
  identity: { email: string | null; displayName: string | null } | null
  version: string
  title: string | null
  status: SessionStatus
  mcpServers: readonly McpServerView[]
  /** Shown only while a sub-surface (sessions, task details) has replaced the conversation. */
  onBack?: () => void
  onNewSession: () => void
  onOpenSessions: () => void
  /** Whether every tool row is showing its parameters and output. */
  detailed: boolean
  /** Flip the panel-wide detail switch — the editor's equivalent of the CLI's Ctrl+O. */
  onToggleDetailed: () => void
  /** How many conversations the panel is holding open, for the Sessions badge. */
  openSessionCount: number
  /** How many background tasks exist, for the badge on the background-work control. */
  backgroundTaskCount: number
  /** Whether the background-work surface is the one currently open. */
  backgroundOpen: boolean
  onToggleBackground: () => void
  onOpenProviderSetup: () => void
  onRefreshMcp: () => void
  onReconnectMcp: (serverName: string) => void
  onToggleMcp: (serverName: string, enabled: boolean) => void
  onSignOut: () => void
}

export function SessionHeader({
  ready,
  signedOut,
  identity,
  version,
  title,
  status,
  mcpServers,
  onBack,
  onNewSession,
  onOpenSessions,
  detailed,
  onToggleDetailed,
  openSessionCount,
  backgroundTaskCount,
  backgroundOpen,
  onToggleBackground,
  onOpenProviderSetup,
  onRefreshMcp,
  onReconnectMcp,
  onToggleMcp,
  onSignOut,
}: SessionHeaderProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const container = useRef<HTMLDivElement | null>(null)

  // Registered only while open, so a closed menu costs no document listener.
  useEffect(() => {
    if (!menuOpen) return
    function onDocument(event: MouseEvent): void {
      if (!container.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocument)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocument)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // MCP status is fetched when the menu opens rather than polled: it is only visible here,
  // and a background poll would keep the engine busy for a panel nobody is looking at.
  useEffect(() => {
    if (menuOpen) onRefreshMcp()
  }, [menuOpen, onRefreshMcp])

  const who = identity?.displayName ?? identity?.email ?? null

  return (
    <header className="rc-header" ref={container}>
      {onBack ? (
        <button
          type="button"
          className="rc-icon-button"
          onClick={onBack}
          title="Back to conversation"
          aria-label="Back to conversation"
        >
          <BackIcon size={14} />
        </button>
      ) : (
        <RayuMark size={14} className="rc-header-mark" />
      )}

      <span className="rc-header-title" title={title ?? undefined}>
        {title ?? 'New conversation'}
      </span>

      {/* `idle` is not rendered: a pill that says "Ready" on every fresh panel is furniture. */}
      {ready && status !== 'idle' ? (
        <span
          className={`rc-session-status rc-session-status-${status}`}
          role="status"
          aria-live="polite"
        >
          {status === 'working' || status === 'waiting' ? (
            <span className="rc-progress-glyph" aria-hidden="true" />
          ) : null}
          {STATUS_LABEL[status]}
        </span>
      ) : null}

      <span className="rc-header-spacer" />

      {!signedOut ? (
        <>
          {/*
            The clickable equivalent of the CLI's Ctrl+O. A shortcut alone would be
            invisible in an editor panel — a keystroke nobody can discover is the same as
            no feature — so this is a real control, and the shortcut is documented on it.
          */}
          <button
            type="button"
            className={`rc-icon-button${detailed ? ' rc-icon-button-active' : ''}`}
            aria-pressed={detailed}
            title={
              detailed
                ? 'Hide tool details (Ctrl+O)'
                : 'Show tool parameters and output (Ctrl+O)'
            }
            aria-label="Toggle tool details"
            onClick={onToggleDetailed}
          >
            <ListIcon size={14} />
          </button>
          {/* Only offered when there IS background work: an always-present control that
              opens an empty panel teaches the user to stop pressing it. */}
          {backgroundTaskCount > 0 ? (
            <button
              type="button"
              className={`rc-icon-button rc-icon-button-badged${
                backgroundOpen ? ' rc-icon-button-active' : ''
              }`}
              aria-expanded={backgroundOpen}
              title={`Background work (${backgroundTaskCount})`}
              aria-label={`Background work, ${backgroundTaskCount} ${
                backgroundTaskCount === 1 ? 'task' : 'tasks'
              }`}
              onClick={onToggleBackground}
            >
              <RayuMark size={13} />
              <span className="rc-icon-badge">{backgroundTaskCount}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="rc-icon-button"
            title="New session"
            aria-label="New session"
            onClick={onNewSession}
          >
            <PlusIcon size={14} />
          </button>
          <button
            type="button"
            className={`rc-icon-button${openSessionCount > 1 ? ' rc-icon-button-badged' : ''}`}
            title={
              openSessionCount > 1
                ? `Sessions — ${openSessionCount} open`
                : 'Sessions'
            }
            aria-label="Sessions"
            onClick={onOpenSessions}
          >
            <HistoryIcon size={14} />
            {/* Only shown when more than one is open. With a single conversation the count is
                not information, and this is the only affordance that leads back to the others
                after pressing +. */}
            {openSessionCount > 1 ? (
              <span className="rc-icon-badge">{openSessionCount}</span>
            ) : null}
          </button>
        </>
      ) : null}

      <div className="rc-dropdown">
        <button
          type="button"
          className={`rc-icon-button${menuOpen ? ' rc-icon-button-active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="More actions"
          aria-label="More actions"
          onClick={() => setMenuOpen(open => !open)}
        >
          <EllipsisIcon size={14} />
        </button>

        {menuOpen ? (
          <div className="rc-dropdown-panel rc-overflow-panel" role="menu">
            <div className="rc-overflow-identity">
              <RayuMark size={16} />
              <span className="rc-overflow-who">{who ?? 'Not signed in'}</span>
              <span className="rc-overflow-version">v{version}</span>
            </div>

            <button
              type="button"
              role="menuitem"
              className="rc-overflow-item"
              onClick={() => {
                setMenuOpen(false)
                onOpenProviderSetup()
              }}
            >
              <PlugIcon size={13} />
              Connect provider
            </button>

            <div className="rc-overflow-section">
              <span className="rc-overflow-section-title">MCP servers</span>
              {/*
                Three states, kept apart: not yet fetched, fetched-and-none, and a list. An
                empty list rendered as "none configured" while the fetch was still in flight
                would be a confident wrong answer.
              */}
              {mcpServers.length === 0 ? (
                <p className="rc-overflow-empty">No MCP servers connected.</p>
              ) : (
                <ul className="rc-overflow-mcp">
                  {mcpServers.map(server => (
                    <li key={server.name} className="rc-overflow-mcp-row">
                      <span
                        className={`rc-mcp-dot rc-mcp-${server.status}`}
                        aria-hidden="true"
                      />
                      <span className="rc-overflow-mcp-name" title={server.error}>
                        {server.name}
                      </span>
                      <span className="rc-overflow-mcp-status">{server.status}</span>
                      {/* Reconnect is offered only where it can help. A disabled server needs
                          enabling, not reconnecting. */}
                      {server.status === 'disconnected' ? (
                        <button
                          type="button"
                          className="rc-overflow-mcp-action"
                          onClick={() => onReconnectMcp(server.name)}
                        >
                          Reconnect
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="rc-overflow-mcp-action"
                        onClick={() =>
                          onToggleMcp(server.name, server.status === 'disabled')
                        }
                      >
                        {server.status === 'disabled' ? 'Enable' : 'Disable'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {!signedOut ? (
              <button
                type="button"
                role="menuitem"
                className="rc-overflow-item rc-overflow-item-danger"
                onClick={() => {
                  setMenuOpen(false)
                  onSignOut()
                }}
              >
                <SignOutIcon size={13} />
                Sign out
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  )
}
