import type { LocalCommandResult } from '../../types/command.js'
import { loginRayu } from '../../services/rayuAuth/rayuLogin.js'
import { readRayuSession } from '../../services/rayuAuth/rayuSession.js'

export async function call(): Promise<LocalCommandResult> {
  const existing = readRayuSession()
  if (existing?.accessToken) {
    const who = existing.user.email ?? existing.user.displayName ?? 'your account'
    return {
      type: 'text',
      value: `Already signed in to Rayu as ${who}. Run /logout to switch accounts.`,
    }
  }

  try {
    const { user } = await loginRayu({
      onAuthUrl: () => {
        // The browser is opened automatically; nothing to print here in the
        // local-command flow.
      },
    })
    const who = user.email ?? user.displayName ?? `user #${user.id}`
    return { type: 'text', value: `Signed in to Rayu as ${who}.` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { type: 'text', value: `Rayu login failed: ${msg}` }
  }
}
