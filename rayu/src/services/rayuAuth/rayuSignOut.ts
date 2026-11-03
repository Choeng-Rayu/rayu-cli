// Signing out of Rayu: the one place that knows everything a sign-in leaves behind.
//
// The terminal's /logout and Rayucode's "Sign out" both come here, so neither can
// forget a cache: the entitlements (which also drop the rayu-hosted provider), the
// feature-usage counts and the plan-filtered media catalog all belong to the account
// that signed in, and must not be shown to the next one.
//
// The API key is a separate credential. /logout removes it too — it is the terminal's
// clean break — while Rayucode keeps it, because there the key is set up as a provider
// and signing out of the account should not disconnect it.
import { clearMediaModels } from './mediaModels.js'
import { clearRayuEntitlements } from './rayuEntitlements.js'
import { clearFeatureUsage } from './rayuFeatureUsage.js'
import { clearRayuApiKeyValidation, hasRayuApiKeyConfigured } from './rayuApiKeyAuth.js'
import { clearRayuSession, hasRayuSession } from './rayuSession.js'
import { removeProvider } from '../../utils/rayuConfig.js'
import { RAYU_API_PROVIDER_ID } from '../../utils/rayuProviders.js'

export interface RayuSignOutResult {
  /** An account session was signed out. */
  hadSession: boolean
  /** A Rayu API key was configured before signing out. */
  hadApiKey: boolean
  /** The API key was removed (only when asked to). */
  removedApiKey: boolean
}

export function signOutRayu(options: { removeApiKey: boolean }): RayuSignOutResult {
  const hadSession = hasRayuSession()
  const hadApiKey = hasRayuApiKeyConfigured()

  if (hadSession) {
    clearRayuSession()
    clearRayuEntitlements()
    clearFeatureUsage()
    clearMediaModels()
  }

  let removedApiKey = false
  if (options.removeApiKey && hadApiKey) {
    try {
      removeProvider(RAYU_API_PROVIDER_ID)
      removedApiKey = true
    } catch {
      // Best-effort, as before: the validation record below is still cleared.
    }
    clearRayuApiKeyValidation()
  }

  return { hadSession, hadApiKey, removedApiKey }
}
