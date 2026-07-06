// Add / list / remove multiple API keys for a multi-key provider (NVIDIA /
// OpenRouter) during /connect. Used only when the Basic-plan multi-key
// entitlement is granted (see isMultiApiKeyAllowed); Free users get the plain
// single-key input in RayuProviderSetup instead.
//
// The request path (openaiAdapter withKeyRotation) rotates to the next stored
// key when one hits its rate limit, so storing several keys gives automatic
// failover. This manager doubles as an editor: re-running /connect for the
// provider loads the existing keys so the user can add, remove, or replace them.
//
// SECURITY: keys are secrets — masked on display (first4…last4), never logged,
// and persisted to the 0600 providers.json by the caller.
import React, { useState } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import TextInput from './TextInput.js'
import { PRODUCT_NAME } from '../constants/product.js'

/** Mask a secret for display: `nvap…1a2b` for long keys, dots for short ones. */
export function maskApiKey(key: string): string {
  const k = key.trim()
  if (k.length <= 8) return '•'.repeat(Math.max(3, k.length))
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}

type Mode = 'list' | 'add' | 'remove'

export function MultiApiKeyManager({
  providerLabel,
  maxKeys,
  initialKeys,
  onDone,
  onCancel,
}: {
  providerLabel: string
  maxKeys: number
  initialKeys: string[]
  /** Called with the final ordered key list when the user is done. */
  onDone: (keys: string[]) => void
  onCancel: () => void
}): React.ReactNode {
  const [keys, setKeys] = useState<string[]>(() =>
    initialKeys.map(k => k.trim()).filter(Boolean),
  )
  // Start in "add" when there are no keys yet (onboarding), else show the list.
  const [mode, setMode] = useState<Mode>(initialKeys.length ? 'list' : 'add')
  const [draft, setDraft] = useState('')
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const canAddMore = keys.length < maxKeys

  if (mode === 'add') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Add an API key for {providerLabel}</Text>
        <Text dimColor>
          Key {keys.length + 1} of up to {maxKeys}. Stored locally in
          ~/.rayu/providers.json (0600).{' '}
          {keys.length
            ? 'Enter to add · empty to finish.'
            : 'Paste the key and press Enter.'}
        </Text>
        {error ? <Text color="yellow">{error}</Text> : null}
        <TextInput
          value={draft}
          onChange={setDraft}
          onSubmit={() => {
            const k = draft.trim()
            if (!k) {
              // Empty submit: finish if we have at least one key, else cancel.
              if (keys.length) setMode('list')
              else onCancel()
              return
            }
            if (keys.includes(k)) {
              setError('That key is already added.')
              return
            }
            setKeys([...keys, k])
            setDraft('')
            setCursor(0)
            setError(null)
            setMode('list')
          }}
          mask="*"
          placeholder="paste API key (e.g. nvapi-… / sk-or-…)"
          columns={80}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
    )
  }

  if (mode === 'remove') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Remove an API key for {providerLabel}</Text>
        <Text dimColor>Select a key to delete. This cannot be undone.</Text>
        <Select
          options={[
            ...keys.map((k, i) => ({
              label: `Delete key ${i + 1} — ${maskApiKey(k)}`,
              value: String(i),
            })),
            { label: '← Back', value: 'back' },
          ]}
          onChange={(v: string) => {
            if (v === 'back') {
              setMode('list')
              return
            }
            const idx = parseInt(v, 10)
            const next = keys.filter((_, i) => i !== idx)
            setKeys(next)
            // Drop straight back to adding when the last key was removed.
            setMode(next.length ? 'list' : 'add')
          }}
          onCancel={() => setMode('list')}
        />
      </Box>
    )
  }

  // list mode
  const options = [
    ...(canAddMore
      ? [{ label: `Add another key  (${keys.length}/${maxKeys})`, value: 'add' }]
      : []),
    ...(keys.length ? [{ label: 'Remove / delete a key', value: 'remove' }] : []),
    {
      label: `Done — save ${keys.length} key${keys.length === 1 ? '' : 's'}`,
      value: 'done',
    },
    { label: 'Cancel', value: 'cancel' },
  ]

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>API keys for {providerLabel}</Text>
      <Text dimColor>
        {PRODUCT_NAME} rotates to the next key automatically when one hits its
        rate limit (HTTP 429). Store up to {maxKeys}.
      </Text>
      <Box flexDirection="column">
        {keys.length === 0 ? (
          <Text dimColor>No keys stored yet.</Text>
        ) : (
          keys.map((k, i) => (
            <Text key={`${i}-${k.slice(-4)}`}>
              {'  '}
              {i + 1}. {maskApiKey(k)}
            </Text>
          ))
        )}
      </Box>
      {!canAddMore ? (
        <Text dimColor>
          Reached the {maxKeys}-key limit (set NUMBER_API_KEYS_STORE to change).
        </Text>
      ) : null}
      <Select
        options={options}
        onChange={(v: string) => {
          if (v === 'add') {
            setDraft('')
            setCursor(0)
            setError(null)
            setMode('add')
          } else if (v === 'remove') {
            setMode('remove')
          } else if (v === 'done') {
            onDone(keys)
          } else {
            onCancel()
          }
        }}
        onCancel={onCancel}
      />
    </Box>
  )
}
