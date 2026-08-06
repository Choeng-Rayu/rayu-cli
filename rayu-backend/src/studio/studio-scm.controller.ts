import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { IsOptional, IsString, MaxLength } from 'class-validator'
import type { User } from '@prisma/client'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { StudioConnectionsService } from './studio-connections.service'
import { StudioUpstreamService } from './studio-upstream.service'

/**
 * GitHub / GitLab reads for Studio's repo import and connection UI.
 *
 * Ported from bolt.diy's api.github-*.ts and api.gitlab-*.ts. The one behavioural
 * change is where the credential comes from: upstream bolt accepted a `token`
 * field in the request body (the browser held the PAT and handed it back to its
 * own server). Here the token is resolved from studio_connections for the
 * authenticated user, so a caller cannot supply one — which also means a request
 * can only ever act as its own owner.
 */

/** Upper bound on a starter template's file count. */
const MAX_TEMPLATE_FILES = 500

export class TemplateQueryDto {
  /** "owner/name" of the template repository. */
  @IsString()
  @MaxLength(200)
  repo!: string
}

export class RepoQueryDto {
  @IsString()
  @MaxLength(100)
  owner!: string

  @IsString()
  @MaxLength(100)
  repo!: string
}

export class GitLabProjectsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string

  @IsOptional()
  @IsString()
  @MaxLength(8)
  perPage?: string
}

export class GitLabBranchesDto {
  /** Numeric id or URL-encoded path of the project. */
  @IsString()
  @MaxLength(300)
  projectId!: string
}

interface GitHubUser {
  login: string
  name: string | null
  avatar_url: string
  html_url: string
  type: string
}

interface GitHubRepo {
  name: string
  full_name: string
  default_branch: string
  private: boolean
  html_url: string
  description: string | null
  stargazers_count: number
  updated_at: string
}

interface GitHubBranch {
  name: string
  commit: { sha: string }
  protected: boolean
}

@Controller('studio/scm/github')
@UseGuards(RayuAuthGuard)
export class StudioGithubController {
  constructor(
    private readonly upstream: StudioUpstreamService,
    private readonly connections: StudioConnectionsService,
  ) {}

  /** Mirrors bolt's /api/github-user response shape. */
  @Get('user')
  async user(@CurrentUser() user: User): Promise<GitHubUser> {
    const u = await this.upstream.call<GitHubUser>(user.id, 'github', '/user')
    // Cache the non-secret identity so the settings UI can render the connection
    // without a round trip to GitHub on every page load.
    await this.connections.mergeMeta(user.id, 'github', {
      login: u.login,
      name: u.name,
      avatarUrl: u.avatar_url,
    })
    return {
      login: u.login,
      name: u.name,
      avatar_url: u.avatar_url,
      html_url: u.html_url,
      type: u.type,
    }
  }

  @Get('repos')
  repos(@CurrentUser() user: User): Promise<GitHubRepo[]> {
    return this.upstream.call<GitHubRepo[]>(user.id, 'github', '/user/repos', {
      query: { per_page: '100', sort: 'updated', affiliation: 'owner,collaborator,organization_member' },
    })
  }

  /** Mirrors bolt's /api/github-branches (repo metadata + branch list). */
  @Get('branches')
  async branches(
    @CurrentUser() user: User,
    @Query() q: RepoQueryDto,
  ): Promise<{ repo: GitHubRepo; branches: GitHubBranch[] }> {
    const repoPath = `/repos/${encodeURIComponent(q.owner)}/${encodeURIComponent(q.repo)}`
    const [repo, branches] = await Promise.all([
      this.upstream.call<GitHubRepo>(user.id, 'github', repoPath),
      this.upstream.call<GitHubBranch[]>(user.id, 'github', `${repoPath}/branches`, {
        query: { per_page: '100' },
      }),
    ])
    return { repo, branches }
  }

