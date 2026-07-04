import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { TelegramConfig } from '../config/configuration'
import { AbaService } from './aba.service'
import { PaymentsService } from './payments.service'

/**
 * ABA posts its credit alerts FROM ITS OWN BOT into a Telegram group. The Bot
 * API forbids one bot from reading another bot's messages in a group, so we log
 * in as a real USER account over MTProto (GramJS) — which has no such limit —
 * watch the group, and match each alert to a pending ABA payment by amount.
 *
 * The account behind TELEGRAM_SESSION must be a MEMBER of ABA_TELEGRAM_GROUP_ID.
 * Confirmation trusts whatever is posted in that group, so group posting must be
 * locked down to ABA's bot / admins only.
 */
@Injectable()
export class AbaTelegramListener implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AbaTelegramListener.name)
  private readonly cfg: TelegramConfig
  // GramJS has no first-class Nest types; keep the client loosely typed and
  // contained to this file.
  private client: { destroy: () => Promise<void> } | null = null

  constructor(
    private readonly config: ConfigService,
    private readonly aba: AbaService,
    private readonly payments: PaymentsService,
  ) {
    this.cfg = this.config.get<TelegramConfig>('telegram')!
  }

  onModuleInit(): void {
    if ((process.env.NODE_ENV ?? 'development') === 'test') return
    if (!this.cfg.apiId || !this.cfg.apiHash || !this.cfg.session) {
      this.logger.warn(
        'ABA Telegram listener disabled: set TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION to enable ABA payment confirmation',
      )
      return
    }
    // Connect in the background so a slow/failed Telegram login never blocks the
    // HTTP server from coming up.
    void this.start()
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.destroy()
        this.logger.log('ABA userbot disconnected')
      } catch (err) {
        this.logger.warn(`ABA userbot shutdown error: ${String(err)}`)
      }
      this.client = null
    }
  }

  private async start(): Promise<void> {
    try {
      const { TelegramClient } = await import('telegram')
      const { StringSession } = await import('telegram/sessions')
      const { NewMessage } = await import('telegram/events')
      const { Logger, LogLevel } = await import('telegram/extensions/Logger')

      const client = new TelegramClient(
        new StringSession(this.cfg.session!),
        this.cfg.apiId!,
        this.cfg.apiHash!,
        {
          connectionRetries: 5,
          // Telegram's data centers close idle MTProto connections roughly
          // every ~90s when no traffic is flowing; GramJS's own reconnect
          // loop (reconnectRetries defaults to Infinity — intentionally NOT
          // overridden here, so a long-lived userbot always recovers) then
          // logs a WARN/INFO pair + a raw stack trace on every single cycle.
          // That is expected, self-healing behavior, not an actionable
          // error — silencing it below ERROR keeps logs readable without
          // hiding a genuine failure to reconnect.
          baseLogger: new Logger(LogLevel.ERROR),
        },
      )
      // A user session needs no interactive prompts; the string session carries
      // the auth. connect() is enough (start() would prompt).
      await client.connect()
      this.client = client as unknown as { destroy: () => Promise<void> }
      this.logger.log('ABA userbot connected')

      const expectedChatId = normalizeChatId(this.cfg.groupId)
      client.addEventHandler(
        (event: unknown) => this.onMessage(event, expectedChatId),
        new NewMessage({}),
      )
      this.logger.log('ABA Telegram userbot payment listener started')
    } catch (err) {
      this.logger.error(`ABA userbot failed to start: ${String(err)}`)
      this.client = null
    }
  }

  private async onMessage(
    event: unknown,
    expectedChatId: string | null,
  ): Promise<void> {
    const message = (event as { message?: { message?: string; chatId?: unknown } })
      .message
    const text = message?.message
    const chatId = message?.chatId != null ? normalizeChatId(String(message.chatId)) : null

    this.logger.log(
      `ABA userbot received a message chatId=${chatId} expectedChatId=${expectedChatId} text=${JSON.stringify(text)}`,
    )

    if (!text) return
    if (expectedChatId && chatId && chatId !== expectedChatId) return

    const parsed = this.aba.parseAbaNotification(text)
    if (!parsed) return

    try {
      const confirmed = await this.payments.confirmAbaPaymentByAmount(
        parsed.amount,
        parsed.trxId,
      )
      if (confirmed) {
        this.logger.log(
          `ABA payment confirmed via Telegram userbot (amount=${parsed.amount}, trxId=${parsed.trxId})`,
        )
      } else {
        this.logger.warn(
          `ABA alert had no matching pending payment (amount=${parsed.amount}, trxId=${parsed.trxId})`,
        )
      }
    } catch (err) {
      this.logger.error(`ABA confirmation failed: ${String(err)}`)
    }
  }
}

/**
 * Normalize a Telegram chat id to its bare numeric form. Bot-API "marked" ids
 * for supergroups/channels are prefixed with -100 (e.g. -1004302307901), while
 * GramJS reports the bare id (4302307901). Strip the prefix/sign so both match.
 */
function normalizeChatId(id: string | undefined | null): string | null {
  if (!id) return null
  let s = id.trim()
  if (s.startsWith('-100')) s = s.slice(4)
  else if (s.startsWith('-')) s = s.slice(1)
  return s
}
