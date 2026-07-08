import * as React from 'react'
import { Box, Text } from 'src/ink.js'
import { AnimatedAsterisk } from './AnimatedAsterisk.js'
import { getActiveWelcomeBanner } from './bannerConfig.js'
import { UP_ARROW } from '../../constants/figures.js'

// First-launch brand icon: banner is data-driven (see bannerConfig.ts) so a
// future letters/design swap doesn't require touching this component.
export function WelcomeV2(): React.ReactNode {
  const { lines } = getActiveWelcomeBanner()
  return (
    <Box flexDirection="column" marginY={1}>
      {lines.map(([line, color], i) => (
        <Text key={i} bold color={color}>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text bold color="#22E063">
          Welcome to Rayu-CLI{' '}
        </Text>
        <Text dimColor>v{MACRO.VERSION}</Text>
      </Box>
      <Box paddingLeft={2}>
        <AnimatedAsterisk char={UP_ARROW} />
        <Text dimColor={true}>{" "}Welcome!, Thank You For Choosing Rayu!</Text>
      </Box>
    </Box>
  )
}
