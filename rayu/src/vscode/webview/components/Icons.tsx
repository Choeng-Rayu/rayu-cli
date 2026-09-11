/**
 * Consolidated 16px currentColor SVG icons for the Rayucode webview.
 *
 * All icons render at standard 16x16 with viewBox="0 0 16 16" and fill="currentColor"
 * so they adapt cleanly to any VS Code theme.
 */

export interface IconProps {
  size?: number
  className?: string
  title?: string
}

/**
 * The Rayu identity mark.
 *
 * A brand asset rather than an icon: it is the one glyph in here that is not `currentColor`
 * geometry, and it must not be restyled to match the icon set. It lives in this module
 * anyway because it was previously its own file exporting a component ALSO called
 * `SparkleIcon`, which collided with the generic icon of that name — two different marks,
 * one identifier, imported from two places.
 *
 * `aria-hidden` by default: it appears next to the word "Rayu" or beside an assistant turn
 * that is already labelled, so announcing "Cat Logo" would be noise. Callers that use it as
 * the sole identifier pass a `title`.
 */
export function RayuMark({ size = 16, className, title }: IconProps): JSX.Element {
  return (
    <span
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{
        fontSize: `${size}px`,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      🐱
    </span>
  )
}

export function SendIcon({ size = 14, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M8 2.25l4.75 4.75h-3.5v6.5h-2.5v-6.5h-3.5L8 2.25z" />
    </svg>
  )
}

export function StopIcon({ size = 12, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  )
}

export function PaperclipIcon({ size = 14, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M4.317 7.436L8.56 3.193a2.35 2.35 0 0 1 3.325 3.325l-5.657 5.657a1.2 1.2 0 0 1-1.697-1.697l4.95-4.95a.45.45 0 1 1 .636.636l-4.95 4.95a.3.3 0 0 0 .425.425l5.657-5.657a1.45 1.45 0 0 0-2.053-2.053L4.953 8.072a2.6 2.6 0 0 0 3.676 3.676l4.243-4.243a.45.45 0 1 1 .636.636l-4.243 4.243A3.5 3.5 0 1 1 4.317 7.436z" />
    </svg>
  )
}

export function PlusIcon({ size = 14, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z" />
    </svg>
  )
}

export function HistoryIcon({ size = 14, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5.75.75 0 0 0-1.5 0 5 5 0 1 1-5-5c1.43 0 2.71.6 3.61 1.56L9.75 6.4a.75.75 0 0 0 .53 1.28h3.97a.75.75 0 0 0 .75-.75V2.96a.75.75 0 0 0-1.28-.53l-1.63 1.63A6.47 6.47 0 0 0 8 1.5zM8 4.5a.75.75 0 0 0-.75.75v3c0 .2.08.39.22.53l2 2a.75.75 0 0 0 1.06-1.06L8.75 7.94V5.25A.75.75 0 0 0 8 4.5z" />
    </svg>
  )
}

export function ChevronIcon({ size = 10, className, direction = 'down' }: IconProps & { direction?: 'down' | 'right' | 'left' }): JSX.Element {
  const transform = direction === 'right' ? 'rotate(-90 8 8)' : direction === 'left' ? 'rotate(90 8 8)' : undefined
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} transform={transform} role="presentation">
      <path d="M3.22 5.47a.75.75 0 0 1 1.06 0L8 9.19l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 6.53a.75.75 0 0 1 0-1.06z" />
    </svg>
  )
}

export function SearchIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 0-1.06 1.06l3.66 3.66a.75.75 0 1 0 1.06-1.06l-3.66-3.66z" />
    </svg>
  )
}

/** A stacked-lines mark. Used for "show detail" and for the background-work list. */
export function ListIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M2 3.75A.75.75 0 0 1 2.75 3h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 3.75zm0 4A.75.75 0 0 1 2.75 7h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 7.75zm.75 3.25a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5z" />
    </svg>
  )
}

export function CopyIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M4 2a2 2 0 0 0-2 2v7a1 1 0 0 0 2 0V4a1 1 0 0 1 1-1h7a1 1 0 0 0 0-2H4zm3 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H7zm0 1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" />
    </svg>
  )
}

export function CheckIcon({ size = 12, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
    </svg>
  )
}

export function CloseIcon({ size = 12, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z" />
    </svg>
  )
}

export function BackIcon({ size = 14, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M9.78 3.22a.75.75 0 0 1 0 1.06L6.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0z" />
    </svg>
  )
}

export function EllipsisIcon({ size = 14, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M3 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
    </svg>
  )
}

export function PlugIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M6 1v3H5V1h1zm5 0v3h-1V1h1zm0 4H5a3 3 0 0 0-1 5.83V14h1v-3.17a3.001 3.001 0 0 0 2-2.83h2a3.001 3.001 0 0 0 2 2.83V14h1v-3.17A3 3 0 0 0 11 5z" />
    </svg>
  )
}

