import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/select.js'
import {
  getImageModelSelection,
  setImageModelSelection,
} from '../../utils/rayuConfig.js'
import {
  getCachedMediaModels,
  refreshMediaModels,
  type MediaCatalog,
  type MediaModelEntry,
} from '../../services/rayuAuth/mediaModels.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

/** Human name for the upstream that serves a model. */
function backendLabel(backend: string): string {
  if (backend === 'vertex') return 'Vertex (Imagen)'
  return 'NVIDIA'
}

/** "id · backend · edit" — capabilities come from the catalog, not a code list. */
function optionLabel(m: MediaModelEntry): string {
  const caps = m.capabilities.includes('edit') ? ' · edit' : ''
  return `${m.id}  ·  ${backendLabel(m.backend)}${caps}`
}

function ImageModelPicker({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const current = getImageModelSelection()
  // The catalog is SERVER-OWNED, so render whatever is cached immediately, then
  // refresh once on open: a model the admin added moments ago should appear now
  // rather than after the TTL, which otherwise reads as "the CLI didn't pick it
  // up". Mirrors refreshHostedCatalog() in the chat /model picker.
  const [catalog, setCatalog] = React.useState<MediaCatalog>(() =>
    getCachedMediaModels(),
  )
  React.useEffect(() => {
    let alive = true
    void refreshMediaModels(true).then((fresh) => {
      if (alive && fresh) setCatalog(fresh)
    })
    return () => {
      alive = false
    }
  }, [])

  const options = [
    { label: 'Default (auto: NVIDIA, or Vertex when configured)', value: '' },
    ...catalog.image.map((m) => ({ label: optionLabel(m), value: m.id })),
  ]
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Image generation model</Text>
      <Text dimColor>
        Used by /generate-image and /image-editor. Default backend is NVIDIA.
        {current ? `  Current: ${current}` : ''}
      </Text>
      {catalog.source === 'fallback' && (
        <Text dimColor>
          Showing built-in defaults — sign in to Rayu to load the full model
          catalog.
        </Text>
      )}
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
