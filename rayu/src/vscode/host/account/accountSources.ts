/**
 * The live sources behind the Account section: Rayucode's own sign-in profile, and the
 * shared clients for rayu-backend and rayu-gateway. Bound here so `accountService.ts`
 * stays free of network code and testable with fakes.
 */
import { fetchRayuCredits } from '../../../services/rayuAuth/rayuCredits.js'
import { fetchDevices } from '../../../services/rayuAuth/rayuDevices.js'
import { listFeatureUsage, refreshFeatureUsage } from '../../../services/rayuAuth/rayuFeatureUsage.js'
import { fetchRayuProfile } from '../../../services/rayuAuth/rayuProfile.js'
import { peekDeviceIdentity } from '../../../utils/deviceIdentity.js'
import { getAuthSnapshot, hasAccountSession } from '../auth/rayuAuthBridge.js'
import type { AccountSources } from './accountService.js'

/** Each request gets this long; the section shows what arrived and says what did not. */
const ACCOUNT_REQUEST_TIMEOUT_MS = 10_000

export function liveAccountSources(): AccountSources {
  return {
    auth: getAuthSnapshot,
    hasAccountSession,
    profile: () => fetchRayuProfile({ timeoutMs: ACCOUNT_REQUEST_TIMEOUT_MS }),
    credits: () => fetchRayuCredits({ timeoutMs: ACCOUNT_REQUEST_TIMEOUT_MS }),
    // Only a fresh answer: the cache may still hold a previous sign-in's counts.
    features: async () => ((await refreshFeatureUsage()) ? listFeatureUsage() : null),
    devices: fetchDevices,
    // Read, never created: the terminal CLI gives this machine its identity.
    thisDeviceId: () => peekDeviceIdentity()?.deviceId ?? null,
    now: Date.now,
  }
}
