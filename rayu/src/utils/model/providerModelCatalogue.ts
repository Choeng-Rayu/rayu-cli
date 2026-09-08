import { getAllProviderModelOptions, loadRayuConfig } from '../rayuConfig.js'
import { modelSupportsThinking } from '../thinking.js'
import { resolveImageSupport } from './imageCapability.js'

/** Credential-free projection of the CLI's cross-provider choices and resolvers. */
export function getProviderModelCatalogue() {
  const providers = loadRayuConfig().providers
  return getAllProviderModelOptions().map(choice => {
    const provider = providers.find(p => p.id === choice.providerId)
    const image = resolveImageSupport(choice.value)
    return {
      value: choice.value,
      label: choice.label ?? choice.model,
      description: `${choice.providerId} · ${choice.model}`,
      providerId: choice.providerId,
      model: choice.model,
      contextWindow: choice.contextWindow,
      supportsThinking: provider?.kind === 'rayu-hosted' ? provider.modelSupportsThinking?.[choice.model] : modelSupportsThinking(choice.value),
      supportsImage: provider?.kind === 'rayu-hosted' ? provider.modelSupportsImage?.[choice.model] : image === 'unknown' ? undefined : image === 'yes',
      supportsTools: provider?.modelSupportsTools?.[choice.model],
    }
  })
}
