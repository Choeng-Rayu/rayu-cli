/**
 * The reasoning-effort control, in the composer toolbar.
 *
 * Extended thinking is always on for Rayucode, so this control now renders only the
 * effort dropdown. The acknowledged value is the one the shared engine reports back.
 *
 * ── HIDDEN WHEN THE MODEL DOES NOT SUPPORT IT ──────────────────────────────────
 *
 * Not disabled — hidden. A permanently-inert control is noise, and worse, it implies the
 * feature exists for this model when it does not. The capability comes from the engine's
 * own `ModelInfo` (`supportsEffort`, `supportedEffortLevels`), so the panel offers
 * exactly what the active model accepts.
 *
 * ── THE STATE SHOWN IS THE ACKNOWLEDGED ONE ────────────────────────────────────
 *
 * The control does not update optimistically. `settings` only changes after the engine
 * has applied the request, so the pill can never claim "High" while the engine is still
 * on the model default. The same rule the permission-mode pill follows.
 */
import { useEffect, useRef, useState } from 'react'

import {
  availableEffortOptions,
  effortLabel,
  type EffortChoice,
  type InferenceSettingsView,
} from '../../shared/inferenceSettings.js'
import { CheckIcon, ChevronIcon, EffortIcon } from './Icons.js'

export interface InferenceControlsProps {
  settings: InferenceSettingsView
  onSetEffort: (level: EffortChoice) => void
  /** Incremented when a typed `/effort` command asks the dropdown to open. */
  effortOpenRequest?: number
}

export function InferenceControls({
  settings,
  onSetEffort,
  effortOpenRequest,
}: InferenceControlsProps): JSX.Element | null {
  if (!settings.supportsEffort) return null

  return (
    <EffortDropdown
      settings={settings}
      onSetEffort={onSetEffort}
      openRequest={effortOpenRequest}
    />
  )
}

function EffortDropdown({
  settings,
  onSetEffort,
  openRequest,
}: {
  settings: InferenceSettingsView
  onSetEffort: (level: EffortChoice) => void
  openRequest?: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement | null>(null)
  const options = availableEffortOptions(settings)

  useEffect(() => {
    if (openRequest) setOpen(true)
  }, [openRequest])

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
                        <span className="rc-dropdown-current"><CheckIcon size={10} /> Active</span>
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

