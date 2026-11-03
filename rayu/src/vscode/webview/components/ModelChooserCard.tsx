/**
 * The model chooser opened by `/subagent_models`, `/webfetch_model`,
 * `/model_image_generation` and `/model_video_generation`.
 *
 * Pinned above the composer, in the same slot approvals use, because it is a decision the
 * user just asked for and must not be scrolled away from. It reuses `ModelPickerList`, so
 * the rows, the search and the empty states are identical to the composer's own model
 * dropdown — a user who has learned one has learned both.
 *
 * The agent and WebFetch settings pick from the session's chat-model catalogue. The image
 * and video settings carry their OWN list (`chooser.catalogue`), fetched live from Rayu
 * when the chooser opens, so "Try again" re-fetches that list rather than the chat one.
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
  /** The session's chat-model catalogue, used when the chooser carries no list of its own. */
  catalogue: ModelCatalogueView
  /** null resets to the default. */
  onChoose: (value: string | null) => void
  /** Switch between the global setting and one named agent. */
  onTargetChange?: (agentType?: string) => void
  onDismiss: () => void
  /** Refresh the chat-model catalogue. */
  onRefresh: () => void
  /** Re-fetch the chooser's own list (image/video). */
  onRefreshOwnList?: () => void
}

const MEDIA_EMPTY_HINT =
  'No models are available for your account yet. A Rayu admin adds them under Admin → Media Catalogs.'

export function ModelChooserCard({
  chooser,
  catalogue,
  onChoose,
  onTargetChange,
  onDismiss,
  onRefresh,
  onRefreshOwnList,
}: ModelChooserCardProps): JSX.Element {
  const ownList = chooser.catalogue
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

      {chooser.target === 'subagent' && chooser.agentTypes?.length ? (
        <div className="rc-model-chooser-scope">
          <span className="rc-model-chooser-scope-label">Apply to</span>
          <div
            className="rc-model-chooser-scope-options"
            role="group"
            aria-label="Agent model scope"
          >
            <button
              type="button"
              className={`rc-model-chooser-scope-option${chooser.agentType ? '' : ' rc-model-chooser-scope-option-active'}`}
              aria-pressed={!chooser.agentType}
              onClick={() => onTargetChange?.()}
            >
              All agents
            </button>
            {chooser.agentTypes.map(agentType => {
              const active = chooser.agentType === agentType
              return (
                <button
                  key={agentType}
                  type="button"
                  className={`rc-model-chooser-scope-option${active ? ' rc-model-chooser-scope-option-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => onTargetChange?.(agentType)}
                >
                  {agentType}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      <p className="rc-model-chooser-current">
        {chooser.current
          ? `Currently: ${chooser.current}`
          : `Currently: default \u2014 ${chooser.defaultNote}`}
      </p>

      {chooser.note ? <p className="rc-model-chooser-tip">{chooser.note}</p> : null}

      <ModelPickerList
        catalogue={ownList ?? catalogue}
        current={chooser.current}
        onChoose={option => {
          // The subagent setting stores provider AND model, so the host is given the
          // provider-qualified `value`; it splits them using the same encoding the CLI's
          // own cross-provider routing uses. A media row's `value` is the bare model id.
          onChoose(option.value)
        }}
        onRefresh={ownList ? onRefreshOwnList ?? onRefresh : onRefresh}
        onEscape={onDismiss}
        {...(ownList ? { emptyHint: MEDIA_EMPTY_HINT } : {})}
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
