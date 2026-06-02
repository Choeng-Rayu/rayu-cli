import type { LocalCommandCall } from '../../types/command.js'
import { undoLatestPendingFileChange } from '../../utils/pendingFileChanges.js'

export const call: LocalCommandCall = async (args, context) => {
  return {
    type: 'text',
    value: await undoLatestPendingFileChange(context, args),
  }
}
