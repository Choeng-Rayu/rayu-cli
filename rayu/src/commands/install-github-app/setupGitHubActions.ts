import { saveGlobalConfig } from '../../utils/config.js'
import { openBrowser } from '../../utils/browser.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logError } from '../../utils/log.js'
import {
  buildGitHubSetupPullRequestBody,
  buildRayuAssistantWorkflow,
  buildRayuReviewWorkflow,
  normalizeGitHubRepo,
  PR_TITLE,
  RAYU_ASSISTANT_WORKFLOW_PATH,
  RAYU_REVIEW_WORKFLOW_PATH,
  type RayuGitHubIntegrationConfig,
  validateGitHubSecretName,
} from '../../constants/github-app.js'
import type { Workflow } from './types.js'

export type SetupGitHubActionsOptions = {
  repoName: string
  apiKey: string | null
  secretName: string
  selectedWorkflows: Workflow[]
  config: RayuGitHubIntegrationConfig
  updateProgress?: (message: string) => void
}

export type SetupGitHubActionsResult = {
  branchName: string
  pullRequestUrl: string
}

type WorkflowFile = {
  path: string
  content: string
  commitMessage: string
}

export async function setupGitHubActions({
  repoName,
  apiKey,
  secretName,
  selectedWorkflows,
  config,
  updateProgress = () => undefined,
}: SetupGitHubActionsOptions): Promise<SetupGitHubActionsResult> {
  const normalizedRepo = normalizeGitHubRepo(repoName)
  if (!normalizedRepo || normalizedRepo !== repoName) {
    throw new Error('Repository must use the owner/repository format')
  }
  if (!validateGitHubSecretName(secretName)) {
    throw new Error('Invalid GitHub Actions secret name')
  }
  if (selectedWorkflows.length === 0) {
    throw new Error('Select at least one Rayu workflow')
  }

  try {
    updateProgress('Checking repository access')
    await ghValue(['api', `repos/${repoName}`, '--jq', '.id'], 'access repository')
    const defaultBranch = await ghValue(
      ['api', `repos/${repoName}`, '--jq', '.default_branch'],
      'read the default branch',
    )
    const defaultSha = await ghValue(
      [
        'api',
        `repos/${repoName}/git/ref/heads/${defaultBranch}`,
        '--jq',
        '.object.sha',
      ],
      'read the default branch revision',
    )

    if (apiKey) {
      updateProgress(`Saving ${secretName} as an Actions secret`)
      const result = await execFileNoThrow(
        'gh',
        ['secret', 'set', secretName, '--repo', repoName],
        { stdin: 'pipe', input: apiKey },
      )
      if (result.code !== 0) {
        throw ghError('set the Rayu API key secret', result.stderr)
      }
    }

    const branchName = `add-rayu-github-actions-${Date.now()}`
    updateProgress(`Creating branch ${branchName}`)
    await gh(
      [
        'api',
        '--method',
        'POST',
        `repos/${repoName}/git/refs`,
        '-f',
        `ref=refs/heads/${branchName}`,
        '-f',
        `sha=${defaultSha}`,
      ],
      'create the setup branch',
    )

    for (const workflow of selectedWorkflowFiles(
      selectedWorkflows,
      config.actionRef,
      secretName,
    )) {
      updateProgress(`Writing ${workflow.path}`)
      await createOrUpdateWorkflowFile(
        repoName,
        branchName,
        workflow,
      )
    }

    const pullRequestUrl = buildCompareUrl(
      repoName,
      defaultBranch,
      branchName,
      config,
    )
    updateProgress('Opening the pull-request form')
    await openBrowser(pullRequestUrl)

    saveGlobalConfig(current => ({
      ...current,
      githubActionSetupCount: (current.githubActionSetupCount ?? 0) + 1,
    }))
    return { branchName, pullRequestUrl }
  } catch (error) {
    if (error instanceof Error) logError(error)
    throw error
  }
}

function selectedWorkflowFiles(
  selected: Workflow[],
  actionRef: string,
  secretName: string,
): WorkflowFile[] {
  const files: WorkflowFile[] = []
  if (selected.includes('rayu')) {
    files.push({
      path: RAYU_ASSISTANT_WORKFLOW_PATH,
      content: buildRayuAssistantWorkflow(actionRef, secretName),
      commitMessage: 'Add Rayu assistant workflow',
    })
  }
  if (selected.includes('rayu-review')) {
    files.push({
      path: RAYU_REVIEW_WORKFLOW_PATH,
      content: buildRayuReviewWorkflow(actionRef, secretName),
      commitMessage: 'Add Rayu review workflow',
    })
  }
  return files
}

async function createOrUpdateWorkflowFile(
  repoName: string,
  branchName: string,
  workflow: WorkflowFile,
): Promise<void> {
  const endpoint = `repos/${repoName}/contents/${workflow.path}`
  const existing = await execFileNoThrow('gh', [
    'api',
    `${endpoint}?ref=${encodeURIComponent(branchName)}`,
    '--jq',
    '.sha',
  ])
  const sha = existing.code === 0 ? existing.stdout.trim() : null
  const args = [
    'api',
    '--method',
    'PUT',
    endpoint,
    '-f',
    `message=${sha ? `Update ${workflow.commitMessage}` : workflow.commitMessage}`,
    '-f',
    `content=${Buffer.from(workflow.content).toString('base64')}`,
    '-f',
    `branch=${branchName}`,
  ]
  if (sha) args.push('-f', `sha=${sha}`)
  await gh(args, `write ${workflow.path}`)
}

function buildCompareUrl(
  repoName: string,
  defaultBranch: string,
  branchName: string,
  config: RayuGitHubIntegrationConfig,
): string {
  const url = new URL(
    `https://github.com/${repoName}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branchName)}`,
  )
  url.searchParams.set('quick_pull', '1')
  url.searchParams.set('title', PR_TITLE)
  url.searchParams.set('body', buildGitHubSetupPullRequestBody(config))
  return url.toString()
}

async function ghValue(args: string[], operation: string): Promise<string> {
  const result = await gh(args, operation)
  const value = result.stdout.trim()
  if (!value) throw new Error(`GitHub CLI returned no value while trying to ${operation}.`)
  return value
}

async function gh(
  args: string[],
  operation: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await execFileNoThrow('gh', args)
  if (result.code !== 0) throw ghError(operation, result.stderr)
  return result
}

function ghError(operation: string, stderr: string): Error {
  const detail = stderr.trim() || 'GitHub CLI returned an unknown error.'
  return new Error(
    `Could not ${operation}: ${detail}\nRun "gh auth refresh -h github.com -s repo,workflow" and verify repository admin access.`,
  )
}
