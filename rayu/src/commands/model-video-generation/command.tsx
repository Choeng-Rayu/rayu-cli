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
  emptyHostedPickerNote,
  hostedPickerModels,
  mediaCatalogNotice,
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

  const hosted = hostedPickerModels(catalog.video)
  const options = [
    {
      label: 'Default (auto)',
      value: '',
    },
    ...hosted.map((m) => ({
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
        Used by /image-video (GenerateVideo). These are the Rayu-hosted video
        models your Rayu admin publishes (no provider key needed, billed per
        second in Rayu credits), in the admin's order; the default is the first
        one that matches the operation — text-to-video for a prompt, image2video
        when a reference image is supplied. Sign in (/login) or connect a Rayu
        API key to see them.
        {current ? `  Current: ${current}` : ''}
      </Text>
      {notice ? <Text dimColor>{notice}</Text> : null}
      {hosted.length === 0 && !notice ? (
        <Text dimColor>{emptyHostedPickerNote('video')}</Text>
      ) : null}
      <Select
        options={options}
        onChange={(v: string) => {
          setVideoModelSelection(v || undefined)
          onDone(
            v
              ? `Video model set to ${v}`
              : 'Video model reset to default (the first Rayu-hosted model available)',
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
