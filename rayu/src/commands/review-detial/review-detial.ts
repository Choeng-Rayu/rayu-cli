import type { LocalCommandCall } from '../../types/command.js'
import { getPendingFileChangeReviewDetail } from '../../utils/pendingFileChanges.js'

export const call: LocalCommandCall = async (args, context) => {
  return {
    type: 'text',
    value: getPendingFileChangeReviewDetail(context, args),
  }
}
