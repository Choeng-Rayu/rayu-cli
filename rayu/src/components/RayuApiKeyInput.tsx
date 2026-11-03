// Shared "enter a Rayu API key" step.
//
// Used by BOTH entry points so they cannot drift apart:
//   • /connect → Rayu           (RayuProviderSetup, phase 'rayuKey')
//   • the two-option first run  (RayuFirstRunSetup)
//
// Flow: paste key → validate against the gateway → fetch the model catalog →
// persist the provider. Validation happens BEFORE anything is written, so a
// rejected key never leaves a half-configured provider behind.
//
// SECURITY: the key is masked on input, is written only by saveRayuConfig (0600),
// and is never logged or echoed — not in the error text, not in diagnostics.
import React, { useState } from 'react'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'
import { type RayuProvider, upsertProvider } from '../utils/rayuConfig.js'
import {
  RAYU_API_PROVIDER_ID,
  rayuApiAnthropicBaseURL,
} from '../utils/rayuProviders.js'
import {
  rayuApiKeyValidationMessage,
  validateRayuApiKey,
} from '../services/rayuAuth/rayuCredits.js'
import { recordRayuApiKeyValidation } from '../services/rayuAuth/rayuApiKeyAuth.js'
import { pickRayuDefaultModels } from '../services/rayuAuth/rayuModelCatalog.js'

export type RayuApiKeyOutcome =
  /** Key accepted, provider saved and made active. */
  | { status: 'connected'; models: string[] }
  /** User pressed Esc without connecting. */
  | { status: 'cancelled' }

export function RayuApiKeyInput({
  onOutcome,
  /** Rendered above the input; lets each caller set its own framing. */
  heading = 'Rayu API key',
}: {
  onOutcome: (outcome: RayuApiKeyOutcome) => void
  heading?: string
}): React.ReactNode {
  const [apiKey, setApiKey] = useState('')
  const [cursor, setCursor] = useState(0)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    const key = apiKey.trim()
    if (!key) {
      setError('Enter a key, or press Esc to go back.')
      return
    }
    setChecking(true)
    setError(null)
    try {
      // 1. Is the credential real, and does the account have anything to spend?
      const verdict = await validateRayuApiKey(key)
      recordRayuApiKeyValidation(key, verdict)
      if (verdict.status !== 'valid') {
        setError(rayuApiKeyValidationMessage(verdict))
        setChecking(false)
        return
      }

      // 2. Which models may it use? Fetched live so the dashboard is the only
      //    source of truth. A catalog failure here is NOT fatal — the key is
      //    already proven good, so save it and let /model refresh later.
      const { fetchRayuApiKeyCatalog } = await import(
        '../services/api/rayuHosted/rayuApiKeyCatalog.js'
      )
      const catalog = await fetchRayuApiKeyCatalog(key)
      const models = catalog.ok ? catalog.models : []

      // 3. Persist. The base URL is resolved here and is never optional: an empty
      //    one would let the Anthropic SDK fall back to api.anthropic.com and send
      //    this Rayu key to Anthropic.
      const provider: RayuProvider = {
        id: RAYU_API_PROVIDER_ID,
        kind: 'anthropic-compatible',
        baseURL: rayuApiAnthropicBaseURL(),
        apiKey: key,
        ...pickRayuDefaultModels(models),
        ...(models.length
          ? {
              models,
              fetchedModels: models,
              modelLabels: catalog.ok ? catalog.modelLabels : {},
              modelContextWindows: catalog.ok ? catalog.modelContextWindows : {},
            }
          : {}),
      }
      upsertProvider(provider, true)
      onOutcome({ status: 'connected', models })
    } catch {
      // validateRayuApiKey / fetchRayuApiKeyCatalog never throw, so reaching here
      // means the config write failed (unwritable ~/.rayu, full disk).
      setError('Could not save the provider. Check that ~/.rayu is writable.')
      setChecking(false)
    }
  }

  if (checking) {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Checking your Rayu API key…</Text>
        <Text dimColor>Verifying the key and loading your available models.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>{heading}</Text>
      <Text dimColor>
        Create one at rayucode.com/dashboard/api-keys. Stored locally in
        ~/.rayu/providers.json (0600).
      </Text>
      {error ? <Text color="yellow">{error}</Text> : null}
      <TextInput
        value={apiKey}
        onChange={setApiKey}
        onSubmit={() => void submit()}
        mask="*"
        placeholder="rayu_sk_live_..."
        columns={80}
        cursorOffset={cursor}
        onChangeCursorOffset={setCursor}
      />
      <Text dimColor>Enter to continue · Esc to go back</Text>
    </Box>
  )
}
