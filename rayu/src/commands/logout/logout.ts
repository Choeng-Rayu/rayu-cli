import type { LocalCommandResult } from '../../types/command.js'
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
  return { type: 'text', value: 'Signed out of Rayu.' }
}
