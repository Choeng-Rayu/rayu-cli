/**
 * The Rayucode webview's icons.
 *
 * Every glyph is a codicon — VS Code's own icon font, staged into media/ and linked by
 * `renderWebviewHtml` — so the panel uses the same icons, at the same weight, as the
 * editor around it, and they follow the theme's foreground colour like the editor's do.
 * The two Rayu marks (`RayuMark`, `ProgressGlyph`) stay sprites: they are the product's
 * character, not UI glyphs.
 *
 * Signatures are unchanged (`size`/`className`/`title`), so no call site needed an edit.
 */
import type { SpriteState } from '../spriteAtlas.js'
import { SpriteAvatar } from './SpriteAvatar.js'

export interface IconProps {
  size?: number
  className?: string
  title?: string
}

/**
 * One codicon. Decorative unless it has a `title`: it sits next to a label or inside a
 * button that has its own, so announcing the glyph too would be noise.
 */
export function Codicon({ name, size = 16, className, title }: IconProps & { name: string }): JSX.Element {
  return (
    <span
      className={`codicon codicon-${name}${className ? ` ${className}` : ''}`}
      style={{ fontSize: `${size}px` }}
      {...(title ? { role: 'img', 'aria-label': title, title } : { 'aria-hidden': true })}
    />
  )
}

/**
 * The Rayu identity mark.
 *
 * Was the 🐱 emoji, rendered as text. Now a static frame of the same sprite that
 * animates elsewhere in the panel (`SpriteAvatar`, `spriteAtlas.ts`) — the user's
 * own ask was that no cat/emoji glyph remain anywhere, including the pure-branding
 * spots that have no "current status" to represent (this header mark, the
 * background-task badge, the overflow-menu identity row, the sign-in and welcome
 * screens). `static` freezes on the idle row's first frame and never subscribes to
 * the shared animation clock: a toolbar logo has nothing to animate, and every one
 * of these call sites would otherwise pay for a timer subscription for no visible
 * benefit — exactly the same reasoning `SpriteAvatar` already applies to its own
 * `idle` state.
 *
 * `aria-hidden` by default: it appears next to the word "Rayu" or beside an assistant turn
 * that is already labelled, so announcing "Cat Logo" would be noise. Callers that use it as
 * the sole identifier pass a `title`.
 */
export function RayuMark({ size = 16, className, title }: IconProps): JSX.Element {
  return (
    <SpriteAvatar
      state="idle"
      static
      size={size}
      className={className}
      title={title}
    />
  )
}

export function SendIcon({ size = 14, ...props }: IconProps): JSX.Element {
  return <Codicon name="send" size={size} {...props} />
}

export function StopIcon({ size = 12, ...props }: IconProps): JSX.Element {
  return <Codicon name="debug-stop" size={size} {...props} />
}

export function PaperclipIcon({ size = 14, ...props }: IconProps): JSX.Element {
  return <Codicon name="attach" size={size} {...props} />
}

export function PlusIcon({ size = 14, ...props }: IconProps): JSX.Element {
  return <Codicon name="add" size={size} {...props} />
}

export function HistoryIcon({ size = 14, ...props }: IconProps): JSX.Element {
  return <Codicon name="history" size={size} {...props} />
}

export function ChevronIcon({ size = 10, direction = 'down', ...props }: IconProps & { direction?: 'down' | 'right' | 'left' }): JSX.Element {
  return <Codicon name={`chevron-${direction}`} size={size} {...props} />
}

export function SearchIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="search" size={size} {...props} />
}

/** Stacked lines. Used for "show detail" and for the background-work list. */
export function ListIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="list-flat" size={size} {...props} />
}

export function CopyIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="copy" size={size} {...props} />
}

export function CheckIcon({ size = 12, ...props }: IconProps): JSX.Element {
  return <Codicon name="check" size={size} {...props} />
}

/** An unset or not-installed marker, paired with `CheckIcon`. */
export function CircleIcon({ size = 12, ...props }: IconProps): JSX.Element {
  return <Codicon name="circle-large-outline" size={size} {...props} />
}

export function CloseIcon({ size = 12, ...props }: IconProps): JSX.Element {
  return <Codicon name="close" size={size} {...props} />
}

/** A failed result, paired with `CheckIcon`. */
export function ErrorIcon({ size = 12, ...props }: IconProps): JSX.Element {
  return <Codicon name="error" size={size} {...props} />
}

export function BackIcon({ size = 14, ...props }: IconProps): JSX.Element {
  return <Codicon name="chevron-left" size={size} {...props} />
}

export function EllipsisIcon({ size = 14, ...props }: IconProps): JSX.Element {
  return <Codicon name="ellipsis" size={size} {...props} />
}

export function PlugIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="plug" size={size} {...props} />
}

export function SignOutIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="sign-out" size={size} {...props} />
}

export function GearIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="gear" size={size} {...props} />
}

export function TerminalIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="terminal" size={size} {...props} />
}

export function ShieldIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="shield" size={size} {...props} />
}

export function FolderIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="folder" size={size} {...props} />
}

export function FileIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="file" size={size} {...props} />
}

export function SignInIcon({ size = 13, ...props }: IconProps): JSX.Element {
  return <Codicon name="sign-in" size={size} {...props} />
}

/** Reasoning effort. A lightning bolt: depth of thought, not speed. */
export function EffortIcon({ size = 11, ...props }: IconProps): JSX.Element {
  return <Codicon name="zap" size={size} {...props} />
}

/** The active model. */
export function ModelIcon({ size = 12, ...props }: IconProps): JSX.Element {
  return <Codicon name="sparkle" size={size} {...props} />
}

/** A task list. */
export function TaskListIcon({ size = 12, ...props }: IconProps): JSX.Element {
  return <Codicon name="checklist" size={size} {...props} />
}

/** An established connection — used for CLI attachment. */
export function LinkIcon({ size = 12, ...props }: IconProps): JSX.Element {
  return <Codicon name="link" size={size} {...props} />
}

/**
 * The shared "something is working" indicator — replaces the old braille pulse
 * spinner (`⠁⠇⠷⡿⣿`, via `useBrailleSpinner`) at every call site that used it
 * EXCEPT the thinking-block header (`ThinkingBlock.tsx` keeps the braille
 * spinner: reasoning is a distinct, narrower kind of "in progress" than the
 * turn-level activity this glyph now represents, and the user asked for that
 * one to stay as it was).
 *
 * Renders the animated sprite (`SpriteAvatar`, `spriteAtlas.ts`) at a fixed
 * 14px — the same small-icon size already used for `RayuMark` and
 * `.rc-todo-status` throughout this panel — instead of a character glyph, so
 * every "AI is doing something" indicator in the panel is the same animated
 * character rather than two unrelated visual languages for the same idea.
 *
 * `state` selects which row: defaults to `thinking` (the general "actively
 * working" row) for call sites that have no more specific phase to report.
 * Callers that DO know they are specifically blocked on the user pass
 * `state="waiting"` explicitly (`App.tsx`'s turn status, the background-task
 * waiting card) so the character visibly stops advancing and waits instead of
 * animating progress that cannot happen until the user answers — the same
 * distinction `TurnStatus` already drew with the old dashed-circle glyph.
 */
export function ProgressGlyph({
  className,
  state = 'thinking',
}: {
  className?: string
  state?: SpriteState
}): JSX.Element {
  return (
    <SpriteAvatar
      state={state}
      size={14}
      className={className ?? 'rc-progress-glyph'}
    />
  )
}
