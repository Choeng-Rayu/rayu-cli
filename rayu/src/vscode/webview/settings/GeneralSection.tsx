/**
 * Settings → General: Rayu's own settings, edited in place.
 *
 * Every row is described by the host (label, type, where it is saved, when it applies),
 * so this component only renders and reports changes; the host validates and saves.
 */
import { useEffect, useState } from 'react'

import type { GeneralSettingView, GeneralSettingsView } from '../../shared/settingsProtocol.js'
import { SettingsItem } from './SettingsItem.js'

export interface GeneralSectionProps {
  general: GeneralSettingsView
  onChange: (key: string, value: boolean | string) => void
  onRetry: () => void
}

export function effectLabel(row: GeneralSettingView): string {
  const where = row.scope === 'workspace' ? 'This workspace. ' : ''
  return `${where}${row.effect === 'live' ? 'Applies right away.' : 'Applies to new conversations.'}`
}

export function GeneralSection({ general, onChange, onRetry }: GeneralSectionProps): JSX.Element {
  if (general.status === 'idle' || (general.status === 'loading' && general.items.length === 0)) {
    return <p className="rs-loading" role="status">Loading settings…</p>
  }
  return (
    <>
      {general.error && (
        <div className="rs-error" role="alert">
          <span>{general.error}</span>
          {general.status === 'error' && (
            <button type="button" className="rs-button rs-button-secondary" onClick={onRetry}>Retry</button>
          )}
        </div>
      )}
      {general.items.map(row => (
        <SettingsItem
          key={row.key}
          label={row.label}
          description={row.type === 'boolean' ? undefined : row.description}
          badge={row.shared ? 'Shared with Rayu CLI' : undefined}
        >
          <SettingControl row={row} saving={general.saving === row.key} onChange={onChange} />
          <span className="rs-item-note">
            {row.disabledReason ?? (general.saving === row.key ? 'Saving…' : effectLabel(row))}
          </span>
        </SettingsItem>
      ))}
    </>
  )
}

interface ControlProps {
  row: GeneralSettingView
  saving: boolean
  onChange: (key: string, value: boolean | string) => void
}

function SettingControl({ row, saving, onChange }: ControlProps): JSX.Element {
  const disabled = saving || row.disabledReason !== undefined
  switch (row.type) {
    case 'boolean':
      return (
        <label className="rs-checkbox">
          <input
            type="checkbox"
            checked={row.value === true}
            disabled={disabled}
            onChange={event => onChange(row.key, event.currentTarget.checked)}
          />
          <span>{row.description}</span>
        </label>
      )
    case 'choice':
      return (
        <select
          className="rs-select"
          aria-label={row.label}
          value={String(row.value)}
          disabled={disabled}
          onChange={event => onChange(row.key, event.currentTarget.value)}
        >
          {(row.choices ?? []).map(choice => (
            <option key={choice.value} value={choice.value} title={choice.description}>
              {choice.label}
            </option>
          ))}
        </select>
      )
    case 'text':
      return <TextControl row={row} disabled={disabled} onChange={onChange} />
  }
}

/** A text field that saves on Enter or when it loses focus, and reverts on Escape. */
function TextControl({ row, disabled, onChange }: { row: GeneralSettingView; disabled: boolean; onChange: ControlProps['onChange'] }): JSX.Element {
  const saved = String(row.value)
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  const commit = (): void => {
    if (draft.trim() !== saved) onChange(row.key, draft)
  }
  return (
    <input
      type="text"
      className="rs-input"
      aria-label={row.label}
      value={draft}
      placeholder={row.placeholder}
      maxLength={row.maxLength}
      disabled={disabled}
      onChange={event => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setDraft(saved)
      }}
    />
  )
}
