import { refreshHostedCatalog } from '../../services/rayuAuth/rayuHostedProvider.js'
import { refreshRayuApiKeyCatalog } from '../rayuConfig.js'

/** The CLI picker and editor refresh the same server-driven Rayu catalogs. */
export async function refreshModelPickerCatalog(): Promise<boolean> {
  const changes = await Promise.all([
    refreshHostedCatalog(),
    refreshRayuApiKeyCatalog().then(result => result.changed).catch(() => false),
  ])
  return changes.some(Boolean)
}
