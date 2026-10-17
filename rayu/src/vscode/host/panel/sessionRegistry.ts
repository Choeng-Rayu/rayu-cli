/**
 * The panel's open conversations.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 *
 * The panel used to own exactly ONE `ChatSession`, and "new session" called `newSession()` on
 * it — which tears down the engine child. So pressing + while a turn was running killed that
 * turn mid-flight: the model's answer was lost, any tool that had been approved was abandoned,
 * and going "back" meant `--resume`, which respawns a child and rebuilds the transcript from
 * the session FILE. That rebuild is where the raw `<command-name>/model</command-name>`
 * breadcrumbs surfaced, because the file contains bookkeeping the live path never renders.
 *
 * A registry replaces all of that with the obvious model: several conversations, each with its
 * own engine, all running at once, one of them on screen.
 *
 * ── ONLY THE ACTIVE SESSION MAY WRITE TO THE PANEL ─────────────────────────────
 *
 * Every `ChatSession` keeps its own transcript, turn state, thinking blocks, tasks and review
 * records internally; the callbacks are purely a PUSH channel to the webview. That is what
 * makes this cheap: a background session's callbacks are dropped, its state keeps accruing,
 * and activation is a full `surfaces.syncSession()` that re-posts the init snapshot to the
 * surfaces bound to the session that just came to the front. There
 * is no second copy of anything and no reconciliation step.
 *
 * The PERMISSION ROUTER is a per-session exception, and getting it wrong would be a
 * silent-wrong-answer bug:
 *
 *   the PERMISSION ROUTER — one per session, because a card belongs to the engine that is
 *     blocked on it. A shared router would offer the foreground user a decision on a
 *     background conversation's tool, and answering it would allow a tool they never saw.
 *     Its callbacks now carry their OWNING entry, so a card is routed to the surfaces
 *     showing THAT conversation rather than to whatever happens to be on screen.
 *
 * The DIFF STORE used to be a second such singleton, hand-published on activation. It is
 * now keyed by `(sessionKey, displayPath)` (see `review/fileChangeReview.ts`), so each
 * conversation reconstructs "before" content from its own recorded hunks — no handover,
 * and no cross-session collision when two conversations edit the same file.
 *
 * ── SESSIONS ARE BOUNDED, AND THE BOUND IS ABOUT PROCESSES ─────────────────────
 *
 * Each session is a ~23 MB Node child that may own MCP subprocesses. Unbounded growth would be
 * a memory leak the user creates by pressing a button, so the oldest IDLE session is retired
 * when the limit is reached. Never a running one: silently killing work is the bug this whole
 * module exists to fix.
 */
import { ChatSession, type SessionCallbacks, type SessionOptions } from './sessionHandle.js'
import { PermissionRouter } from './permissionRouter.js'
import type { LiveSessionView, PermissionRequestView } from '../../shared/webviewProtocol.js'

/**
 * How many conversations may be open at once.
 *
 * Four is a judgement, not a measurement: enough for the "kick something off, work on
 * something else" pattern this exists to serve, few enough that the worst case is four engine
 * children rather than however many times the user pressed +.
 */
export const MAX_LIVE_SESSIONS = 4

export interface RegistryCallbacks {
  /** Build the callbacks for one session. `isActive` gates every push to the webview. */
  sessionCallbacks: (entry: SessionEntry, isActive: () => boolean) => SessionCallbacks
  /**
   * Show an approval card, tagged with the conversation that raised it. Called for a
   * background conversation too — its card belongs in ITS tab, not the foreground one.
   */
  onShowPermission: (entry: SessionEntry, request: PermissionRequestView) => void
  /** Remove an approval card, tagged with the conversation that raised it. */
  onDismissPermission: (entry: SessionEntry, requestId: string) => void
  /** The active session changed, or a live session's summary did. */
  onChanged: () => void
  /** The active (sidebar-bound) session changed. */
  onActivate: (entry: SessionEntry) => void
  /**
   * An entry is being retired — evicted for capacity, or explicitly closed. Fired
   * immediately before its engine is disposed. Used to close the conversation's editor
   * tab; callers must treat it as idempotent.
   */
  onRetire?: (entry: SessionEntry) => void
}

