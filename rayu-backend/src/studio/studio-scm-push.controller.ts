import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common'
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import type { User } from '@prisma/client'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { StudioConnectionsService } from './studio-connections.service'

/**
 * Push a Studio project to a GitHub repository.
 *
 * WHY THIS IS SERVER-SIDE
 *
 * bolt.diy did the whole flow in the browser with `@octokit/rest` and the user's
 * personal access token: create-or-update the repo, upload each file as a blob,
 * build a tree, create a commit, move the ref. That requires the PAT to be in the
 * page, which is exactly what Rayu Studio avoids — GitHub credentials live
 * encrypted in `studio_connections` and never leave this backend.
 *
 * So the browser sends the file map and this controller performs the git plumbing
 * with the user's own decrypted token. @octokit/rest is a backend dependency only.
 */

const MAX_FILES = 3_000
const MAX_TOTAL_BYTES = 40 * 1024 * 1024

export class GithubPushDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  repo!: string

  /** Map of relative path -> file contents. */
  @IsObject()
  files!: Record<string, string>

  @IsOptional()
  @IsString()
  @MaxLength(500)
  commitMessage?: string

  @IsOptional()
  @IsString()
  @MaxLength(200)
  branch?: string

  /** Applied only when the repository is created by this call. */
  @IsOptional()
  @IsBoolean()
  private?: boolean

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string
}

export interface GithubPushResult {
  owner: string
  repo: string
  branch: string
  commitSha: string
  htmlUrl: string
  created: boolean
}

function validateFiles(files: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(files ?? {})

  if (entries.length === 0) {
    throw new BadRequestException('no files to push')
  }

  if (entries.length > MAX_FILES) {
    throw new BadRequestException(`too many files (${entries.length} > ${MAX_FILES})`)
  }

  let total = 0

  for (const [path, content] of entries) {
    if (typeof content !== 'string') {
      throw new BadRequestException(`file ${path} has non-string contents`)
    }

    // A path escaping the repo root, or an absolute one, is never legitimate here.
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new BadRequestException(`file path ${path} is not a relative path inside the repo`)
    }

    total += content.length

    if (total > MAX_TOTAL_BYTES) {
      throw new BadRequestException(`push exceeds ${MAX_TOTAL_BYTES} bytes`)
    }
  }

  return entries
}

@Controller('studio/scm/github')
@UseGuards(RayuAuthGuard)
export class StudioGithubPushController {
  private readonly logger = new Logger(StudioGithubPushController.name)

  constructor(private readonly connections: StudioConnectionsService) {}

  @Post('push')
  async push(
    @CurrentUser() user: User,
    @Body() body: GithubPushDto,
  ): Promise<GithubPushResult> {
    const entries = validateFiles(body.files)
    const token = await this.connections.requireToken(user.id, 'github')

    // Imported lazily so the (large) Octokit tree is not loaded on every boot.
    const { Octokit } = await import('@octokit/rest')
    const octokit = new Octokit({ auth: token })

    const { data: me } = await octokit.users.getAuthenticated()
    const owner = me.login
    const repo = body.repo
    const message = body.commitMessage?.trim() || 'Update from Rayu Studio'

    let created = false
    let defaultBranch: string

    try {
      const { data: existing } = await octokit.repos.get({ owner, repo })
      defaultBranch = existing.default_branch
    } catch (e) {
      if ((e as { status?: number }).status !== 404) {
        throw e
      }

      const { data: fresh } = await octokit.repos.createForAuthenticatedUser({
        name: repo,
        // Defaults to private: a project pushed from an IDE is more likely to be
        // unfinished than intended for publication.
        private: body.private ?? true,
        description: body.description,
        auto_init: true,
      })
      created = true
      defaultBranch = fresh.default_branch ?? 'main'
    }

    const branch = body.branch?.trim() || defaultBranch

    // Blobs first, then a tree, then a commit, then move the ref — the standard
    // git-over-API sequence, and the only way to land a multi-file commit atomically.
    const tree = await Promise.all(
      entries.map(async ([path, content]) => {
        const { data: blob } = await octokit.git.createBlob({
          owner,
          repo,
          content: Buffer.from(content, 'utf8').toString('base64'),
          encoding: 'base64',
        })

        return { path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha }
      }),
    )

    // A branch that does not exist yet has no ref; base the tree on the default
    // branch in that case so the new branch shares history.
    let parentSha: string | undefined
    let baseTreeSha: string | undefined

    for (const ref of [branch, defaultBranch]) {
      try {
        const { data } = await octokit.git.getRef({ owner, repo, ref: `heads/${ref}` })
        parentSha = data.object.sha

        const { data: commit } = await octokit.git.getCommit({
          owner,
          repo,
          commit_sha: parentSha,
        })
        baseTreeSha = commit.tree.sha
        break
      } catch (e) {
        if ((e as { status?: number }).status !== 404) {
          throw e
        }
      }
    }

    const { data: newTree } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree,
    })

    const { data: commit } = await octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: newTree.sha,
      parents: parentSha ? [parentSha] : [],
    })

    try {
      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.sha,
      })
    } catch (e) {
      if ((e as { status?: number }).status !== 404 && (e as { status?: number }).status !== 422) {
        throw e
      }

      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      })
    }

    this.logger.log(
      `studio github push user=${user.id} repo=${owner}/${repo} branch=${branch} files=${entries.length} created=${created}`,
    )

    await this.connections.mergeMeta(user.id, 'github', { login: owner })

    return {
      owner,
      repo,
      branch,
      commitSha: commit.sha,
      htmlUrl: `https://github.com/${owner}/${repo}/tree/${branch}`,
      created,
    }
  }
}

