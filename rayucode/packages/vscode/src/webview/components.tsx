// Conversation item components.
//
// Replaces the manual keyed reconciliation in the old `dom.ts`. React handles
// keying and diffing, so what remains here is only how each item KIND looks.
//
// Two rules hold throughout this file:
//
//   1. No `dangerouslySetInnerHTML`, anywhere. Model output reaches the DOM only
//      as React text children or through `renderMarkdown`, which itself never
//      produces HTML.
//   2. Colour and spacing come from VS Code theme CSS variables in
//      `styles.css`, never from hard-coded values, so the panel follows the
//      user's theme including high-contrast.

import { useState, type ReactNode } from "react";

import type {
  AssistantConversationItem,
  ErrorConversationItem,
  ModelUsage,
  PermissionRequestConversationItem,
  ToolActionConversationItem,
  Usage,
  UsageConversationItem,
  UserConversationItem,
} from "@rayucode/core";

import { EditDiff, isDiffableTool } from "./diff.js";
import { renderMarkdown } from "./markdown.js";
import type { NoticeRenderItem, RenderItem } from "./viewModel.js";
import { isEditToolName } from "./protocol.js";
import type { WebviewToHostMessage } from "./protocol.js";

/** Callback used by every interactive item to send an intent to the host. */
export type PostMessage = (message: WebviewToHostMessage) => void;

// ----------------------------------------------------------------------------
// Small shared pieces
// ----------------------------------------------------------------------------

/**
 * A labelled region for one conversation entry.
 *
 * `role="article"` with an accessible name lets a screen reader enumerate the
 * transcript entry by entry instead of reading one undifferentiated block.
 */
function Entry({
  kind,
  label,
  children,
}: {
  kind: string;
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={`item item-${kind}`} role="article" aria-label={label}>
      {children}
    </div>
  );
}

