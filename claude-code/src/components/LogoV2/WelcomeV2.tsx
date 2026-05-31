import * as React from 'react'
import { Box, Text } from 'src/ink.js'

// First-launch brand icon: "RAYU" as an ASCII-art block banner with a
// top-to-bottom green gradient.
const RAYU_LOGO: ReadonlyArray<readonly [string, string]> = [
  ['██████   █████   ██    ██ ██    ██', '#7CFFA0'],
  ['██   ██ ██   ██   ██  ██  ██    ██', '#4DF581'],
  ['██████  ███████    ████   ██    ██', '#22E063'],
  ['██   ██ ██   ██     ██    ██    ██', '#15BD4E'],
  ['██   ██ ██   ██     ██     ██████ ', '#0E9B3E'],
]

export function WelcomeV2(): React.ReactNode {
  return (
    <Box flexDirection="column" marginY={1}>
      {RAYU_LOGO.map(([line, color], i) => (
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
    </Box>
  )
}
