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
} from '../../services/rayuAuth/mediaModels.js'
import {
  describeMediaModel,
  EMPTY_HOSTED_IMAGE_PICKER_NOTE,
  hostedImagePickerModels,
  mediaCatalogNotice,
} from '../../services/rayuAuth/mediaModelPicker.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

function ImageModelPicker({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const current = getImageModelSelection()
  // The catalog is SERVER-OWNED, so render whatever is cached immediately, then
  // fetch it again on open: a model the admin added, renamed or reordered
  // moments ago should appear now rather than after the TTL. Mirrors the
  // on-open refresh of the chat /model picker.
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

  const hosted = hostedImagePickerModels(catalog.image)
  const options = [
    {
      // The unset sentinel: keep it neutral rather than promising a hosted model
      // that may not exist — the note below already explains an empty list.
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
      <Text bold>Image generation model</Text>
      <Text dimColor>
        Used by /generate-image and /image-editor. These are the Rayu-hosted
        models your Rayu admin publishes (no provider key needed, billed in Rayu
        credits), in the admin's order; the default is the first one that can do
        the request. Sign in (/login) or connect a Rayu API key to see them.
        {current ? `  Current: ${current}` : ''}
      </Text>
      {notice ? <Text dimColor>{notice}</Text> : null}
      {hosted.length === 0 && !notice ? (
        <Text dimColor>{EMPTY_HOSTED_IMAGE_PICKER_NOTE}</Text>
      ) : null}
      <Select
        options={options}
        onChange={(v: string) => {
          setImageModelSelection(v || undefined)
          onDone(
            v
              ? `Image model set to ${v}`
              : 'Image model reset to default (the first Rayu-hosted model available)',
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