/** A disclosure section that is collapsed by default. */
function Collapsible({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      {/* <summary> is focusable and Enter/Space-operable natively, so no extra
          keyboard handling is needed. */}
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/** Format a token count with thousands separators, tolerating bad input. */
function formatTokens(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "—";
}

/**
 * Format a USD cost.
 *
 * Guards non-finite input: `usage` is an opaque, unvalidated payload
 * (see protocol/contentBlocks.ts), and rendering `$NaN` would look like a bug in
 * the extension rather than missing data.
 */
function formatCost(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  return value < 0.01 && value > 0
    ? `<$0.01`
    : `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/** Render a tool's input as pretty JSON, never as markup. */
function InputJson({ input }: { input: Record<string, unknown> }): ReactNode {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  return <pre className="tool-input">{text}</pre>;
}

// ----------------------------------------------------------------------------
// Item renderers
// ----------------------------------------------------------------------------

/**
 * Show a tool's input as a DIFF when it is a file edit, and as JSON otherwise.
 *
 * Approving a file edit from raw JSON meant approving blind, which is the wrong
 * default for an action that writes to the user's working tree.
 * {@link EditDiff} returns `null` for an unrecognised payload, so an unexpected
 * shape falls back to JSON rather than rendering a misleading diff.
 */
function ToolInputView({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}): ReactNode {
  if (isDiffableTool(toolName)) {
    const diff = <EditDiff toolName={toolName} input={input} />;
    if (diff !== null) {
      return (
        <>
          {diff}
          <Collapsible summary="Raw input">
            <InputJson input={input} />
          </Collapsible>
        </>
      );
    }
  }
  return <InputJson input={input} />;
}

function UserEntry({ item }: { item: UserConversationItem }): ReactNode {
  return (
    <Entry kind="user" label="Your message">
      {/* The user's own text is shown verbatim rather than as markdown: it is
          input, and re-interpreting it would misrepresent what was sent. */}
      <div className="user-text">{item.text}</div>
    </Entry>
  );
}

function AssistantEntry({
  item,
}: {
  item: AssistantConversationItem;
}): ReactNode {
  return (
    <Entry kind="assistant" label="Assistant response">
      <div className="assistant-text">{renderMarkdown(item.text)}</div>
      {item.streaming ? (
        // aria-live so a screen reader announces that output is still arriving,
        // without the caller having to poll.
        <div className="streaming-indicator" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          <span className="sr-only">Response in progress</span>
        </div>
      ) : null}
      {item.error !== undefined ? (
        <div className="assistant-error" role="alert">
          {item.error}
        </div>
      ) : null}
    </Entry>
  );
}

const TOOL_STATUS_LABEL: Record<string, string> = {
  pending: "pending",
  running: "running",
  complete: "complete",
  error: "failed",
  denied: "denied",
};

function ToolActionEntry({
  item,
}: {
  item: ToolActionConversationItem;
}): ReactNode {
  const status = TOOL_STATUS_LABEL[item.status] ?? item.status;
  return (
    <Entry kind="tool" label={`Tool ${item.toolName}, ${status}`}>
      <div className="tool-header">
        <span className="tool-name">{item.toolName}</span>
        <span className={`tool-status tool-status-${item.status}`}>{status}</span>
      </div>
      {/* A bash command is shown in full, never truncated: the user is being
          asked to reason about exactly what will run. */}
      {item.command !== undefined ? (
        <pre className="tool-command">{item.command}</pre>
      ) : (
        <Collapsible summary="Input" defaultOpen={isDiffableTool(item.toolName)}>
          <ToolInputView toolName={item.toolName} input={item.input} />
        </Collapsible>
      )}
      {item.output !== undefined && item.output.length > 0 ? (
        <Collapsible summary="Output">
          <pre className="tool-output">{item.output}</pre>
        </Collapsible>
      ) : null}
    </Entry>
  );
}

/**
 * The Allow / Deny pair.
 *
 * Shared by the transcript card and the sticky bar so the two can never post
 * different intents for the same request.
 *
 * "Allow" is NOT one intent. For a file-edit tool the host has stashed the
 * request in `pendingEdits` precisely so an approval can apply it through VS
 * Code's workspace edit API — which is what makes the change undoable, gives
 * stale-base conflict detection, and leaves an already-open file dirty for review
 * (R6.2–R6.4). That only happens for `approveEdit`; `approvePermission` merely
 * tells the agent to proceed, so using it for an edit tool would silently skip all
 * of it and leak the `pendingEdits` entry. Hence the branch on `isEditToolName`.
 */
function PermissionActions({
  item,
  post,
  layout,
}: {
  item: PermissionRequestConversationItem;
  post: PostMessage;
  layout: "stacked" | "inline";
}): ReactNode {
  const allow = (): void => {
    post(
      isEditToolName(item.toolName)
        ? { type: "approveEdit", requestId: item.requestId }
        : { type: "approvePermission", requestId: item.requestId },
    );
  };

  return (
    <div className={`permission-actions permission-actions-${layout}`}>
      <button type="button" className="btn btn-primary btn-allow" onClick={allow}>
        Allow
      </button>
      <button
        type="button"
        className="btn btn-deny"
        onClick={() => post({ type: "denyPermission", requestId: item.requestId })}
      >
        Deny
      </button>
    </div>
  );
}

/** One-line description of what is being asked for, for the sticky bar. */
function permissionSummary(item: PermissionRequestConversationItem): string {
  if (item.command !== undefined && item.command.length > 0) {
    return item.command;
  }
  const path = item.input?.["file_path"];
  if (typeof path === "string" && path.length > 0) {
    return path;
  }
  return item.toolName;
}

/**
 * The blocking-approval bar, pinned above the composer.
 *
 * This exists because the transcript card alone was not enough: the agent stops
 * and waits, but the card is an ordinary scrollable entry, so a user who had
 * scrolled up saw only a spinner that never finished and had no way to know a
 * click was required. A pinned element cannot scroll out of reach.
 *
 * `role="alert"` rather than `alertdialog`: an alertdialog promises the assistive
 * technology that focus has moved into it and is managed there, and neither is
 * true here — deliberately. Moving focus onto "Allow" would put a destructive
 * command one stray Enter away, and trapping focus would stop the user scrolling
 * back to read the diff they are being asked to approve. `alert` is a live region,
 * so it is announced on appearance with no focus contract to break. The card in
 * the transcript therefore does NOT also announce, or the same event would be read
 * out twice.
 */
export function PendingPermissionBar({
  item,
  post,
  onReview,
}: {
  item: PermissionRequestConversationItem;
  post: PostMessage;
  /** Scroll the matching transcript card into view. */
  onReview: () => void;
}): ReactNode {
  return (
    <div
      className="permission-bar"
      role="alert"
      aria-label={`${item.toolName} needs your approval`}
    >
      <div className="permission-bar-head">
        {/* The glyph is decorative: the adjacent text already says "needs your
            approval", so announcing "warning sign" would only add noise. */}
        <span className="permission-bar-icon" aria-hidden="true">
          ⚠
        </span>
        <span className="permission-bar-title">
          <strong>{item.toolName}</strong> needs your approval
        </span>
        <span className="header-spacer" />
        <button type="button" className="btn btn-quiet btn-review" onClick={onReview}>
          Review
        </button>
      </div>
      <code className="permission-bar-summary">{permissionSummary(item)}</code>
      <PermissionActions item={item} post={post} layout="inline" />
    </div>
  );
}

function PermissionEntry({
  item,
  post,
}: {
  item: PermissionRequestConversationItem;
  post: PostMessage;
}): ReactNode {
  const decided = item.resolution !== undefined;
  const allowed = item.resolution?.behavior === "allow";

  return (
    <Entry
      kind={`permission${decided ? " permission-decided" : " permission-blocking"}`}
      label={`Permission request for ${item.toolName}`}
    >
      {/* Not a live region: the sticky bar announces the block, and two alerts
          for one event would be read out twice. The status is still conveyed
          non-visually by the "Needs approval" text, not by colour alone. */}
      <div className="permission-header">
        {!decided ? (
          <span className="permission-icon" aria-hidden="true">
            ⚠
          </span>
        ) : null}
        <strong>{item.toolName}</strong>
        {decided ? (
          <span className={`permission-outcome ${allowed ? "allowed" : "denied"}`}>
            {allowed ? "approved" : "denied"}
          </span>
        ) : (
          <span className="permission-pending">Needs approval</span>
        )}
      </div>

      {item.command !== undefined ? (
        <pre className="tool-command">{item.command}</pre>
      ) : (
        <ToolInputView toolName={item.toolName} input={item.input} />
      )}

      {/*
        The buttons stay on the card as well as in the sticky bar. Deciding from
        here is the INFORMED action — the diff is right above them — while the bar
        exists to be noticed. Both post the same intent and the coordinator
        resolves a request once, rejecting any later decision for the same id, so
        the duplication cannot double-approve.
      */}
      {!decided ? (
        <PermissionActions item={item} post={post} layout="stacked" />
      ) : null}
    </Entry>
  );
}

function UsageEntry({ item }: { item: UsageConversationItem }): ReactNode {
  return (
    <Entry kind="usage" label="Token usage and cost">
      <UsageDetails
        usage={item.usage}
        totalCostUsd={item.totalCostUsd}
        modelUsage={item.modelUsage}
      />
    </Entry>
  );
}

/** Shared usage/cost table, used by the inline item and the status footer. */
export function UsageDetails({
  usage,
  totalCostUsd,
  modelUsage,
}: {
  usage: Usage;
  totalCostUsd: number;
  modelUsage: Record<string, ModelUsage>;
}): ReactNode {
  const models = Object.entries(modelUsage ?? {});
  return (
    <div className="usage">
      <div className="usage-summary">
        <span>
          in <b>{formatTokens(usage?.input_tokens)}</b>
        </span>
        <span>
          out <b>{formatTokens(usage?.output_tokens)}</b>
        </span>
        {typeof usage?.cache_read_input_tokens === "number" ? (
          <span>
            cached <b>{formatTokens(usage.cache_read_input_tokens)}</b>
          </span>
        ) : null}
        <span className="usage-cost">
          cost <b>{formatCost(totalCostUsd)}</b>
        </span>
      </div>
      {models.length > 0 ? (
        <Collapsible summary={`Per-model breakdown (${models.length})`}>
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">In</th>
                <th scope="col">Out</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {models.map(([name, m]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td>{formatTokens(m?.inputTokens)}</td>
                  <td>{formatTokens(m?.outputTokens)}</td>
                  <td>{formatCost(m?.costUSD)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Collapsible>
      ) : null}
    </div>
  );
}

function ErrorEntry({ item }: { item: ErrorConversationItem }): ReactNode {
  return (
    <Entry kind="error" label="Error">
      {/* role="alert" so the message is announced immediately. A protocol
          failure or auth error is exactly the case where a silent panel was the
          original complaint (TRIAGE.md D2). */}
      <div className="error-text" role="alert">
        {item.message}
      </div>
    </Entry>
  );
}

function NoticeEntry({
  item,
  post,
}: {
  item: NoticeRenderItem;
  post: PostMessage;
}): ReactNode {
  return (
    <Entry kind={`notice notice-${item.level}`} label={`${item.level} notice`}>
      <div className="notice-text" role={item.level === "warn" ? "alert" : "status"}>
        {item.message}
      </div>
      {item.paths !== undefined && item.paths.length > 0 ? (
        <ul className="notice-paths">
          {item.paths.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {item.requestId !== undefined ? (
        <div className="notice-actions">
          <button
            type="button"
            className="btn"
            onClick={() =>
              post({ type: "confirmConflict", requestId: item.requestId as string })
            }
          >
            Apply anyway
          </button>
        </div>
      ) : null}
    </Entry>
  );
}

/**
 * Render one conversation entry.
 *
 * The `default` branch is deliberate: `RenderItem` is derived from wire messages,
 * and the engine can add kinds this build does not know. An unknown kind is
 * skipped rather than crashing the panel.
 */
export function ConversationEntry({
  item,
  post,
}: {
  item: RenderItem;
  post: PostMessage;
}): ReactNode {
  switch (item.kind) {
    case "user":
      return <UserEntry item={item} />;
    case "assistant":
      return <AssistantEntry item={item} />;
    case "tool_action":
      return <ToolActionEntry item={item} />;
    case "permission_request":
      return <PermissionEntry item={item} post={post} />;
    case "usage":
      return <UsageEntry item={item} />;
    case "error":
      return <ErrorEntry item={item} />;
    case "notice":
      return <NoticeEntry item={item} post={post} />;
    default:
      return null;
  }
}
