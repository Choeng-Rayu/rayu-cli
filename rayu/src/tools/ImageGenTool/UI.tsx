import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import { RawAnsi } from '../../ink/components/RawAnsi.js'
import { toRelativePath } from '../../utils/path.js'
import type { Input, Output } from './ImageGenTool.js'
import { decodeImage, imageToAnsiLines } from './terminalImage.js'

export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  return input.prompt ?? ''
}

/** Truecolor ANSI half-block preview of the generated image (persists in scrollback). */
function ImagePreview({ output }: { output: Output }): React.ReactNode {
  const img = output.base64
    ? decodeImage(Buffer.from(output.base64, 'base64'), output.mediaType)
    : null
  if (!img) return null
  const maxCols = Math.max(16, Math.min(64, (process.stdout.columns || 80) - 4))
  const { lines, width } = imageToAnsiLines(img, maxCols)
  if (lines.length === 0) return null
  return <RawAnsi lines={lines} width={width} />
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  const preview = ImagePreview({ output })
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          Saved {toRelativePath(output.path)}{' '}
          <Text dimColor>
            ({output.width}×{output.height}, {output.model})
          </Text>
        </Text>
        {preview}
        {preview && (
          <Text dimColor>
            Low-res preview — open {toRelativePath(output.path)} in an image
            viewer for full resolution (hi-res terminal rendering coming soon).
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}
