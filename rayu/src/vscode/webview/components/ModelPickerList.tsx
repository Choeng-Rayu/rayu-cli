/**
 * The searchable model list. One implementation, two hosts.
 *
 * Extracted from `ModelDropdown` when the `/model_subagent` and `/webfetch_model` commands
 * needed the same list in a different container. Copying it would have meant two search
 * predicates, two sets of keyboard bindings and two definitions of what "no models" looks
 * like — and the three empty states below are exactly the kind of detail that gets
 * simplified away in a copy and then diverges.
 *
 * ── THREE EMPTY STATES, NOT ONE ────────────────────────────────────────────────
 *
 * Loading, failed, and genuinely-empty are distinct. Collapsing them into one blank list
 * makes a broken provider indistinguishable from an unconfigured one, and hides the fact
 * that a retry would help.
 *
 * ── THIS COMPONENT NEVER DECIDES WHAT A CHOICE MEANS ───────────────────────────
 *
 * It reports the chosen option and nothing else. The dropdown writes the session's active
 * model; the chooser card writes a subagent or WebFetch setting. Keeping that out of here
 * is what lets one list serve both without a mode flag.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  ModelCatalogueView,
  ModelOptionView,
} from '../../shared/webviewProtocol.js'
import { SearchIcon } from './Icons.js'

export interface ModelPickerListProps {
  catalogue: ModelCatalogueView
  /**
   * The currently selected identifier, for the ✓ marker.
   *
   * Matched against both `value` and `model` because callers hold it in different forms:
   * the session's active model is a runtime id, while a saved subagent selection is a bare
   * model name.
   */
  current: string | null
  onChoose: (option: ModelOptionView) => void
  onRefresh: () => void
  /** Focus the search field on mount. False inside a closed dropdown. */
  autoFocus?: boolean
  /** Escape handling belongs to the container, which knows what closing means. */
  onEscape?: () => void
  emptyHint?: string
}

export function ModelPickerList({
  catalogue,
  current,
  onChoose,
  onRefresh,
  autoFocus = true,
  onEscape,
  emptyHint = 'No models configured yet. Connect a provider to choose one.',
}: ModelPickerListProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const search = useRef<HTMLInputElement | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return catalogue.options
    // Matches label, value and both descriptions so a provider-qualified id like
    // "openai · gpt-4o" is findable by provider as well as by model.
    return catalogue.options.filter(
      o =>
        (o.label && o.label.toLowerCase().includes(q)) ||
        (o.value && o.value.toLowerCase().includes(q)) ||
        Boolean(o.customerDescription && o.customerDescription.toLowerCase().includes(q)) ||
        Boolean(o.description && o.description.toLowerCase().includes(q)),
    )
  }, [catalogue.options, query])

  // Keep the highlight inside the filtered list. Without this, narrowing the query
  // leaves it pointing past the end and Enter selects nothing.
  useEffect(() => {
    setHighlight(h => (h >= filtered.length ? 0 : h))
  }, [filtered.length])

  useEffect(() => {
    if (autoFocus) search.current?.focus()
  }, [autoFocus])

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
        if (picked) onChoose(picked)
        return
      }
      case 'Escape':
        if (!onEscape) return
        event.preventDefault()
        // Stops here rather than bubbling: Escape in the composer means something else,
        // and closing this list is the more specific intent.
        event.stopPropagation()
        onEscape()
        return
      default:
        return
    }
  }

  return (
    <>
      <div className="rc-dropdown-search-wrap">
        <SearchIcon size={12} className="rc-search-icon" />
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
        <p className="rc-dropdown-empty">{emptyHint}</p>
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
                  // Hover moves the highlight so mouse and keyboard agree about which row
                  // Enter would take.
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    onChoose(option)
                  }}
                >
                  <div className="rc-dropdown-item-header">
                    <span className="rc-dropdown-label">{option.label}</span>
                    {isCurrent ? (
                      <span className="rc-dropdown-current">✓ Active</span>
                    ) : null}
                  </div>
                  {option.customerDescription ? (
                    <div className="rc-dropdown-detail rc-model-customer-description">
                      <span className="rc-model-desc">{option.customerDescription}</span>
                    </div>
                  ) : null}
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
    </>
  )
}
