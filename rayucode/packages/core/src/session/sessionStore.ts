// In-memory session store: ordered conversation history per active session
// (R12.1–R12.5).
//
// The store is the host-owned home of every active session's conversation
// history. Because it lives in the Core_Integration host — not in the
// Agent_Panel webview — the history is independent of any panel lifecycle, so
// closing and reopening the panel does not lose the conversation (R12.2). The
// panel is a thin view: on reopen it asks the host for a snapshot via
// {@link SessionStore.restoreHistory} and re-renders it.
//
// Each session is keyed by a stable, workspace-derived key and is backed by a
// {@link ConversationReducer}, so the retained history, model, permission mode,
// and resumable session identifier all stay consistent with the way inbound
// messages are reduced everywhere else (R12.1, R12.5). Starting a new session
// allocates a fresh reducer — and therefore a fresh, independent history —
// without disturbing any prior session (R12.4).
//
// The store is editor-agnostic and side-effect free: no `vscode`, no process
// handles, no I/O (R13.1, R13.5). The SessionManager (task 10.3) composes it
// with the process / protocol / permission components and drives it.

import { ConversationReducer } from "./reducer.js";
import type { ConversationReducerState } from "./reducer.js";
import type { ConversationItem } from "./state.js";
import type { StdoutMessage } from "../protocol/wire.js";
import type { PermissionMode } from "../protocol/wire.js";

/**
 * Reconstructs a detached snapshot of a session's history for re-rendering when
 * the panel reopens (R12.2). The default builder deep-clones the retained
 * items so the snapshot is fully decoupled from the store's live state; a
 * custom builder can be injected (e.g. to force a deterministic failure in
 * tests, exercising the empty-on-failure guarantee of R12.3).
 */
export type HistorySnapshotBuilder = (
  history: readonly ConversationItem[],
) => ConversationItem[];

/** Construction options for a {@link SessionStore}. */
export interface SessionStoreOptions {
  /**
   * Override the history-snapshot builder used by {@link SessionStore.restoreHistory}.
   * Defaults to a deep clone of the retained history.
   */
  snapshotBuilder?: HistorySnapshotBuilder;
}

/**
 * Deep-clone the retained history into an independent array (R12.2). A deep
 * clone — rather than a shared reference — guarantees the panel re-renders from
 * a stable point-in-time copy that later reductions cannot mutate underneath
 * it. `structuredClone` throws on non-cloneable values; that failure is caught
 * by {@link SessionStore.restoreHistory} (R12.3).
 */
const defaultSnapshotBuilder: HistorySnapshotBuilder = (history) =>
  structuredClone(history.slice());

/**
 * One session's retained state, wrapping a {@link ConversationReducer}. Holds
 * the ordered conversation history (R12.1) plus the model, permission mode, and
 * resumable session identifier the reducer derives from the stream (R12.5).
 *
 * Inbound protocol messages are fed through {@link accept} and user prompts
 * through {@link submitUserPrompt}, so the entry stays consistent with the
 * reduction applied everywhere else. The history exposed by {@link history} is
 * a live reference and MUST be treated as read-only; callers that need an
 * independent copy use {@link SessionStore.restoreHistory}.
 */
export class SessionStoreEntry {
  /** The stable session key this entry belongs to. */
  readonly key: string;

  private readonly reducer: ConversationReducer;

  constructor(key: string, init: Partial<ConversationReducerState> = {}) {
    this.key = key;
    this.reducer = new ConversationReducer(init);
  }

  /** Ordered conversation history (R12.1). Live reference — treat as read-only. */
  get history(): ConversationItem[] {
    return this.reducer.history;
  }

  /** The full reducer-owned state slice (history, model, mode, resumable id). */
  get state(): ConversationReducerState {
    return this.reducer.state;
  }

  /** Latest resumable session identifier seen on the stream, or `null` (R12.5). */
  get resumableSessionId(): string | null {
    return this.reducer.state.resumableSessionId;
  }

  /** Currently effective model, or `null` before `system/init`. */
  get model(): string | null {
    return this.reducer.state.model;
  }

