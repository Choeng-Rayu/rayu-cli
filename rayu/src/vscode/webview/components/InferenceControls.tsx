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
  onSetThinking: (enabled: boolean) => void
}

export function InferenceControls({
  settings,
  onSetEffort,
  onSetThinking,
}: InferenceControlsProps): JSX.Element | null {
  if (!settings.supportsEffort && !settings.supportsThinking) return null

  return (
    <>
      {settings.supportsThinking ? (
        <button
          type="button"
          className={`rc-pill rc-pill-button${
            settings.thinkingEnabled ? ' rc-pill-on' : ''
          }`}
          aria-pressed={settings.thinkingEnabled}
          title={
            settings.thinkingEnabled
              ? 'Extended thinking is on. Applies to your next message.'
              : 'Extended thinking is off. Applies to your next message.'
          }
          onClick={() => onSetThinking(!settings.thinkingEnabled)}
        >
          <BrainIcon />
          Thinking
        </button>
      ) : null}

      {settings.supportsEffort ? (
        <EffortDropdown settings={settings} onSetEffort={onSetEffort} />
      ) : null}
    </>
  )
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
    <div className="rc-dropdown" ref={container}>
      <button
        type="button"
        className="rc-pill rc-pill-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          settings.effortEnvOverride
            ? `CLAUDE_CODE_EFFORT_LEVEL=${settings.effortEnvOverride} is controlling effort this session`
            : 'Reasoning effort. Applies to your next message.'
        }
        onClick={() => setOpen(o => !o)}
      >
        Effort: {effortLabel(settings.effort)}
        {/* An environment override outranks anything chosen here, so it is marked
            rather than left to look like a control that does nothing. */}
        {settings.effortEnvOverride ? <span className="rc-pill-pinned">·env</span> : null}
      </button>

      {open ? (
        <div className="rc-dropdown-panel" role="dialog" aria-label="Reasoning effort">
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
                    onClick={() => {
                      setOpen(false)
                      onSetEffort(option.value)
                    }}
                  >
                    <span className="rc-dropdown-label">
                      {option.label}
                      {isCurrent ? (
                        <span className="rc-dropdown-current"> · current</span>
                      ) : null}
                    </span>
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

function BrainIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" role="presentation">
      <path d="M6 2a2.5 2.5 0 0 0-2.5 2.5v.6A2 2 0 0 0 2 7a2 2 0 0 0 1 1.73v.52A2.25 2.25 0 0 0 5.25 11.5H6V2zm4 0v9.5h.75A2.25 2.25 0 0 0 13 9.25v-.52A2 2 0 0 0 14 7a2 2 0 0 0-1.5-1.9v-.6A2.5 2.5 0 0 0 10 2zM6 12.5v.25a1.25 1.25 0 1 0 2.5 0v-.25H6zm4 0v.25a1.25 1.25 0 1 0-2.5 0v-.25H10z" />
    </svg>
  )
}
