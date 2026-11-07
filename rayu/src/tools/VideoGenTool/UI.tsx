import React from 'react'
import { Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { toRelativePath } from '../../utils/path.js'
import type { Input, Output } from './VideoGenTool.js'

export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  return input.prompt ?? ''
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  // Prefer the ACTUAL served length the gateway reported; the requested
  // frames/fps are shown only when the caller supplied both, and only as a
  // fallback. Never print fabricated frame counts.
  const meta =
    output.durationSeconds != null
      ? `${output.durationSeconds.toFixed(1)}s, ${output.model}`
      : output.frames != null && output.fps != null
        ? `${output.frames} frames @ ${output.fps}fps, ${output.model}`
        : output.model
  return (
    <MessageResponse>
      <Text>
        Saved {toRelativePath(output.path)} <Text dimColor>({meta})</Text>
      </Text>
    </MessageResponse>
  )
}
