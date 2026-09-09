/**
 * The searchable model dropdown, anchored inside the composer.
 *
 * Replaces a `vscode.window.showQuickPick` in the host. The QuickPick is a good control
 * in general, but it is the WRONG control here for two reasons the plan calls out:
 * it is unavailable until the engine has reported a catalogue, and it takes focus away
 * from the composer — so choosing a model mid-thought interrupted what the user was
 * typing.
 *
 * ── SELECTING A MODEL CHANGES CONFIGURATION, NEVER TEXT ────────────────────────
 *
 * This is the one invariant worth stating out loud. The dropdown lives inside the
 * composer, next to a text field, and shares its keyboard. It must never insert the
 * model name into the prompt: it posts `selectModelValue` and nothing else.
 *
 * ── THE DRAFT SURVIVES ─────────────────────────────────────────────────────────
 *
 * All dropdown state — open, query, highlighted index — is local to this component, so
 * opening it, searching, and choosing cannot touch the composer's `value`. The parent
 * never remounts on selection, which is why the draft is preserved rather than
 * "restored".
 *
 * ── THREE EMPTY STATES, NOT ONE ────────────────────────────────────────────────
 *
 * Loading, failed, and genuinely-empty are distinct. Collapsing them into one blank
 * list makes a broken provider indistinguishable from an unconfigured one, and hides
 * the fact that a retry would help.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import type { ModelCatalogueView } from '../../shared/webviewProtocol.js'

export interface ModelDropdownProps {
  /** The active model identifier, or null before one is known. */
  current: string | null
  catalogue: ModelCatalogueView
  onSelect: (value: string) => void
  onRefresh: () => void
}

