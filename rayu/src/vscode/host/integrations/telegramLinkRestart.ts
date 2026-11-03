/**
 * When a conversation restarts so its engine attaches to a new Telegram link.
 *
 * An engine reads telegram.json when it starts, so a link made after that needs a
 * restart (see `restartTelegramLinkedSession` in extension.ts). A turn in flight is never
 * interrupted for it: the restart waits until that turn ends, and then a little longer.
 * The restart resumes the conversation from its session file, which the engine writes on
 * a 100 ms timer (FLUSH_INTERVAL_MS in src/utils/sessionStorage.ts), so the last reply
 * must be on disk before the old engine is stopped.
 *
 * When the restart is due, the conversation is looked up again:
 *  - closed: nothing to do;
 *  - a new turn running: wait for that one instead;
 *  - no engine: it stopped, and the next one reads the link when it starts;
 *  - a different engine than at link time: something else already restarted it, and
 *    restarting again would only cost the user a reload.
 * A link made while the engine was still starting restarts whichever engine the turn ends
 * with, because that engine may have read telegram.json before the link was written.
 *
 * Free of `vscode` imports; the lookup, the restart and the timer are injected.
 */

/** How long after a turn ends its restart waits, for the turn's transcript writes. */
export const TELEGRAM_RESTART_SETTLE_MS = 1_000

/** A conversation as it is now. The engine is compared by identity. */
export interface LinkRestartTarget<Engine> {
  readonly isTurnRunning: boolean
  /** The running engine, or null when none is connected. */
  readonly engine: Engine | null
}

export interface TelegramLinkRestartDeps<Engine> {
  /** The conversation now, or null once it has closed. */
  lookup(key: string): LinkRestartTarget<Engine> | null
  restart(key: string): void
  /** Run `settle` once an ended turn has had TELEGRAM_RESTART_SETTLE_MS to finish writing. */
  schedule(settle: () => void): void
}

export class TelegramLinkRestarts<Engine> {
  /** Conversation key → its engine when the link was made; null while it was starting. */
  private readonly waiting = new Map<string, Engine | null>()

  constructor(private readonly deps: TelegramLinkRestartDeps<Engine>) {}

  /** A link completed for this conversation. Restarts it now, or after its turn. */
  requestRestart(key: string): void {
    this.waiting.delete(key)
    const target = this.deps.lookup(key)
    if (!target) return
    if (target.isTurnRunning) this.waiting.set(key, target.engine)
    else this.deps.restart(key)
  }

  /** A conversation's turn ended. Called from its turn-state callback. */
  turnEnded(key: string): void {
    if (this.waiting.has(key)) this.deps.schedule(() => this.settle(key))
  }

  isWaiting(key: string): boolean {
    return this.waiting.has(key)
  }

  private settle(key: string): void {
    if (!this.waiting.has(key)) return
    const target = this.deps.lookup(key)
    if (target?.isTurnRunning) return
    const linkedEngine = this.waiting.get(key)
    this.waiting.delete(key)
    if (!target || target.engine === null) return
    if (linkedEngine === null || linkedEngine === target.engine) this.deps.restart(key)
  }
}
