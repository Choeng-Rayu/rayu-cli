/**
 * The model chooser opened by `/model_subagent` and `/webfetch_model`.
 *
 * Pinned above the composer, in the same slot approvals use, because it is a decision the
 * user just asked for and must not be scrolled away from. It reuses `ModelPickerList`, so
 * the rows, the search and the empty states are identical to the composer's own model
 * dropdown — a user who has learned one has learned both.
 *
 * ── RESET IS OFFERED, NOT IMPLIED ──────────────────────────────────────────────
 *
 * The CLI commands take a `default` sub-command, and the equivalent has to be reachable
 * here or the chooser could only ever narrow the configuration. It says what the default
 * actually is, because "default" alone does not tell the user which model they would get.
 */
import type { ModelCatalogueView, ModelChooserView } from '../../shared/webviewProtocol.js'
import { CloseIcon } from './Icons.js'
import { ModelPickerList } from './ModelPickerList.js'

export interface ModelChooserCardProps {
  chooser: ModelChooserView
  catalogue: ModelCatalogueView
  /** null resets to the default. */
  onChoose: (value: string | null) => void
  onDismiss: () => void
  onRefresh: () => void
}

export function ModelChooserCard({
  chooser,
  catalogue,
  onChoose,
  onDismiss,
  onRefresh,
}: ModelChooserCardProps): JSX.Element {
  return (
    <section className="rc-model-chooser" role="dialog" aria-label={chooser.title}>
      <header className="rc-model-chooser-head">
        <div className="rc-model-chooser-heading">
          <h3 className="rc-model-chooser-title">{chooser.title}</h3>
          <p className="rc-model-chooser-tip">{chooser.tip}</p>
        </div>
        <button
          type="button"
          className="rc-icon-button"
          onClick={onDismiss}
          title="Close without changing"
          aria-label="Close without changing"
        >
          <CloseIcon size={12} />
        </button>
      </header>

      <p className="rc-model-chooser-current">
        {chooser.current
          ? `Currently: ${chooser.current}`
          : `Currently: default \u2014 ${chooser.defaultNote}`}
      </p>

      <ModelPickerList
        catalogue={catalogue}
        current={chooser.current}
        onChoose={option => {
          // The subagent setting stores provider AND model, so the host is given the
          // provider-qualified `value`; it splits them using the same encoding the CLI's
          // own cross-provider routing uses.
          onChoose(option.value)
        }}
        onRefresh={onRefresh}
        onEscape={onDismiss}
      />

      {chooser.current ? (
        <footer className="rc-model-chooser-foot">
          <button type="button" className="rc-button" onClick={() => onChoose(null)}>
            Reset to default
          </button>
        </footer>
      ) : null}
    </section>
  )
}
