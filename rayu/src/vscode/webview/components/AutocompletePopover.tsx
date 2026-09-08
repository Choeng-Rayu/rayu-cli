/**
 * The autocomplete popover for slash commands and @-file mentions.
 *
 * Rendered directly above the composer card, with ArrowUp/ArrowDown navigation
 * and Enter/Tab selection.
 */
import type { JSX } from 'react'

export interface AutocompleteItem {
  id: string
  label: string
  description?: string
  insertText: string
  kind: 'command' | 'file'
}

export interface AutocompletePopoverProps {
  items: AutocompleteItem[]
  selectedIndex: number
  onSelect: (item: AutocompleteItem) => void
  onHoverIndex: (index: number) => void
}

export function AutocompletePopover({
  items,
  selectedIndex,
  onSelect,
  onHoverIndex,
}: AutocompletePopoverProps): JSX.Element | null {
  if (items.length === 0) return null

  return (
    <ul className="rc-popover" role="listbox" aria-label="Suggestions">
      {items.map((item, index) => {
        const isSelected = index === selectedIndex
        return (
          <li
            key={item.id}
            role="option"
            aria-selected={isSelected}
            className={`rc-popover-item ${isSelected ? 'rc-popover-item-active' : ''}`}
            onMouseDown={event => {
              // Prevent textarea blur so cursor stays intact
              event.preventDefault()
              onSelect(item)
            }}
            onMouseEnter={() => onHoverIndex(index)}
          >
            <span className="rc-popover-icon" aria-hidden="true">
              {item.kind === 'command' ? '/' : '@'}
            </span>
            <span className="rc-popover-label">{item.label}</span>
            {item.description ? (
              <span className="rc-popover-desc">{item.description}</span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
