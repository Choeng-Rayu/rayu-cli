import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/select.js'
import {
  getVideoModelSelection,
  setVideoModelSelection,
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
  if (backend === 'vertex') return 'Vertex (Veo)'
  if (backend === 'fal') return 'fal.ai'
  return 'NVIDIA'
}

/** "id · backend · text2video,image2video" — all of it from the catalog. */
function optionLabel(m: MediaModelEntry): string {
  return `${m.id}  ·  ${backendLabel(m.backend)} · ${m.capabilities.join(', ')}`
}

function VideoModelPicker({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const current = getVideoModelSelection()
  // Server-owned catalog: render the cached copy at once, then refresh so a model
  // the admin just added shows up without waiting out the TTL.
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
    { label: 'Default (auto: NVIDIA/fal, or Vertex when configured)', value: '' },
    ...catalog.video.map((m) => ({ label: optionLabel(m), value: m.id })),
  ]
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Video generation model</Text>
      <Text dimColor>
        Used by /image-video (GenerateVideo). Default backend is NVIDIA/fal.
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
