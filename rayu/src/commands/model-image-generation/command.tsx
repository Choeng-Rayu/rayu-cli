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
  mediaCatalogNotice,
  orderMediaModelsForPicker,
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

  const options = [
    {
      label: 'Default (auto: Rayu-hosted when signed in, else Vertex Imagen)',
      value: '',
    },
    ...orderMediaModelsForPicker(catalog.image).map((m) => ({
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
        Used by /generate-image and /image-editor. Signed-in Rayu users get a
        hosted model by default (no key needed, billed in Rayu credits): the
        first one in the order set by your Rayu admin that can do the request.
        Pick a Vertex Imagen model here to use your own Google Cloud project
        instead.
        {current ? `  Current: ${current}` : ''}
      </Text>
      {notice ? <Text dimColor>{notice}</Text> : null}
      <Select
        options={options}
        onChange={(v: string) => {
          setImageModelSelection(v || undefined)
          onDone(
            v
              ? `Image model set to ${v}`
              : 'Image model reset to default (Rayu-hosted when signed in)',
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
