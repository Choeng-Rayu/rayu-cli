import * as React from 'react'
import { RayuProviderSetup } from '../../components/RayuProviderSetup.js'
import { SearchableModelPicker } from '../../components/SearchableModelPicker.js'
import type {
  CommandResultDisplay,
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import { runPostAuthChangeRefresh } from '../../utils/postAuthRefresh.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

/**
 * /connect — pick a provider, authenticate it (API key, or a browser sign-in for
 * the OAuth providers such as "Login with Claude (Pro plan / Max plan)"), then
 * search/select a model from the provider's live catalog.
 */
function ConnectFlow({
  onDone,
  onAuthChanged,
}: {
  onDone: OnDone
  /** Invoked when the setup step signed the session in or out. */
  onAuthChanged: () => void
}): React.ReactNode {
  const [phase, setPhase] = React.useState<'setup' | 'model'>('setup')
  if (phase === 'setup') {
    return (
      <RayuProviderSetup
        onDone={info => {
          if (info?.authChanged) onAuthChanged()
          setPhase('model')
        }}
      />
    )
  }
  return <SearchableModelPicker onDone={onDone as never} />
}

// Local-jsx commands export a `call` that returns the React node to render.
export const call: LocalJSXCommandCall = async (onDone, context, _args) => {
  return (
    <ConnectFlow
      onDone={onDone}
      onAuthChanged={() => handleAuthChanged(context)}
    />
  )
}

/**
 * A provider sign-in/out changed the session's identity. Signature-bearing
 * blocks (thinking, connector_text) are bound to the credential that produced
 * them, so they must be stripped before the next turn — otherwise the new
 * credential rejects stale signatures. Then run the shared refresh sequence.
 * Mirrors the /login post-success contract.
 */
function handleAuthChanged(context: LocalJSXCommandContext): void {
  context.onChangeAPIKey()
  context.setMessages(stripSignatureBlocks)
  runPostAuthChangeRefresh(context, { enrollDevice: true })
}
