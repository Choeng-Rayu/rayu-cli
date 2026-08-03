// Interactive Anthropic OAuth flow UI.
//
// Drives services/oauth/oauthService.OAuthService through the authorization-code
// + PKCE flow and reports the outcome to the caller. Two paths, both live at
// once, whichever completes first wins:
//
//   AUTOMATIC — the browser is opened on the authorize URL and the code is
//     captured by the localhost listener. Nothing for the user to do but approve.
//   MANUAL    — for headless hosts / no browser: the user opens the printed URL
//     themselves, then pastes the code Anthropic displays back in here.
//
// `loginWithClaudeAi` selects the Claude.ai PAID SUBSCRIPTION (Pro / Max plan)
// scopes; with it set, a successful login is installed as the
// 'claude-subscription' provider (see services/oauth/claudeAiLogin.ts).
//
// SECURITY: the access/refresh tokens never reach this component's render path.
// Only the authorize URL (which contains no secret — just the PKCE challenge) is
// displayed.
import React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import TextInput from './TextInput.js'
import type { OAuthService } from '../services/oauth/oauthService.js'

type Phase = 'starting' | 'waiting' | 'manual' | 'installing' | 'error'

type Props = {
  /** Called once the flow settles. `success` is false on cancel or failure. */
  onDone(success: boolean): void
  startingMessage?: string
  /**
   * Request the Claude.ai subscription scopes and install the result as the
   * 'claude-subscription' provider. Without it the flow targets the Console
   * (API-key) consent page instead.
   */
  loginWithClaudeAi?: boolean
}

/**
 * Anthropic's manual callback page shows the code as `<code>#<state>`. The parser
 * lives in services/oauth/oauthService.ts (next to handleManualAuthCodeInput) and
 * is captured here when the flow starts, so this component keeps no static import
 * of the OAuth modules.
 */
type ParsePastedAuthCode = (pasted: string) => {
  authorizationCode: string
  state: string
}

export function ConsoleOAuthFlow({
  onDone,
  startingMessage,
  loginWithClaudeAi = true,
}: Props): React.ReactNode {
  const [phase, setPhase] = React.useState<Phase>('starting')
  const [manualUrl, setManualUrl] = React.useState('')
  const [code, setCode] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [warning, setWarning] = React.useState<string | null>(null)
  const serviceRef = React.useRef<OAuthService | null>(null)
  const parseRef = React.useRef<ParsePastedAuthCode | null>(null)
  // True only while startOAuthFlow() is still waiting for an authorization code.
  // Once it has settled, handleManualAuthCodeInput() would be a silent no-op, so
  // the manual-paste fallback must not be offered any more.
  const awaitingCodeRef = React.useRef(false)
  const [canPasteManually, setCanPasteManually] = React.useState(false)

  // Start the flow once. Everything OAuth-related is lazy-imported here so the
  // localhost listener + axios profile fetch never load unless the user actually
  // picks this path.
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [oauth, login] = await Promise.all([
          import('../services/oauth/oauthService.js'),
          import('../services/oauth/claudeAiLogin.js'),
        ])
        if (cancelled) return
        parseRef.current = oauth.parsePastedAuthCode
        const service = new oauth.OAuthService()
        serviceRef.current = service

        const tokens = await service.startOAuthFlow(
          async (url: string) => {
            if (cancelled) return
            awaitingCodeRef.current = true
            setCanPasteManually(true)
            setManualUrl(url)
            setPhase('waiting')
          },
          { loginWithClaudeAi },
        )
        awaitingCodeRef.current = false
        setCanPasteManually(false)
        if (cancelled) return

        if (!loginWithClaudeAi) {
          // Console (API-key) logins are not installed as a provider here.
          onDone(true)
          return
        }

        setPhase('installing')
        const result = await login.installClaudeSubscription(tokens)
        if (cancelled) return
        if (!result.success) {
          setError(result.warning ?? 'Could not save the Claude credentials.')
          setPhase('error')
          return
        }
        // A plaintext-storage warning is informational, not a failure.
        if (result.warning) setWarning(result.warning)
        onDone(true)
      } catch (e) {
        awaitingCodeRef.current = false
        setCanPasteManually(false)
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
      serviceRef.current?.cleanup()
      serviceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // While waiting for the browser, `m` switches to the manual paste step and
  // `esc` cancels. TextInput owns the keyboard once we're in the manual step.
  useInput(
    (input: string, key: { [k: string]: boolean }) => {
      if (phase !== 'waiting') return
      if (key.escape) {
        serviceRef.current?.cleanup()
        onDone(false)
        return
      }
      if (input === 'm' || input === 'M') setPhase('manual')
    },
    { isActive: phase === 'waiting' },
  )

  function submitManualCode(): void {
    const parse = parseRef.current
    if (!parse) return
    const parsed = parse(code)
    if (!parsed.authorizationCode) {
      setError('Paste the code shown on the Anthropic page.')
      return
    }
    if (!awaitingCodeRef.current) {
      // The flow already settled — a paste now would be silently dropped.
      setError('This sign-in attempt has ended. Run /connect again to retry.')
      return
    }
    setError(null)
    setPhase('installing')
    serviceRef.current?.handleManualAuthCodeInput(parsed)
  }

  if (phase === 'starting') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        {startingMessage ? <Text>{startingMessage}</Text> : null}
        <Text bold>Starting Claude sign-in…</Text>
        <Text dimColor>Preparing a secure (PKCE) authorization request.</Text>
      </Box>
    )
  }

  if (phase === 'installing') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Finishing sign-in…</Text>
        <Text dimColor>
          Exchanging the authorization code and reading your plan.
        </Text>
        {warning ? <Text color="yellow">{warning}</Text> : null}
      </Box>
    )
  }

  if (phase === 'error') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Claude sign-in failed</Text>
        {error ? <Text color="red">{error}</Text> : null}
        {!canPasteManually ? (
          <Text dimColor>
            Run /connect → Login with Claude again to retry.
          </Text>
        ) : null}
        <Select
          options={[
            // Only offered while the flow is still waiting for a code —
            // otherwise the paste would be silently discarded.
            ...(canPasteManually
              ? [{ label: 'Paste the code manually instead', value: 'manual' }]
              : []),
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={(v: string) => {
            if (v === 'manual') {
              setError(null)
              setPhase('manual')
            } else {
              serviceRef.current?.cleanup()
              onDone(false)
            }
          }}
          onCancel={() => {
            serviceRef.current?.cleanup()
            onDone(false)
          }}
        />
      </Box>
    )
  }

  if (phase === 'manual') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Paste your authorization code</Text>
        <Text dimColor>
          Open this URL, approve access, then copy the code Anthropic shows:
        </Text>
        <Text color="cyan">{manualUrl}</Text>
        {error ? <Text color="yellow">{error}</Text> : null}
        <TextInput
          value={code}
          onChange={setCode}
          onSubmit={submitManualCode}
          placeholder="paste the code here"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  // waiting
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      {startingMessage ? <Text>{startingMessage}</Text> : null}
      <Text bold>
        {loginWithClaudeAi
          ? 'Sign in with your Claude subscription (Pro plan / Max plan)'
          : 'Sign in to the Anthropic Console'}
      </Text>
      <Text dimColor>
        A browser window should have opened. Approve access there and this
        returns automatically.
      </Text>
      <Text dimColor>If it didn&apos;t open, use this URL:</Text>
      <Text color="cyan">{manualUrl}</Text>
      <Text dimColor>
        Press m to paste the code manually (no browser), or Esc to cancel.
      </Text>
    </Box>
  )
}
