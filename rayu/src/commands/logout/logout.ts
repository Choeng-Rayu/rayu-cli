import type { LocalCommandResult } from '../../types/command.js'
import { clearMediaModels } from '../../services/rayuAuth/mediaModels.js'
import { clearRayuEntitlements } from '../../services/rayuAuth/rayuEntitlements.js'
import { clearFeatureUsage } from '../../services/rayuAuth/rayuFeatureUsage.js'
import {
  clearRayuApiKeyValidation,
  hasRayuApiKeyConfigured,
} from '../../services/rayuAuth/rayuApiKeyAuth.js'
import {
  clearRayuSession,
  hasRayuSession,
} from '../../services/rayuAuth/rayuSession.js'
import { removeProvider } from '../../utils/rayuConfig.js'
import { RAYU_API_PROVIDER_ID } from '../../utils/rayuProviders.js'

export async function call(): Promise<LocalCommandResult> {
  const hadSession = hasRayuSession()
  const hadApiKey = hasRayuApiKeyConfigured()

  if (!hadSession && !hadApiKey) {
    return { type: 'text', value: 'You are not signed in to Rayu.' }
  }

  // Clear BOTH credential types so the user can start fresh — Rayu Auth and
  // Rayu API key are either-or, and /logout is the clean-break point.
  if (hadSession) {
    clearRayuSession()
    clearRayuEntitlements()
    clearFeatureUsage()
    // The image/video catalog is plan-filtered, so it must not outlive the session
    // (a signed-out CLI falls back to its built-in defaults).
    clearMediaModels()
  }

  if (hadApiKey) {
    try {
      removeProvider(RAYU_API_PROVIDER_ID)
    } catch {
      // best-effort
    }
    clearRayuApiKeyValidation()
  }

  const what = hadSession && hadApiKey
    ? 'Signed out of Rayu (cleared account session and API key).'
    : hadSession
      ? 'Signed out of Rayu.'
      : 'Removed Rayu API key.'

  return {
    type: 'text',
    value: `${what} Run /login to sign in again, or /connect → Rayu to use a different API key.`,
  }
}
