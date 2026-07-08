import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { getActiveClawdBanner } from './bannerConfig.js'

// Pose type kept for API compatibility with AnimatedClawd; the RAYU banner is
// static so the value is ignored.
export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'

export function Clawd(_props: { pose?: ClawdPose } = {}): React.ReactNode {
  const { lines } = getActiveClawdBanner()
  return (
    <Box flexDirection="column">
      {lines.map(([line, color], i) => (
        <Text key={i} bold color={color}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
