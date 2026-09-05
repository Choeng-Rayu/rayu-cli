// Agent panel React shell.
//
// Replaces `dom.ts`. The state model is UNCHANGED: `PanelViewModel` still folds
// host messages by `seq`, and this component only paints its output and posts
// user intents back. That fold is the piece with real ordering subtlety, so it
// was ported as-is rather than reimplemented.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  ConversationEntry,
  PendingPermissionBar,
  UsageDetails,
  type PostMessage,
} from "./components.js";
import { SELECTABLE_PERMISSION_MODES } from "./protocol.js";
import type { PanelRenderState } from "./viewModel.js";

/** Props for the panel root. */
export interface AppProps {
  state: PanelRenderState;
  post: PostMessage;
  /**
   * Drains the one-shot text staged by the host's `insertPrompt`. Called after
   * paint so the value is consumed exactly once.
   */
  consumePendingInput: () => string | null;
}

// ----------------------------------------------------------------------------
// Header
// ----------------------------------------------------------------------------

function Header({
  state,
  post,
}: {
  state: PanelRenderState;
  post: PostMessage;
}): ReactNode {
  const failedServers = state.mcpServers.filter(
    (s) => s.status !== "connected" && s.status !== "pending",
  );

  return (
    <header className="panel-header">
      <div className="header-row">
        <label className="model-label" htmlFor="model-select">
          Model
        </label>
        {state.models.length > 0 ? (
          <select
            id="model-select"
            className="model-select"
            value={state.model ?? ""}
            onChange={(e) => post({ type: "selectModel", model: e.currentTarget.value })}
          >
            {state.model !== null &&
            !state.models.some((m) => m.value === state.model) ? (
              <option value={state.model}>{state.model}</option>
            ) : null}
            {state.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.displayName || m.value}
              </option>
            ))}
          </select>
        ) : (
          <button
            id="model-select"
            type="button"
            className="btn btn-quiet"
            onClick={() => post({ type: "openModelList" })}
          >
            {state.model ?? "Loading…"}
          </button>
        )}

        {/*
          Permission mode was previously a read-only badge, so changing it meant
          leaving the panel for settings JSON — and because it governs whether the
          agent asks before each action, that is the control users reach for most.

          The list is a curated subset (see SELECTABLE_PERMISSION_MODES). A mode in
          force but not in the list — set through `rayucode.permissionMode` — is
          added as an extra option so the picker always shows the truth rather than
          silently misreporting a mode it cannot offer.
        */}
        {state.permissionMode !== null ? (
          <>
            <label className="sr-only" htmlFor="mode-select">
              Permission mode
            </label>
            <select
              id="mode-select"
              className={`mode-select mode-${state.permissionMode}`}
              value={state.permissionMode}
              title={
                SELECTABLE_PERMISSION_MODES.find(
                  (m) => m.value === state.permissionMode,
                )?.hint ?? `Permission mode: ${state.permissionMode}`
              }
              onChange={(e) =>
                post({
                  type: "selectPermissionMode",
                  mode: e.currentTarget.value,
                })
              }
            >
              {!SELECTABLE_PERMISSION_MODES.some(
                (m) => m.value === state.permissionMode,
              ) ? (
                <option value={state.permissionMode}>{state.permissionMode}</option>
              ) : null}
              {SELECTABLE_PERMISSION_MODES.map((m) => (
                <option key={m.value} value={m.value} title={m.hint}>
                  {m.label}
                </option>
              ))}
            </select>
          </>
        ) : null}

        <span className="header-spacer" />

        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => post({ type: "newSession" })}
        >
          New session
        </button>
      </div>

      {failedServers.length > 0 ? (
        <div className="mcp-warning" role="status">
          {`MCP: ${failedServers.map((s) => `${s.name} (${s.status})`).join(", ")}`}
        </div>
      ) : null}

      {/* Provider quota. Only shown when there is something to act on — a
          steady stream of "allowed" events would be noise. */}
      {state.rateLimit !== null ? (
        <div
          className={`rate-limit rate-limit-${state.rateLimit.status}`}
          role={state.rateLimit.status === "rejected" ? "alert" : "status"}
        >
          {state.rateLimit.status === "rejected"
            ? "Rate limit reached — the provider is rejecting requests."
            : "Approaching the provider rate limit."}
          {typeof state.rateLimit.utilization === "number"
            ? ` ${Math.round(state.rateLimit.utilization * 100)}% used.`
            : ""}
          {typeof state.rateLimit.resetsAt === "number"
            ? // resetsAt is in SECONDS.
              ` Resets ${new Date(state.rateLimit.resetsAt * 1000).toLocaleTimeString()}.`
            : ""}
        </div>
      ) : null}

      {state.authenticating ? (
        <div className="auth-status" role="status">
          Signing in to the model provider…
        </div>
      ) : null}
    </header>
  );
}

// ----------------------------------------------------------------------------
// Transcript
// ----------------------------------------------------------------------------

