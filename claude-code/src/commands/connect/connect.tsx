import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { ModelPicker } from '../../components/ModelPicker.js'
import { RayuProviderSetup } from '../../components/RayuProviderSetup.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

/**
 * /connect — pick a provider, enter its API key, then select a model from the
 * provider's live catalog. RayuProviderSetup handles provider pick + key +
 * model-catalog fetch; ModelPicker then shows the fetched models.
 */
function ConnectFlow({ onDone }: { onDone: OnDone }): React.ReactNode {
  const [phase, setPhase] = React.useState<'setup' | 'model'>('setup')
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const setAppState = useSetAppState()

  if (phase === 'setup') {
    return <RayuProviderSetup onDone={() => setPhase('model')} />
  }

  return (
    <ModelPicker
      initial={mainLoopModel}
      onSelect={(model: string | null) => {
        setAppState(prev => ({
          ...prev,
          mainLoopModel: model,
          mainLoopModelForSession: null,
        }))
        onDone(`Connected · model set to ${chalk.bold(model ?? 'default')}`)
      }}
      onCancel={() =>
        onDone('Provider connected. Model unchanged.', { display: 'system' })
      }
      isStandaloneCommand={true}
    />
  )
}

// Local-jsx commands export a `call` that returns the React node to render.
export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  return <ConnectFlow onDone={onDone} />
}

