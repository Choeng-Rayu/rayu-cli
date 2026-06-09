import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { resolvePendingFileChangeReview } from '../../utils/pendingFileChanges.js'

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const result = resolvePendingFileChangeReview(context, args ?? '')
  if (result.type === 'message') {
    onDone(result.message, { display: 'system' })
    return null
  }
  const { ReviewDetailDialog } = await import(
    '../../components/ReviewDetailDialog.js'
  )
  return <ReviewDetailDialog review={result.review} onDone={onDone} />
}
