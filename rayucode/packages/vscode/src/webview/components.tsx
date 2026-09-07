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
  FileChangeReviewConversationItem,
  ModelUsage,
  PermissionRequestConversationItem,
  ToolActionConversationItem,
  Usage,
  UsageConversationItem,
  UserConversationItem,
} from "@rayucode/core";

import {
  SparkleIcon,
  UserIcon,
  TerminalIcon,
  EditIcon,
  FileIcon,
  DiffIcon,
  CompareIcon,
  CheckAllIcon,
  UndoIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "./icons.js";

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
    <div className="copilot-turn copilot-user-turn" role="article" aria-label="Your message">
      <div className="copilot-turn-avatar copilot-user-avatar" aria-hidden="true">
        <UserIcon />
      </div>
      <div className="copilot-user-card">
        <div className="user-text">{item.text}</div>
      </div>
    </div>
  );
}

function AssistantEntry({
  item,
}: {
  item: AssistantConversationItem;
}): ReactNode {
  return (
    <div className="copilot-turn copilot-assistant-turn" role="article" aria-label="Assistant response">
      <div className="copilot-turn-avatar copilot-assistant-avatar" aria-hidden="true">
        <SparkleIcon />
      </div>
      <div className="copilot-assistant-content">
        <div className="assistant-text">{renderMarkdown(item.text)}</div>
        {item.streaming ? (
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
      </div>
    </div>
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
  const [open, setOpen] = useState(false);
  const isBash = item.toolName === "Bash";
  const isEdit = isDiffableTool(item.toolName);
  const status = TOOL_STATUS_LABEL[item.status] ?? item.status;
  const isRunning = item.status === "running";

  const preview =
    item.command !== undefined
      ? item.command
      : typeof item.input["file_path"] === "string"
        ? (item.input["file_path"] as string)
        : typeof item.input["path"] === "string"
          ? (item.input["path"] as string)
          : "";

  return (
    <div className={`copilot-tool-pill-container status-${item.status}`}>
      <button
        type="button"
        className="copilot-tool-pill-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="copilot-tool-icon">
          {isBash ? <TerminalIcon /> : isEdit ? <EditIcon /> : <FileIcon />}
        </span>
        <span className="copilot-tool-title">
          <span className="copilot-tool-name">{item.toolName}</span>
          {preview ? <span className="copilot-tool-preview">{preview}</span> : null}
        </span>
        <span className={`copilot-tool-badge badge-${item.status}`}>
          {isRunning ? <span className="dot pulse" /> : null}
          {status}
        </span>
        <span className="copilot-tool-chevron">
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
      </button>
      {open ? (
        <div className="copilot-tool-details">
          {item.command !== undefined ? (
            <pre className="tool-command">{item.command}</pre>
          ) : (
            <ToolInputView toolName={item.toolName} input={item.input} />
          )}
          {item.output !== undefined && item.output.length > 0 ? (
            <Collapsible summary="Output" defaultOpen={true}>
              <pre className="tool-output">{item.output}</pre>
            </Collapsible>
          ) : null}
        </div>
      ) : null}
    </div>
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

  // Only file edits have a diff to show. Offered alongside Allow/Deny rather than
  // replacing the inline diff: the inline view answers "what is this?" at a
  // glance, this one answers "let me actually read it" in a real editor
  // (UI_PARITY flow 11). Opening it decides nothing — the request stays pending.
  const isEdit = isEditToolName(item.toolName);

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
      {isEdit ? (
        <button
          type="button"
          className="btn btn-quiet btn-diff"
          title="Open the proposed change in the diff editor. This does not approve it."
          onClick={() => post({ type: "openDiff", requestId: item.requestId })}
        >
          Open diff
        </button>
      ) : null}
    </div>
  );
}

/**
 * The tools that ask the user to approve a PLAN rather than an action.
 *
 * `ExitPlanMode` is how the CLI's plan mode requests approval, and both the v1 and
 * v2 tools share the name (`EXIT_PLAN_MODE_TOOL_NAME` and
 * `EXIT_PLAN_MODE_V2_TOOL_NAME` are both 'ExitPlanMode'). Both plan tools are in
 * the host's tool list, so once permission requests actually reach the panel these
 * arrive like any other approval.
 */
const PLAN_APPROVAL_TOOLS = new Set(["ExitPlanMode", "EnterPlanMode"]);

/** Whether this request is a plan review (UI_PARITY flow 16). */
export function isPlanApproval(toolName: string): boolean {
  return PLAN_APPROVAL_TOOLS.has(toolName);
}

/**
 * The plan text to review, or null when this is not a plan approval.
 *
 * The engine puts the plan in the tool input; `plan` is the field the CLI's
 * ExitPlanMode uses. Falls back through the other plausible carriers rather than
 * showing an empty review, which would be worse than a generic prompt.
 */
export function planApprovalText(
  item: PermissionRequestConversationItem,
): string | null {
  if (!isPlanApproval(item.toolName)) return null;
  for (const field of ["plan", "content", "text"]) {
    const value = item.input?.[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * A human title for the approval.
 *
 * "ExitPlanMode needs your approval" is technically accurate and completely
 * unhelpful at the moment a user is being asked to review a plan.
 */
export function permissionTitle(toolName: string): string {
  return isPlanApproval(toolName) ? "Review the plan" : `${toolName} needs your approval`;
}

/** One-line description of what is being asked for, for the sticky bar. */
function permissionSummary(item: PermissionRequestConversationItem): string {
  // A plan is prose, not a command or a path; the bar shows its first line and the
  // full text is rendered in the card.
  if (isPlanApproval(item.toolName)) {
    const plan = planApprovalText(item);
    if (plan !== null) {
      const firstLine = plan.trim().split("\n")[0] ?? "";
      return firstLine.length > 0 ? firstLine : "the proposed plan";
    }
    return "the proposed plan";
  }
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
      aria-label={permissionTitle(item.toolName)}
    >
      <div className="permission-bar-head">
        {/* The glyph is decorative: the adjacent text already says "needs your
            approval", so announcing "warning sign" would only add noise. */}
        <span className="permission-bar-icon" aria-hidden="true">
          ⚠
        </span>
        <span className="permission-bar-title">
          {isPlanApproval(item.toolName) ? (
            <strong>Review the plan</strong>
          ) : (
            <>
              <strong>{item.toolName}</strong> needs your approval
            </>
          )}
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

function FileChangeReviewCard({
  item,
  post,
}: {
  item: FileChangeReviewConversationItem;
  post: PostMessage;
}): ReactNode {
  const { summary } = item;
  const fileCount = summary.totalFiles;

  return (
    <div className="copilot-review-card" role="region" aria-label="File changes review">
      <div className="copilot-review-header">
        <div className="copilot-review-title">
          <CompareIcon />
          <span className="copilot-review-heading">
            Files Changed ({fileCount})
          </span>
          <span className="copilot-diff-stats">
            <span className="stat-additions">+{summary.totalAdditions}</span>
            <span className="stat-removals">-{summary.totalRemovals}</span>
          </span>
        </div>
        <div className="copilot-review-global-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm btn-keep-all"
            title="Accept and keep all changes (/keep)"
            onClick={() => post({ type: "submitPrompt", text: "/keep" })}
          >
            <CheckAllIcon />
            <span>Keep All</span>
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-sm btn-undo-all"
            title="Revert all file changes (/undo all)"
            onClick={() => post({ type: "submitPrompt", text: "/undo all" })}
          >
            <UndoIcon />
            <span>Undo All</span>
          </button>
        </div>
      </div>

      <div className="copilot-review-files">
        {summary.files.map((file) => {
          const fileName = file.displayPath.split("/").pop() ?? file.displayPath;
          const dirPath = file.displayPath.includes("/")
            ? file.displayPath.slice(0, file.displayPath.lastIndexOf("/"))
            : "";

          return (
            <div key={file.filePath} className="copilot-review-file-row">
              <button
                type="button"
                className="copilot-review-file-link"
                title={`Open ${file.displayPath}`}
                onClick={() => post({ type: "openFile", filePath: file.filePath })}
              >
                <FileIcon />
                <span className="copilot-file-name">{fileName}</span>
                {dirPath ? (
                  <span className="copilot-file-dir">{dirPath}</span>
                ) : null}
              </button>

              <span className="copilot-file-stats">
                <span className="stat-additions">+{file.additions}</span>
                <span className="stat-removals">-{file.removals}</span>
              </span>

              <div className="copilot-review-file-actions">
                <button
                  type="button"
                  className="btn-icon"
                  title="Compare Changes (diff editor)"
                  onClick={() => post({ type: "openReviewDiff", filePath: file.filePath })}
                >
                  <DiffIcon />
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  title={`Keep ${fileName} (/keep)`}
                  onClick={() => post({ type: "submitPrompt", text: `/keep ${file.filePath}` })}
                >
                  <CheckIcon />
                </button>
                <button
                  type="button"
                  className="btn-icon btn-icon-danger"
                  title={`Undo ${fileName} (/undo)`}
                  onClick={() => post({ type: "submitPrompt", text: `/undo ${file.filePath}` })}
                >
                  <UndoIcon />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="copilot-review-footer">
        <span className="copilot-review-hint">
          Use <code>/keep [file]</code> to accept or <code>/undo [file]</code> to revert
        </span>
      </div>
    </div>
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
    case "file_change_review":
      return <FileChangeReviewCard item={item} post={post} />;
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
