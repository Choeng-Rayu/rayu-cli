/**
 * The one mapping from an engine or config model to a picker option.
 *
 * The chat's model dropdown, the slash-command chooser and Settings → Models all list the
 * same models; mapping them in one place keeps the label fallback and the capability flags
 * identical on every surface. Free of `vscode` imports.
 */
import type { ModelCatalogueView, ModelOptionView } from '../../shared/webviewProtocol.js'
import type { EngineModel } from './modelConfig.js'

export function modelOptionView(model: EngineModel): ModelOptionView {
  return {
    value: model.value,
    label: model.displayName || model.value,
    description: model.description,
    customerDescription: model.customerDescription,
    providerId: model.providerId,
    model: model.model,
    contextWindow: model.contextWindow,
    supportsThinking: model.supportsThinking,
    supportsImage: model.supportsImage,
    supportsTools: model.supportsTools,
  }
}

/** `loading` while nothing has arrived and nothing has failed. */
export function catalogueView(models: readonly EngineModel[], error: string | null = null): ModelCatalogueView {
  return {
    options: models.map(modelOptionView),
    loading: models.length === 0 && error === null,
    error,
  }
}