  /**
   * Mirrors bolt's /api/github-template. Returns a starter template repository's
   * text files so the studio can seed a project from it.
   *
   * Runs server-side for the same reason bolt proxied it: GitHub's unauthenticated
   * rate limit is 60 requests/hour per IP, and a template can be 100+ files. With
   * the user's stored token the limit is 5,000/hour, and the token never reaches
   * the browser.
   */
  @Get('template')
  async template(
    @CurrentUser() user: User,
    @Query() q: TemplateQueryDto,
  ): Promise<Array<{ name: string; path: string; content: string }>> {
    // Only owner/name is accepted, so a caller cannot address an arbitrary path.
    if (!/^[\w.-]+\/[\w.-]+$/.test(q.repo)) {
      throw new BadRequestException('repo must be in "owner/name" form');
    }

    const repoInfo = await this.upstream.call<{ default_branch: string }>(
      user.id,
      'github',
      `/repos/${q.repo}`,
    );

    const tree = await this.upstream.call<{
      tree: Array<{ path: string; type: string; size?: number }>;
    }>(user.id, 'github', `/repos/${q.repo}/git/trees/${repoInfo.default_branch}`, {
      query: { recursive: '1' },
    });

    const wanted = tree.tree.filter((item) => {
      if (item.type !== 'blob' || item.path.startsWith('.git/')) {
        return false;
      }

      // Lock files are allowed through regardless of size; everything else is
      // capped so one enormous file cannot blow the response up.
      const isLockFile = /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(item.path);

      return isLockFile || (item.size ?? 0) < 100_000;
    });

    if (wanted.length > MAX_TEMPLATE_FILES) {
      throw new BadRequestException(
        `template has ${wanted.length} files, more than the ${MAX_TEMPLATE_FILES} supported`,
      );
    }

    // Batched to stay well inside GitHub's secondary (concurrency) rate limits;
    // firing 100+ parallel requests earns a 403.
    const out: Array<{ name: string; path: string; content: string }> = [];
    const BATCH = 10;

    for (let i = 0; i < wanted.length; i += BATCH) {
      const batch = wanted.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            const data = await this.upstream.call<{ content: string; encoding: string }>(
              user.id,
              'github',
              `/repos/${q.repo}/contents/${file.path}`,
            );

            return {
              name: file.path.split('/').pop() ?? file.path,
              path: file.path,
              content: Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8'),
            };
          } catch {
            // A single unreadable file should not fail the whole template.
            return null;
          }
        }),
      );
      out.push(...results.filter((r): r is NonNullable<typeof r> => r !== null));
    }

    return out;
  }

  /**
   * Mirrors bolt's /api/github-stats. Upstream also walked every repo to count
   * branches, which is O(repos) upstream calls per page load; that fan-out is
   * dropped here because the number it produced was not displayed.
   */
  @Get('stats')
  async stats(@CurrentUser() user: User): Promise<{
    user: GitHubUser
    repos: GitHubRepo[]
    totalStars: number
    totalRepos: number
  }> {
    const [u, repos] = await Promise.all([
      this.upstream.call<GitHubUser>(user.id, 'github', '/user'),
      this.upstream.call<GitHubRepo[]>(user.id, 'github', '/user/repos', {
        query: { per_page: '100', sort: 'updated' },
      }),
    ])
    return {
      user: u,
      repos,
      totalStars: repos.reduce((n, r) => n + (r.stargazers_count ?? 0), 0),
      totalRepos: repos.length,
    }
  }
}

@Controller('studio/scm/gitlab')
@UseGuards(RayuAuthGuard)
export class StudioGitlabController {
  constructor(
    private readonly upstream: StudioUpstreamService,
    private readonly connections: StudioConnectionsService,
  ) {}

  @Get('user')
  async user(@CurrentUser() user: User): Promise<Record<string, unknown>> {
    const u = await this.upstream.call<Record<string, unknown>>(
      user.id,
      'gitlab',
      '/api/v4/user',
    )
    await this.connections.mergeMeta(user.id, 'gitlab', {
      username: u.username,
      name: u.name,
      avatarUrl: u.avatar_url,
    })
    return u
  }

  @Get('projects')
  projects(
    @CurrentUser() user: User,
    @Query() q: GitLabProjectsQueryDto,
  ): Promise<unknown[]> {
    return this.upstream.call<unknown[]>(user.id, 'gitlab', '/api/v4/projects', {
      query: {
        membership: 'true',
        order_by: 'last_activity_at',
        per_page: q.perPage ?? '100',
        search: q.search,
      },
    })
  }

  @Post('branches')
  branches(
    @CurrentUser() user: User,
    @Body() body: GitLabBranchesDto,
  ): Promise<unknown[]> {
    // GitLab accepts either a numeric id or a URL-encoded full path; encoding it
    // here means a path containing "/" cannot escape the intended endpoint.
    const id = encodeURIComponent(body.projectId)
    return this.upstream.call<unknown[]>(
      user.id,
      'gitlab',
      `/api/v4/projects/${id}/repository/branches`,
      { query: { per_page: '100' } },
    )
  }
}
