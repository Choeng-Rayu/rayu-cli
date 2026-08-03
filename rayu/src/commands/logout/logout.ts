import type { LocalCommandResult } from '../../types/command.js'
import { clearMediaModels } from '../../services/rayuAuth/mediaModels.js'
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
  // The image/video catalog is plan-filtered, so it must not outlive the session
  // (a signed-out CLI falls back to its built-in defaults).
  clearMediaModels()
  return { type: 'text', value: 'Signed out of Rayu.' }
}
