import type { LocalCommandResult } from '../../types/command.js'
import {
  fetchRayuCredits,
  formatRayuUsageSummary,
} from '../../services/rayuAuth/rayuCredits.js'
import { hasRayuSession } from '../../services/rayuAuth/rayuSession.js'

export async function call(): Promise<LocalCommandResult> {
  if (!hasRayuSession()) {
    return {
      type: 'text',
      value: 'Not signed in. Run /login to view your usage.',
    }
  }
  const c = await fetchRayuCredits()
  if (!c) {
    return {
      type: 'text',
      value:
        'Could not fetch usage. Make sure you are on a paid plan and the gateway is reachable.',
    }
  }
  return { type: 'text', value: formatRayuUsageSummary(c) }
}
