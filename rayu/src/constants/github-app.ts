export const PR_TITLE = 'Add Rayu GitHub workflows'
export const GITHUB_ACTION_SETUP_DOCS_URL = 'https://rayucode.com/docs'
export const RAYU_GITHUB_SECRET_NAME = 'RAYU_API_KEY'
export const RAYU_ASSISTANT_WORKFLOW_PATH = '.github/workflows/rayu.yml'
export const RAYU_REVIEW_WORKFLOW_PATH =
  '.github/workflows/rayu-code-review.yml'

const APP_URL_ENV = 'RAYU_GITHUB_APP_INSTALL_URL'
const ACTION_REF_ENV = 'RAYU_GITHUB_ACTION_REF'
const DOCS_URL_ENV = 'RAYU_GITHUB_ACTION_DOCS_URL'

export type RayuGitHubIntegrationConfig = {
  appInstallUrl: string
  actionRef: string
  docsUrl: string
}

export type RayuGitHubIntegrationConfigResult =
  | { ok: true; config: RayuGitHubIntegrationConfig }
  | {
      ok: false
      missing: string[]
      invalid: Array<{ name: string; reason: string }>
    }

/**
 * Resolve the public GitHub integration settings supplied by the Rayu release
 * publisher. There are deliberately no legacy third-party fallbacks: an
 * unconfigured Rayu build must stop before it installs a different product.
 */
export function getRayuGitHubIntegrationConfig(): RayuGitHubIntegrationConfigResult {
  const appInstallUrl = process.env.RAYU_GITHUB_APP_INSTALL_URL?.trim() ?? ''
  const actionRef = process.env.RAYU_GITHUB_ACTION_REF?.trim() ?? ''
  const docsUrl =
    process.env.RAYU_GITHUB_ACTION_DOCS_URL?.trim() ||
    GITHUB_ACTION_SETUP_DOCS_URL
  const missing = [
    ...(appInstallUrl ? [] : [APP_URL_ENV]),
    ...(actionRef ? [] : [ACTION_REF_ENV]),
  ]
  const invalid: Array<{ name: string; reason: string }> = []

  if (appInstallUrl && !isGitHubAppInstallUrl(appInstallUrl)) {
    invalid.push({
      name: APP_URL_ENV,
      reason: 'must be an HTTPS URL under github.com/apps/',
    })
  }
  if (actionRef && !isGitHubActionRef(actionRef)) {
    invalid.push({
      name: ACTION_REF_ENV,
      reason: 'must use owner/repository[/path]@ref format',
    })
  }
  if (!isHttpsUrl(docsUrl)) {
    invalid.push({
      name: DOCS_URL_ENV,
      reason: 'must be an HTTPS URL',
    })
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, missing, invalid }
  }
  return {
    ok: true,
    config: { appInstallUrl, actionRef, docsUrl },
  }
}

export function validateGitHubSecretName(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value)
}

/** Normalize a GitHub repository without allowing extra REST path segments. */
export function normalizeGitHubRepo(value: string): string | null {
  let candidate = value.trim()
  const httpsMatch = candidate.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?$/i,
  )
  const sshMatch = candidate.match(
    /^git@github\.com:([^/]+)\/([^/?#]+?)(?:\.git)?$/i,
  )
  if (httpsMatch) candidate = `${httpsMatch[1]}/${httpsMatch[2]}`
  else if (sshMatch) candidate = `${sshMatch[1]}/${sshMatch[2]}`

  const match = candidate.match(
    /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)$/,
  )
  if (!match || match[2] === '.' || match[2] === '..') return null
  return `${match[1]}/${match[2]}`
}

export function buildRayuAssistantWorkflow(
  actionRef: string,
  secretName: string,
): string {
  assertWorkflowInputs(actionRef, secretName)
  return `name: Rayu

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]
  issues:
    types: [opened, assigned]

jobs:
  rayu:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@rayu') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@rayu') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)) ||
      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@rayu') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.review.author_association)) ||
      (github.event_name == 'issues' && (contains(github.event.issue.body, '@rayu') || contains(github.event.issue.title, '@rayu')) && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.issue.author_association))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Run Rayu
        id: rayu
        uses: ${actionRef}
        with:
          rayu_api_key: \${{ secrets.${secretName} }}
          github_token: \${{ secrets.GITHUB_TOKEN }}
`
}

export function buildRayuReviewWorkflow(
  actionRef: string,
  secretName: string,
): string {
  assertWorkflowInputs(actionRef, secretName)
  return `name: Rayu Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

jobs:
  rayu-review:
    if: |
      github.event.pull_request.draft == false &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.pull_request.author_association)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Run Rayu review
        id: rayu-review
        uses: ${actionRef}
        with:
          rayu_api_key: \${{ secrets.${secretName} }}
          github_token: \${{ secrets.GITHUB_TOKEN }}
          mode: review
          pull_request_number: \${{ github.event.pull_request.number }}
`
}

export function buildGitHubSetupPullRequestBody(
  config: RayuGitHubIntegrationConfig,
): string {
  return `## Installing Rayu GitHub workflows

This pull request adds Rayu GitHub Actions integration to this repository.

After it is merged, trusted repository members can mention \`@rayu\` in an issue or pull-request comment. The optional review workflow runs automatically for trusted, same-repository pull requests.

Security controls included in these workflows:

- The Rayu API key is stored as the \`${RAYU_GITHUB_SECRET_NAME}\` Actions secret.
- Comment-triggered runs are restricted to owners, members, and collaborators.
- Automatic reviews do not receive secrets for forked pull requests.
- Runs and their output remain visible in the repository's Actions history.

Action: \`${config.actionRef}\`

Setup documentation: ${config.docsUrl}

Learn more about Rayu: https://github.com/Choeng-Rayu/rayu-cli`
}

function assertWorkflowInputs(actionRef: string, secretName: string): void {
  if (!isGitHubActionRef(actionRef)) {
    throw new Error('Invalid Rayu GitHub Action reference')
  }
  if (!validateGitHubSecretName(secretName)) {
    throw new Error('Invalid GitHub Actions secret name')
  }
}

function isGitHubActionRef(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(
    value,
  )
}

function isGitHubAppInstallUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      /^\/apps\/[A-Za-z0-9-]+\/?$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
