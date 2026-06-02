import type { LocalCommandCall } from '../../types/command.js'
import { keepPendingFileChanges } from '../../utils/pendingFileChanges.js'

export const call: LocalCommandCall = async (args, context) => {
  return {
    type: 'text',
    value: keepPendingFileChanges(context, args),
  }
}
