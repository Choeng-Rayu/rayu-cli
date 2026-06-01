import React from 'react'
import { Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { toRelativePath } from '../../utils/path.js'
import type { Input, Output } from './VideoGenTool.js'

export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  return input.prompt ?? ''
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        Saved {toRelativePath(output.path)}{' '}
        <Text dimColor>
          ({output.frames} frames @ {output.fps}fps, {output.model})
        </Text>
      </Text>
    </MessageResponse>
  )
}
