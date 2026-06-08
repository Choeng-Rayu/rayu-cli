import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/select.js'
import {
  getVideoModelSelection,
  setVideoModelSelection,
} from '../../utils/rayuConfig.js'
import { VIDEO_MODELS } from '../../tools/VideoGenTool/models.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

function backendLabel(backend: string): string {
  if (backend === 'vertex') return 'Vertex (Veo)'
  if (backend === 'fal') return 'fal.ai'
  return 'NVIDIA'
}

function VideoModelPicker({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const current = getVideoModelSelection()
  const options = [
    { label: 'Default (auto: NVIDIA/fal, or Vertex when configured)', value: '' },
    ...Object.values(VIDEO_MODELS).map(m => ({
      label: `${m.id}  ·  ${backendLabel(m.backend)} · ${m.capability}`,
      value: m.id,
    })),
  ]
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Video generation model</Text>
      <Text dimColor>
        Used by /image-video (GenerateVideo). Default backend is NVIDIA/fal.
        {current ? `  Current: ${current}` : ''}
      </Text>
      <Select
        options={options}
        onChange={(v: string) => {
          setVideoModelSelection(v || undefined)
          onDone(
            v ? `Video model set to ${v}` : 'Video model reset to default (NVIDIA/auto)',
          )
        }}
        onCancel={() => onDone('Video model unchanged.')}
      />
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone) => {
  return <VideoModelPicker onDone={onDone as (result?: string) => void} />
}
