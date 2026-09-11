/**
 * The autocomplete popover for slash commands and @-file mentions.
 *
 * Rendered directly above the composer card, with ArrowUp/ArrowDown navigation
 * and Enter/Tab selection.
 */
import type { JSX } from 'react'

import { FileIcon, FolderIcon } from './Icons.js'

export interface AutocompleteItem {
  id: string
  label: string
  description?: string
  insertText: string
  /**
   * `folder` is distinguished from `file` because the two are otherwise indistinguishable
   * strings — an extensionless file and a directory look identical — and they behave
   * differently when the engine expands the mention: a directory is walked.
   */
  kind: 'command' | 'file' | 'folder'
}

export interface AutocompletePopoverProps {
  items: AutocompleteItem[]
  selectedIndex: number
  onSelect: (item: AutocompleteItem) => void
  onHoverIndex: (index: number) => void
}

function ItemIcon({ kind }: { kind: AutocompleteItem['kind'] }): JSX.Element {
  switch (kind) {
    case 'command':
      return <span className="rc-popover-glyph">/</span>
    case 'folder':
      return <FolderIcon size={12} />
    case 'file':
      return <FileIcon size={12} />
  }
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
              <ItemIcon kind={item.kind} />
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
