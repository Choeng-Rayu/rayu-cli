import type { LocalCommandCall } from '../../types/command.js'
import {
  undoAllPendingFileChanges,
  undoLatestPendingFileChange,
} from '../../utils/pendingFileChanges.js'

export const call: LocalCommandCall = async (args, context) => {
  // `/undo all` undoes every pending change; `/undo [file]` undoes a file;
  // `/undo` undoes the latest single change.
  const isAll = args.trim().toLowerCase() === 'all'
  return {
    type: 'text',
    value: isAll
      ? await undoAllPendingFileChanges(context)
      : await undoLatestPendingFileChange(context, args),
  }
}
