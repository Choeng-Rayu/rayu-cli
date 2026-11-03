// The two-option Rayu setup screen.
//
// Shown on FIRST RUN (from Onboarding) and again on any launch where a stored
// Rayu API key no longer works (from showSetupScreens). It offers exactly the two
// ways to get a working Rayu credential:
//
//   1. Sign in to Rayu    — the account flow, identical to /login. Renders the
//                           very same LoginFlow component, so the browser
//                           handoff, the copy/paste URL fallback, the
//                           entitlements refresh and the rayu-hosted provider
//                           registration all behave exactly as they do from the
//                           slash command.
//   2. Use a Rayu API key — paste a `rayu_sk_live_…` key, which is validated
//                           against the gateway before anything is saved.
//
// Every OTHER provider is deliberately absent from the first screen: a new user
// should not have to choose between twenty vendors before their first prompt.
// They remain one keystroke away via the third entry, and `/connect` offers the
// full list at any time afterwards.
//
// A rejected key returns to this choice rather than dead-ending, so the user can
// switch to signing in instead — the explicit requirement for this flow.
import React, { useState } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import { LoginFlow } from '../commands/login/login.js'
import { RayuApiKeyInput } from './RayuApiKeyInput.js'
import { RayuProviderSetup } from './RayuProviderSetup.js'
import { hasRayuSession } from '../services/rayuAuth/rayuSession.js'

type Choice = 'login' | 'apikey' | 'other'

type Phase =
  /** The two-option menu. */
  | 'choose'
  /** Account sign-in (the /login flow). */
  | 'login'
  /** API-key entry + validation. */
  | 'apikey'
  /** Escape hatch: the full /connect provider list. */
  | 'other'

export function RayuFirstRunSetup({
  onDone,
  /**
   * Why the screen is being shown. `relaunch` means a previously working key
   * stopped working, which needs different framing from a genuine first run —
   * the user has done this before and wants to know what changed.
   */
  reason = 'first-run',
  /** Explanation of a failed key check, shown above the choice on a relaunch. */
  notice,
}: {
  onDone: () => void
  reason?: 'first-run' | 'relaunch'
  notice?: string
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>('choose')
  const [error, setError] = useState<string | null>(null)

  function choose(choice: Choice): void {
    setError(null)
    setPhase(choice)
  }

  if (phase === 'login') {
    return (
      <LoginFlow
        onDone={result => {
          // LoginFlow resolves with a human-readable string for success, failure
          // AND cancellation alike, so the session is the only reliable signal of
          // whether we actually got a credential.
          if (hasRayuSession()) {
            onDone()
            return
          }
          setError(result ?? 'Sign-in did not complete. Choose how to continue.')
          setPhase('choose')
        }}
      />
    )
  }

  if (phase === 'apikey') {
    return (
      <RayuApiKeyInput
        heading="Enter your Rayu API key"
        onOutcome={outcome => {
          if (outcome.status === 'connected') {
            onDone()
            return
          }
          // Cancelled — back to the choice so the user can sign in instead.
          setPhase('choose')
        }}
      />
    )
  }

  if (phase === 'other') {
    // The full provider list is only reachable on a RELAUNCH (broken key) — the
    // first run requires a Rayu credential. Other providers are always available
    // later via /connect.
    return <RayuProviderSetup onDone={() => onDone()} />
  }

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>
        {reason === 'relaunch'
          ? 'Your Rayu API key needs attention'
          : 'Connect Rayu to get started'}
      </Text>
      {notice ? <Text color="yellow">{notice}</Text> : null}
      {error ? <Text color="yellow">{error}</Text> : null}
      <Text dimColor>
        {reason === 'relaunch'
          ? 'Choose how you want to continue.'
          : 'Sign in with your Rayu account, or paste an API key. You can add other providers later with /connect.'}
      </Text>
      <Select
        options={[
          {
            label: 'Sign in to Rayu — opens your browser (recommended)',
            value: 'login',
          },
          {
            label: 'Use a Rayu API key — paste a rayu_sk_live_… key',
            value: 'apikey',
          },
          // The "Other provider" escape hatch is only available on a RELAUNCH
          // (broken key), not on the genuine first run. A first-run user must
          // obtain a Rayu credential; other providers can be added later via
          // /connect. This prevents the scenario where a user skips the Rayu
          // credential and then gets login-gated on every prompt.
          ...(reason === 'relaunch'
            ? [
                {
                  label: 'Other provider — Anthropic, OpenAI, Bedrock, local, …',
                  value: 'other' as const,
                },
              ]
            : []),
        ]}
        onChange={(v: string) => choose(v as Choice)}
        // On relaunch Esc falls through to the full provider list so a user with
        // a broken key isn't stranded. On first-run Esc is a no-op — the user
        // must pick one of the two Rayu credential options.
        onCancel={reason === 'relaunch' ? () => choose('other') : undefined}
      />
      <Text dimColor>
        {reason === 'relaunch'
          ? 'Enter to select · Esc for other providers'
          : 'Enter to select — you can add other providers later with /connect'}
      </Text>
    </Box>
  )
}
