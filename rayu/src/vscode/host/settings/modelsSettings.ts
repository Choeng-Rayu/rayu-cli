/**
 * The Settings tab's Models section: the subagent (default and per agent type), image, video
 * and WebFetch models.
 *
 * Every read and write goes through `modelSettingCommands.ts`, the same functions the slash
 * commands use, so the tab, the chooser card and the terminal CLI store each value in one
 * place and word it the same way. The lists come from injected loaders: the chat catalogue
 * for subagent and WebFetch, the live media catalog for image and video.
 *
 * Free of `vscode` imports.
 */
import type { ModelOptionView } from '../../shared/webviewProtocol.js'
import type {
  ModelSettingEditorView,
  ModelSettingRowView,
  ModelsSettingsView,
} from '../../shared/settingsProtocol.js'
import {
  applySelection,
  buildChooser,
  currentSelectionValue,
  describeSelection,
  isMediaModelTarget,
  type ModelSettingTarget,
} from '../models/modelSettingCommands.js'

export type CatalogueOutcome =
  | { ok: true; options: ModelOptionView[]; note?: string }
  | { ok: false; error: string }

export interface ModelsSettingsDeps {
  /** Chat-model catalogue for the subagent and WebFetch pickers. */
  loadProviderCatalogue(): Promise<CatalogueOutcome>
  /** Live image or video generation models. */
  loadMediaCatalogue(target: 'image' | 'video'): Promise<CatalogueOutcome>
  /** Agent types the live engine reported; may be empty. Passed to buildChooser as knownAgentTypes. */
  knownAgentTypes(): readonly string[]
  /** After a successful save. The host restarts idle engines for subagent/webfetch. */
  onSaved(target: ModelSettingTarget): void
}

const ROW_LABELS: Record<ModelSettingTarget, string> = {
  subagent: 'Subagent model (all agents)',
  image: 'Image generation model',
  video: 'Video generation model',
  webfetch: 'WebFetch model',
}

const NOT_SAVED = 'That model cannot be used for this setting. Choose another one.'
const UNKNOWN_AGENT = 'That agent type is not one Rayu can configure.'

export class ModelsSettings {
  private view: ModelsSettingsView = { status: 'idle', error: null, notice: null, rows: [], editor: null }
  /** Bumped on every open/close, so a list that arrives after its picker closed is dropped. */
  private editorGeneration = 0

  constructor(
    private readonly deps: ModelsSettingsDeps,
    private readonly publish: (view: ModelsSettingsView) => void,
  ) {}

  get current(): ModelsSettingsView {
    return this.view
  }

  /** Rebuild every row from the saved selections. */
  refresh(): void {
    try {
      this.set({ status: 'ready', error: null, rows: this.buildRows() })
    } catch (cause) {
      this.set({ status: 'error', error: `Reading the model settings failed: ${messageOf(cause)}` })
    }
  }

  /** Show the picker for one row and load its list. */
  async open(target: ModelSettingTarget, agentType?: string): Promise<void> {
    if (!this.isKnownScope(target, agentType)) {
      this.set({ error: UNKNOWN_AGENT })
      return
    }
    const chooser = buildChooser(target, agentType, this.deps.knownAgentTypes())
    const generation = ++this.editorGeneration
    this.set({
      notice: null,
      error: null,
      editor: {
        target,
        ...(agentType ? { agentType } : {}),
        title: chooser.title,
        tip: chooser.tip,
        defaultNote: chooser.defaultNote,
        current: chooser.current,
        catalogue: { options: [], loading: true, error: null },
        saving: false,
        error: null,
      },
    })
    const outcome = await this.loadCatalogue(target)
    if (generation !== this.editorGeneration || !this.view.editor) return
    this.patchEditor(
      outcome.ok
        ? { catalogue: { options: outcome.options, loading: false, error: null }, ...(outcome.note ? { note: outcome.note } : {}) }
        : { catalogue: { options: [], loading: false, error: outcome.error } },
    )
  }

  /** Save `value` for a setting, or reset it with `null`. */
  choose(target: ModelSettingTarget, value: string | null, agentType?: string): void {
    if (!this.isKnownScope(target, agentType)) {
      this.reportChooseError(UNKNOWN_AGENT)
      return
    }
    let confirmation: string | null
    try {
      confirmation = applySelection(target, value, agentType)
    } catch (cause) {
      this.reportChooseError(`Saving the model failed: ${messageOf(cause)}`)
      return
    }
    if (confirmation === null) {
      this.reportChooseError(NOT_SAVED)
      return
    }
    this.notifySaved(target)
    this.editorGeneration++
    this.set({ editor: null, notice: confirmation })
    this.refresh()
  }

  close(): void {
    this.editorGeneration++
    if (this.view.editor) this.set({ editor: null })
  }

  /** Read the rows again, and the open picker's list. */
  async reload(): Promise<void> {
    this.refresh()
    const editor = this.view.editor
    if (editor) await this.open(editor.target, editor.agentType)
  }

  private buildRows(): ModelSettingRowView[] {
    const agentTypes = buildChooser('subagent', undefined, this.deps.knownAgentTypes()).agentTypes ?? []
    const row = (target: ModelSettingTarget, agentType?: string): ModelSettingRowView => ({
      target,
      ...(agentType ? { agentType } : {}),
      label: agentType ? `Subagent model: ${agentType}` : ROW_LABELS[target],
      summary: describeSelection(target, agentType),
      current: currentSelectionValue(target, agentType),
    })
    return [
      row('subagent'),
      ...agentTypes.map(agentType => row('subagent', agentType)),
      row('image'),
      row('video'),
      row('webfetch'),
    ]
  }

  /** An agent type only scopes the subagent setting, and only when Rayu can configure it. */
  private isKnownScope(target: ModelSettingTarget, agentType?: string): boolean {
    if (agentType === undefined) return true
    if (target !== 'subagent') return false
    const known = buildChooser('subagent', undefined, this.deps.knownAgentTypes()).agentTypes ?? []
    return known.includes(agentType)
  }

  private async loadCatalogue(target: ModelSettingTarget): Promise<CatalogueOutcome> {
    try {
      return isMediaModelTarget(target)
        ? await this.deps.loadMediaCatalogue(target)
        : await this.deps.loadProviderCatalogue()
    } catch (cause) {
      return { ok: false, error: `Loading the models failed: ${messageOf(cause)}` }
    }
  }

  private reportChooseError(error: string): void {
    if (this.view.editor) this.patchEditor({ saving: false, error })
    else this.set({ error })
  }

  /** The save already succeeded; a failing follow-up must not be reported as a failed save. */
  private notifySaved(target: ModelSettingTarget): void {
    try {
      this.deps.onSaved(target)
    } catch (cause) {
      console.warn(`[rayucode] after saving the ${target} model:`, cause)
    }
  }

  private patchEditor(patch: Partial<ModelSettingEditorView>): void {
    if (!this.view.editor) return
    this.set({ editor: { ...this.view.editor, ...patch } })
  }

  private set(patch: Partial<ModelsSettingsView>): void {
    this.view = { ...this.view, ...patch }
    this.publish(this.view)
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