export function SignOutIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M11.5 3.5l3 3.5-3 3.5V8H6V6h5.5V3.5zM2 2h7v1H3v10h6v1H2V2z" />
    </svg>
  )
}

export function GearIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M9.1 1.066a1 1 0 0 0-.2-.066h-1.8a1 1 0 0 0-.2.066l-.3 1.3a5.55 5.55 0 0 0-1.3.75l-1.25-.5a1 1 0 0 0-1.15.35l-.9 1.55a1 1 0 0 0 .25 1.2l1.05.85a5.7 5.7 0 0 0 0 1.5l-1.05.85a1 1 0 0 0-.25 1.2l.9 1.55a1 1 0 0 0 1.15.35l1.25-.5c.4.3.85.55 1.3.75l.3 1.3a1 1 0 0 0 1 .8h1.8a1 1 0 0 0 1-.8l.3-1.3c.45-.2.9-.45 1.3-.75l1.25.5a1 1 0 0 0 1.15-.35l.9-1.55a1 1 0 0 0-.25-1.2l-1.05-.85a5.7 5.7 0 0 0 0-1.5l1.05-.85a1 1 0 0 0 .25-1.2l-.9-1.55a1 1 0 0 0-1.15-.35l-1.25.5a5.55 5.55 0 0 0-1.3-.75l-.3-1.3zM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z" />
    </svg>
  )
}

export function TerminalIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3zm3.354 2.146a.5.5 0 0 0-.708.708L5.793 8l-2.147 2.146a.5.5 0 0 0 .708.708l2.5-2.5a.5.5 0 0 0 0-.708l-2.5-2.5zM8.5 10.5a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1h-4z" />
    </svg>
  )
}

export function ShieldIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M8 1l5 2v4.5c0 3.8-2.6 6.8-5 7.5-2.4-.7-5-3.7-5-7.5V3l5-2zm0 1.2L4 3.8v3.7c0 3.1 2 5.6 4 6.2 2-.6 4-3.1 4-6.2V3.8L8 2.2z" />
    </svg>
  )
}

export function FolderIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M1.75 2.5A.75.75 0 0 0 1 3.25v9.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75v-7.5a.75.75 0 0 0-.75-.75H7.414L5.707 2.793A.75.75 0 0 0 5.177 2.5H1.75z" />
    </svg>
  )
}

export function FileIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M3.75 1.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75V5.5L9.25 1.5H3.75zm5 1.5v3h3L8.75 3z" />
    </svg>
  )
}

export function SignInIcon({ size = 13, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M8 1a5 5 0 0 0-5 5v1h1V6a4 4 0 1 1 8 0v1h1V6a5 5 0 0 0-5-5zM5.5 9a2.5 2.5 0 0 0-2.5 2.5V13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1.5A2.5 2.5 0 0 0 10.5 9h-5z" />
    </svg>
  )
}

/** Reasoning effort. A lightning bolt: depth of thought, not speed. */
export function EffortIcon({ size = 11, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M7.5 1v5.5H3.75L9 15V9.5h3.75L7.5 1z" />
    </svg>
  )
}

/** The active model. A denser sparkle than the Rayu identity mark, to stay distinct from it. */
export function ModelIcon({ size = 12, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M8 0a.75.75 0 0 1 .71.51l1.45 4.34a.75.75 0 0 0 .49.49l4.34 1.45a.75.75 0 0 1 0 1.42l-4.34 1.45a.75.75 0 0 0-.49.49l-1.45 4.34a.75.75 0 0 1-1.42 0l-1.45-4.34a.75.75 0 0 0-.49-.49L.51 8.21a.75.75 0 0 1 0-1.42l4.34-1.45a.75.75 0 0 0 .49-.49L6.79.51A.75.75 0 0 1 7.5 0h.5z" />
    </svg>
  )
}

/** A task list. */
export function TaskListIcon({ size = 12, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M2 3.5a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm0 4.5a1 1 0 1 1 2 0 1 1 0 0 1-2 0zm0 4.5a1 1 0 1 1 2 0 1 1 0 0 1-2 0zM6 3h8v1H6V3zm0 4.5h8v1H6v-1zM6 12h8v1H6v-1z" />
    </svg>
  )
}

/** An established connection — used for CLI attachment. */
export function LinkIcon({ size = 12, className, title }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className={className} role="presentation">
      {title ? <title>{title}</title> : null}
      <path d="M6.5 4h-2a3.5 3.5 0 0 0 0 7h2v-1h-2a2.5 2.5 0 0 1 0-5h2V4zm3 0h2a3.5 3.5 0 0 1 0 7h-2v-1h2a2.5 2.5 0 0 0 0-5h-2V4zM5 7h6v1H5V7z" />
    </svg>
  )
}