  /** Active permission mode. */
  get permissionMode(): PermissionMode {
    return this.reducer.state.permissionMode;
  }

  /**
   * Process one inbound protocol message, advancing history/model/mode and
   * capturing the latest `session_id` as the resumable identifier (R12.5).
   */
  accept(message: StdoutMessage): void {
    this.reducer.accept(message);
  }

  /** Record a submitted user prompt in the ordered history. */
  submitUserPrompt(text: string): void {
    this.reducer.submitUserPrompt(text);
  }
}

/**
 * In-memory registry of active sessions keyed by a stable session key. Owns the
 * retained conversation history for every active session (R12.1) and survives
 * panel close/reopen because it is held by the host, not the webview (R12.2).
 *
 * Pure and editor-agnostic: it holds only data and reducers, never touches the
 * editor, the process, or the filesystem (R13.1, R13.5).
 */
export class SessionStore {
  private readonly entries = new Map<string, SessionStoreEntry>();
  private readonly snapshotBuilder: HistorySnapshotBuilder;

  constructor(options: SessionStoreOptions = {}) {
    this.snapshotBuilder = options.snapshotBuilder ?? defaultSnapshotBuilder;
  }

  /** Whether a session entry exists for `key`. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The existing entry for `key`, or `undefined` if none has been created. */
  get(key: string): SessionStoreEntry | undefined {
    return this.entries.get(key);
  }

  /**
   * Return the entry for `key`, creating an empty one (with optional seed state)
   * if none exists yet (R12.1). Idempotent: repeated calls for the same key
   * return the same entry, so its history accumulates across the session.
   */
  getOrCreate(
    key: string,
    init: Partial<ConversationReducerState> = {},
  ): SessionStoreEntry {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = new SessionStoreEntry(key, init);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /**
   * Start a NEW session for `key`: allocate a fresh entry with an empty,
   * independent history, replacing any prior entry registered for the key
   * (R12.4). The returned entry shares no state with the prior one — reducing
   * messages into it never mutates the previous session's retained history.
   */
  startNewSession(
    key: string,
    init: Partial<ConversationReducerState> = {},
  ): SessionStoreEntry {
    const entry = new SessionStoreEntry(key, init);
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * The retained ordered history for `key`, or an empty array if no entry
   * exists (R12.1). Returns the live reference — treat as read-only.
   */
  getHistory(key: string): ConversationItem[] {
    return this.entries.get(key)?.history ?? [];
  }

  /** The resumable session identifier recorded for `key`, or `null` (R12.5). */
  getResumableSessionId(key: string): string | null {
    return this.entries.get(key)?.resumableSessionId ?? null;
  }

  /**
   * Feed one inbound protocol message to `key`'s entry, creating the entry if
   * it does not exist yet. Returns the affected entry. The latest `session_id`
   * carried by the message is captured as the resumable identifier (R12.5).
   */
  accept(key: string, message: StdoutMessage): SessionStoreEntry {
    const entry = this.getOrCreate(key);
    entry.accept(message);
    return entry;
  }

  /**
   * Record a submitted user prompt for `key`, creating the entry if it does not
   * exist yet. Returns the affected entry.
   */
  submitUserPrompt(key: string, text: string): SessionStoreEntry {
    const entry = this.getOrCreate(key);
    entry.submitUserPrompt(text);
    return entry;
  }

  /**
   * Produce a snapshot of the retained history for `key` so the panel can
   * re-render it on reopen (R12.2). If `key` has no entry, or if reconstructing
   * the snapshot throws for ANY reason, returns an EMPTY history rather than
   * propagating the error — the panel must still open (R12.3).
   */
  restoreHistory(key: string): ConversationItem[] {
    try {
      const entry = this.entries.get(key);
      if (entry === undefined) {
        return [];
      }
      return this.snapshotBuilder(entry.history);
    } catch {
      return [];
    }
  }

  /** Forget the entry for `key`. Returns `true` if an entry was removed. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }
}
