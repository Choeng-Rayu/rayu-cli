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

export type GitHubCommandResult = {
  stdout: string
  stderr: string
  code: number
}

export type GitHubCommandRunner = (
  args: string[],
  input?: string,
) => Promise<GitHubCommandResult>

export type SetupGitHubActionsCoreOptions = {
  repoName: string
  apiKey: string | null
  secretName: string
  selectedWorkflows: Workflow[]
  config: RayuGitHubIntegrationConfig
  runGitHubCommand: GitHubCommandRunner
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

/** Host-neutral GitHub setup used by both the terminal and VS Code surfaces. */
export async function setupGitHubActionsCore({
  repoName,
  apiKey,
  secretName,
  selectedWorkflows,
  config,
  runGitHubCommand,
  updateProgress = () => undefined,
}: SetupGitHubActionsCoreOptions): Promise<SetupGitHubActionsResult> {
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

  updateProgress('Checking repository access')
  await ghValue(runGitHubCommand, ['api', `repos/${repoName}`, '--jq', '.id'], 'access repository')
  const defaultBranch = await ghValue(
    runGitHubCommand,
    ['api', `repos/${repoName}`, '--jq', '.default_branch'],
    'read the default branch',
  )
  const defaultSha = await ghValue(
    runGitHubCommand,
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
    await gh(
      runGitHubCommand,
      ['secret', 'set', secretName, '--repo', repoName],
      'set the Rayu API key secret',
      apiKey,
    )
  }

  const branchName = `add-rayu-github-actions-${Date.now()}`
  updateProgress(`Creating branch ${branchName}`)
  await gh(
    runGitHubCommand,
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
      runGitHubCommand,
      repoName,
      branchName,
      workflow,
    )
  }

  return {
    branchName,
    pullRequestUrl: buildCompareUrl(repoName, defaultBranch, branchName, config),
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
  runGitHubCommand: GitHubCommandRunner,
  repoName: string,
  branchName: string,
  workflow: WorkflowFile,
): Promise<void> {
  const endpoint = `repos/${repoName}/contents/${workflow.path}`
  const existing = await runGitHubCommand([
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
  await gh(runGitHubCommand, args, `write ${workflow.path}`)
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

async function ghValue(
  runGitHubCommand: GitHubCommandRunner,
  args: string[],
  operation: string,
): Promise<string> {
  const result = await gh(runGitHubCommand, args, operation)
  const value = result.stdout.trim()
  if (!value) {
    throw new Error(`GitHub CLI returned no value while trying to ${operation}.`)
  }
  return value
}

async function gh(
  runGitHubCommand: GitHubCommandRunner,
  args: string[],
  operation: string,
  input?: string,
): Promise<GitHubCommandResult> {
  const result = await runGitHubCommand(args, input)
  if (result.code !== 0) throw ghError(operation, result.stderr)
  return result
}

function ghError(operation: string, stderr: string): Error {
  const detail = stderr.trim() || 'GitHub CLI returned an unknown error.'
  return new Error(
    `Could not ${operation}: ${detail}\nRun "gh auth refresh -h github.com -s repo,workflow" and verify repository admin access.`,
  )
}
