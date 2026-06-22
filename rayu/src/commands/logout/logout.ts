import type { LocalCommandResult } from '../../types/command.js'
import { clearRayuEntitlements } from '../../services/rayuAuth/rayuEntitlements.js'
import { clearFeatureUsage } from '../../services/rayuAuth/rayuFeatureUsage.js'
import {
  clearRayuSession,
  readRayuSession,
} from '../../services/rayuAuth/rayuSession.js'

export async function call(): Promise<LocalCommandResult> {
  const existing = readRayuSession()
  if (!existing?.accessToken) {
    return { type: 'text', value: 'You are not signed in to Rayu.' }
  }
  clearRayuSession()
  clearRayuEntitlements()
  clearFeatureUsage()
  return { type: 'text', value: 'Signed out of Rayu.' }
}
