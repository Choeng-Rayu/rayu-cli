/**
 * The selectable permission mode dropdown, anchored in the composer toolbar.
 *
 * ── WHY SELECTABLE, NOT JUST CYCLING ───────────────────────────────────────────
 *
 * Previously the pill only advanced to the next mode on click. That hid the modes
 * from the user, made switching from "Ask" to "Plan" require 3 clicks, and prevented
 * users from seeing what each mode actually permits before choosing it.
 *
 * This dropdown lets the user click to inspect all 4 modes with their descriptions,
 * choose one directly with mouse or keyboard, while retaining Shift+Tab in the composer
 * as a fast-path cycle shortcut.
 */
import { useEffect, useRef, useState } from 'react'

import {
  PERMISSION_MODES,
  type PermissionModeView,
} from '../../shared/permissionModes.js'

export interface PermissionDropdownProps {
  mode: PermissionModeView
  onSelect: (modeId: string) => void
  onCycle?: () => void
}

export function PermissionDropdown({
  mode,
  onSelect,
}: PermissionDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const container = useRef<HTMLDivElement | null>(null)

  // Sync highlight index with current mode when opened
  useEffect(() => {
    if (open) {
      const idx = PERMISSION_MODES.findIndex(m => m.id === mode.id)
      setHighlight(idx >= 0 ? idx : 0)
    }
  }, [open, mode.id])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function onDocument(event: MouseEvent): void {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocument)
    return () => document.removeEventListener('mousedown', onDocument)
  }, [open])

  function choose(modeId: string): void {
    setOpen(false)
    onSelect(modeId)
  }

  function onButtonKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setOpen(true)
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setHighlight(h => (h + 1) % PERMISSION_MODES.length)
        return
      case 'ArrowUp':
        event.preventDefault()
        setHighlight(h => (h - 1 + PERMISSION_MODES.length) % PERMISSION_MODES.length)
        return
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const target = PERMISSION_MODES[highlight]
        if (target) choose(target.id)
        return
      }
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return
      default:
        return
    }
  }

  return (
    <div className="rc-dropdown rc-permission-dropdown" ref={container}>
      <button
        type="button"
        className={`rc-pill rc-pill-button rc-pill-permission rc-pill-mode-${mode.id}${open ? ' rc-pill-active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onButtonKeyDown}
        title={`${mode.description}  (Shift+Tab to cycle)`}
        aria-label={`Permission mode: ${mode.label}. Shift+Tab to change.`}
      >
        <span className={`rc-mode-dot rc-mode-dot-${mode.id}`} aria-hidden="true" />
        <PermissionIcon mode={mode.id} />
        <span className="rc-pill-label">{mode.label}</span>
        <ChevronIcon />
      </button>

      {open ? (
        <div
          className="rc-dropdown-panel rc-permission-panel"
          role="dialog"
          aria-label="Select permission mode"
        >
          <div className="rc-dropdown-header">
            <span className="rc-dropdown-title">Permission Mode</span>
            <span className="rc-dropdown-subtitle">Control tool execution approval</span>
          </div>

          <ul className="rc-dropdown-list" role="listbox">
            {PERMISSION_MODES.map((option, index) => {
              const isCurrent = option.id === mode.id
              const isHighlighted = index === highlight
              return (
                <li key={option.id} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    className={`rc-dropdown-item rc-permission-item${
                      isHighlighted ? ' rc-dropdown-item-active' : ''
                    }${isCurrent ? ' rc-permission-item-selected' : ''}`}
                    onMouseEnter={() => setHighlight(index)}
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      choose(option.id)
                    }}
                  >
                    <div className="rc-dropdown-item-header">
                      <div className="rc-mode-item-title">
                        <span
                          className={`rc-mode-dot rc-mode-dot-${option.id}`}
                          aria-hidden="true"
                        />
                        <PermissionIcon mode={option.id} />
                        <span className="rc-dropdown-label">{option.label}</span>
                      </div>
                      {isCurrent ? (
                        <span className="rc-dropdown-current">✓ Active</span>
                      ) : null}
                    </div>
                    <div className="rc-dropdown-detail">
                      <span className="rc-mode-item-desc">{option.description}</span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="rc-dropdown-footer">
            <span className="rc-dropdown-hint">Tip: Shift+Tab cycles modes while typing</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function PermissionIcon({ mode }: { mode: string }): JSX.Element {
  switch (mode) {
    case 'plan':
      return (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="currentColor"
          role="presentation"
          className="rc-permission-icon"
        >
          <path d="M8 1a7 7 0 1 0 7 7A7 7 0 0 0 8 1zm0 1.5a5.5 5.5 0 1 1-5.5 5.5A5.5 5.5 0 0 1 8 2.5zm2.8 3.7l-4.5 1.5-1.5 4.5 4.5-1.5 1.5-4.5zM8 7.2a.8.8 0 1 1-.8.8.8.8 0 0 1 .8-.8z" />
        </svg>
      )
    case 'acceptEdits':
      return (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="currentColor"
          role="presentation"
          className="rc-permission-icon"
        >
          <path d="M8.5 1.5L2 9.5h5L6 14.5l7.5-8.5H8.5l1.5-4.5z" />
        </svg>
      )
    case 'bypassPermissions':
      return (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="currentColor"
          role="presentation"
          className="rc-permission-icon"
        >
          <path d="M8 1.5l5 2v4c0 3-2.1 5.6-5 6.9-2.9-1.3-5-3.9-5-6.9v-4l5-2zm0 1.6L4.5 4.5v3c0 2.2 1.5 4.1 3.5 5.1 2-1 3.5-2.9 3.5-5.1v-3L8 3.1z" />
        </svg>
      )
    default:
      return (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="currentColor"
          role="presentation"
          className="rc-permission-icon"
        >
          <path d="M8 1.5l5 2v4c0 3-2.1 5.6-5 6.9-2.9-1.3-5-3.9-5-6.9v-4l5-2z" />
        </svg>
      )
  }
}

function ChevronIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="9"
      height="9"
      fill="currentColor"
      role="presentation"
      className="rc-chevron-icon"
    >
      <path d="M4 6l4 4 4-4H4z" />
    </svg>
  )
}