/** One open conversation. */
export interface SessionEntry {
  /** The panel's own key. Stable for the entry's life, unlike the engine's session id. */
  readonly key: string
  readonly session: ChatSession
  /** This conversation's approval cards. See the header for why it is not shared. */
  readonly permissions: PermissionRouter
  customTitle: string | null
}

export class SessionRegistry {
  private readonly entries: SessionEntry[] = []
  private activeKey = ''
  private counter = 0

  constructor(
    private readonly baseOptions: SessionOptions,
    private readonly callbacks: RegistryCallbacks,
  ) {}

  /** The conversation on screen. Created on first access so construction stays trivial. */
  get active(): SessionEntry {
    const found = this.entries.find(entry => entry.key === this.activeKey)
    if (found) return found
    return this.create()
  }

  get activeSessionKey(): string {
    return this.active.key
  }

  /** Every open conversation, for disposal and for the live list. */
  get all(): readonly SessionEntry[] {
    return this.entries
  }

  /**
   * Open a new conversation, leaving the others RUNNING.
   *
   * This is the whole point of the module: the previous implementation's "new session" was a
   * teardown of the only session there was.
   */
  create(options: { resumeSessionId?: string; cwd?: string; customTitle?: string } = {}): SessionEntry {
    this.retireForCapacity()

    const key = `panel-${++this.counter}`
    let entry: SessionEntry
    const session = new ChatSession(
      {
        ...this.baseOptions,
        ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      // Late-bound through a getter closure: the callbacks need the entry, and the entry needs
      // the session. The alternative — a settable `entry` field on the session — would let a
      // callback fire against a half-built entry.
      this.callbacks.sessionCallbacks(
        { get key() { return key }, get session() { return entry.session }, get permissions() { return entry.permissions }, get customTitle() { return entry.customTitle }, set customTitle(value) { entry.customTitle = value } },
        () => this.activeKey === key,
      ),
    )
    const permissions = new PermissionRouter({
      onShow: request => {
        // The card is routed to the surfaces showing THIS conversation — a background
        // tab must render its own approval card, so the active key no longer gates it.
        // `onChanged()` still fires so the live list's pending-approval count is fresh.
        this.callbacks.onShowPermission(entry, request)
        this.callbacks.onChanged()
      },
      onDismiss: requestId => {
        this.callbacks.onDismissPermission(entry, requestId)
        this.callbacks.onChanged()
      },
    })

    entry = { key, session, permissions, customTitle: options.customTitle ?? null }
    this.entries.push(entry)
    this.activeKey = key
    this.callbacks.onActivate(entry)
    this.callbacks.onChanged()
    return entry
  }

  /**
   * Bring an already-open conversation to the front.
   *
   * Returns null for an unknown key, which happens when the webview acts on a list it fetched
   * before a session was closed. Reporting it lets the caller resync rather than throw.
   */
  activate(key: string): SessionEntry | null {
    const entry = this.entries.find(item => item.key === key)
    if (!entry) return null
    if (this.activeKey === key) return entry
    this.activeKey = key
    this.callbacks.onActivate(entry)
    this.callbacks.onChanged()
    return entry
  }

  /** The open conversation whose engine reports this session id, if any. */
  findByEngineSessionId(sessionId: string): SessionEntry | null {
    return (
      this.entries.find(entry => entry.session.engineSessionId === sessionId) ?? null
    )
  }

  /** The open conversation with this panel key, or null when it is unknown. */
  byKey(key: string): SessionEntry | null {
    return this.entries.find(entry => entry.key === key) ?? null
  }

  /** True while a conversation with this panel key is open. */
  has(key: string): boolean {
    return this.entries.some(entry => entry.key === key)
  }

  setTitle(key: string, title: string): boolean {
    const entry = this.entries.find(item => item.key === key)
    if (!entry) return false
    entry.customTitle = title
    this.callbacks.onChanged()
    return true
  }

  /**
   * Close one conversation and stop its engine.
   *
   * Pending cards are dismissed WITHOUT an answer, for the reason `permissionRouter.ts`
   * documents: fabricating a denial would reject a tool the user was mid-way through
   * approving. The engine is going away, so nothing can act on an invented answer anyway.
   */
  close(key: string): void {
    const index = this.entries.findIndex(entry => entry.key === key)
    if (index === -1) return
    const [entry] = this.entries.splice(index, 1)
    // The conversation is gone: close its editor tab BEFORE the engine is disposed, so
    // the surfaces can be torn down while the entry is still identifiable.
    if (entry) this.callbacks.onRetire?.(entry)
    entry?.permissions.cancelAll()
    entry?.session.dispose()
    // Closing the visible conversation has to leave SOMETHING visible. The most recently
    // active remaining session is the least surprising choice; with none left, a fresh one.
    if (this.activeKey === key) {
      const next = this.entries[this.entries.length - 1]
      if (next) {
        this.activeKey = next.key
        this.callbacks.onActivate(next)
      } else {
        this.create()
        return
      }
    }
    this.callbacks.onChanged()
  }

  /** The live list, newest activity first, with the active session's key. */
  summaries(): LiveSessionView[] {
    return [...this.entries]
      .sort((a, b) => b.session.lastActivityAt - a.session.lastActivityAt)
      .map(entry => ({
        key: entry.key,
        ...(entry.session.engineSessionId ? { sessionId: entry.session.engineSessionId } : {}),
        label: labelFor(entry),
        running: entry.session.isTurnRunning,
        pendingApprovals: entry.permissions.snapshot().length,
        model: entry.session.currentModelInfo.model,
        updatedAt: entry.session.lastActivityAt,
      }))
  }

  dispose(): void {
    for (const entry of this.entries.splice(0)) {
      entry.permissions.cancelAll()
      entry.session.dispose()
    }
  }

  /**
   * Make room, without ever stopping work.
   *
   * Retires the least-recently-active IDLE session. When every session is busy the limit is
   * exceeded rather than enforced: a cap is a resource guard, and honouring it by killing a
   * running turn would reintroduce the exact failure this module was written to remove.
   */
  private retireForCapacity(): void {
    while (this.entries.length >= MAX_LIVE_SESSIONS) {
      const idle = [...this.entries]
        .filter(
          entry =>
            !entry.session.isTurnRunning && entry.permissions.snapshot().length === 0,
        )
        .sort((a, b) => a.session.lastActivityAt - b.session.lastActivityAt)[0]
      if (!idle) return
      const index = this.entries.indexOf(idle)
      this.entries.splice(index, 1)
      // An eviction is a retirement too: close the idle conversation's tab, then its
      // engine. Only ever an IDLE session (see the policy above), so nothing mid-turn.
      this.callbacks.onRetire?.(idle)
      idle.session.dispose()
    }
  }
}

/**
 * A name for a live conversation.
 *
 * Derived from the first prompt, exactly as the header's title is, so the list and the header
 * agree. A session with no prompt yet is named for the fact that it is empty rather than left
 * blank — an unlabelled row is unclickable in practice.
 */
function labelFor(entry: SessionEntry): string {
  if (entry.customTitle) return entry.customTitle
  const prompt = entry.session.transcript.find(item => item.kind === 'prompt')
  if (prompt?.kind === 'prompt') {
    const line = prompt.text.split('\n').map(part => part.trim()).find(Boolean)
    if (line) return line.length > 60 ? `${line.slice(0, 59)}…` : line
  }
  return 'New conversation'
}
