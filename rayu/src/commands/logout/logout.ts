import type { LocalCommandResult } from '../../types/command.js'
import { signOutRayu } from '../../services/rayuAuth/rayuSignOut.js'

export async function call(): Promise<LocalCommandResult> {
  // Clear BOTH credential types so the user can start fresh — Rayu Auth and
  // Rayu API key are either-or, and /logout is the clean-break point.
  const { hadSession, hadApiKey } = signOutRayu({ removeApiKey: true })

  if (!hadSession && !hadApiKey) {
    return { type: 'text', value: 'You are not signed in to Rayu.' }
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
