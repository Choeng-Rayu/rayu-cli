/**
 * The Settings tab's General section: reading, validating and saving each row.
 *
 * Two stores, chosen by each setting's descriptor (`src/utils/settings/editableSettings.ts`):
 *   - shared settings are read and written by a short-lived engine child
 *     (`sharedSettings.ts`), so they land in Rayu's own files and the terminal CLI sees them;
 *   - Rayucode-only settings live in Rayucode's profile (`rayucodeSettings.ts`), read and
 *     written right here.
 * Every value from the (untrusted) tab is checked against its descriptor before anything
 * is written; the engine child checks shared values again.
 *
 * Free of `vscode` imports: the readers, writers and the post-save hook are injected.
 */
import {
  editableSetting,
  validateEditableValue,
  type EditableSettingDescriptor,
} from '../../../utils/settings/editableSettings.js'
import type { GeneralSettingsView } from '../../shared/settingsProtocol.js'
import { GENERAL_ROW_KEYS, NO_FOLDER, buildGeneralItems, runtimeChoices } from './generalRows.js'
import type { RayucodeSettingsValues } from './rayucodeSettings.js'
import type { SharedSettingsOutcome, SharedSettingsSnapshot } from './sharedSettings.js'

export { GENERAL_ROW_KEYS, buildGeneralItems } from './generalRows.js'

export interface GeneralSettingsDeps {
  readShared(): Promise<SharedSettingsOutcome<SharedSettingsSnapshot>>
  writeShared(key: string, value: boolean | string): Promise<SharedSettingsOutcome<true>>
  readRayucode(): RayucodeSettingsValues
  writeRayucode(key: string, value: boolean | string): SharedSettingsOutcome<true>
  /** Whether a workspace folder is open; workspace-scoped rows need one. */
  hasWorkspace(): boolean
  /** Called after a successful save, e.g. to bring conversations that have not started up to date. */
  onSaved(setting: EditableSettingDescriptor, value: boolean | string): void
}

type Checked =
  | { ok: true; setting: EditableSettingDescriptor; value: boolean | string }
  | { ok: false; error: string }

export class GeneralSettings {
  private view: GeneralSettingsView = { status: 'idle', error: null, saving: null, items: [] }
  private snapshot: SharedSettingsSnapshot | null = null
  /** Reads and writes run one at a time, in the order they were asked for. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: GeneralSettingsDeps,
    private readonly publish: (view: GeneralSettingsView) => void,
  ) {}

  get current(): GeneralSettingsView {
    return this.view
  }

  /** Read both stores again, e.g. when the tab (re)appears. */
  refresh(): Promise<void> {
    return this.enqueue(() => this.load())
  }

  update(key: string, value: boolean | string): Promise<void> {
    return this.enqueue(() => this.save(key, value))
  }

  /**
   * Rayucode's profile changed elsewhere — the chat switched the permission mode. Rebuilds
   * the rows from it without another engine child, and only once the section has loaded.
   */
  rayucodeChanged(): Promise<void> {
    return this.enqueue(async () => {
      if (this.view.status === 'ready') this.rebuild()
    })
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    // Never rejects, so one failure cannot stall the queue or leave a row "Saving…".
    const run = async (): Promise<void> => {
      try {
        await work()
      } catch (cause) {
        this.set({
          status: this.view.items.length > 0 ? 'ready' : 'error',
          saving: null,
          error: `Rayu settings failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
    }
    this.queue = this.queue.then(run)
    return this.queue
  }

  private async load(): Promise<void> {
    if (this.view.status !== 'ready') this.set({ status: 'loading', error: null })
    const outcome = await this.deps.readShared()
    if (!outcome.ok) {
      this.set({ status: 'error', error: outcome.error, saving: null })
      return
    }
    this.snapshot = outcome.value
    this.rebuild()
  }

  /** Rows from the last shared read and a fresh read of Rayucode's profile. */
  private rebuild(): void {
    if (!this.snapshot) {
      // Nothing to show yet (the tab sent a change before its first read finished).
      this.set({ saving: null })
      return
    }
    const sources = { shared: this.snapshot, rayucode: this.deps.readRayucode() }
    this.set({ status: 'ready', error: null, saving: null, items: buildGeneralItems(sources, this.deps.hasWorkspace()) })
  }

  private async save(key: string, value: boolean | string): Promise<void> {
    const checked = this.check(key, value)
    if (!checked.ok) {
      this.set({ error: checked.error })
      return
    }
    const { setting } = checked
    const rayucodeOnly = setting.store === 'rayucodePreferences'
    this.set({ saving: setting.key, error: null })
    const written = rayucodeOnly
      ? this.deps.writeRayucode(setting.key, checked.value)
      : await this.deps.writeShared(setting.key, checked.value)
    if (!written.ok) {
      this.set({ saving: null, error: written.error })
      return
    }
    this.notifySaved(setting, checked.value)
    // Only a shared value needs the files read again; Rayucode's profile is read locally.
    if (rayucodeOnly) this.rebuild()
    else await this.load()
  }

  private check(key: string, value: boolean | string): Checked {
    const setting = editableSetting(key)
    if (!setting || !GENERAL_ROW_KEYS.includes(setting.key)) {
      return { ok: false, error: 'That setting cannot be changed here.' }
    }
    if (setting.store === 'localSettings' && !this.deps.hasWorkspace()) return { ok: false, error: NO_FOLDER }
    const result = validateEditableValue(setting, value, runtimeChoices(setting.key, this.snapshot))
    return result.ok ? { ok: true, setting, value: result.value } : result
  }

  /** The save already succeeded; a failing follow-up must not be reported as a failed save. */
  private notifySaved(setting: EditableSettingDescriptor, value: boolean | string): void {
    try {
      this.deps.onSaved(setting, value)
    } catch (cause) {
      console.warn(`[rayucode] after saving ${setting.key}:`, cause)
    }
  }

  private set(patch: Partial<GeneralSettingsView>): void {
    this.view = { ...this.view, ...patch }
    this.publish(this.view)
  }
}
