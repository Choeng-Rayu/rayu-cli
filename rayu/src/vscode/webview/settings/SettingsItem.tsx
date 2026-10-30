/**
 * One row of the Settings tab, laid out like VS Code's Settings editor: the label, a
 * description, then the control or value.
 */
import type { ReactNode } from 'react'

export interface SettingsItemProps {
  label: string
  description?: string
  /** A short tag after the label, e.g. "Shared with Rayu CLI". */
  badge?: string
  children: ReactNode
}

export function SettingsItem({ label, description, badge, children }: SettingsItemProps): JSX.Element {
  return (
    <div className="rs-item" role="group" aria-label={label}>
      <div className="rs-item-label">
        {label}
        {badge && <span className="rs-badge">{badge}</span>}
      </div>
      {description && <div className="rs-item-description">{description}</div>}
      <div className="rs-item-control">{children}</div>
    </div>
  )
}
