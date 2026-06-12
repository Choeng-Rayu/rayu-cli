import type {
  ThinkingBlock,
  ThinkingBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import figures from 'figures'
import React from 'react'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'

type Props = {
  // Accept either full ThinkingBlock/ThinkingBlockParam or a minimal shape with just type and thinking
  param:
    | ThinkingBlock
    | ThinkingBlockParam
    | {
        type: 'thinking'
        thinking: string
      }
  addMargin: boolean
  isTranscriptMode: boolean
  verbose: boolean
  /** When true, hide this thinking block entirely (used for past thinking in transcript mode) */
  hideInTranscript?: boolean
  /**
   * True while the model is actively streaming this thinking block. Drives the
   * in-progress → done transition: an animated dot-matrix "⣿ Thinking…" while
   * reasoning, then a green "✓ Thought" once the block is complete.
   */
  isThinking?: boolean
}

// Animated dot-matrix "pulse" for the in-progress thinking icon — the same
// braille breathing glyph as the loading spinner (reference SVG). Light icon
// color (--on: #F5F5F5); ~120ms/frame ≈ a 1.2s cycle.
const THINK_PULSE = ['\u2801', '\u2807', '\u2837', '\u287F', '\u28FF'] // ⠁ ⠇ ⠷ ⡿ ⣿
const THINK_FRAMES = [...THINK_PULSE, ...[...THINK_PULSE].reverse()]
const THINK_ICON_COLOR = '#F5F5F5'

/** Animated "⣿ Thinking…" header shown while the model is still reasoning. */
function ThinkingHeader(): React.ReactNode {
  const reducedMotion =
    (useAppState((s: { settings?: { prefersReducedMotion?: boolean } }) => s?.settings?.prefersReducedMotion) as
      | boolean
      | undefined) ?? false
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 120)
  const icon = reducedMotion
    ? '\u28FF'
    : THINK_FRAMES[Math.floor(time / 120) % THINK_FRAMES.length]
  return (
    <Box ref={ref} flexDirection="row">
      <Text color={THINK_ICON_COLOR}>{icon}</Text>
      <Text dimColor italic>
        {' '}
        Thinking{'\u2026'}
      </Text>
    </Box>
  )
}

/** Completed "✓ Thought" header shown once reasoning has finished. */
function ThoughtHeader(): React.ReactNode {
  return <Text color="green">{figures.tick} Thought</Text>
}

export function AssistantThinkingMessage({
  param: { thinking },
  addMargin = false,
  isTranscriptMode,
  verbose,
  hideInTranscript = false,
  isThinking = false,
}: Props): React.ReactNode {
  if (!thinking) {
    return null
  }
  if (hideInTranscript) {
    return null
  }

  const shouldShowFullThinking = isTranscriptMode || verbose

  // Collapsed one-liner (default view): status + a hint to expand. The live
  // streaming view always uses the expanded path below (where the icon
  // animates), so this static icon is only seen for completed blocks.
  if (!shouldShowFullThinking) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        {isThinking ? (
          <Text dimColor italic>
            {'\u2234'} Thinking{'\u2026'} <CtrlOToExpand />
          </Text>
        ) : (
          <Text>
            <Text color="green">{figures.tick} Thought</Text> <CtrlOToExpand />
          </Text>
        )}
      </Box>
    )
  }

  // Expanded view (transcript / verbose / live streaming): status header + the
  // reasoning text, dimmed and indented so it reads as a distinct block.
  return (
    <Box flexDirection="column" gap={1} marginTop={addMargin ? 1 : 0} width="100%">
      {isThinking ? <ThinkingHeader /> : <ThoughtHeader />}
      <Box paddingLeft={2}>
        <Markdown dimColor>{thinking}</Markdown>
      </Box>
    </Box>
  )
}
