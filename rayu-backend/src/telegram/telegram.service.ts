import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import {
  tgCall,
  tgGetMe,
  tgGetUpdates,
  tgSendMessage,
  type TelegramUpdate,
} from './telegram.client'
import {
  generatePairingCode,
  isExpired,
  parseStartCommand,
  RELAY_ALLOWED_METHODS,
  RELAY_CHAT_SCOPED_METHODS,
  routeUpdate,
  unmatchedPairingReply,
  updateChatId,
  updateText,
  updateUsername,
} from './telegram.util'

const PAIRING_TTL_MS = 10 * 60 * 1000 // 10 minutes
const INBOUND_LONG_POLL_MS = 25_000
const INBOUND_POLL_STEP_MS = 1_000
const INBOUND_BATCH = 50

export interface BotInfo {
  configured: boolean
  username: string | null
}

export interface PairingResult {
  code: string
  expiresAt: string
  botUsername: string | null
  deepLink: string | null
}

export interface LinkStatus {
  linked: boolean
  chatId?: string
  username?: string | null
}

export interface InboundBatch {
  linked: boolean
  updates: Array<{ id: number; update: unknown }>
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

/**
 * Shared Telegram bot service. Runs either:
 * - a getUpdates poller, or
 * - a Telegram Bot API webhook receiver
 * for the whole deployment (Telegram allows a single consumer per token), routes
 * each chat's traffic to the owning Rayu user's inbound queue, and relays
 * outbound calls (chat_id forced to the caller's own link). Users who bring their
 * own bot token in the CLI never touch this service.
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name)
  // The shared bot's token lives under its OWN env var (RAYU_SHARED_BOT_TOKEN)
  // so it never collides with the separate ABA payment bot's TELEGRAM_BOT_TOKEN.
  private readonly token = process.env.RAYU_SHARED_BOT_TOKEN?.trim() || ''
  private readonly webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim() || ''
  private readonly webhookSecret =
    process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || ''
  private botUsername: string | null = null
  private polling = false
  private lastConflictLogAt = 0

  constructor(private readonly prisma: PrismaService) {}

  /** True when a shared bot token is configured (hosted mode is available). */
  get configured(): boolean {
    return this.token.length > 0
  }

  /** True when the deployment is configured to receive Telegram webhooks. */
  get webhookConfigured(): boolean {
    return this.webhookUrl.length > 0
  }

  onModuleInit(): void {
    // Never start the network consumer in tests, or when no shared token is
    // configured (BYO-only deployment).
    if (
      !this.configured ||
      process.env.NODE_ENV === 'test'
    ) {
      return
    }

    if (process.env.SKIP_TELEGRAM_POLL === 'true' && !this.webhookConfigured) {
      this.logger.log('Shared Telegram bot configured (poller + webhook disabled).')
      return
    }

    if (this.webhookConfigured) {
      void this.registerWebhook()
      return
    }

    void this.startPoller()
  }

  // ---- Public API (called by the controller) --------------------------------

  async getBotInfo(): Promise<BotInfo> {
    if (!this.configured) return { configured: false, username: null }
    if (!this.botUsername) this.botUsername = await tgGetMe(this.token)
    return { configured: true, username: this.botUsername }
  }

