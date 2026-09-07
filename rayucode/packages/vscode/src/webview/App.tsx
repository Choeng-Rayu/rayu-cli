// Agent panel React shell.
//
// Replaces `dom.ts`. The state model is UNCHANGED: `PanelViewModel` still folds
// host messages by `seq`, and this component only paints its output and posts
// user intents back. That fold is the piece with real ordering subtlety, so it
// was ported as-is rather than reimplemented.

import { matchSlashCommands } from "./commandPalette.js";
import {
  applyMention,
  parseMentionQuery,
  rankMentionCandidates,
} from "./mentions.js";
import { taskLabel } from "./backgroundTasks.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  ConversationEntry,
  PendingPermissionBar,
  UsageDetails,
  type PostMessage,
} from "./components.js";
import {
  ArrowUpIcon,
  FileIcon,
  ShieldIcon,
  SparkleIcon,
  StopIcon,
} from "./icons.js";
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
  return (
    <header className="panel-header">
      <div className="header-row">
        <span className="header-spacer" />

        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => post({ type: "newSession" })}
        >
          New session
        </button>
      </div>

      {/*
        MCP servers, with the actions the engine already supports (UI_PARITY
        flow 14). Previously this was a read-only warning line: it could tell you a
        server had failed and offer nothing to do about it.

        Only rendered when there is at least one server — an empty list is not
        worth a row. Statuses come from the engine's `mcp_status`; nothing here is
        inferred.
      */}
      {state.mcpServers.length > 0 ? (
        <div className="mcp-servers">
          {state.mcpServers.map((server) => {
            const healthy = server.status === "connected";
            const disabled = server.status === "disabled";
            return (
              <span key={server.name} className={`mcp-server mcp-${server.status}`}>
                <span className="mcp-name" title={`MCP server: ${server.status}`}>
                  {server.name}
                </span>
                <span className="mcp-status">{server.status}</span>
                {/* Retry is only meaningful for a server that is not connected. */}
                {!healthy && !disabled ? (
                  <button
                    type="button"
                    className="btn btn-quiet btn-mcp"
                    title={`Reconnect ${server.name}`}
                    onClick={() => post({ type: "mcpReconnect", serverName: server.name })}
                  >
                    Reconnect
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-quiet btn-mcp"
                  title={
                    disabled
                      ? `Enable ${server.name}`
                      : `Disable ${server.name} without discarding its configuration`
                  }
                  onClick={() =>
                    post({
                      type: "mcpToggle",
                      serverName: server.name,
                      enabled: disabled,
                    })
                  }
                >
                  {disabled ? "Enable" : "Disable"}
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      {/* The engine's real capability inventory, announced in system/init.
          Previously the host discarded `tools`, `slash_commands` and `skills`
          entirely, so the panel could only show a hardcoded guess at what the
          engine supported (RAYU_CORE_MIGRATION_PLAN.md Task 16).

          Rendered as counts with the full list in the title: the tool inventory
          runs to dozens of entries and the commands to ~81, which would dominate
          the header. Hidden entirely when the inventory is empty, i.e. before the
          handshake, so there is no empty-state flicker on open. */}
      {state.tools.length + state.slashCommands.length + state.skills.length > 0 ? (
        <div className="capabilities" role="status">
          <span title={state.tools.join(", ")}>{`${state.tools.length} tools`}</span>
          {state.slashCommands.length > 0 ? (
            <span
              title={state.slashCommands.join(", ")}
            >{`${state.slashCommands.length} commands`}</span>
          ) : null}
          {state.skills.length > 0 ? (
            <span title={state.skills.join(", ")}>{`${state.skills.length} skills`}</span>
          ) : null}
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
        <div className="copilot-welcome">
          <div className="copilot-welcome-avatar" aria-hidden="true">
            <SparkleIcon />
          </div>
          <h2 className="copilot-welcome-title">What can I help with?</h2>
          <p className="copilot-welcome-subtitle">
            Generate code, refactor files, or review pending changes with Rayu.
          </p>
          <div className="copilot-welcome-suggestions">
            <button
              type="button"
              className="copilot-welcome-chip"
              onClick={() => post({ type: "submitPrompt", text: "/review_detail" })}
            >
              <span className="chip-cmd">/review_detail</span>
              <span className="chip-label">Review pending changes</span>
            </button>
            <button
              type="button"
              className="copilot-welcome-chip"
              onClick={() => post({ type: "submitPrompt", text: "/keep" })}
            >
              <span className="chip-cmd">/keep</span>
              <span className="chip-label">Accept all file edits</span>
            </button>
            <button
              type="button"
              className="copilot-welcome-chip"
              onClick={() => post({ type: "submitPrompt", text: "/undo" })}
            >
              <span className="chip-cmd">/undo</span>
              <span className="chip-label">Revert latest change</span>
            </button>
            <button
              type="button"
              className="copilot-welcome-chip"
              onClick={() => post({ type: "selectPermissionMode", mode: "plan" })}
            >
              <span className="chip-cmd">/plan</span>
              <span className="chip-label">Switch to read-only plan mode</span>
            </button>
          </div>
        </div>
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

  /*
    Slash-command palette (UI_PARITY.md flow 10).

    Driven entirely by what the ENGINE announced — `commandCatalog` from the
    `initialize` response, with `slashCommands` from `system/init` as the fallback
    for names that arrive before the catalog does. Nothing here is hardcoded: the
    extension used to ship four invented commands against the engine's 98 real
    ones.

    Dispatch is just prompt text. `/name args` is how the CLI REPL invokes a
    command AND a skill (SlashCommandSchema: "invoked via /command syntax"), so no
    protocol request type is involved.
  */
  // Caret offset, needed to know which `@` mention is being typed.
  const [caret, setCaret] = useState(0);

  const commandMatches = useMemo(
    () => matchSlashCommands(text, state.commandCatalog, state.slashCommands),
    [text, state.commandCatalog, state.slashCommands],
  );

  /*
    `@`-mentions (UI_PARITY flow 20). The mention under the caret is computed from the
    text and the caret position; the host is asked for matches, because only it can
    read the workspace. Requesting on every keystroke is fine: findFiles is cached by
    VS Code and the result is capped.
  */
  const mention = useMemo(() => parseMentionQuery(text, caret), [text, caret]);

  useEffect(() => {
    if (mention === null) return;
    post({ type: "searchFiles", query: mention.query });
  }, [mention, post]);

  // Ranked host-side, but ranked again here so the list narrows as you keep typing
  // rather than waiting for the next round trip.
  const mentionMatches = useMemo(
    () =>
      mention === null
        ? []
        : rankMentionCandidates(mention.query, state.fileMatches),
    [mention, state.fileMatches],
  );

  const chooseMention = useCallback(
    (path: string) => {
      if (mention === null) return;
      const next = applyMention(text, mention, path);
      setText(next.text);
      setCaret(next.caret);
      const area = areaRef.current;
      if (area) {
        // Restore the caret after React re-renders, or it jumps to the end.
        requestAnimationFrame(() => {
          area.focus();
          area.setSelectionRange(next.caret, next.caret);
        });
      }
    },
    [mention, text],
  );

  const chooseCommand = useCallback(
    (name: string, argumentHint: string) => {
      // Leave the cursor after a trailing space when the command takes an
      // argument, so the hint is immediately actionable.
      setText(argumentHint.length > 0 ? `/${name} ` : `/${name}`);
      areaRef.current?.focus();
    },
    [],
  );

  // Auto-grow textarea height to fit content
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area) {
      area.style.height = "auto";
      const nextHeight = Math.min(Math.max(area.scrollHeight, 56), 240);
      area.style.height = `${nextHeight}px`;
    }
  }, [text]);

  const cyclePermissionMode = useCallback(() => {
    const modes = SELECTABLE_PERMISSION_MODES.map((m) => m.value);
    const currentIndex = modes.indexOf(state.permissionMode ?? "default");
    const nextMode = modes[(currentIndex + 1) % modes.length] ?? "default";
    post({ type: "selectPermissionMode", mode: nextMode });
  }, [state.permissionMode, post]);

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
        produce 60 entries.
      */}
      {state.toolProgress !== null && !blocked ? (
        <div className="tool-progress" role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {`${state.toolProgress.toolName} running — ${Math.round(state.toolProgress.elapsedSeconds)}s`}
        </div>
      ) : null}

      {/* Workspace files floating popover, offered as the user types `@`. */}
      {mentionMatches.length > 0 ? (
        <div className="copilot-popover" role="listbox" aria-label="Workspace files">
          <div className="copilot-popover-header">Workspace Files</div>
          <ul className="copilot-popover-list">
            {mentionMatches.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  className="copilot-popover-item"
                  onClick={() => chooseMention(path)}
                >
                  <FileIcon />
                  <span className="popover-item-primary">
                    {path.slice(path.lastIndexOf("/") + 1)}
                  </span>
                  <span className="popover-item-secondary">{path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Background tasks */}
      {state.backgroundTasks.length > 0 ? (
        <ul className="background-tasks" aria-label="Background tasks">
          {state.backgroundTasks.map((task) => (
            <li key={task.taskId} className="background-task">
              <span className="dot" aria-hidden="true" />
              <span className="background-task-label">{taskLabel(task)}</span>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => post({ type: "stopTask", taskId: task.taskId })}
              >
                Stop
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Slash commands floating popover, offered as user types leading slash. */}
      {commandMatches.length > 0 ? (
        <div className="copilot-popover" role="listbox" aria-label="Slash commands">
          <div className="copilot-popover-header">Commands</div>
          <ul className="copilot-popover-list">
            {commandMatches.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  className="copilot-popover-item"
                  onClick={() => chooseCommand(c.name, c.argumentHint)}
                >
                  <span className="popover-cmd-name">{`/${c.name}`}</span>
                  {c.argumentHint ? (
                    <span className="popover-cmd-hint">{c.argumentHint}</span>
                  ) : null}
                  {c.description ? (
                    <span className="popover-cmd-desc">{c.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
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

      {/* Copilot Integrated Composer Card */}
      <div className="copilot-composer-card">
        <label className="sr-only" htmlFor="prompt-input">
          Message to the agent
        </label>
        <textarea
          id="prompt-input"
          ref={areaRef}
          className="prompt-input"
          value={text}
          rows={2}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          placeholder={
            blocked
              ? "Waiting for your approval above…"
              : "Ask Rayu or type / for commands…  (Enter to send, Shift+Enter for newline, Shift+Tab for mode)"
          }
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              cyclePermissionMode();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div className="copilot-composer-toolbar">
          <div className="copilot-composer-pills">
            {/* Permission mode pill */}
            {state.permissionMode !== null ? (
              <div className="copilot-pill-select-wrapper">
                <label className="sr-only" htmlFor="mode-select">
                  Permission mode
                </label>
                <ShieldIcon />
                <select
                  id="mode-select"
                  className={`copilot-pill-select mode-${state.permissionMode}`}
                  value={state.permissionMode}
                  title={`Permission mode: ${state.permissionMode} (Shift+Tab to cycle)`}
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
              </div>
            ) : null}

            {/* Model selector pill */}
            <div className="copilot-pill-select-wrapper">
              {state.models.length > 0 ? (
                <>
                  <label className="sr-only" htmlFor="model-select">
                    Model
                  </label>
                  <select
                    id="model-select"
                    className="copilot-pill-select"
                  value={state.model ?? ""}
                  title={`Active model: ${state.model ?? "None"}`}
                  onChange={(e) =>
                    post({ type: "selectModel", model: e.currentTarget.value })
                  }
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
              </>
            ) : (
                <button
                  type="button"
                  className="copilot-pill-btn"
                  title="Select model"
                  onClick={() => post({ type: "openModelList" })}
                >
                  {state.model ?? (state.signedIn === false ? "Sign in" : "Loading…")}
                </button>
              )}
            </div>

            {/* Provider badge */}
            <button
              type="button"
              className="copilot-pill-btn copilot-provider-btn"
              title={
                state.providerId === null
                  ? "Configure provider (BYOK)"
                  : `Provider: ${state.providerId} — click to change`
              }
              onClick={() => post({ type: "openProviderSetup" })}
            >
              {state.providerId ?? "Provider"}
            </button>
          </div>

          <div className="copilot-composer-actions">
            {state.generating ? (
              <button
                type="button"
                className="btn btn-danger btn-circle btn-stop"
                title="Stop response"
                onClick={() => post({ type: "interrupt" })}
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-circle btn-send"
                title="Send message (Enter)"
                onClick={submit}
                disabled={text.trim().length === 0}
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Auth state notification */}
      {state.signedIn === false ? (
        <div className="copilot-auth-banner">
          <span>Not signed in to Rayu.</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => post({ type: "signIn" })}
          >
            Sign in
          </button>
        </div>
      ) : null}
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
