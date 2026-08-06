import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common'
import { IsString, MaxLength, MinLength } from 'class-validator'
import type { User } from '@prisma/client'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { StudioUpstreamService } from './studio-upstream.service'

/**
 * Supabase integration for Studio.
 *
 * SECURITY — this is the sharpest endpoint in the studio backend.
 *
 * bolt.diy's api.supabase.query.ts POSTs caller-supplied SQL to
 * `/v1/projects/{projectId}/database/query` with a Supabase management token.
 * Upstream, both the SQL *and* the projectId came from the request and the token
 * came from the browser, which is coherent for single-user local software: you
 * can only ever attack your own project.
 *
 * Hosted, that shape is a confused-deputy: the backend holds tokens for many
 * users, so an unchecked projectId would let user A run arbitrary SQL against any
 * project reachable by user A's token — and, worse, a mixed-up token lookup would
 * cross tenants. Two controls apply here:
 *
 *   1. The token is always the caller's own (studio_connections, keyed by
 *      user id) — never supplied by the request.
 *   2. `projectId` is verified to be a project that the CALLER's own token can
 *      enumerate, before any query is forwarded (assertOwnsProject).
 *
 * Arbitrary SQL is still arbitrary SQL *against the user's own database*, which
 * is the feature. It is not narrowed further, because the studio's whole purpose
 * is letting the agent manage the user's schema.
 */

export class SupabaseProjectDto {
  // Supabase project refs are 20-char lowercase strings; bounded rather than
  // pattern-matched so a format change upstream doesn't break the feature.
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  projectId!: string
}

export class SupabaseQueryDto extends SupabaseProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  query!: string
}

interface SupabaseProject {
  id: string
  name: string
  region: string
  organization_id: string
  created_at: string
}

@Controller('studio/supabase')
@UseGuards(RayuAuthGuard)
export class StudioSupabaseController {
  constructor(private readonly upstream: StudioUpstreamService) {}

  /** Projects visible to the caller's own Supabase token. */
  @Get('projects')
  projects(@CurrentUser() user: User): Promise<SupabaseProject[]> {
    return this.upstream.call<SupabaseProject[]>(user.id, 'supabase', '/v1/projects')
  }

  /**
   * Confirm the caller's token can see `projectId`.
   *
   * This is the ownership gate. It is intentionally a positive check against the
   * live project list rather than a stored allow-list, so revoking a user's
   * Supabase access upstream takes effect immediately instead of at the next
   * cache expiry.
   */
  private async assertOwnsProject(userId: number, projectId: string): Promise<void> {
    const projects = await this.upstream.call<SupabaseProject[]>(
      userId,
      'supabase',
      '/v1/projects',
    )
    if (!projects.some((p) => p.id === projectId)) {
      // Deliberately does not distinguish "no such project" from "not yours":
      // the difference would confirm the existence of another tenant's ref.
      throw new ForbiddenException(
        'That Supabase project is not accessible with your connected account.',
      )
    }
  }

  /** Anon/service keys for a project the caller owns. */
  @Post('keys')
  async keys(
    @CurrentUser() user: User,
    @Body() body: SupabaseProjectDto,
  ): Promise<unknown> {
    await this.assertOwnsProject(user.id, body.projectId)
    return this.upstream.call<unknown>(
      user.id,
      'supabase',
      `/v1/projects/${encodeURIComponent(body.projectId)}/api-keys`,
    )
  }

  /** Run SQL against a project the caller owns. */
  @Post('query')
  async query(
    @CurrentUser() user: User,
    @Body() body: SupabaseQueryDto,
  ): Promise<unknown> {
    await this.assertOwnsProject(user.id, body.projectId)
    return this.upstream.call<unknown>(
      user.id,
      'supabase',
      `/v1/projects/${encodeURIComponent(body.projectId)}/database/query`,
      { method: 'POST', body: { query: body.query } },
    )
  }
}
