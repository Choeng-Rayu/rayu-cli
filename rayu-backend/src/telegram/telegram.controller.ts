import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator'
import type { User } from '@prisma/client'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { RELAY_ALLOWED_METHODS } from './telegram.util'
import {
  BotInfo,
  InboundBatch,
  LinkStatus,
  PairingResult,
  TelegramService,
} from './telegram.service'

export class SendRelayDto {
  @IsString()
  @IsIn(Array.from(RELAY_ALLOWED_METHODS))
  method!: string

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>
}

/**
 * Shared Telegram bot endpoints for the signed-in user. All routes are
 * JWT-guarded and scoped to `user.id`, so a user can only pair/read/relay for
 * their OWN linked chat. The bot token itself lives only in the backend env.
 */
@Controller('telegram')
@UseGuards(RayuAuthGuard)
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  /** Is the shared bot available, and what's its @username (for deep links)? */
  @Get('bot')
  bot(): Promise<BotInfo> {
    return this.telegram.getBotInfo()
  }

  /** Issue a single-use pairing code + deep link to the shared bot. */
  @Post('pair')
  pair(@CurrentUser() user: User): Promise<PairingResult> {
    return this.telegram.createPairing(user.id)
  }

  /** Current link status for this user (poll after showing the QR). */
  @Get('link')
  link(@CurrentUser() user: User): Promise<LinkStatus> {
    return this.telegram.getLink(user.id)
  }

  /** Unlink this user's Telegram chat from the shared bot. */
  @Delete('link')
  unlink(@CurrentUser() user: User): Promise<{ ok: true }> {
    return this.telegram.unlink(user.id)
  }

  /** Long-poll inbound updates routed to this user's linked chat. */
  @Get('updates')
  updates(
    @CurrentUser() user: User,
    @Query('after', new DefaultValuePipe(0), ParseIntPipe) after: number,
  ): Promise<InboundBatch> {
    return this.telegram.fetchInbound(user.id, after)
  }

  /** Relay an outbound Telegram call (chat_id forced to the user's own chat). */
  @Post('send')
  send(
    @CurrentUser() user: User,
    @Body() body: SendRelayDto,
  ): Promise<{ ok: true; result: unknown }> {
    return this.telegram.relaySend(user.id, body.method, body.params ?? {})
  }
}
