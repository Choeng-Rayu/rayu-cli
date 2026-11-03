/** Native VS Code surface for the shared Rayu GitHub Actions installer. */
import * as vscode from 'vscode'
import { spawn } from 'node:child_process'

import {
  setupGitHubActionsCore,
  type GitHubCommandResult,
} from '../../../commands/install-github-app/setupGitHubActionsCore.js'
import type { Workflow } from '../../../commands/install-github-app/types.js'
import { provisionGitHubActionsCredential } from '../../../commands/install-github-app/rayuGitHubCredential.js'
import {
  getRayuGitHubIntegrationConfig,
  normalizeGitHubRepo,
  RAYU_GITHUB_SECRET_NAME,
} from '../../../constants/github-app.js'

type WorkflowChoice = vscode.QuickPickItem & { workflow: Workflow }

export type RayuAccountAuth = {
  signedIn: boolean
  apiBaseUrl: string
  getAccessToken: () => Promise<string | null>
}

type CredentialChoice =
  | { kind: 'account' }
  | { kind: 'key'; apiKey: string | null }

const WORKFLOW_CHOICES: WorkflowChoice[] = [
  {
    workflow: 'rayu',
    label: '$(tools) Rayu assistant',
    description: 'Respond to trusted @rayu requests and implement changes',
    picked: true,
  },
  {
    workflow: 'rayu-review',
    label: '$(comment-discussion) Rayu pull-request review',
    description: 'Automatically review trusted same-repository pull requests',
    picked: true,
  },
]

