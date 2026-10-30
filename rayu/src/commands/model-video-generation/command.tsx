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
} from '../../services/rayuAuth/mediaModels.js'
import {
  describeMediaModel,
  mediaCatalogNotice,
  orderMediaModelsForPicker,
} from '../../services/rayuAuth/mediaModelPicker.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

function VideoModelPicker({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const current = getVideoModelSelection()
  // Server-owned catalog: render the cached copy at once, then fetch it again on
  // open so a model the admin just added, renamed or reordered shows up without
  // waiting out the TTL.
  const [catalog, setCatalog] = React.useState<MediaCatalog>(() =>
    getCachedMediaModels(),
  )
  // null while the on-open fetch is in flight, then whether it succeeded.
  const [refreshed, setRefreshed] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    let alive = true
    void refreshMediaModels(true).then((fresh) => {
      if (!alive) return
      if (fresh) setCatalog(fresh)
      setRefreshed(fresh !== null)
    })
    return () => {
      alive = false
    }
  }, [])

  const options = [
    {
      label: 'Default (auto: Rayu-hosted when signed in, else fal.ai / Vertex Veo)',
      value: '',
    },
    ...orderMediaModelsForPicker(catalog.video).map((m) => ({
      label: m.id,
      value: m.id,
      description: describeMediaModel(m),
    })),
  ]
  const notice =
    refreshed === null
      ? 'Loading the latest models from Rayu…'
      : mediaCatalogNotice(catalog, refreshed)
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Video generation model</Text>
      <Text dimColor>
        Used by /image-video (GenerateVideo). Signed-in Rayu users get a hosted
        model by default (no key needed, billed per second in Rayu credits): the
        first one in the order set by your Rayu admin that matches the
        operation, text-to-video for a prompt or image2video when a reference
        image is supplied. Pick a fal.ai or Vertex Veo model here to use your
        own key instead.
        {current ? `  Current: ${current}` : ''}
      </Text>
      {notice ? <Text dimColor>{notice}</Text> : null}
      <Select
        options={options}
        onChange={(v: string) => {
          setVideoModelSelection(v || undefined)
          onDone(
            v
              ? `Video model set to ${v}`
              : 'Video model reset to default (Rayu-hosted when signed in)',
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
