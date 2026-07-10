import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { loginRayu } from '../../services/rayuAuth/rayuLogin.js'
import { readRayuSession } from '../../services/rayuAuth/rayuSession.js'

type Props = {
  onDone: (result?: string) => void
}

/**
 * Interactive Rayu sign-in. Renders as a pane so the auth URL is ALWAYS visible
 * in the terminal (not just auto-opened in a browser) — the user can copy/paste
 * it if the browser can't open on its own (headless/SSH/WSL, no default
 * browser). Mirrors the /session command's local-jsx pattern; a plain `local`
 * command can't reliably paint output mid-flight while it awaits the browser
 * callback, which is why the link wasn't showing before.
 */
function LoginFlow({ onDone }: Props): React.ReactNode {
  const [url, setUrl] = useState<string | null>(null)
  const finished = useRef(false)

  // Resolve the command exactly once (browser success, failure, or esc-cancel).
  const finish = (result: string): void => {
    if (finished.current) return
    finished.current = true
    onDone(result)
  }

  useEffect(() => {
    let cancelled = false
    loginRayu({
      // Fires with the sign-in URL right before the browser is opened; surface
      // it in the pane so it's copy/paste-able.
      onAuthUrl: (u) => {
        if (!cancelled) setUrl(u)
      },
    })
      .then(({ user }) => {
        if (cancelled) return
        const who = user.email ?? user.displayName ?? `user #${user.id}`
        finish(`Signed in to Rayu as ${who}.`)
      })
      .catch((err) => {
        if (cancelled) return
        finish(`Rayu login failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc dismisses the pane (the background listener harmlessly times out).
  useKeybinding('confirm:no', () => finish('Login cancelled.'), {
    context: 'Confirmation',
  })

  return (
    <Box flexDirection="column">
      <Text bold>Sign in to Rayu</Text>
      <Box marginTop={1}>
        <Text>Opening your browser to sign in…</Text>
      </Box>
      {url ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            If it doesn&apos;t open automatically, copy this link into your
            browser:
          </Text>
          <Text color="ide">{url}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>Starting sign-in…</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>(press esc to cancel)</Text>
      </Box>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone) => {
  // Short-circuit when already signed in — no need to render the pane.
  const existing = readRayuSession()
  if (existing?.accessToken) {
    const who =
      existing.user.email ?? existing.user.displayName ?? 'your account'
    onDone(`Already signed in to Rayu as ${who}. Run /logout to switch accounts.`)
    return null
  }
  return <LoginFlow onDone={onDone} />
}
