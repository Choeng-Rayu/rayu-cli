import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { RayuProviderSetup } from '../../components/RayuProviderSetup.js'
import { SearchableModelPicker } from '../../components/SearchableModelPicker.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

/**
 * /connect — pick a provider, enter its API key, then search/select a model
 * from the provider's live catalog (across all connected providers).
 */
function ConnectFlow({ onDone }: { onDone: OnDone }): React.ReactNode {
  const [phase, setPhase] = React.useState<'setup' | 'model'>('setup')
  if (phase === 'setup') {
    return <RayuProviderSetup onDone={() => setPhase('model')} />
  }
  return <SearchableModelPicker onDone={onDone as never} />
}

// Local-jsx commands export a `call` that returns the React node to render.
export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  return <ConnectFlow onDone={onDone} />
}

