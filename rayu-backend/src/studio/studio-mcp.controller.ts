import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common'
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator'
import type { User } from '@prisma/client'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { requirePublicUrl } from '../common/studio-urls'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Per-user MCP (Model Context Protocol) server configuration for Studio.
 *
 * Ported from bolt.diy's api.mcp-check.ts / api.mcp-update-config.ts, which held
 * the config in a process-global `MCPService.getInstance()` singleton. In a
 * multi-tenant backend a singleton would mean one user's MCP servers serving
 * another user's session, so config is stored per user and never cached across
 * requests.
 *
 * Every server URL passes the SSRF guard both on write and before each
 * availability check: a row already in the database is not trusted, because the
 * allow-list rules can tighten after the row was written.
 */

/** Shape of the config bolt's UI sends. */
interface McpServersConfig {
  mcpServers?: Record<string, { type?: string; url?: string; command?: string }>
}

export class UpdateMcpConfigDto {
  @IsObject()
  mcpServers!: Record<string, { type?: string; url?: string; command?: string }>
}

export class CheckMcpServerDto {
  @IsString()
  @MaxLength(2048)
  url!: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string
}

interface ServerStatus {
  name: string
  url: string
  available: boolean
  error?: string
}

const CHECK_TIMEOUT_MS = 5_000

@Controller('studio/mcp')
@UseGuards(RayuAuthGuard)
export class StudioMcpController {
  private readonly logger = new Logger(StudioMcpController.name)

  constructor(private readonly prisma: PrismaService) {}

  @Get('config')
  async getConfig(@CurrentUser() user: User): Promise<McpServersConfig> {
    const row = await this.prisma.studioMcpConfig.findUnique({
      where: { userId: user.id },
    })
    return (row?.config as McpServersConfig) ?? { mcpServers: {} }
  }

  @Put('config')
  async putConfig(
    @CurrentUser() user: User,
    @Body() body: UpdateMcpConfigDto,
  ): Promise<McpServersConfig> {
    // Validate every URL before storing, so a bad entry is rejected at the point
    // the user can still see which one it was.
    for (const [name, server] of Object.entries(body.mcpServers ?? {})) {
      if (server?.url) {
        requirePublicUrl(server.url, `mcpServers.${name}.url`)
      }
      // A `command` server means "spawn this process", which is meaningful for
      // local bolt but would be remote code execution on our host.
      if (server?.command) {
        throw new BadRequestException(
          `mcpServers.${name} uses "command", which is only supported when running Studio locally. ` +
            `Use an HTTP/SSE server URL instead.`,
        )
      }
    }

    const config = { mcpServers: body.mcpServers } as never
    const row = await this.prisma.studioMcpConfig.upsert({
      where: { userId: user.id },
      create: { userId: user.id, config },
      update: { config },
    })
    return row.config as McpServersConfig
  }

  /**
   * Probe the caller's configured servers. Mirrors bolt's
   * `checkServersAvailabilities()` response shape (a map of server name → status).
   */
  @Post('check')
  async check(@CurrentUser() user: User): Promise<Record<string, ServerStatus>> {
    const cfg = await this.getConfig(user)
    const servers = Object.entries(cfg.mcpServers ?? {})

    const results = await Promise.all(
      servers.map(async ([name, server]): Promise<ServerStatus> => {
        if (!server?.url) {
          return { name, url: '', available: false, error: 'no url configured' }
        }
        let url: URL
        try {
          // Re-validate: the allow-list may have tightened since the row was saved.
          url = requirePublicUrl(server.url, `mcpServers.${name}.url`)
        } catch (e) {
          return {
            name,
            url: server.url,
            available: false,
            error: (e as Error).message,
          }
        }
        try {
          const res = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          })
          return { name, url: url.toString(), available: res.ok }
        } catch (e) {
          this.logger.debug(`mcp check failed for ${name}: ${(e as Error).message}`)
          return {
            name,
            url: url.toString(),
            available: false,
            error: (e as Error).message,
          }
        }
      }),
    )

    return Object.fromEntries(results.map((r) => [r.name, r]))
  }
}
