// Stub: AssistantSessionChooser dialog absent from the leaked tree. The bridge/
// remote "assistant" session feature is infra-gated; render nothing.
import type { AssistantSession } from './sessionDiscovery.js'

export function AssistantSessionChooser(_props: {
  sessions: AssistantSession[]
  onSelect: (id: string) => void
  onCancel: () => void
}): null {
  return null
}
