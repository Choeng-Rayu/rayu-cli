/**
 * Sticky panel header with interactive controls for the most common actions.
 *
 * Renders: attach/detach toggle, current model name, thinking indicator,
 * permission-mode indicator, and a session status badge.
 *
 * ── DESIGN PHILOSOPHY ──────────────────────────────────────────────────────────
 *
 * Every button here is a shortcut for an action the user can also do by typing
 * a slash command.  The header exists to surface the most-used controls without
 * requiring the user to type.  All state shown here comes from `WebviewState`
 * (for local session) or from `RuntimeStateSnapshot` (for attached sessions).
 *
 * ── NO DIRECT IPC ──────────────────────────────────────────────────────────────
 *
 * The header sends `WebviewToHostMessage` events via the `onAction` prop.  The
 * parent (`App.tsx`) owns the `postMessage` calls so this component stays pure
 * React with no VS Code API surface.
 */
import React from 'react'
import type { AttachmentView, PermissionModeView } from '../../shared/webviewProtocol.js'

export type HeaderAction =
  | { type: 'attach' }
  | { type: 'detach' }
  | { type: 'cyclePermissionMode' }
  | { type: 'toggleThinking'; enabled: boolean }
  | { type: 'openModelPicker' }

export interface PanelHeaderProps {
  attachment: AttachmentView
  permissionMode: PermissionModeView | null
  thinkingEnabled: boolean
  currentlyThinking: boolean
  modelDisplayName: string
  sessionStatus: 'idle' | 'running' | 'waiting' | 'attached'
  onAction: (action: HeaderAction) => void
}

export function PanelHeader({
  attachment,
  permissionMode,
  thinkingEnabled,
  currentlyThinking,
  modelDisplayName,
  sessionStatus,
  onAction,
}: PanelHeaderProps): JSX.Element {
  const isAttached = attachment.attached !== null

  return (
    <header className="rc-panel-header">
      <AttachButton
        isAttached={isAttached}
        onAttach={() => onAction({ type: 'attach' })}
        onDetach={() => onAction({ type: 'detach' })}
      />

      <button
        type="button"
        className="rc-header-model"
        title={`Current model: ${modelDisplayName}. Click to change.`}
        onClick={() => onAction({ type: 'openModelPicker' })}
      >
        <span className="rc-header-model-name">{modelDisplayName || 'Default'}</span>
      </button>

      <ThinkingToggle
        enabled={thinkingEnabled}
        active={currentlyThinking}
        onToggle={enabled => onAction({ type: 'toggleThinking', enabled })}
      />

      <PermissionIndicator
        mode={permissionMode}
        onCycle={() => onAction({ type: 'cyclePermissionMode' })}
      />

      <StatusIndicator status={sessionStatus} />
    </header>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AttachButton({
  isAttached,
  onAttach,
  onDetach,
}: {
  isAttached: boolean
  onAttach: () => void
  onDetach: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`rc-header-attach${isAttached ? ' rc-header-attach--attached' : ''}`}
      title={isAttached ? 'Detach from CLI session' : 'Attach to a running CLI session'}
      onClick={isAttached ? onDetach : onAttach}
    >
      {isAttached ? '⊡ Attached' : '⊞ Attach'}
    </button>
  )
}

function ThinkingToggle({
  enabled,
  active,
  onToggle,
}: {
  enabled: boolean
  active: boolean
  onToggle: (next: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`rc-header-thinking${enabled ? ' rc-header-thinking--on' : ''}${active ? ' rc-header-thinking--active' : ''}`}
      title={enabled ? 'Extended thinking: ON. Click to disable.' : 'Extended thinking: OFF. Click to enable.'}
      onClick={() => onToggle(!enabled)}
      aria-pressed={enabled}
    >
      {active ? '💭' : '🧠'}
    </button>
  )
}

function PermissionIndicator({
  mode,
  onCycle,
}: {
  mode: PermissionModeView | null
  onCycle: () => void
}): JSX.Element {
  const label = mode?.label ?? 'Permissions'
  const modeId = mode?.id ?? ''
  const colorClass =
    modeId === 'acceptEdits' ||
    modeId === 'bypassPermissions' ||
    modeId === 'fullManage' ||
    modeId === 'orchestrator'
      ? 'allow'
      : modeId === 'plan'
        ? 'deny'
        : 'ask'

  return (
    <button
      type="button"
      className={`rc-header-perms rc-header-perms--${colorClass}`}
      title={`Permission mode: ${label}. Click to cycle.`}
      onClick={onCycle}
    >
      {label}
    </button>
  )
}

function StatusIndicator({
  status,
}: {
  status: PanelHeaderProps['sessionStatus']
}): JSX.Element {
  const labels: Record<PanelHeaderProps['sessionStatus'], string> = {
    idle: 'Ready',
    running: 'Working…',
    waiting: 'Waiting',
    attached: 'Attached',
  }
  return (
    <span
      className={`rc-header-status rc-header-status--${status}`}
      aria-label={`Session status: ${labels[status]}`}
    >
      {labels[status]}
    </span>
  )
}
