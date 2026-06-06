import React from 'react'
import { Box, Text } from '../ink.js'

type Props = {
  onDone(): void
  startingMessage?: string
}

export function ConsoleOAuthFlow({
  onDone,
  startingMessage,
}: Props): React.ReactNode {
  void onDone

  return (
    <Box flexDirection="column" gap={1}>
      {startingMessage ? <Text>{startingMessage}</Text> : null}
      <Text color="warning">OAuth login is not supported in Rayu.</Text>
      <Text>
        Configure providers with /connect or edit ~/.rayu/providers.json.
      </Text>
    </Box>
  )
}
