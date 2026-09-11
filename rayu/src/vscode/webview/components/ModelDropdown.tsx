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
 * ── THE LIST ITSELF LIVES IN `ModelPickerList` ─────────────────────────────────
 *
 * This component owns the trigger pill, the open/closed state and the outside-click
 * dismissal. Search, keyboard navigation, the row layout and the three empty states are
 * shared with the command-driven chooser card, so both surfaces cannot disagree about what
 * a model row looks like or what "no models" means.
 */
import { useEffect, useRef, useState } from 'react'

import type { ModelCatalogueView } from '../../shared/webviewProtocol.js'
import { ChevronIcon, ModelIcon } from './Icons.js'
import { ModelPickerList } from './ModelPickerList.js'

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
  const container = useRef<HTMLDivElement | null>(null)

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
        <ModelIcon size={12} className="rc-model-icon" />
        <span className="rc-pill-label">{current ?? 'Default model'}</span>
        <ChevronIcon />
      </button>

      {open ? (
        <div className="rc-dropdown-panel rc-model-panel" role="dialog" aria-label="Select a model">
          <div className="rc-dropdown-header">
            <span className="rc-dropdown-title">Model</span>
            <span className="rc-dropdown-subtitle">Select language model for responses</span>
          </div>
          <ModelPickerList
            catalogue={catalogue}
            current={current}
            // Configuration only. Deliberately does not touch the composer's text.
            onChoose={option => { setOpen(false); onSelect(option.value) }}
            onRefresh={onRefresh}
            autoFocus={open}
            onEscape={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  )
}



