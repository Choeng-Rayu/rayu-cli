import * as React from 'react'
import { UP_ARROW } from '../../constants/figures.js'
import { Box, Text } from '../../ink.js'
import { AnimatedAsterisk } from './AnimatedAsterisk.js'

/**
 * Friendly thank-you tagline shown directly under the logo (model · provider ·
 * cwd) on launch. Always rendered — replaces the upstream Claude-specific
 * "Opus 1m merge" notice, which isn't relevant to Rayu.
 */
export function WelcomeTagline(): React.ReactNode {
  return (
    <Box paddingLeft={2}>
      <AnimatedAsterisk char={UP_ARROW} />
      <Text dimColor={true}>{' '}Welcome!, Thank You For Choosing Rayu!</Text>
    </Box>
  )
}
