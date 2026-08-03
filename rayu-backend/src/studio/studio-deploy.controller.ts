import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common'
import { BadRequestException } from '@nestjs/common'
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator'
import type { User } from '@prisma/client'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { StudioConnectionsService } from './studio-connections.service'
import { StudioUpstreamService } from './studio-upstream.service'

/**
 * Netlify / Vercel deploys for Studio.
 *
 * Ported from bolt.diy's api.netlify-deploy.ts and api.vercel-deploy.ts. Two
 * changes from upstream:
 *
 *  1. The deploy token is read from studio_connections, not from the request.
 *     Upstream accepted `token` in the body (and, for Vercel's status loader,
 *     as a QUERY PARAMETER — which lands access tokens in access logs and
 *     browser history).
 *  2. `files` is bounded (see MAX_DEPLOY_FILES / MAX_TOTAL_BYTES). A deploy body
 *     is attacker-sized otherwise, and this backend shares a process with the
 *     accounts API.
 *
 * NOTE: the request body for a deploy is large by nature, so main.ts raises the
 * JSON body limit for /api/studio/deploy specifically. Express's 100kb default
 * would reject a real site.
 */

const MAX_DEPLOY_FILES = 3_000
const MAX_TOTAL_BYTES = 40 * 1024 * 1024 // 40 MB of file contents

export class DeployFilesDto {
  /** Map of path → file contents. */
  @IsObject()
  files!: Record<string, string>

  @IsOptional()
  @IsString()
  @MaxLength(128)
  chatId?: string
}

export class NetlifyDeployDto extends DeployFilesDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  siteId?: string

  @IsOptional()
  @IsString()
  @MaxLength(128)
  siteName?: string
}

export class VercelDeployDto extends DeployFilesDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  projectId?: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  framework?: string
}

export class DeploymentStatusQueryDto {
  @IsString()
  @MaxLength(128)
  id!: string

  @IsIn(['netlify', 'vercel'])
  provider!: 'netlify' | 'vercel'
}

/**
 * Reject an oversized or malformed file map before any upstream call. Returns the
 * validated entries so the caller cannot re-read a different object.
 */
function validateFiles(files: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(files ?? {})
  if (entries.length === 0) {
    throw new BadRequestException('no files to deploy')
  }
  if (entries.length > MAX_DEPLOY_FILES) {
    throw new BadRequestException(`too many files (${entries.length} > ${MAX_DEPLOY_FILES})`)
  }
  let total = 0
  for (const [path, content] of entries) {
    if (typeof content !== 'string') {
      throw new BadRequestException(`file ${path} has non-string contents`)
    }
    // Path traversal in a deploy manifest would let a caller write outside the
    // intended site root on hosts that honour it.
    if (path.includes('..') || path.startsWith('/')) {
      throw new BadRequestException(`file path ${path} is not relative`)
    }
    total += content.length
    if (total > MAX_TOTAL_BYTES) {
      throw new BadRequestException(`deploy exceeds ${MAX_TOTAL_BYTES} bytes`)
    }
  }
  return entries
}

@Controller('studio/deploy')
@UseGuards(RayuAuthGuard)
export class StudioDeployController {
  constructor(
    private readonly upstream: StudioUpstreamService,
    private readonly connections: StudioConnectionsService,
  ) {}

  @Get('netlify/user')
  async netlifyUser(@CurrentUser() user: User): Promise<Record<string, unknown>> {
    const u = await this.upstream.call<Record<string, unknown>>(
      user.id,
      'netlify',
      '/api/v1/user',
    )
    await this.connections.mergeMeta(user.id, 'netlify', {
      id: u.id,
      email: u.email,
      fullName: u.full_name,
    })
    return u
  }

  @Get('netlify/sites')
  netlifySites(@CurrentUser() user: User): Promise<unknown[]> {
    return this.upstream.call<unknown[]>(user.id, 'netlify', '/api/v1/sites')
  }

