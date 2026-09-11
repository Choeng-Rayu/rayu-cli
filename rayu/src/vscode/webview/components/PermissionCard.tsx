/**
 * The tool approval card.
 *
 * ── PINNED, NOT MODAL ──────────────────────────────────────────────────────────
 *
 * It sits above the composer and leaves the transcript readable. A modal dialog would
 * cover exactly the information the decision depends on — what the assistant said it
 * was about to do, and what happened in the preceding steps.
 *
 * ── NO DEFAULT, AND NO AUTOFOCUS ON A DESTRUCTIVE ACTION ───────────────────────
 *
 * There is deliberately no pre-selected button and no Enter-to-approve. The engine is
 * blocked and will wait; a keystroke aimed at the composer must never become consent
 * for a command the user has not read. Deny is placed first for the same reason —
 * the safe choice is the easy one to hit.
 */
import type { PermissionRequestView } from '../../shared/webviewProtocol.js'

export interface PermissionCardProps {
  request: PermissionRequestView
  onDecide: (decision: 'allow-once' | 'allow-always' | 'deny') => void
}

export function PermissionCard({
  request,
  onDecide,
}: PermissionCardProps): JSX.Element {
  return (
    <section
      className="rc-permission"
      // `alertdialog` is the correct role for a blocking decision: a screen reader
      // announces it immediately rather than waiting for the user to reach it.
      role="alertdialog"
      aria-label={`Allow Rayu to run ${request.toolName}?`}
    >
      <header className="rc-permission-head">
        <span className="rc-permission-title">
          Allow <strong>{request.toolName}</strong>?
        </span>
      </header>

      {request.label ? <code className="rc-permission-label">{request.label}</code> : null}

      {request.description ? (
        <p className="rc-permission-body">{request.description}</p>
      ) : null}

      {/* The usual reason the engine could not decide for itself, so it is called
          out rather than left for the user to find in the parameters. */}
      {request.blockedPath ? (
        <p className="rc-permission-warning">
          Outside the workspace: <code>{request.blockedPath}</code>
        </p>
      ) : null}

      {request.reason ? (
        <p className="rc-permission-body rc-muted">{request.reason}</p>
      ) : null}

      {request.parameters.length > 0 ? (
        <details className="rc-permission-params">
          <summary>Show parameters</summary>
          <pre className="rc-tool-pre">{request.parameters}</pre>
        </details>
      ) : null}

      <div className="rc-permission-actions">
        <button
          type="button"
          className="rc-button"
          onClick={() => onDecide('deny')}
        >
          Deny
        </button>
        <button
          type="button"
          className="rc-button rc-button-primary"
          onClick={() => onDecide('allow-once')}
        >
          Allow once
        </button>
        {request.canAlwaysAllow ? (
          <button
            type="button"
            className="rc-button"
            title="Stop asking for this tool in this project"
            onClick={() => onDecide('allow-always')}
          >
            Always allow
          </button>
        ) : null}
      </div>
    </section>
  )
}
