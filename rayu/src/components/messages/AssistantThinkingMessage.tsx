import type {
  ThinkingBlock,
  ThinkingBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import figures from 'figures'
import React from 'react'
import { Box, Text } from '../../ink.js'
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
   * True while the model is still streaming this thinking block. Drives the
   * in-progress → done transition: dim "∴ Thinking…" while reasoning, then a
   * green "✓ Thought" once the block is complete.
   */
  isThinking?: boolean
}

/** In-progress reasoning header: dim, italic "∴ Thinking…". */
function ThinkingHeader(): React.ReactNode {
  return (
    <Text dimColor italic>
      {'\u2234'} Thinking{'\u2026'}
    </Text>
  )
}

/** Completed reasoning header: green "✓ Thought". */
function ThoughtHeader(): React.ReactNode {
  return (
    <Text color="green">
      {figures.tick} Thought
    </Text>
  )
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

  // Collapsed one-liner (default view): just the status + a hint to expand.
  if (!shouldShowFullThinking) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        {isThinking ? (
          <Text dimColor italic>
            {'\u2234'} Thinking{'\u2026'} <CtrlOToExpand />
          </Text>
        ) : (
          <Text>
            <Text color="green">{figures.tick} Thought</Text>{' '}
            <CtrlOToExpand />
          </Text>
        )}
      </Box>
    )
  }

  // Expanded view (transcript / verbose): status header + the reasoning text,
  // dimmed and indented so it reads as a distinct, secondary "thinking" block.
  return (
    <Box flexDirection="column" gap={1} marginTop={addMargin ? 1 : 0} width="100%">
      {isThinking ? <ThinkingHeader /> : <ThoughtHeader />}
      <Box paddingLeft={2}>
        <Markdown dimColor>{thinking}</Markdown>
      </Box>
    </Box>
  )
}
