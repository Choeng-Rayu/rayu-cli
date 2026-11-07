/**
 * Settings → Models: the subagent (default and per agent type), image, video and WebFetch
 * models.
 *
 * Each row shows what is saved now, worded as the CLI's `show` words it. "Change" opens the
 * shared `ModelPickerList` under that row; the host saves the choice through the same
 * functions the slash commands use, so this component never decides what a value means.
 */
import type {
  ModelSettingEditorView,
  ModelSettingRowView,
  ModelSettingTargetId,
  ModelsSettingsView,
} from '../../shared/settingsProtocol.js'
import { ModelPickerList } from '../components/ModelPickerList.js'
import { SettingsItem } from './SettingsItem.js'

export interface ModelsSectionProps {
  models: ModelsSettingsView
  onOpen: (target: ModelSettingTargetId, agentType?: string) => void
  /** `null` resets the setting to its default. */
  onChoose: (target: ModelSettingTargetId, value: string | null, agentType?: string) => void
  onClose: () => void
  onRefresh: () => void
}

function sameRow(row: ModelSettingRowView, editor: ModelSettingEditorView | null): boolean {
  return editor !== null && editor.target === row.target && editor.agentType === row.agentType
}

export function ModelsSection({ models, onOpen, onChoose, onClose, onRefresh }: ModelsSectionProps): JSX.Element {
  if (models.status === 'idle' || (models.status === 'loading' && models.rows.length === 0)) {
    return <p className="rs-loading" role="status">Loading model settings…</p>
  }
  return (
    <>
      {models.error && (
        <div className="rs-error" role="alert">
          <span>{models.error}</span>
          {models.status === 'error' && (
            <button type="button" className="rs-button rs-button-secondary" onClick={onRefresh}>Retry</button>
          )}
        </div>
      )}
      {models.notice && <p className="rs-item-note rs-models-notice" role="status">{models.notice}</p>}
      {models.rows.map(row => {
        const editing = sameRow(row, models.editor)
        return (
          <SettingsItem
            key={`${row.target}:${row.agentType ?? ''}`}
            label={row.label}
            description={row.summary}
            badge="Shared with Rayu CLI"
          >
            {editing && models.editor ? (
              <ModelEditor editor={models.editor} onChoose={onChoose} onClose={onClose} onRefresh={onRefresh} />
            ) : (
              <div className="rs-models-actions">
                <button type="button" className="rs-button" onClick={() => onOpen(row.target, row.agentType)}>
                  Change
                </button>
                {row.current !== null && (
                  <button
                    type="button"
                    className="rs-button rs-button-secondary"
                    onClick={() => onChoose(row.target, null, row.agentType)}
                  >
                    Use default
                  </button>
                )}
              </div>
            )}
          </SettingsItem>
        )
      })}
    </>
  )
}

interface ModelEditorProps {
  editor: ModelSettingEditorView
  onChoose: ModelsSectionProps['onChoose']
  onClose: () => void
  onRefresh: () => void
}

function ModelEditor({ editor, onChoose, onClose, onRefresh }: ModelEditorProps): JSX.Element {
  return (
    <div className="rs-models-editor" role="group" aria-label={editor.title}>
      <span className="rs-value">{editor.title}</span>
      <span className="rs-item-note">{editor.tip}</span>
      {editor.note && <span className="rs-item-note">{editor.note}</span>}
      {editor.error && <div className="rs-error" role="alert"><span>{editor.error}</span></div>}
      <div className="rs-models-picker">
        <ModelPickerList
          catalogue={editor.catalogue}
          current={editor.current}
          onChoose={option => onChoose(editor.target, option.value, editor.agentType)}
          onRefresh={onRefresh}
          onEscape={onClose}
        />
      </div>
      <div className="rs-models-actions">
        <button
          type="button"
          className="rs-button rs-button-secondary"
          title={editor.defaultNote}
          disabled={editor.saving}
          onClick={() => onChoose(editor.target, null, editor.agentType)}
        >
          Use default
        </button>
        <button type="button" className="rs-button rs-button-secondary" onClick={onClose}>Cancel</button>
      </div>
      <span className="rs-item-note">Default: {editor.defaultNote}</span>
    </div>
  )
}