export function ModelDropdown({
  current,
  catalogue,
  onSelect,
  onRefresh,
}: ModelDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const container = useRef<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return catalogue.options
    // Matches label, value and description so a provider-qualified id like
    // "openai · gpt-4o" is findable by provider as well as by model.
    return catalogue.options.filter(
      o =>
        (o.label && o.label.toLowerCase().includes(q)) ||
        (o.value && o.value.toLowerCase().includes(q)) ||
        Boolean(o.description && o.description.toLowerCase().includes(q)),
    )
  }, [catalogue.options, query])

  // Keep the highlight inside the filtered list. Without this, narrowing the query
  // leaves it pointing past the end and Enter selects nothing.
  useEffect(() => {
    setHighlight(h => (h >= filtered.length ? 0 : h))
  }, [filtered.length])

  useEffect(() => {
    if (open) search.current?.focus()
    else setQuery('')
  }, [open])

  // Close on an outside click. Registered only while open so the panel does not carry
  // a document-level listener for a control nobody is using.
  useEffect(() => {
    if (!open) return
    function onDocument(event: MouseEvent): void {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocument)
    return () => document.removeEventListener('mousedown', onDocument)
  }, [open])

  function choose(value: string): void {
    setOpen(false)
    // Configuration only. Deliberately does not touch the composer's text.
    onSelect(value)
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setHighlight(h => (filtered.length === 0 ? 0 : (h + 1) % filtered.length))
        return
      case 'ArrowUp':
        event.preventDefault()
        setHighlight(h =>
          filtered.length === 0 ? 0 : (h - 1 + filtered.length) % filtered.length,
        )
        return
      case 'Enter': {
        event.preventDefault()
        const picked = filtered[highlight]
        if (picked) choose(picked.value)
        return
      }
      case 'Escape':
        event.preventDefault()
        // Stops here rather than bubbling: Escape in the composer means something
        // else, and closing the dropdown is the more specific intent.
        event.stopPropagation()
        setOpen(false)
        return
      default:
        return
    }
  }

  return (
    <div className="rc-dropdown rc-model-dropdown" ref={container}>
      <button
        type="button"
        className={`rc-pill rc-pill-button rc-pill-model${open ? ' rc-pill-active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { if (!open) onRefresh(); setOpen(o => !o) }}
        title="Change model"
      >
        <ModelSparkleIcon />
        <span className="rc-pill-label">{current ?? 'Default model'}</span>
        <ChevronIcon />
      </button>

      {open ? (
        <div className="rc-dropdown-panel rc-model-panel" role="dialog" aria-label="Select a model">
          <div className="rc-dropdown-header">
            <span className="rc-dropdown-title">Model</span>
            <span className="rc-dropdown-subtitle">Select language model for responses</span>
          </div>
          <div className="rc-dropdown-search-wrap">
            <SearchIcon />
            <input
              ref={search}
              className="rc-dropdown-search"
              type="text"
              value={query}
              placeholder="Search models…"
              aria-label="Search models"
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>

          {catalogue.loading && catalogue.options.length === 0 ? (
            <p className="rc-dropdown-empty">Loading models…</p>
          ) : catalogue.error ? (
            <div className="rc-dropdown-empty">
              <p className="rc-dropdown-error">{catalogue.error}</p>
              <button type="button" className="rc-button" onClick={onRefresh}>
                Try again
              </button>
            </div>
          ) : catalogue.options.length === 0 ? (
            <p className="rc-dropdown-empty">
              No models configured yet. Connect a provider to choose one.
            </p>
          ) : filtered.length === 0 ? (
            <p className="rc-dropdown-empty">No model matches “{query}”.</p>
          ) : (
            <ul className="rc-dropdown-list" role="listbox">
              {filtered.map((option, index) => {
                const isCurrent = option.value === current || option.model === current
                return (
                  <li key={option.value} role="none">
                    <button
                      type="button"
                      role="option"
                      aria-selected={isCurrent}
                      className={`rc-dropdown-item${
                        index === highlight ? ' rc-dropdown-item-active' : ''
                      }`}
                      // Hover moves the highlight so mouse and keyboard agree about
                      // which row Enter would take.
                      onMouseEnter={() => setHighlight(index)}
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        choose(option.value)
                      }}
                    >
                      <div className="rc-dropdown-item-header">
                        <span className="rc-dropdown-label">{option.label}</span>
                        {isCurrent ? (
                          <span className="rc-dropdown-current">✓ Active</span>
                        ) : null}
                      </div>
                      {option.description ? (
                        <div className="rc-dropdown-detail">
                          <span className="rc-model-desc">{option.description}</span>
                          {option.contextWindow ? (
                            <span className="rc-model-tag"> · {option.contextWindow.toLocaleString()} tokens</span>
                          ) : null}
                          {option.supportsImage !== undefined ? (
                            <span className="rc-model-tag"> · Images: {option.supportsImage ? 'yes' : 'no'}</span>
                          ) : null}
                          {option.supportsThinking !== undefined ? (
                            <span className="rc-model-tag"> · Thinking: {option.supportsThinking ? 'yes' : 'no'}</span>
                          ) : null}
                          {option.supportsTools !== undefined ? (
                            <span className="rc-model-tag"> · Tools: {option.supportsTools ? 'yes' : 'no'}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ModelSparkleIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" role="presentation" className="rc-model-icon">
      <path d="M8 0a.75.75 0 0 1 .71.51l1.45 4.34a.75.75 0 0 0 .49.49l4.34 1.45a.75.75 0 0 1 0 1.42l-4.34 1.45a.75.75 0 0 0-.49.49l-1.45 4.34a.75.75 0 0 1-1.42 0l-1.45-4.34a.75.75 0 0 0-.49-.49L.51 8.21a.75.75 0 0 1 0-1.42l4.34-1.45a.75.75 0 0 0 .49-.49L6.79.51A.75.75 0 0 1 7.5 0h.5z" />
    </svg>
  )
}

function SearchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" role="presentation" className="rc-search-icon">
      <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" />
    </svg>
  )
}

function ChevronIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor" role="presentation">
      <path d="M4 6l4 4 4-4H4z" />
    </svg>
  )
}
