/**
 * Connecting Telegram from the editor — the state and the link polling behind the
 * Telegram card in Settings → Integrations. The editor's `/telegram-bot`.
 *
 * Moved out of extension.ts unchanged in behaviour. The state is owned by the host, so
 * it survives VS Code re-creating a webview, and it deliberately holds NO bot token: a
 * BYO token is passed straight to the engine child and never stored.
 *
 * ── ONE POLLER, TWO SOURCES ────────────────────────────────────────────────────
 *
 *  - hosted: `hostedLink` is a single authenticated GET whose graph is already in the
 *    host bundle. The child creates the pairing and renders the QR; the host watches for
 *    the backend to report the link, exactly as `HostedStep` does in the terminal.
 *  - byo: there is no server-side link — the engine bridge's `consumePendingToken` writes
 *    `linkedChatId` into telegram.json when the user sends `/start <token>`, so this
 *    poller only reads that local file, as the BYO step of `/telegram-bot` does.
 *
 * Hosted never reads local state and BYO never hits the backend. Both pairings expire
 * after 10 minutes (TOKEN_TTL_MS in src/commands/telegram-bot/telegram-bot.tsx, and the
 * BYO pending token's TTL), so a poller cannot wait forever.
 *
 * Free of `vscode` imports; the child calls, the config writes and the restart are injected.
 */
import type { TelegramConnectView } from '../../shared/webviewProtocol.js'
import type { TelegramConnectOutcome } from '../auth/telegramSetup.js'

/** Same cadence as the CLI's HostedStep / BYO-step poll. */
export const TELEGRAM_LINK_POLL_MS = 1_500
export const TELEGRAM_LINK_POLL_TIMEOUT_MS = 10 * 60 * 1000

export const EMPTY_TELEGRAM_CONNECT: TelegramConnectView = {
  open: false,
  busy: false,
  busyMessage: null,
  error: null,
  linkedChatId: null,
  linkedBotUsername: null,
  mode: null,
  botUsername: null,
  qr: null,
  deepLink: null,
  pairingCode: null,
  waitingForLink: false,
}

const NO_PAIRING = { qr: null, deepLink: null, pairingCode: null, waitingForLink: false } as const

export interface TelegramConnectDeps {
  status(): Promise<TelegramConnectOutcome>
  startHosted(): Promise<TelegramConnectOutcome>
  /** The token goes to the engine child and nowhere else. */
  verifyByo(token: string): Promise<TelegramConnectOutcome>
  unlink(): Promise<TelegramConnectOutcome>
  hostedLink(): Promise<{ linked: boolean; chatId?: string; username?: string | null }>
  /** telegram.json's linked chat, read locally. */
  localLinkedChatId(): number | undefined
  setLinkedChat(chatId: number, username?: string, botUsername?: string): void
  setLinkedBotUsername(botUsername: string): void
  /**
   * A link completed. Restart `origin`'s engine (the conversation that asked, or the
   * active one when it was asked from Settings) so it attaches to Telegram.
   */
  onLinked(origin: string | null): void
  publish(view: TelegramConnectView): void
  now?(): number
}

