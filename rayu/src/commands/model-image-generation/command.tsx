import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/select.js'
import {
  getImageModelSelection,
  setImageModelSelection,
} from '../../utils/rayuConfig.js'
import { IMAGE_MODELS } from '../../tools/ImageGenTool/models.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

function backendLabel(provider?: string): string {
  return provider === 'vertex' ? 'Vertex (Imagen)' : 'NVIDIA'
}

function ImageModelPicker({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const current = getImageModelSelection()
  const options = [
    { label: 'Default (auto: NVIDIA, or Vertex when configured)', value: '' },
    ...Object.values(IMAGE_MODELS).map(m => ({
      label: `${m.id}  ·  ${backendLabel(m.provider)}${m.capability === 'edit' ? ' · edit' : ''}`,
      value: m.id,
    })),
  ]
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Image generation model</Text>
      <Text dimColor>
        Used by /generate-image and /image-editor. Default backend is NVIDIA.
        {current ? `  Current: ${current}` : ''}
      </Text>
      <Select
        options={options}
        onChange={(v: string) => {
          setImageModelSelection(v || undefined)
          onDone(
            v ? `Image model set to ${v}` : 'Image model reset to default (NVIDIA/auto)',
          )
        }}
        onCancel={() => onDone('Image model unchanged.')}
      />
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone) => {
  return <ImageModelPicker onDone={onDone as (result?: string) => void} />
}
