import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PrismaModule } from '../prisma/prisma.module'
import { StudioConnectionsController } from './studio-connections.controller'
import { StudioConnectionsService } from './studio-connections.service'
import { StudioDeployController } from './studio-deploy.controller'
import { StudioGitProxyController } from './studio-git-proxy.controller'
import {
  StudioGithubPushController,
  StudioGitlabPushController,
} from './studio-scm-push.controller'
import { StudioMcpController } from './studio-mcp.controller'
import { StudioGithubController, StudioGitlabController } from './studio-scm.controller'
import { StudioSupabaseController } from './studio-supabase.controller'
import { StudioProxyTokenGuard } from './studio-proxy-token.guard'
import { StudioUpstreamService } from './studio-upstream.service'
import { StudioWebSearchController } from './studio-web-search.controller'

/**
 * Backend for Rayu Studio (rayucode.com/studio).
 *
 * SCOPE — this module owns everything the studio needs that is NOT an LLM call.
 * Model calls, the model catalog, credit metering, and the BYO-key proxy all live
 * in rayu-gateway; nothing in this module may talk to a model provider. The
 * frontend (rayu-web) holds no secrets and has no API routes of its own.
 *
 * These endpoints replace 17 of bolt.diy's Remix server routes. Upstream, all of
 * them were unauthenticated and took third-party tokens from the request, which
 * is coherent for single-user software on localhost. Every controller here is
 * behind RayuAuthGuard and resolves credentials from studio_connections for the
 * authenticated user, so a request can only ever act as its own owner.
 *
 * Eight further bolt routes are deliberately NOT ported: api.system.diagnostics,
 * api.system.disk-info, api.system.git-info, api.git-info and api.update all
 * introspect the host a local bolt install runs on (filesystem, process, repo),
 * which on a shared host leaks infrastructure and means nothing to a user;
 * api.export-api-keys returned provider keys to the client; api.health duplicates
 * this backend's /api/health and the gateway's /healthz. Bug reports use the
 * existing /api/feedback module rather than bolt's api.bug-report.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    StudioConnectionsController,
    StudioGithubController,
    StudioGithubPushController,
    StudioGitlabController,
    StudioGitlabPushController,
    StudioDeployController,
    StudioSupabaseController,
    StudioGitProxyController,
    StudioMcpController,
    StudioWebSearchController,
  ],
  providers: [StudioConnectionsService, StudioUpstreamService, StudioProxyTokenGuard],
  exports: [StudioConnectionsService],
})
export class StudioModule {}
