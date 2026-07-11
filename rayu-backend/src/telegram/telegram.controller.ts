import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Headers,
  HttpCode,
  ParseIntPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator'
import type { User } from '@prisma/client'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import type { TelegramUpdate } from './telegram.client'
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

/** Shared Telegram bot endpoints for the signed-in user. All JWT-guarded routes
 * are scoped to `user.id`, so a user can only pair/read/relay for their OWN
 * linked chat. The webhook endpoint is public — Telegram pushes updates to it
 * directly and validates via a secret token header. */
@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @UseGuards(RayuAuthGuard)
  @Get('bot')
  bot(): Promise<BotInfo> {
    return this.telegram.getBotInfo()
  }

  @UseGuards(RayuAuthGuard)
  @Post('pair')
  pair(@CurrentUser() user: User): Promise<PairingResult> {
    return this.telegram.createPairing(user.id)
  }

  @UseGuards(RayuAuthGuard)
  @Get('link')
  link(@CurrentUser() user: User): Promise<LinkStatus> {
    return this.telegram.getLink(user.id)
  }

  @UseGuards(RayuAuthGuard)
  @Delete('link')
  unlink(@CurrentUser() user: User): Promise<{ ok: true }> {
    return this.telegram.unlink(user.id)
  }

  @UseGuards(RayuAuthGuard)
  @Get('updates')
  updates(
    @CurrentUser() user: User,
    @Query('after', new DefaultValuePipe(0), ParseIntPipe) after: number,
  ): Promise<InboundBatch> {
    return this.telegram.fetchInbound(user.id, after)
  }

  @UseGuards(RayuAuthGuard)
  @Post('send')
  send(
    @CurrentUser() user: User,
    @Body() body: SendRelayDto,
  ): Promise<{ ok: true; result: unknown }> {
    return this.telegram.relaySend(user.id, body.method, body.params ?? {})
  }

  /**
   * Telegram Bot API webhook receiver. Not JWT-guarded — Telegram pushes here
   * directly. Protected by a secret token in `X-Telegram-Bot-Api-Secret-Token`.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TelegramUpdate,
  ): Promise<void> {
    if (!this.telegram.validateWebhookSecret(secret)) {
      throw new UnauthorizedException()
    }
    await this.telegram.receiveUpdate(update)
  }
}
