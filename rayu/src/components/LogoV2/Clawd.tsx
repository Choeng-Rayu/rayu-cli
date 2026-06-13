import * as React from 'react'
import { Box, Text } from '../../ink.js'

// Pose type kept for API compatibility with AnimatedClawd; the RAYU banner is
// static so the value is ignored.
export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'

// "RAYU" in the ANSI Shadow figlet style, with a top-to-bottom green gradient.
const RAYU_BANNER: ReadonlyArray<readonly [string, string]> = [
  ['██████╗  █████╗ ██╗   ██╗██╗   ██╗', '#ff7cda'],
  ['██╔══██╗██╔══██╗╚██╗ ██╔╝██║   ██║', '#a35bf5'],
  ['██████╔╝███████║ ╚████╔╝ ██║   ██║', '#3DE877'],
  ['██╔══██╗██╔══██║  ╚██╔╝  ██║   ██║', '#2822d0'],
  ['██║  ██║██║  ██║   ██║   ╚██████╔╝', '#84b815'],
  ['╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ', '#9b0e84'],
]

export function Clawd(_props: { pose?: ClawdPose } = {}): React.ReactNode {
  return (
    <Box flexDirection="column">
      {RAYU_BANNER.map(([line, color], i) => (
        <Text key={i} bold color={color}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
