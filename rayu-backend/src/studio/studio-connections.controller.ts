import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common'
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import type { User } from '@prisma/client'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import {
  STUDIO_CONNECTION_KINDS,
  type StudioConnectionKind,
} from '../common/enums'
import {
  StudioConnectionsService,
  type StudioConnectionView,
} from './studio-connections.service'

export class UpsertConnectionDto {
  // Upper bound is generous (some Vercel/Supabase tokens are long JWTs) but
  // bounded, because the value is encrypted into a TEXT column.
  @IsString()
  @MinLength(8)
  @MaxLength(4096)
  token!: string

  /** Non-secret metadata to cache for the settings UI (login, avatar, …). */
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>
}

export class ConnectionKindParam {
  @IsIn(STUDIO_CONNECTION_KINDS as unknown as string[])
  kind!: StudioConnectionKind
}

/**
 * Per-user credentials for the third-party services Studio integrates with.
 *
 * Reads return only a masked form of the token; the plaintext is write-only from
 * the client's perspective and is used solely by this backend when calling the
 * service upstream.
 */
@Controller('studio/connections')
@UseGuards(RayuAuthGuard)
export class StudioConnectionsController {
  constructor(private readonly connections: StudioConnectionsService) {}

  @Get()
  list(@CurrentUser() user: User): Promise<StudioConnectionView[]> {
    return this.connections.list(user.id)
  }

  @Put(':kind')
  upsert(
    @CurrentUser() user: User,
    @Param() params: ConnectionKindParam,
    @Body() body: UpsertConnectionDto,
  ): Promise<StudioConnectionView> {
    return this.connections.upsert(user.id, params.kind, body.token, body.meta ?? null)
  }

  @Delete(':kind')
  async remove(
    @CurrentUser() user: User,
    @Param() params: ConnectionKindParam,
  ): Promise<{ ok: true }> {
    await this.connections.remove(user.id, params.kind)
    return { ok: true }
  }
}
