import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import type { OptionWithDescription } from '../../components/CustomSelect/select.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  hasRayuSession,
  isUseRayuOAuthEnabled,
} from '../../services/rayuAuth/rayuSession.js'
import {
  RAYU_FEEDBACK_MAX_MESSAGE,
  submitRayuFeedback,
  type RayuFeedbackType,
} from '../../services/rayuAuth/rayuFeedback.js'

/**
 * The exact login gate the other account commands use: /feedback needs a Rayu
 * account session (a JWT), so a signed-out user is told how to sign in rather
 * than being shown a composer that would fail on submit.
 */
const NOT_SIGNED_IN = 'Not signed in. Run /login to send feedback.'

/** Step 1 — what kind of feedback this is. */
const TYPE_OPTIONS: OptionWithDescription<string>[] = [
  { value: 'bug', label: 'Bug', description: 'Something is broken or misbehaves' },
  { value: 'idea', label: 'Idea', description: 'A feature request or improvement' },
  { value: 'other', label: 'Other', description: 'Anything else' },
]

/** Step 3 — optional rating. The last entry submits without one. */
const RATING_OPTIONS: OptionWithDescription<string>[] = [
  { value: '5', label: '5', description: 'Excellent' },
  { value: '4', label: '4', description: 'Good' },
  { value: '3', label: '3', description: 'Okay' },
  { value: '2', label: '2', description: 'Poor' },
  { value: '1', label: '1', description: 'Terrible' },
  { value: 'skip', label: 'Skip', description: 'No rating' },
]

type Phase = 'type' | 'message' | 'rating' | 'submitting'

function FeedbackFlow({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>('type')
  const [type, setType] = useState<RayuFeedbackType>('bug')
  const [message, setMessage] = useState('')
  const [rating, setRating] = useState<number | undefined>(undefined)
  const finished = useRef(false)

  /** Resolve the command exactly once (submitted, failed, or esc-cancelled). */
  const finish = (result: string): void => {
    if (finished.current) return
    finished.current = true
    onDone(result)
  }

  // Submit exactly once, after the optional-rating step resolves — so a "skip"
  // and a rating share this single call site. `rating` is in the dep list because
  // it is set in the same handler that flips `phase` to 'submitting'.
  useEffect(() => {
    if (phase !== 'submitting') return
    let alive = true
    void (async () => {
      const result = await submitRayuFeedback({
        type,
        message,
        rating,
        source: 'cli',
      })
      if (!alive) return
      finish(
        result.ok
          ? 'Thanks — your feedback was sent to the Rayu team.'
          : `Could not send feedback: ${result.error}`,
      )
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, rating])

  // Esc abandons the flow at any step.
  useKeybinding('confirm:no', () => finish('Feedback canceled.'), {
    context: 'Confirmation',
  })

  const header = (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>Send feedback</Text>
      <Text dimColor>
        Your message goes to the Rayu team — nothing is shared with third parties.
      </Text>
    </Box>
  )

  if (phase === 'type') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        {header}
        <Text>What kind of feedback is this?</Text>
        <Select
          options={TYPE_OPTIONS}
          inlineDescriptions
          onChange={(v: string) => {
            setType(v as RayuFeedbackType)
            setPhase('message')
          }}
          onCancel={() => finish('Feedback canceled.')}
        />
        <Text dimColor>(press esc to cancel)</Text>
      </Box>
    )
  }

  if (phase === 'message') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        {header}
        <Text>Describe it (Enter to continue, ctrl+g for an editor):</Text>
        <Select
          options={[
            {
              type: 'input',
              label: 'Message',
              value: 'message',
              placeholder: 'Tell us what happened…',
              onChange: (raw: string) => {
                setMessage(raw)
                setPhase('rating')
              },
            },
          ]}
          onCancel={() => finish('Feedback canceled.')}
        />
        <Text dimColor>
          Up to {RAYU_FEEDBACK_MAX_MESSAGE.toLocaleString()} characters.
        </Text>
      </Box>
    )
  }

  if (phase === 'rating') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        {header}
        <Text>How would you rate RayuCode overall? (optional)</Text>
        <Select
          options={RATING_OPTIONS}
          inlineDescriptions
          onChange={(v: string) => {
            setRating(v === 'skip' ? undefined : Number.parseInt(v, 10))
            setPhase('submitting')
          }}
          onCancel={() => finish('Feedback canceled.')}
        />
        <Text dimColor>(press esc to cancel)</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text dimColor>Sending your feedback…</Text>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  if (!isUseRayuOAuthEnabled() || !hasRayuSession()) {
    onDone(NOT_SIGNED_IN)
    return null
  }
  return <FeedbackFlow onDone={onDone as (result?: string) => void} />
}
