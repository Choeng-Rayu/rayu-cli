/**
 * Approvals awaiting an answer, pinned above the composer.
 *
 * ── WHY ONLY THE OLDEST IS EXPANDED ────────────────────────────────────────────
 *
 * The engine runs tools in parallel, so several approvals can be outstanding at once. Every
 * card rendered expanded was the previous behaviour, and with three of them the composer left
 * the screen entirely — which is a problem, because the composer is where the user goes to
 * say "stop". The oldest is expanded because it has been blocking longest; the rest collapse
 * to a count they can open.
 *
 * ── A CARD IS NEVER ANSWERED IMPLICITLY ────────────────────────────────────────
 *
 * Collapsing is a display state and nothing more. No path here answers, dismisses or defers a
 * request — an approval leaves only when the user decides or the engine withdraws it, because
 * inventing a decision would be inventing consent.
 */
import { useState } from 'react'

import type { PermissionRequestView } from '../../shared/webviewProtocol.js'
import { PermissionCard } from './PermissionCard.js'
import { QuestionCard } from './QuestionCard.js'
import { ChevronIcon } from './Icons.js'

export interface ApprovalStackProps {
  requests: readonly PermissionRequestView[]
  onAnswerQuestions: (
    requestId: string,
    answers: Record<string, string>,
    notes: Record<string, string>,
  ) => void
  onDecide: (
    requestId: string,
    decision: 'allow-once' | 'allow-always' | 'deny',
  ) => void
}

export function ApprovalStack({
  requests,
  onAnswerQuestions,
  onDecide,
}: ApprovalStackProps): JSX.Element | null {
  const [showAll, setShowAll] = useState(false)

  if (requests.length === 0) return null

  // Oldest first is the order the host sends them in, and the order they blocked in.
  const [oldest, ...rest] = requests
  const visible = showAll ? requests : oldest ? [oldest] : []

  return (
    <div className="rc-approvals">
      {visible.map(request =>
        request.questionInteraction ? (
          <QuestionCard
            key={request.requestId}
            request={request}
            onSubmit={(answers, notes) =>
              onAnswerQuestions(request.requestId, answers, notes)
            }
            onCancel={() => onDecide(request.requestId, 'deny')}
          />
        ) : (
          <PermissionCard
            key={request.requestId}
            request={request}
            onDecide={decision => onDecide(request.requestId, decision)}
          />
        ),
      )}

      {rest.length > 0 ? (
        <button
          type="button"
          className="rc-approvals-more"
          aria-expanded={showAll}
          onClick={() => setShowAll(open => !open)}
        >
          <ChevronIcon size={10} direction={showAll ? 'down' : 'right'} />
          {showAll
            ? 'Show only the oldest request'
            : `${rest.length} more ${rest.length === 1 ? 'request' : 'requests'} waiting`}
        </button>
      ) : null}
    </div>
  )
}
