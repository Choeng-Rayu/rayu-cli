/**
 * Thinking and effort controls, in the composer toolbar.
 *
 * ── BOTH ARE HIDDEN WHEN THE MODEL DOES NOT SUPPORT THEM ───────────────────────
 *
 * Not disabled — hidden. A permanently-inert control is noise, and worse, it implies the
 * feature exists for this model when it does not. The capability comes from the engine's
 * own `ModelInfo` (`supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`),
 * so the panel offers exactly what the active model accepts.
 *
 * ── THE STATE SHOWN IS THE ACKNOWLEDGED ONE ────────────────────────────────────
 *
 * Neither control updates optimistically. `settings` only changes after the engine has
 * applied the request, so the pill can never claim "High" while the engine is still on
 * the model default. The same rule the permission-mode pill follows.
 */
import { useEffect, useRef, useState } from 'react'


import {
  availableEffortOptions,
  effortLabel,
  type EffortChoice,
  type InferenceSettingsView,
} from '../../shared/inferenceSettings.js'

export interface InferenceControlsProps {
  settings: InferenceSettingsView
  onSetEffort: (level: EffortChoice) => void
}

export function InferenceControls({
  settings,
  onSetEffort,
}: InferenceControlsProps): JSX.Element | null {
  if (!settings.supportsEffort) return null

  return <EffortDropdown settings={settings} onSetEffort={onSetEffort} />
}

function EffortDropdown({
  settings,
  onSetEffort,
}: {
  settings: InferenceSettingsView
  onSetEffort: (level: EffortChoice) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement | null>(null)
  const options = availableEffortOptions(settings)

  useEffect(() => {
    if (!open) return
    function onDocument(event: MouseEvent): void {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocument)
    return () => document.removeEventListener('mousedown', onDocument)
  }, [open])

  return (
    <div className="rc-dropdown rc-effort-dropdown" ref={container}>
      <button
        type="button"
        className={`rc-pill rc-pill-button rc-pill-effort${open ? ' rc-pill-active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          settings.effortEnvOverride
            ? `CLAUDE_CODE_EFFORT_LEVEL=${settings.effortEnvOverride} is controlling effort this session`
            : 'Reasoning effort. Applies to your next message.'
        }
        onClick={() => setOpen(o => !o)}
      >
        <EffortIcon />
        <span className="rc-pill-label">Effort: {effortLabel(settings.effort)}</span>
        {/* An environment override outranks anything chosen here, so it is marked
            rather than left to look like a control that does nothing. */}
        {settings.effortEnvOverride ? <span className="rc-pill-pinned">·env</span> : null}
        <ChevronIcon />
      </button>

      {open ? (
        <div className="rc-dropdown-panel rc-effort-panel" role="dialog" aria-label="Reasoning effort">
          <div className="rc-dropdown-header">
            <span className="rc-dropdown-title">Reasoning Effort</span>
            <span className="rc-dropdown-subtitle">Control model thinking depth</span>
          </div>

          {settings.effortEnvOverride ? (
            <p className="rc-dropdown-empty">
              <code>CLAUDE_CODE_EFFORT_LEVEL={settings.effortEnvOverride}</code> is
              pinning effort for this session. Choosing here saves the setting but will
              not take effect until that variable is cleared.
            </p>
          ) : null}

          <ul className="rc-dropdown-list" role="listbox">
            {options.map(option => {
              const isCurrent = option.value === settings.effort
              return (
                <li key={option.label} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    className={`rc-dropdown-item${isCurrent ? ' rc-dropdown-item-active' : ''}`}
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      setOpen(false)
                      onSetEffort(option.value)
                    }}
                  >
                    <div className="rc-dropdown-item-header">
                      <span className="rc-dropdown-label">{option.label}</span>
                      {isCurrent ? (
                        <span className="rc-dropdown-current">✓ Active</span>
                      ) : null}
                    </div>
                    <span className="rc-dropdown-detail">{option.description}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function EffortIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="currentColor"
      role="presentation"
      className="rc-effort-icon"
    >
      <path d="M7.5 1v5.5H3.75L9 15V9.5h3.75L7.5 1z" />
    </svg>
  )
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