export class TelegramConnectController {
  private view: TelegramConnectView = EMPTY_TELEGRAM_CONNECT
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: TelegramConnectDeps) {}

  get current(): TelegramConnectView {
    return this.view
  }

  /**
   * Open or close the connect surface. Closing abandons an in-flight pairing: nothing is
   * left watching for the link, and the QR would be stale by the time it reopens.
   */
  async open(open: boolean): Promise<void> {
    if (!open) {
      this.stopPolling()
      this.set({ open: false, error: null, ...NO_PAIRING })
      return
    }
    this.set({ open: true, error: null })
    await this.refreshStatus()
  }

  /** Read the link through the engine child, so a link made in the terminal shows here. */
  async refreshStatus(): Promise<void> {
    this.set({ busy: true, busyMessage: 'Loading the Telegram link status…' })
    const outcome = await this.deps.status()
    const view = this.view
    const linked = outcome.ok ? (outcome.linkedChatId ?? null) : view.linkedChatId
    this.set({
      busy: false,
      busyMessage: null,
      linkedChatId: linked,
      linkedBotUsername: outcome.ok ? (outcome.linkedBotUsername ?? null) : view.linkedBotUsername,
      mode: outcome.ok ? (outcome.mode ?? null) : view.mode,
      botUsername: outcome.ok ? (outcome.botUsername ?? view.botUsername) : view.botUsername,
      // A live link means any pairing artifacts are stale.
      ...(linked !== null ? NO_PAIRING : {}),
      error: outcome.ok ? null : (outcome.error ?? 'Could not load the Telegram connection.'),
    })
  }

  async startHosted(origin: string | null): Promise<void> {
    this.set({ busy: true, busyMessage: 'Creating a hosted Telegram pairing…', error: null })
    const outcome = await this.deps.startHosted()
    this.set(outcome.ok
      ? {
          busy: false,
          busyMessage: null,
          error: null,
          mode: 'hosted',
          botUsername: outcome.botUsername ?? this.view.botUsername,
          qr: outcome.qr ?? null,
          deepLink: outcome.deepLink ?? null,
          pairingCode: outcome.pairingCode ?? null,
          waitingForLink: true,
        }
      : { busy: false, busyMessage: null, error: outcome.error ?? 'Could not create a hosted pairing.' })
    // Started AFTER the waiting state is on screen, so the panel and the timer cannot
    // disagree about whether a pairing is in progress.
    if (outcome.ok) this.pollHostedLink(origin)
    else this.stopPolling()
  }

  async startByo(origin: string | null, token: string): Promise<void> {
    this.set({ busy: true, busyMessage: 'Verifying the Telegram bot token…', error: null })
    // The token goes straight to the child; nothing here stores it.
    const outcome = await this.deps.verifyByo(token)
    this.set(outcome.ok
      ? {
          busy: false,
          busyMessage: null,
          error: null,
          mode: 'byo',
          botUsername: outcome.botUsername ?? this.view.botUsername,
          deepLink: outcome.deepLink ?? null,
          waitingForLink: true,
        }
      : { busy: false, busyMessage: null, error: outcome.error ?? 'Could not verify the bot token.' })
    if (outcome.ok) this.pollLocalLink(origin)
    else this.stopPolling()
  }

  async unlink(): Promise<void> {
    // A poll in flight would otherwise race the unlink and re-record the binding.
    this.stopPolling()
    this.set({ busy: true, busyMessage: 'Disconnecting Telegram…', error: null })
    const outcome = await this.deps.unlink()
    if (!outcome.ok) {
      this.set({ busy: false, busyMessage: null, error: outcome.error ?? 'Could not disconnect Telegram.' })
      return
    }
    // The child's unlink() already deletes the auto-attach memory. It leaves the mode
    // and a BYO token in place, matching the CLI, so the status is read back.
    const status = await this.deps.status()
    const view = this.view
    this.set({
      busy: false,
      busyMessage: null,
      error: null,
      ...NO_PAIRING,
      linkedChatId: status.ok ? (status.linkedChatId ?? null) : null,
      linkedBotUsername: status.ok ? (status.linkedBotUsername ?? null) : null,
      botUsername: status.ok ? (status.botUsername ?? view.botUsername) : view.botUsername,
      mode: status.ok ? (status.mode ?? null) : view.mode,
    })
  }

  /** Stop the link poller, hosted or BYO. Idempotent; called on every terminal outcome. */
  stopPolling(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  dispose(): void {
    this.stopPolling()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private pollHostedLink(origin: string | null): void {
    this.stopPolling()
    const deadline = this.now() + TELEGRAM_LINK_POLL_TIMEOUT_MS
    // A slow `hostedLink` can outlast the interval; without this the requests would stack.
    let inFlight = false
    this.startTimer(() => {
      if (inFlight) return
      inFlight = true
      void this.hostedTick(origin, deadline).finally(() => {
        inFlight = false
      })
    })
  }

  private async hostedTick(origin: string | null, deadline: number): Promise<void> {
    try {
      if (!this.view.waitingForLink) return this.stopPolling()
      if (this.now() > deadline) {
        this.stopPolling()
        this.set({ ...NO_PAIRING, error: 'The Telegram pairing code expired. Generate a new QR to try again.' })
        return
      }
      const link = await this.deps.hostedLink()
      if (!link.linked) return
      this.stopPolling()
      // Same binding rules as HostedStep: a chat id is authoritative; without one, at
      // least record which bot this link belongs to.
      const chatId = link.chatId ? Number(link.chatId) : undefined
      if (chatId !== undefined) {
        this.deps.setLinkedChat(chatId, link.username ?? undefined, this.view.botUsername ?? undefined)
      } else if (this.view.botUsername) {
        this.deps.setLinkedBotUsername(this.view.botUsername)
      }
      // Closed or unlinked while the request ran: the config write stands, but the UI
      // update and the restart belong to a surface that no longer wants them.
      if (!this.view.waitingForLink) return
      this.linked(origin, chatId ?? this.view.linkedChatId)
    } catch (error) {
      // `hostedLink` fails soft, so this is a genuinely unexpected fault: stop, do not loop.
      this.stopPolling()
      this.set({
        waitingForLink: false,
        busy: false,
        busyMessage: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private pollLocalLink(origin: string | null): void {
    this.stopPolling()
    const deadline = this.now() + TELEGRAM_LINK_POLL_TIMEOUT_MS
    this.startTimer(() => {
      // Closed, unlinked, or switched to the other mode since the last tick.
      if (!this.view.waitingForLink || this.view.mode !== 'byo') return this.stopPolling()
      if (this.now() > deadline) {
        this.stopPolling()
        this.set({
          waitingForLink: false,
          deepLink: null,
          pairingCode: null,
          error: 'The Telegram pairing link expired. Start the pairing again to try a new link.',
        })
        return
      }
      const chatId = this.deps.localLinkedChatId()
      if (chatId === undefined) return
      this.stopPolling()
      // `consumePendingToken` cannot know the bot's @username; record it so a later
      // connect can detect a bot change.
      if (this.view.botUsername) this.deps.setLinkedBotUsername(this.view.botUsername)
      this.linked(origin, chatId)
    })
  }

  private linked(origin: string | null, chatId: number | null): void {
    this.set({
      ...NO_PAIRING,
      error: null,
      linkedChatId: chatId,
      linkedBotUsername: this.view.botUsername ?? this.view.linkedBotUsername,
    })
    this.deps.onLinked(origin)
  }

  private startTimer(tick: () => void): void {
    this.timer = setInterval(tick, TELEGRAM_LINK_POLL_MS)
    // Never hold the extension host open for a pairing nobody completes.
    this.timer.unref?.()
  }

  private set(patch: Partial<TelegramConnectView>): void {
    this.view = { ...this.view, ...patch }
    this.deps.publish(this.view)
  }
}
