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
 * "Approve plan" answers `allow-once` and "Keep planning" answers `deny`, so the
 * engine's blocked ExitPlanMode call resolves exactly as before — only the display
 * changed. There is no "Always allow": a lasting rule for a tool that exists to ask
 * would silence the one question it is for. Deny comes first, as on every card, so
 * the safe choice is the easy one to hit.
 */
import { useMemo } from 'react'

import { renderMarkdown } from '../markdown.js'
import type { PermissionRequestView } from '../../shared/webviewProtocol.js'

export interface PlanApprovalCardProps {
  request: PermissionRequestView
  onDecide: (decision: 'allow-once' | 'allow-always' | 'deny') => void
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
        <button
          type="button"
          className="rc-button rc-button-primary"
          onClick={() => onDecide('allow-once')}
        >
          Approve plan
        </button>
      </div>
    </section>
  )
}