/** Run the same installer as the CLI, using native VS Code controls instead of Ink. */
export async function runGitHubSetupFromEditor(
  workspaceDirectory: string | undefined,
  accountAuth: RayuAccountAuth,
): Promise<void> {
  if (!workspaceDirectory) {
    void vscode.window.showErrorMessage(
      'Open a repository folder before running /install-github-app.',
    )
    return
  }

  try {
      const configResult = getRayuGitHubIntegrationConfig()
      if (!configResult.ok) {
        const missing = configResult.missing.join(', ')
        const invalid = configResult.invalid
          .map(item => `${item.name} ${item.reason}`)
          .join('; ')
        const detail = [
          missing ? `Missing: ${missing}.` : '',
          invalid ? `Invalid: ${invalid}.` : '',
        ]
          .filter(Boolean)
          .join(' ')
        void vscode.window.showErrorMessage(
          `Rayu GitHub integration is not configured in this extension build. ${detail}`,
        )
        return
      }

      if (!(await ensureGitHubCliReady(workspaceDirectory))) return

      const remote = await runProcess(
        'git',
        ['config', '--get', 'remote.origin.url'],
        workspaceDirectory,
      )
      const detectedRepository =
        remote.code === 0 ? normalizeGitHubRepo(remote.stdout) ?? '' : ''
      const repositoryInput = await vscode.window.showInputBox({
        title: 'Rayu: choose a GitHub repository',
        prompt: 'Enter owner/repository or a github.com repository URL.',
        value: detectedRepository,
        ignoreFocusOut: true,
        validateInput: value =>
          normalizeGitHubRepo(value)
            ? undefined
            : 'Enter a valid GitHub owner/repository or repository URL.',
      })
      if (repositoryInput === undefined) return
      const repository = normalizeGitHubRepo(repositoryInput)
      if (!repository) return

      const access = await runProcess(
        'gh',
        ['api', `repos/${repository}`, '--jq', '.permissions.admin'],
        workspaceDirectory,
      )
      if (access.code !== 0 || access.stdout.trim() !== 'true') {
        void vscode.window.showErrorMessage(
          `Administrator access to ${repository} is required to manage Actions secrets and install workflows.`,
        )
        return
      }

      const opened = await vscode.env.openExternal(
        vscode.Uri.parse(configResult.config.appInstallUrl),
      )
      if (!opened) {
        void vscode.window.showErrorMessage(
          `Could not open ${configResult.config.appInstallUrl}. Open it manually and install the Rayu GitHub App.`,
        )
        return
      }
      const continueSetup = await vscode.window.showInformationMessage(
        `Install the Rayu GitHub App for ${repository}, then return here to continue.`,
        { modal: true },
        'Continue',
      )
      if (continueSetup !== 'Continue') return

      const workflowChoices = await vscode.window.showQuickPick(WORKFLOW_CHOICES, {
        title: 'Rayu: select GitHub workflows',
        placeHolder: 'Choose one or both workflows',
        canPickMany: true,
        ignoreFocusOut: true,
      })
      if (!workflowChoices) return
      if (workflowChoices.length === 0) {
        void vscode.window.showWarningMessage('Select at least one Rayu workflow.')
        return
      }

      const secretExists = await repositoryHasRayuSecret(
        repository,
        workspaceDirectory,
      )
      const credential = await chooseCredential(secretExists, accountAuth.signedIn)
      if (!credential) return

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Setting up Rayu GitHub Actions',
          cancellable: false,
        },
        async progress => {
          let apiKey: string | null
          if (credential.kind === 'account') {
            progress.report({ message: 'Authorizing with your Rayu account' })
            const accessToken = await accountAuth.getAccessToken()
            if (!accessToken) {
              throw new Error(
                'Your Rayu session expired. Run /login in Rayucode, then try again.',
              )
            }
            progress.report({
              message: 'Creating a repository credential from your Rayu account',
            })
            apiKey = await provisionGitHubActionsCredential({
              repoName: repository,
              apiBaseUrl: accountAuth.apiBaseUrl,
              accessToken,
            })
          } else {
            apiKey = credential.apiKey
          }
          return setupGitHubActionsCore({
            repoName: repository,
            apiKey,
            secretName: RAYU_GITHUB_SECRET_NAME,
            selectedWorkflows: workflowChoices.map(choice => choice.workflow),
            config: configResult.config,
            updateProgress: message => progress.report({ message }),
            runGitHubCommand: (args, input) =>
              runProcess('gh', args, workspaceDirectory, input),
          })
        },
      )

      await openExternal(result.pullRequestUrl)

      const action = await vscode.window.showInformationMessage(
        'Rayu GitHub setup is ready. Review and merge the setup pull request to activate it.',
        'Open Pull Request Again',
      )
      if (action === 'Open Pull Request Again') {
        await openExternal(result.pullRequestUrl)
      }
  } catch (cause) {
    void vscode.window.showErrorMessage(
      `Rayu GitHub setup failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}

async function ensureGitHubCliReady(cwd: string): Promise<boolean> {
  const version = await runProcess('gh', ['--version'], cwd)
  if (version.code !== 0) {
    const install = await vscode.window.showErrorMessage(
      'GitHub CLI (gh) is required for Rayu GitHub setup.',
      'Open Installation Guide',
    )
    if (install === 'Open Installation Guide') {
      await openExternal('https://cli.github.com/')
    }
    return false
  }

  const auth = await runProcess(
    'gh',
    ['auth', 'status', '--hostname', 'github.com'],
    cwd,
  )
  if (auth.code !== 0) {
    void vscode.window.showErrorMessage(
      'GitHub CLI is not authenticated. Run "gh auth login" in a terminal, then retry.',
    )
    return false
  }
  return true
}

async function repositoryHasRayuSecret(
  repository: string,
  cwd: string,
): Promise<boolean> {
  const secrets = await runProcess(
    'gh',
    ['secret', 'list', '--app', 'actions', '--repo', repository],
    cwd,
  )
  return (
    secrets.code === 0 &&
    secrets.stdout
      .split('\n')
      .some(line => new RegExp(`^${RAYU_GITHUB_SECRET_NAME}\\s`).test(line))
  )
}

async function chooseCredential(
  secretExists: boolean,
  accountSignedIn: boolean,
): Promise<CredentialChoice | undefined> {
  const localKey = process.env.RAYU_API_KEY?.trim() || ''

  type KeyChoice = vscode.QuickPickItem & {
    value: 'account' | 'keep' | 'local' | 'enter'
  }
  const choices: KeyChoice[] = []
  if (accountSignedIn) {
    choices.push({
      value: 'account',
      label: '$(account) Use signed-in Rayu account',
      description: 'Recommended — no API key input required',
    })
  }
  if (secretExists) {
    choices.push({
      value: 'keep',
      label: '$(lock) Keep existing repository secret',
      description: RAYU_GITHUB_SECRET_NAME,
    })
  }
  if (localKey) {
    choices.push({
      value: 'local',
      label: '$(key) Use current Rayu API key',
      description: 'Copy the key used by this RayuCode installation',
    })
  }
  choices.push({
    value: 'enter',
    label: '$(edit) Enter a different Rayu API key',
  })

  if (choices.length > 1) {
    const choice = await vscode.window.showQuickPick(choices, {
      title: 'Rayu: choose GitHub Actions authentication',
      ignoreFocusOut: true,
    })
    if (!choice) return undefined
    if (choice.value === 'account') return { kind: 'account' }
    if (choice.value === 'keep') return { kind: 'key', apiKey: null }
    if (choice.value === 'local') {
      return { kind: 'key', apiKey: localKey }
    }
  }

  const entered = await vscode.window.showInputBox({
    title: 'Rayu: enter the Actions API key',
    prompt: 'The key is stored directly as the repository Actions secret RAYU_API_KEY.',
    password: true,
    ignoreFocusOut: true,
    validateInput: value =>
      value.trim() ? undefined : 'Enter a Rayu API key.',
  })
  return entered === undefined
    ? undefined
    : { kind: 'key', apiKey: entered.trim() }
}

async function openExternal(url: string): Promise<void> {
  const opened = await vscode.env.openExternal(vscode.Uri.parse(url))
  if (!opened) throw new Error(`Could not open ${url}`)
}

/** Small host-only runner that avoids importing the terminal engine process graph. */
function runProcess(
  command: string,
  args: string[],
  cwd: string,
  input?: string,
): Promise<GitHubCommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: GitHubCommandResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString('utf8')}`.slice(-1_000_000)

    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk as Buffer)
    })
    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk as Buffer)
    })
    child.on('error', error => finish({ stdout, stderr: error.message, code: 1 }))
    child.on('close', code => finish({ stdout, stderr, code: code ?? 1 }))
    timer = setTimeout(() => {
      child.kill()
      finish({ stdout, stderr: `${stderr}\nCommand timed out.`.trim(), code: 1 })
    }, 10 * 60 * 1_000)

    child.stdin.end(input)
  })
}