  /** Issue a fresh single-use pairing code for a user (replaces any prior one). */
  async createPairing(userId: number): Promise<PairingResult> {
    if (!this.configured) {
      throw new BadRequestException('shared telegram bot is not configured')
    }
    const code = generatePairingCode()
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS)
    // One active pairing per user; also sweep expired rows to bound growth.
    await this.prisma.telegramPairing.deleteMany({
      where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] },
    })
    await this.prisma.telegramPairing.create({ data: { code, userId, expiresAt } })
    const info = await this.getBotInfo()
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      botUsername: info.username,
      deepLink: info.username ? `https://t.me/${info.username}?start=${code}` : null,
    }
  }

  /** Accept and route a single Telegram update (used by webhook + poller). */
  async receiveUpdate(u: TelegramUpdate): Promise<void> {
    try {
      await this.handleUpdate(u)
    } catch (e) {
      this.logger.warn(`telegram update handling failed: ${String(e)}`)
    }
  }

  async setWebhook(): Promise<void> {
    if (!this.configured) throw new Error('shared bot token not configured')
    if (!this.webhookConfigured) throw new Error('webhook URL not configured')
    const secretToken = this.webhookSecret || undefined
    await tgCall(this.token, 'setWebhook', {
      url: this.webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      secret_token: secretToken,
    })
  }

  async getLink(userId: number): Promise<LinkStatus> {
    const link = await this.prisma.telegramLink.findUnique({ where: { userId } })
    if (!link) return { linked: false }
    return { linked: true, chatId: link.chatId, username: link.username }
  }

  async unlink(userId: number): Promise<{ ok: true }> {
    await this.prisma.telegramLink.deleteMany({ where: { userId } })
    return { ok: true }
  }

  /**
   * Long-poll the user's inbound queue. `after` is the highest update-row id the
   * CLI has already processed — rows up to it are deleted (ack), and only rows
   * beyond it are returned. Waits up to INBOUND_LONG_POLL_MS for new traffic.
   */
  async fetchInbound(userId: number, after: number): Promise<InboundBatch> {
    if (after > 0) {
      await this.prisma.telegramInbound.deleteMany({
        where: { userId, id: { lte: after } },
      })
    }
    const deadline = Date.now() + INBOUND_LONG_POLL_MS
    for (;;) {
      const rows = await this.prisma.telegramInbound.findMany({
        where: { userId, id: { gt: after } },
        orderBy: { id: 'asc' },
        take: INBOUND_BATCH,
      })
      if (rows.length > 0 || Date.now() >= deadline) {
        const link = await this.prisma.telegramLink.findUnique({
          where: { userId },
        })
        return {
          linked: !!link,
          updates: rows.map((r) => ({ id: r.id, update: r.payload })),
        }
      }
      await sleep(INBOUND_POLL_STEP_MS)
    }
  }

  /**
   * Relay an outbound Telegram method for a linked user. Only a whitelist of
   * chat-safe methods is permitted, and chat-scoped methods have chat_id FORCED
   * to the caller's own linked chat so a user can never message another chat.
   */
  async relaySend(
    userId: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown }> {
    if (!this.configured) {
      throw new BadRequestException('shared telegram bot is not configured')
    }
    if (!RELAY_ALLOWED_METHODS.has(method)) {
      throw new BadRequestException(`method not allowed: ${method}`)
    }
    const link = await this.prisma.telegramLink.findUnique({ where: { userId } })
    if (!link) throw new BadRequestException('telegram not linked')

    const forced: Record<string, unknown> = { ...(params ?? {}) }
    if (RELAY_CHAT_SCOPED_METHODS.has(method)) {
      forced.chat_id = link.chatId // isolation: always the caller's own chat
    }
    const result = await tgCall(this.token, method, forced)
    return { ok: true, result }
  }

  // ---- Central poller -------------------------------------------------------

  private async registerWebhook(): Promise<void> {
    try {
      await this.setWebhook()
      this.logger.log(`Shared Telegram bot webhook registered: ${this.webhookUrl}`)
    } catch (e) {
      this.logger.error(
        `Failed to register Telegram webhook: ${String(e)}. ` +
          'Telegram will not push updates until this is fixed.',
      )
    }
  }

  private async startPoller(): Promise<void> {
    this.polling = true
    this.logger.log('Starting shared Telegram bot poller…')
    let offset = await this.loadOffset()
    while (this.polling) {
      const updates = await tgGetUpdates(this.token, offset, 50, (msg) =>
        this.onPollError(msg),
      )
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1)
        try {
          await this.handleUpdate(u)
        } catch (e) {
          this.logger.warn(`telegram update handling failed: ${String(e)}`)
        }
      }
      if (updates.length > 0) await this.saveOffset(offset)
      else await sleep(INBOUND_POLL_STEP_MS) // gentle backoff on idle/errors
    }
  }

  /**
   * Surface a getUpdates 409 Conflict — Telegram allows only ONE consumer per
   * token, so this means a SECOND poller (another backend instance, or a CLI
   * using this bot as its own "BYO" token) is stealing updates. Rate-limited so
   * it doesn't spam the logs. This is the #1 cause of "messages don't reach the
   * CLI" + "linked successfully AND invalid" during pairing.
   */
  private onPollError(message: string): void {
    if (!/conflict/i.test(message)) return
    const now = Date.now()
    if (now - this.lastConflictLogAt < 30_000) return
    this.lastConflictLogAt = now
    this.logger.warn(
      'Telegram getUpdates CONFLICT (409): another process is polling this bot. ' +
        'Only ONE poller may consume RAYU_SHARED_BOT_TOKEN — check for a second ' +
        'backend instance (local + prod), or a CLI using this same token as its ' +
        'own bot. Inbound messages will be split/lost until there is exactly one.',
    )
  }

  /** Route a single update: pair / disconnect / enqueue / ignore. */
  private async handleUpdate(u: TelegramUpdate): Promise<void> {
    const chatId = updateChatId(u)
    if (!chatId) return
    const text = updateText(u)
    const link = await this.prisma.telegramLink.findUnique({ where: { chatId } })
    const route = routeUpdate(text, !!link)

    if (route === 'pair') {
      await this.handlePairing(u, chatId, text)
      return
    }
    if (route === 'disconnect') {
      await this.prisma.telegramLink.deleteMany({ where: { chatId } })
      await tgSendMessage(
        this.token,
        chatId,
        '🔌 Disconnected. Run /telegram-bot in rayu-cli to link again.',
      )
      return
    }
    if (route === 'enqueue' && link) {
      await this.prisma.telegramInbound.create({
        data: { userId: link.userId, payload: u as unknown as Prisma.InputJsonValue },
      })
      return
    }
    // ignore — nudge only on plain text so we don't spam on callbacks.
    if (text) {
      await tgSendMessage(
        this.token,
        chatId,
        'This chat is not linked. Run /telegram-bot in rayu-cli to connect.',
      )
    }
  }

  /** Validate the secret token Telegram sends in webhook requests. */
  validateWebhookSecret(headerValue: string | undefined): boolean {
    if (!this.webhookSecret) return true
    if (!headerValue) return false
    // Constant-time-ish compare is overkill for a random secret token, but safe.
    const a = Buffer.from(this.webhookSecret)
    const b = Buffer.from(headerValue)
    if (a.length !== b.length) return false
    let match = true
    for (let i = 0; i < a.length; i++) {
      match = match && a[i] === b[i]
    }
    return match
  }

  private async handlePairing(
    u: TelegramUpdate,
    chatId: string,
    text: string,
  ): Promise<void> {
    const code = parseStartCommand(text)
    if (!code) return
    const pairing = await this.prisma.telegramPairing.findUnique({
      where: { code },
    })
    if (!pairing || isExpired(pairing.expiresAt)) {
      // Not necessarily an error: a duplicate /start (START tapped twice, or a
      // second poller) arrives after the code was already consumed. If this
      // chat is already linked, report success instead of a scary "invalid".
      const existing = await this.prisma.telegramLink.findUnique({
        where: { chatId },
      })
      await tgSendMessage(this.token, chatId, unmatchedPairingReply(!!existing))
      return
    }
    const username = updateUsername(u)
    // Bind this chat to the user, replacing any previous link for either side,
    // and consume all of the user's pairing codes.
    await this.prisma.$transaction([
      this.prisma.telegramLink.deleteMany({
        where: { OR: [{ userId: pairing.userId }, { chatId }] },
      }),
      this.prisma.telegramLink.create({
        data: { userId: pairing.userId, chatId, username },
      }),
      this.prisma.telegramPairing.deleteMany({ where: { userId: pairing.userId } }),
      // Drop any stale inbound rows so a fresh link doesn't replay old messages.
      this.prisma.telegramInbound.deleteMany({ where: { userId: pairing.userId } }),
    ])
    await tgSendMessage(
      this.token,
      chatId,
      '✅ Linked to rayu-cli. Send any message to drive the CLI. Use /disconnect to unlink.',
    )
  }

  private async loadOffset(): Promise<number> {
    const row = await this.prisma.telegramCursor.findUnique({ where: { id: 1 } })
    return row ? Number(row.offset) : 0
  }

  private async saveOffset(offset: number): Promise<void> {
    await this.prisma.telegramCursor.upsert({
      where: { id: 1 },
      create: { id: 1, offset: BigInt(offset) },
      update: { offset: BigInt(offset) },
    })
  }
}
