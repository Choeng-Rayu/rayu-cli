import React, { useCallback, useState } from 'react'
import type { Workflow } from '../commands/install-github-app/types.js'
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../constants/github-app.js'
import type { ExitState } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Link, Text } from '../ink.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { SelectMulti } from './CustomSelect/SelectMulti.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

type WorkflowOption = {
  value: Workflow
  label: string
}

type Props = {
  onSubmit: (selectedWorkflows: Workflow[]) => void
  defaultSelections: Workflow[]
}

const WORKFLOWS: WorkflowOption[] = [
  {
    value: 'rayu',
    label: '@Rayu - Tag @rayu in trusted issue and pull-request comments',
  },
  {
    value: 'rayu-review',
    label: 'Rayu Review - Review trusted, same-repository pull requests',
  },
]

function renderInputGuide(exitState: ExitState): React.ReactNode {
  if (exitState.pending) {
    return <Text>Press {exitState.keyName} again to exit</Text>
  }
  return (
    <Byline>
      <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
      <KeyboardShortcutHint shortcut="Space" action="toggle" />
      <KeyboardShortcutHint shortcut="Enter" action="confirm" />
      <ConfigurableShortcutHint
        action="confirm:no"
        context="Confirmation"
        fallback="Esc"
        description="cancel"
      />
    </Byline>
  )
}

export function WorkflowMultiselectDialog({
  onSubmit,
  defaultSelections,
}: Props): React.ReactNode {
  const [showError, setShowError] = useState(false)
  const handleSubmit = useCallback(
    (selectedValues: Workflow[]) => {
      if (selectedValues.length === 0) {
        setShowError(true)
        return
      }
      setShowError(false)
      onSubmit(selectedValues)
    },
    [onSubmit],
  )

  return (
    <Dialog
      title="Select Rayu GitHub workflows to install"
      subtitle="A pull request will add one file for each selected workflow."
      onCancel={() => setShowError(true)}
      inputGuide={renderInputGuide}
    >
      <Box>
        <Text dimColor>
          Setup documentation:{' '}
          <Link url={GITHUB_ACTION_SETUP_DOCS_URL}>
            {GITHUB_ACTION_SETUP_DOCS_URL}
          </Link>
        </Text>
      </Box>
      <SelectMulti
        options={WORKFLOWS}
        defaultValue={defaultSelections}
        onSubmit={handleSubmit}
        onChange={() => setShowError(false)}
        onCancel={() => setShowError(true)}
        hideIndexes
      />
      {showError ? (
        <Box>
          <Text color="error">
            Select at least one workflow to continue
          </Text>
        </Box>
      ) : null}
    </Dialog>
  )
}