  /**
   * Create-or-update a Netlify site and push a deploy.
   *
   * Netlify's deploy API takes a digest manifest, so the files are hashed and
   * uploaded individually — the same flow bolt used, minus the client-supplied
   * token.
   */
  @Post('netlify')
  async netlifyDeploy(
    @CurrentUser() user: User,
    @Body() body: NetlifyDeployDto,
  ): Promise<{ siteId: string; deployId: string; url: string | null }> {
    const entries = validateFiles(body.files)

    let siteId = body.siteId
    if (!siteId) {
      const site = await this.upstream.call<{ id: string }>(user.id, 'netlify', '/api/v1/sites', {
        method: 'POST',
        body: { name: body.siteName ?? `rayu-studio-${Date.now()}` },
      })
      siteId = site.id
    }

    const { createHash } = await import('crypto')
    const digests: Record<string, string> = {}
    for (const [path, content] of entries) {
      const normalized = path.startsWith('/') ? path : `/${path}`
      digests[normalized] = createHash('sha1').update(content).digest('hex')
    }

    const deploy = await this.upstream.call<{
      id: string
      required?: string[]
      ssl_url?: string
      url?: string
    }>(user.id, 'netlify', `/api/v1/sites/${encodeURIComponent(siteId)}/deploys`, {
      method: 'POST',
      body: { files: digests, async: true },
    })

    // Netlify replies with the subset of digests it does not already have; only
    // those bodies need uploading.
    const required = new Set(deploy.required ?? [])
    for (const [path, content] of entries) {
      const normalized = path.startsWith('/') ? path : `/${path}`
      if (required.size > 0 && !required.has(digests[normalized])) continue
      await this.upstream.callUrl(
        user.id,
        'netlify',
        new URL(
          `https://api.netlify.com/api/v1/deploys/${encodeURIComponent(deploy.id)}/files${normalized}`,
        ),
        { method: 'PUT', body: content, headers: { 'Content-Type': 'application/octet-stream' } },
      )
    }

    return { siteId, deployId: deploy.id, url: deploy.ssl_url ?? deploy.url ?? null }
  }

  @Get('vercel/user')
  async vercelUser(@CurrentUser() user: User): Promise<Record<string, unknown>> {
    const u = await this.upstream.call<{ user?: Record<string, unknown> }>(
      user.id,
      'vercel',
      '/v2/user',
    )
    const profile = u.user ?? (u as Record<string, unknown>)
    await this.connections.mergeMeta(user.id, 'vercel', {
      username: profile.username,
      email: profile.email,
    })
    return profile
  }

  @Get('vercel/projects')
  vercelProjects(@CurrentUser() user: User): Promise<unknown> {
    return this.upstream.call<unknown>(user.id, 'vercel', '/v9/projects')
  }

  @Post('vercel')
  async vercelDeploy(
    @CurrentUser() user: User,
    @Body() body: VercelDeployDto,
  ): Promise<{ projectId: string; deployId: string; url: string | null }> {
    const entries = validateFiles(body.files)

    let projectId = body.projectId
    if (!projectId) {
      const project = await this.upstream.call<{ id: string }>(user.id, 'vercel', '/v9/projects', {
        method: 'POST',
        body: {
          name: `rayu-studio-${Date.now()}`,
          framework: body.framework ?? null,
        },
      })
      projectId = project.id
    }

    const deployment = await this.upstream.call<{ id: string; url?: string }>(
      user.id,
      'vercel',
      '/v13/deployments',
      {
        method: 'POST',
        body: {
          name: projectId,
          project: projectId,
          target: 'production',
          files: entries.map(([file, data]) => ({ file, data })),
          projectSettings: body.framework ? { framework: body.framework } : undefined,
        },
      },
    )

    return {
      projectId,
      deployId: deployment.id,
      url: deployment.url ? `https://${deployment.url}` : null,
    }
  }

  /**
   * Poll a deployment's state. Replaces bolt's Vercel status loader, which took
   * the access token as a query parameter.
   */
  @Get('status')
  status(
    @CurrentUser() user: User,
    @Query() q: DeploymentStatusQueryDto,
  ): Promise<unknown> {
    const id = encodeURIComponent(q.id)
    return q.provider === 'vercel'
      ? this.upstream.call<unknown>(user.id, 'vercel', `/v13/deployments/${id}`)
      : this.upstream.call<unknown>(user.id, 'netlify', `/api/v1/deploys/${id}`)
  }
}
