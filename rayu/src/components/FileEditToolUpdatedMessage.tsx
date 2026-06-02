import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { count } from '../utils/array.js'
import { MessageResponse } from './MessageResponse.js'
import { StructuredDiffList } from './StructuredDiffList.js'

type Props = {
  filePath: string
  structuredPatch: StructuredPatchHunk[]
  firstLine: string | null
  fileContent?: string
  style?: 'condensed'
  verbose: boolean
  previewHint?: string
  reviewHint?: string
}

export function FileEditToolUpdatedMessage({
  filePath,
  structuredPatch,
  firstLine,
  fileContent,
  style,
  verbose,
  previewHint,
  reviewHint,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const numAdditions = structuredPatch.reduce(
    (acc, hunk) =>
      acc + count(hunk.lines as string[], line => line.startsWith('+')),
    0,
  )
  const numRemovals = structuredPatch.reduce(
    (acc, hunk) =>
      acc + count(hunk.lines as string[], line => line.startsWith('-')),
    0,
  )

  const text = (
    <Text>
      {numAdditions > 0 ? (
        <>
          Added <Text bold>{numAdditions}</Text>{' '}
          {numAdditions > 1 ? 'lines' : 'line'}
        </>
      ) : null}
      {numAdditions > 0 && numRemovals > 0 ? ', ' : null}
      {numRemovals > 0 ? (
        <>
          {numAdditions === 0 ? 'R' : 'r'}emoved{' '}
          <Text bold>{numRemovals}</Text>{' '}
          {numRemovals > 1 ? 'lines' : 'line'}
        </>
      ) : null}
    </Text>
  )

  // Plan files keep their existing preview-only behavior in regular mode.
  if (previewHint && style !== 'condensed' && !verbose) {
    return (
      <MessageResponse>
        <Text dimColor>{previewHint}</Text>
      </MessageResponse>
    )
  }

  if (!previewHint && style === 'condensed' && !verbose) {
    return text
  }

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>{text}</Text>
        <StructuredDiffList
          hunks={structuredPatch}
          dim={false}
          width={columns - 12}
          filePath={filePath}
          firstLine={firstLine}
          fileContent={fileContent}
        />
        {reviewHint ? <Text dimColor>{reviewHint}</Text> : null}
      </Box>
    </MessageResponse>
  )
}
