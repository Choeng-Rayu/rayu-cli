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
  /**
   * When true (and not in verbose/transcript mode), render a compact preview
   * while the model is actively thinking: the animated header + only the last
   * few lines of reasoning + a "(ctrl+o to expand)" hint — mirroring how the
   * Bash tool shows a short tail of output while running. The full reasoning
   * stays available in the ctrl+o transcript view. Once thinking completes,
   * this collapses to the one-line "✓ Thought" summary.
   */
  liveStreamingPreview?: boolean
}

// Animated dot-matrix "pulse" for the in-progress thinking icon — the same
// braille breathing glyph as the loading spinner (reference SVG). Light icon
// color (--on: #F5F5F5); ~120ms/frame ≈ a 1.2s cycle.
const THINK_PULSE = ['\u2801', '\u2807', '\u2837', '\u287F', '\u28FF'] // ⠁ ⠇ ⠷ ⡿ ⣿
const THINK_FRAMES = [...THINK_PULSE, ...[...THINK_PULSE].reverse()]
const THINK_ICON_COLOR = '#F5F5F5'

// Number of trailing reasoning lines shown in the compact live-streaming
// preview while the model is actively thinking. The full reasoning stays
// available via the ctrl+o transcript. Mirrors the Bash tool's short tail.
const THINKING_PREVIEW_LINES = 3

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
  liveStreamingPreview = false,
}: Props): React.ReactNode {
  if (!thinking) {
    return null
  }
  if (hideInTranscript) {
    return null
  }

  const shouldShowFullThinking = isTranscriptMode || verbose

  // Live streaming preview: while the model is actively thinking, show a
  // compact, fixed-height tail of the reasoning (the last few lines) instead
  // of the whole block, so a long chain-of-thought never floods the screen or
  // pushes the turn-completion status out of view. Mirrors the Bash tool's
  // "last N lines + (ctrl+o to expand)" pattern. The full reasoning stays
  // available in the ctrl+o transcript / verbose views. Once thinking
  // finishes, this falls through to the collapsed "✓ Thought" one-liner below.
  if (liveStreamingPreview && isThinking && !shouldShowFullThinking) {
    const previewLines = thinking
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.length > 0)
      .slice(-THINKING_PREVIEW_LINES)
    const preview = previewLines.join('\n')
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width="100%">
        <ThinkingHeader />
        <Box paddingLeft={2} flexDirection="column">
          {preview ? (
            <Box
              height={Math.min(THINKING_PREVIEW_LINES, previewLines.length)}
              flexDirection="column"
              overflow="hidden"
            >
              <Text dimColor>{preview}</Text>
            </Box>
          ) : null}
          <Text dimColor italic>
            <CtrlOToExpand />
          </Text>
        </Box>
      </Box>
    )
  }

  // Collapsed one-liner: status + a hint to expand. Shown for completed
  // thinking blocks (including the just-finished live block, which lingers
  // briefly) in the default, non-verbose view.
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

  // Expanded view (transcript / verbose): status header + the full reasoning
  // text, dimmed and indented so it reads as a distinct block.
  return (
    <Box flexDirection="column" gap={1} marginTop={addMargin ? 1 : 0} width="100%">
      {isThinking ? <ThinkingHeader /> : <ThoughtHeader />}
      <Box paddingLeft={2}>
        <Markdown dimColor>{thinking}</Markdown>
      </Box>
    </Box>
  )
}