function Transcript({
  state,
  post,
  reviewNonce,
}: {
  state: PanelRenderState;
  post: PostMessage;
  /**
   * Incremented by the sticky bar's "Review" button. A counter rather than a
   * callback prop so the scroll stays declarative — the effect below owns the
   * scroll container and is the only thing that touches it.
   */
  reviewNonce: number;
}): ReactNode {
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Only auto-scroll when the user is already at the bottom, so reading back
  // through history is not yanked away every time a delta arrives.
  const pinnedRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  /**
   * Bring the blocking permission card into view.
   *
   * Deliberately ignores `pinnedRef`. Every other scroll respects the user's
   * position, but a blocked agent is the one case where staying put is worse:
   * nothing further happens until a decision is made, so the request has to be
   * shown even if the user had scrolled away.
   */
  const scrollToPending = useCallback(() => {
    const card = scrollRef.current?.querySelector(".permission-blocking");
    card?.scrollIntoView({ block: "center" });
  }, []);

  const pendingId = state.pendingPermission?.requestId ?? null;

  // Fires once per NEW request (keyed on requestId, not on every items change),
  // so a stream of deltas arriving while a request is open does not repeatedly
  // yank the view.
  useEffect(() => {
    if (pendingId === null) {
      return;
    }
    scrollToPending();
  }, [pendingId, scrollToPending]);

  // "Review" in the sticky bar. Skips the initial mount.
  useEffect(() => {
    if (reviewNonce === 0) {
      return;
    }
    scrollToPending();
  }, [reviewNonce, scrollToPending]);

  useLayoutEffect(() => {
    if (pinnedRef.current) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [state.items]);

  if (state.items.length === 0) {
    return (
      <div className="transcript transcript-empty" ref={scrollRef}>
        <p className="empty-hint">
          Ask Rayu to explain, refactor, or debug code in this workspace.
        </p>
      </div>
    );
  }

  return (
    <div
      className="transcript"
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-label="Conversation"
      aria-busy={state.generating}
    >
      {state.items.map((item) => (
        <ConversationEntry key={item.id} item={item} post={post} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Composer
// ----------------------------------------------------------------------------

function Composer({
  state,
  post,
  consumePendingInput,
  onReview,
}: AppProps & { onReview: () => void }): ReactNode {
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const blocked = state.pendingPermission !== null;

  // Drain host-staged text (from "Add selection to prompt") after paint.
  useEffect(() => {
    const pending = consumePendingInput();
    if (pending !== null && pending.length > 0) {
      setText((current) => (current.length > 0 ? `${current}\n${pending}` : pending));
      areaRef.current?.focus();
    }
  }, [state.pendingInput, consumePendingInput]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || state.generating) {
      return;
    }
    post({ type: "submitPrompt", text: trimmed });
    setText("");
  }, [text, state.generating, post]);

  return (
    <footer className="composer">
      {/*
        The blocking approval, pinned directly above the input. First child so it
        is the closest thing to where the user's attention and cursor already are.
      */}
      {state.pendingPermission !== null ? (
        <PendingPermissionBar
          item={state.pendingPermission}
          post={post}
          onReview={onReview}
        />
      ) : null}

      {/*
        Live tool progress. Rendered here rather than as a transcript entry
        because it is replaced in place — a 60-second tool would otherwise
        produce 60 entries. Before this existed a slow tool was
        indistinguishable from a hung one (TRIAGE.md D8).

        Suppressed while an approval is outstanding: nothing is running yet, and
        a "running" line next to the request would contradict it.
      */}
      {state.toolProgress !== null && !blocked ? (
        <div className="tool-progress" role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {`${state.toolProgress.toolName} running — ${Math.round(state.toolProgress.elapsedSeconds)}s`}
        </div>
      ) : null}

      {state.usage !== null ? (
        <div className="composer-usage">
          <UsageDetails
            usage={state.usage.usage}
            totalCostUsd={state.usage.totalCostUsd}
            modelUsage={state.usage.modelUsage}
          />
        </div>
      ) : null}

      <div className="composer-row">
        <label className="sr-only" htmlFor="prompt-input">
          Message to the agent
        </label>
        <textarea
          id="prompt-input"
          ref={areaRef}
          className="prompt-input"
          value={text}
          rows={3}
          placeholder={
            blocked
              ? "Waiting for your approval above…"
              : "Ask Rayu…  (Enter to send, Shift+Enter for a new line)"
          }
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline. Deliberately not
            // Ctrl+Enter — Enter-to-send matches every other chat surface in
            // the editor.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {state.generating ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => post({ type: "interrupt" })}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={text.trim().length === 0}
          >
            Send
          </button>
        )}
      </div>
    </footer>
  );
}

// ----------------------------------------------------------------------------
// Root
// ----------------------------------------------------------------------------

export function App(props: AppProps): ReactNode {
  const { state, post, consumePendingInput } = props;
  // Bumped by the sticky bar's "Review"; the transcript watches it and scrolls.
  const [reviewNonce, setReviewNonce] = useState(0);
  const onReview = useCallback(() => setReviewNonce((n) => n + 1), []);

  return (
    <div className="panel">
      <Header state={state} post={post} />
      <Transcript state={state} post={post} reviewNonce={reviewNonce} />
      <Composer
        state={state}
        post={post}
        consumePendingInput={consumePendingInput}
        onReview={onReview}
      />
    </div>
  );
}
