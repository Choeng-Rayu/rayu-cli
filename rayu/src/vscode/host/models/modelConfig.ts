/**
 * Model configuration, read and written through Rayu's shared provider helpers.
 *
 * Deliberately FREE of `vscode` imports. Its sibling `modelSurface.ts` owns the
 * QuickPick and therefore needs the editor API; this half is pure config access, and
 * `sessionHandle.ts` depends on it.
 *
 * That split is not tidiness. When these lived together, importing the session — which
 * needs `readActiveModel` — transitively required `vscode`, and the session could no
 * longer be exercised outside an extension host. A module that can only be tested by
 * stubbing the editor is a module whose tests mostly prove the stub works.
 *
 * ── WHERE THE SELECTION COMES FROM ─────────────────────────────────────────────
 *
 * Rayucode selects an independent provider-profile directory during activation. The
 * file schema and behavior are the same ones `/model` uses in the CLI, while each
 * product reads and writes its own `providers.json`. Taking the selection from the
 * engine's catalogue instead would display whatever the provider happened to list
 * first, which is a different thing from the persisted Rayucode choice.
 */
import {
  getActiveProvider,
  getActiveProviderModelOptions,
  getAllProviderModelOptions,
  decodeModelProvider,
  encodeModelWithProvider,
  invalidateRayuConfigCache,
  getValidDefaultModel,
  setActiveProviderModel,
} from '../../../utils/rayuConfig.js'
import type { ModelInfoView } from '../../shared/webviewProtocol.js'

/**
 * One entry from the engine's `initialize` catalogue.
 *
 * `value` is the API identifier and `displayName` is what a human reads. The field is
 * NOT called `model` — reading the wrong one yields undefined and a picker full of
 * blank rows, with no error anywhere.
 */
export interface EngineModel {
  providerId?: string
  model?: string
  contextWindow?: number
  supportsThinking?: boolean
  supportsImage?: boolean
  supportsTools?: boolean
  value: string
  displayName: string
  /** Admin-published customer summary from the Rayu catalog, when available. */
  customerDescription?: string
  /** Existing provider/engine detail retained for non-Rayu model sources. */
  description: string
}

/**
 * The model shown in the composer.
 *
 * Never throws: a missing or malformed config must degrade to "no model shown" rather
 * than breaking the panel, because the engine still has its own default and the
 * session is still usable.
 */
export function readActiveModel(): ModelInfoView {
  try {
    const provider = getActiveProvider()
    return {
      model: getValidDefaultModel(provider) ?? null,
      provider: provider?.id ?? null,
    }
  } catch {
    return { model: null, provider: null }
  }
}

/**
 * Provider-qualified model used to pin a Rayucode engine session.
 *
 * The engine also reads shared user settings during startup. Always applying this
 * routed value after initialization prevents a CLI `model` setting or later CLI model
 * change from becoming Rayucode's execution provider.
 */
export function readActiveRuntimeModel(): string | null {
  try {
    const provider = getActiveProvider()
    const model = getValidDefaultModel(provider)
    return provider && model ? encodeModelWithProvider(provider.id, model) : null
  } catch {
    return null
  }
}

/**
 * Model options that are available WITHOUT starting the engine.
 *
 * The engine's own catalogue arrives with `initialize`, which only happens on the first
 * turn — so relying on it alone would leave the model control empty until the user had
 * already sent a prompt, which is exactly when choosing a model is too late.
 *
 * `getActiveProviderModelOptions()` is the shared list for the configured providers,
 * read from Rayucode's provider profile. It returns an empty array for the
 * `anthropic` provider kind, whose models the engine enumerates instead — so an empty
 * result here is normal and means "wait for the engine", not "no models".
 *
 * Never throws: a malformed config must leave the control empty rather than break the
 * panel.
 */
export function readModelOptions(): EngineModel[] {
  try {
    const all = getAllProviderModelOptions()
    if (all.length) return all.map(o => ({
      value: o.value, displayName: o.label ?? o.model,
      description: `${o.providerId} · ${o.model}`,
      customerDescription: o.description,
      providerId: o.providerId, model: o.model, contextWindow: o.contextWindow,
      supportsThinking: o.supportsThinking, supportsImage: o.supportsImage, supportsTools: o.supportsTools,
    }))
    return getActiveProviderModelOptions().map(o => ({
      value: o.value,
      displayName: o.label,
      description: o.description,
    }))
  } catch {
    return []
  }
}

/**
 * Persist a model choice to Rayucode's provider profile.
 *
 * Written as well as sent to the engine: `set_model` applies to the running child
 * only, so without this the next Rayucode session would silently revert.
 *
 * Swallows failure on purpose. If the config is not writable the engine has already
 * accepted `set_model`, so the current session honours the choice and only persistence
 * is lost — failing the whole action over that would be worse.
 */
export function persistModelChoice(model: string): string {
  try {
    invalidateRayuConfigCache()
    const choice = decodeModelProvider(model)
    const providerId = choice.providerId ?? getActiveProvider()?.id
    if (providerId) {
      setActiveProviderModel(providerId, choice.model)
      // A routed value pins the running session to the provider the user chose. A
      // bare model can otherwise be resolved through unrelated shared settings.
      return encodeModelWithProvider(providerId, choice.model)
    }
  } catch {
    // See above.
  }
  return model
}
