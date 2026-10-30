/**
 * The ExitPlanMode approval card.
 *
 * ── THE PLAN IS RENDERED, NOT DUMPED ───────────────────────────────────────────
 *
 * `normalizeToolInput` injects the plan file's contents into the tool input, and the
 * generic permission card's label is `summariseInput(input)` — a JSON dump. For every
 * other tool that fallback is a one-line summary; for this one it put the entire plan
 * on screen as escaped JSON. The terminal renders the same moment with its `Markdown`
 * component, so this card renders through the webview's own sanitised markdown
 * pipeline (`renderMarkdown`, the one assistant prose uses) rather than showing the
 * bytes the model wrote.
 *
 * ── SAME DECISION CONTRACT AS THE GENERIC CARD ───────────────────────────────────
 *
 * "Keep planning" answers `deny`, as on every card, and comes first so the safe choice
 * is the easy one to hit. There is no "Always allow": a lasting rule for a tool that
 * exists to ask would silence the one question it is for.
 *
 * ── HOW THE PLAN CONTINUES IS THE USER'S CHOICE ──────────────────────────────────
 *
 * A request from this panel's own engine (`offersModeChoice`) offers one approve button
 * per mode: Ask, Auto-edit, or Orchestrator, the last as the primary action because a
 * confirmed plan enters Orchestrator mode when nothing else is chosen. The labels come
 * from the mode pill (`shared/planApproval.ts`), so the button and the pill that
 * changes after it always name the same mode. A request mirrored from an attached CLI
 * session keeps the single "Approve plan" (`allow-once`): that session applies its own
 * plan-exit rule.
 */
import { useMemo } from 'react'

import { renderMarkdown } from '../markdown.js'
import {
  PLAN_APPROVAL_CHOICES,
  planApprovalLabel,
  type PlanApprovalChoice,
} from '../../shared/planApproval.js'
import type { PermissionRequestView } from '../../shared/webviewProtocol.js'

export type PlanApprovalDecision = 'allow-once' | 'deny' | PlanApprovalChoice

export interface PlanApprovalCardProps {
  request: PermissionRequestView
  onDecide: (decision: PlanApprovalDecision) => void
}

export function PlanApprovalCard({
  request,
  onDecide,
}: PlanApprovalCardProps): JSX.Element {
  const approval = request.planApproval
  // The router only sets `planApproval` for a non-empty plan, but the card must not
  // crash on a stale snapshot restored without one.
  const plan = approval?.plan ?? ''

  const html = useMemo(() => renderMarkdown(plan), [plan])

  return (
    <section
      className="rc-permission rc-plan-card"
      role="alertdialog"
      aria-label="Approve Rayu's plan?"
    >
      <header className="rc-permission-head">
        <span className="rc-permission-title">Rayu is ready to code</span>
        <span className="rc-plan-subtitle">Review the plan before it runs</span>
      </header>

      <div className="rc-plan-body">
        {/* Sanitised in renderMarkdown — the plan is model-produced text, the same
            trust level as assistant prose, and it goes through the same filter. */}
        <div
          className="rc-prose"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      {approval?.planFilePath ? (
        <p className="rc-plan-path">
          Plan file: <code>{approval.planFilePath}</code>
        </p>
      ) : null}

      <div className="rc-permission-actions">
        <button
          type="button"
          className="rc-button"
          onClick={() => onDecide('deny')}
        >
          Keep planning
        </button>
        {approval?.offersModeChoice ? (
          PLAN_APPROVAL_CHOICES.map(choice => {
            const { label, description } = planApprovalLabel(choice)
            return (
              <button
                key={choice}
                type="button"
                className={
                  choice === 'approve-orchestrate'
                    ? 'rc-button rc-button-primary'
                    : 'rc-button'
                }
                title={description}
                onClick={() => onDecide(choice)}
              >
                {label}
              </button>
            )
          })
        ) : (
          <button
            type="button"
            className="rc-button rc-button-primary"
            onClick={() => onDecide('allow-once')}
          >
            Approve plan
          </button>
        )}
      </div>
    </section>
  )
}