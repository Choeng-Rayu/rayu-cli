import * as React from 'react'
import { Box, Text } from '../../ink.js'

// Pose type kept for API compatibility with AnimatedClawd; the RAYU mark is
// static so the value is ignored.
export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'

// Compact "RAYU" brand mark (3 rows) shown beside the session header,
// replacing the legacy mascot. Green gradient to match the welcome banner.
const RAYU_MARK = ['█▀▄ ▄▀▄ █ █ █ █', '█▀▄ █▀█  █  █ █', '▀ ▀ ▀ ▀  █  ▀▀▀']
const RAYU_GREENS = ['#4DF581', '#22E063', '#0E9B3E']

export function Clawd(_props: { pose?: ClawdPose } = {}): React.ReactNode {
  return (
    <Box flexDirection="column">
      {RAYU_MARK.map((line, i) => (
        <Text key={i} bold color={RAYU_GREENS[i]}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