export class GitlabPushDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  repo!: string

  @IsObject()
  files!: Record<string, string>

  @IsOptional()
  @IsString()
  @MaxLength(500)
  commitMessage?: string

  @IsOptional()
  @IsString()
  @MaxLength(200)
  branch?: string

  @IsOptional()
  @IsBoolean()
  private?: boolean
}

export interface GitlabPushResult {
  projectId: number
  path: string
  branch: string
  webUrl: string
  created: boolean
}

/**
 * GitLab equivalent of the GitHub push above.
 *
 * bolt did this in the browser through GitLabApiService with the user's personal
 * access token. Same reasoning applies: the token stays encrypted in the backend,
 * so the commit is assembled here. GitLab's commits API takes every file in one
 * request, so this is simpler than GitHub's blob/tree/commit sequence.
 */
@Controller('studio/scm/gitlab')
@UseGuards(RayuAuthGuard)
export class StudioGitlabPushController {
  private readonly logger = new Logger(StudioGitlabPushController.name)

  constructor(private readonly connections: StudioConnectionsService) {}

  @Post('push')
  async push(
    @CurrentUser() user: User,
    @Body() body: GitlabPushDto,
  ): Promise<GitlabPushResult> {
    const entries = validateFiles(body.files)
    const token = await this.connections.requireToken(user.id, 'gitlab')

    const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const res = await fetch(`https://gitlab.com/api/v4${path}`, {
        ...init,
        headers: {
          'PRIVATE-TOKEN': token,
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(30_000),
      })

      if (!res.ok) {
        throw new BadRequestException(
          `GitLab API ${res.status}: ${(await res.text()).slice(0, 300)}`,
        )
      }

      return (await res.json()) as T
    }

    const me = await api<{ username: string }>('/user')

    interface Project {
      id: number
      path_with_namespace: string
      web_url: string
      default_branch: string | null
    }

    let project: Project | null = null
    let created = false

    const search = await api<Project[]>(
      `/projects?owned=true&search=${encodeURIComponent(body.repo)}&per_page=100`,
    )
    project =
      search.find((p) => p.path_with_namespace === `${me.username}/${body.repo}`) ?? null

    if (!project) {
      project = await api<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: body.repo,
          path: body.repo,
          // Default to private, matching the GitHub path.
          visibility: body.private === false ? 'public' : 'private',
          initialize_with_readme: true,
        }),
      })
      created = true
    }

    const branch = body.branch?.trim() || project.default_branch || 'main'

    /*
     * GitLab rejects a 'create' action for a path that already exists and an
     * 'update' for one that does not, so each file's action is resolved against
     * the branch first. A fresh project initialised with a README means most
     * pushes are a mix of both.
     */
    const actions = await Promise.all(
      entries.map(async ([path, content]) => {
        const url =
          `/projects/${project!.id}/repository/files/` +
          `${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`
        const exists = await fetch(`https://gitlab.com/api/v4${url}`, {
          headers: { 'PRIVATE-TOKEN': token },
          signal: AbortSignal.timeout(30_000),
        })
          .then((r) => r.ok)
          .catch(() => false)

        return { action: exists ? 'update' : 'create', file_path: path, content }
      }),
    )

    await api(`/projects/${project.id}/repository/commits`, {
      method: 'POST',
      body: JSON.stringify({
        branch,
        // GitLab needs a start_branch to create a branch that does not exist yet.
        start_branch: branch === project.default_branch ? undefined : project.default_branch,
        commit_message: body.commitMessage?.trim() || 'Update from Rayu Studio',
        actions,
      }),
    })

    this.logger.log(
      `studio gitlab push user=${user.id} project=${project.path_with_namespace} branch=${branch} files=${entries.length} created=${created}`,
    )

    await this.connections.mergeMeta(user.id, 'gitlab', { username: me.username })

    return {
      projectId: project.id,
      path: project.path_with_namespace,
      branch,
      webUrl: project.web_url,
      created,
    }
  }
}
