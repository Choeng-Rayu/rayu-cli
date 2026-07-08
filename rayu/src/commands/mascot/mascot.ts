import type { MascotId } from '../../utils/mascotBanner.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

// Currently only 'goose' is available. Adding a new mascot means: drop a
// new PNG under assets/, add its id here and to MascotId/MASCOT_ASSET_PATHS
// in mascotBanner.ts — no changes needed to the rendering pipeline itself
// (capability detection, resize/encode, Unicode fallback, and caching are
// all mascot-agnostic).
const AVAILABLE_MASCOTS: readonly MascotId[] = ['goose']

export const call: LocalCommandCall = async args => {
  const trimmed = args.trim().toLowerCase()
  const config = getGlobalConfig()

  if (trimmed === '') {
    return {
      type: 'text',
      value: `Current mascot: ${config.mascot}. Available: ${AVAILABLE_MASCOTS.join(', ')}`,
    }
  }

  if (!AVAILABLE_MASCOTS.includes(trimmed as MascotId)) {
    return {
      type: 'text',
      value: `Unknown mascot "${trimmed}". Available: ${AVAILABLE_MASCOTS.join(', ')}`,
    }
  }

  saveGlobalConfig(current => ({
    ...current,
    mascot: trimmed as MascotId,
  }))

  return {
    type: 'text',
    value: `Mascot set to ${trimmed}. Takes effect on next launch.`,
  }
}
