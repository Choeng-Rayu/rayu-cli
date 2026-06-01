// Stub: SnapshotUpdateDialog absent from the leaked tree. Agent-memory snapshot
// prompt; defaults to 'keep' via the caller's onCancel, so render nothing.
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'

export function SnapshotUpdateDialog(_props: {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  onComplete: (choice: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}): null {
  return null
}
