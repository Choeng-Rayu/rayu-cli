/**
 * Multi-value array input for tool parameters.
 *
 * Renders one text field per item, with add/remove controls.  Used by the
 * tool input form when a parameter's JSON schema type is `"array"`.
 */
import React, { useState } from 'react'

export interface ArrayInputProps {
  value?: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function ArrayInput({
  value,
  onChange,
  placeholder = 'Add item…',
}: ArrayInputProps): JSX.Element {
  const [items, setItems] = useState<string[]>(value ?? [])

  function update(next: string[]): void {
    setItems(next)
    onChange(next)
  }

  function handleChange(index: number, text: string): void {
    const next = [...items]
    next[index] = text
    update(next)
  }

  function handleRemove(index: number): void {
    update(items.filter((_, i) => i !== index))
  }

  function handleAdd(): void {
    update([...items, ''])
  }

  return (
    <div className="rc-array-input">
      {items.map((item, index) => (
        <div key={index} className="rc-array-input-row">
          <input
            type="text"
            className="rc-array-input-field"
            value={item}
            placeholder={placeholder}
            onChange={e => handleChange(index, e.target.value)}
          />
          <button
            type="button"
            className="rc-array-input-remove"
            aria-label="Remove item"
            onClick={() => handleRemove(index)}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="rc-array-input-add"
        onClick={handleAdd}
      >
        + Add
      </button>
    </div>
  )
}
