import { useEffect } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { formatWorkerApprovalLoss } from '../../orchestrator/modeChange.js'
import { subscribeWorkerApprovalLoss } from '../../utils/sessionState.js'

/**
 * Warns when a mode change leaves running background workers unable to get
 * approval (see src/orchestrator/modeChange.ts). The headless engine shows the
 * same text as a warning frame; see print.ts.
 */
export function useWorkerApprovalLossNotification(): void {
  const { addNotification } = useNotifications()
  useEffect(
    () =>
      subscribeWorkerApprovalLoss(loss => {
        addNotification({
          key: 'worker-approval-loss',
          text: formatWorkerApprovalLoss(loss),
          color: 'warning',
          priority: 'high',
        })
      }),
    [addNotification],
  )
}
