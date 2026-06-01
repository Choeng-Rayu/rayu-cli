import * as React from 'react'
import { Box, Text } from 'src/ink.js'

// First-launch brand icon: "RAYU" in the ANSI Shadow figlet style with a
// top-to-bottom green gradient.
const RAYU_BANNER: ReadonlyArray<readonly [string, string]> = [
  ['██████╗  █████╗ ██╗   ██╗██╗   ██╗', '#cfff7c'],
  ['██╔══██╗██╔══██╗╚██╗ ██╔╝██║   ██║', '#5BF58D'],
  ['██████╔╝███████║ ╚████╔╝ ██║   ██║', '#ea1ddc'],
  ['██╔══██╗██╔══██║  ╚██╔╝  ██║   ██║', '#592af2'],
  ['██║  ██║██║  ██║   ██║   ╚██████╔╝', '#64b815'],
  ['╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ', '#001495'],
]

export function WelcomeV2(): React.ReactNode {
  return (
    <Box flexDirection="column" marginY={1}>
      {RAYU_BANNER.map(([line, color], i) => (
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
