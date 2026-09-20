import React, { useEffect, useRef, useState } from 'react'
import { WorkflowMultiselectDialog } from '../../components/WorkflowMultiselectDialog.js'
import { Select } from '../../components/CustomSelect/index.js'
import {
  GITHUB_ACTION_SETUP_DOCS_URL,
  getRayuGitHubIntegrationConfig,
  normalizeGitHubRepo,
  RAYU_GITHUB_SECRET_NAME,
} from '../../constants/github-app.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Link, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getRayuApiKeyProvider } from '../../services/rayuAuth/rayuApiKeyAuth.js'
import {
  getRayuApiBaseUrl,
  getValidRayuAccessToken,
  hasRayuSession,
} from '../../services/rayuAuth/rayuSession.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { openBrowser } from '../../utils/browser.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getGithubRepo } from '../../utils/git.js'
import TextInput from '../../components/TextInput.js'
import { setupGitHubActions } from './setupGitHubActions.js'
import { provisionGitHubActionsCredential } from './rayuGitHubCredential.js'
import type { State, Workflow } from './types.js'

type Props = {
  onDone: LocalJSXCommandOnDone
}

function InstallGitHubApp({ onDone }: Props): React.ReactNode {
  const [configResult] = useState(getRayuGitHubIntegrationConfig)
  const integration = configResult.ok ? configResult.config : null
  const existingApiKey =
    process.env.RAYU_API_KEY?.trim() ||
    getRayuApiKeyProvider()?.apiKey?.trim() ||
    ''
  const [state, setState] = useState<State>(() => ({
    step: configResult.ok ? 'checking-github' : 'configuration',
    selectedRepoName: '',
    selectedWorkflows: ['rayu', 'rayu-review'],
    apiKey: '',
    secretExists: false,
    progress: 'Checking GitHub CLI installation',
  }))
  const [cursorOffset, setCursorOffset] = useState(0)
  const [inputError, setInputError] = useState<string | null>(null)
  const [browserError, setBrowserError] = useState<string | null>(null)
  const [validatingRepo, setValidatingRepo] = useState(false)
  const finished = useRef(false)
  const terminalSize = useTerminalSize()

  const finish = (message: string): void => {
    if (finished.current) return
    finished.current = true
    onDone(message, { display: 'system' })
  }

  useExitOnCtrlCDWithKeybindings(() => finish('Rayu GitHub setup cancelled.'))
  useKeybinding(
    'confirm:no',
    () => finish('Rayu GitHub setup cancelled.'),
    { context: 'Confirmation' },
  )
  useKeybinding(
    'confirm:yes',
    () => {
      if (state.step === 'configuration') {
        finish('Rayu GitHub integration is not configured in this build.')
      } else if (state.step === 'install-app') {
        setState(previous => ({ ...previous, step: 'select-workflows' }))
      } else if (state.step === 'success') {
        finish('Rayu GitHub Actions setup complete.')
      } else if (state.step === 'error') {
        finish(`Rayu GitHub setup failed: ${state.error ?? 'Unknown error'}`)
      }
    },
    {
      context: 'Confirmation',
      isActive: [
        'configuration',
        'install-app',
        'success',
        'error',
      ].includes(state.step),
    },
  )

  useEffect(() => {
    if (state.step !== 'checking-github') return
    let cancelled = false
    void (async () => {
      const version = await execFileNoThrow('gh', ['--version'], {
        useCwd: false,
      })
      if (cancelled) return
      if (version.code !== 0) {
        setState(previous => ({
          ...previous,
          step: 'error',
          error:
            'GitHub CLI (gh) is required. Install it from https://cli.github.com/ and run this command again.',
        }))
        return
      }
      setState(previous => ({
        ...previous,
        progress: 'Checking GitHub CLI authentication',
      }))
      const auth = await execFileNoThrow('gh', ['auth', 'status', '--hostname', 'github.com'])
      if (cancelled) return
      if (auth.code !== 0) {
        setState(previous => ({
          ...previous,
          step: 'error',
          error:
            'GitHub CLI is not authenticated. Run "gh auth login" and then retry.',
        }))
        return
      }
      const currentRepo = (await getGithubRepo()) ?? ''
      if (cancelled) return
      setCursorOffset(currentRepo.length)
      setState(previous => ({
        ...previous,
        step: 'choose-repo',
        selectedRepoName: currentRepo,
      }))
    })()
    return () => {
      cancelled = true
    }
  }, [state.step])

  useEffect(() => {
    if (state.step !== 'install-app' || !integration) return
    let cancelled = false
    void openBrowser(integration.appInstallUrl).catch(() => {
      if (!cancelled) {
        setBrowserError(
          'The browser could not be opened automatically. Open the URL shown below.',
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [integration, state.step])

  async function submitRepository(): Promise<void> {
    const repoName = normalizeGitHubRepo(state.selectedRepoName)
    if (!repoName) {
      setInputError(
        'Enter a GitHub repository as owner/repository or a github.com URL.',
      )
      return
    }
    setValidatingRepo(true)
    setInputError(null)
    const result = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}`,
      '--jq',
      '.permissions.admin',
    ])
    setValidatingRepo(false)
    if (result.code !== 0) {
      setInputError(
        `Could not access ${repoName}. Check the repository name and your GitHub CLI permissions.`,
      )
      return
    }
    if (result.stdout.trim() !== 'true') {
      setInputError(
        `Administrator access to ${repoName} is required to install the app and manage Actions secrets.`,
      )
      return
    }
    setState(previous => ({
      ...previous,
      selectedRepoName: repoName,
      step: 'install-app',
    }))
  }

  async function selectWorkflows(workflows: Workflow[]): Promise<void> {
    const secrets = await execFileNoThrow('gh', [
      'secret',
      'list',
      '--app',
      'actions',
      '--repo',
      state.selectedRepoName,
    ])
    const secretExists =
      secrets.code === 0 &&
      secrets.stdout
        .split('\n')
        .some(line => new RegExp(`^${RAYU_GITHUB_SECRET_NAME}\\s`).test(line))
    setCursorOffset(0)
    setState(previous => ({
      ...previous,
      selectedWorkflows: workflows,
      secretExists,
      step: 'credential',
    }))
  }

  async function runSetup(
    credential: 'account' | 'automatic' | 'keep' | string,
  ): Promise<void> {
    if (!integration) return
    const apiKey =
      credential === 'keep'
        ? null
        : credential === 'automatic'
          ? existingApiKey
          : credential === 'account'
            ? null
            : credential.trim()
    if (!apiKey && credential !== 'account' && credential !== 'keep') {
      setInputError(
        'Enter a Rayu API key. Create one at rayucode.com/dashboard/api-keys.',
      )
      return
    }
    setInputError(null)
    setState(previous => ({
      ...previous,
      step: 'creating',
      progress: 'Starting Rayu GitHub setup',
    }))
    try {
      let resolvedApiKey = apiKey
      if (credential === 'account') {
        setState(previous => ({
          ...previous,
          progress: 'Authorizing with your Rayu account',
        }))
        const accessToken = await getValidRayuAccessToken()
        if (!accessToken) {
          throw new Error('Your Rayu session expired. Run /login, then try again.')
        }
        setState(previous => ({
          ...previous,
          progress: 'Creating a repository credential from your Rayu account',
        }))
        resolvedApiKey = await provisionGitHubActionsCredential({
          repoName: state.selectedRepoName,
          apiBaseUrl: getRayuApiBaseUrl(),
          accessToken,
        })
      }
      const result = await setupGitHubActions({
        repoName: state.selectedRepoName,
        apiKey: resolvedApiKey,
        secretName: RAYU_GITHUB_SECRET_NAME,
        selectedWorkflows: state.selectedWorkflows,
        config: integration,
        updateProgress: progress =>
          setState(previous => ({ ...previous, progress })),
      })
      setState(previous => ({
        ...previous,
        step: 'success',
        pullRequestUrl: result.pullRequestUrl,
      }))
    } catch (error) {
      setState(previous => ({
        ...previous,
        step: 'error',
        error:
          error instanceof Error
            ? error.message
            : 'GitHub Actions setup failed.',
      }))
    }
  }

  function selectCredential(value: string): void {
    if (value === 'manual') {
      setCursorOffset(0)
      setState(previous => ({ ...previous, step: 'api-key', apiKey: '' }))
      return
    }
    void runSetup(value)
  }

  switch (state.step) {
    case 'configuration':
      return (
        <Panel title="Rayu GitHub integration is not configured">
          <Text>
            This command will not fall back to the original third-party app or
            action.
          </Text>
          {!configResult.ok && configResult.missing.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Required release settings:</Text>
              {configResult.missing.map(name => (
                <Text key={name}>• {name}</Text>
              ))}
            </Box>
          ) : null}
          {!configResult.ok && configResult.invalid.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Invalid settings:</Text>
              {configResult.invalid.map(item => (
                <Text key={item.name}>
                  • {item.name} {item.reason}
                </Text>
              ))}
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text dimColor>Press Enter to close.</Text>
          </Box>
        </Panel>
      )
    case 'checking-github':
      return (
        <Panel title="Set up Rayu on GitHub">
          <Text>{state.progress}…</Text>
        </Panel>
      )
    case 'choose-repo':
      return (
        <Panel title="Choose a GitHub repository">
          <Text dimColor>
            Enter owner/repository or a github.com repository URL.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={state.selectedRepoName}
              onChange={value => {
                setState(previous => ({
                  ...previous,
                  selectedRepoName: value,
                }))
                setInputError(null)
              }}
              onSubmit={() => void submitRepository()}
              focus
              placeholder="owner/repository"
              columns={terminalSize.columns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              showCursor
            />
          </Box>
          {validatingRepo ? <Text>Checking repository access…</Text> : null}
          {inputError ? <Text color="error">{inputError}</Text> : null}
          <Text dimColor>Enter to continue · Esc to cancel</Text>
        </Panel>
      )
    case 'install-app':
      return (
        <Panel title="Install the Rayu GitHub App">
          <Text>
            Your browser is opening the Rayu GitHub App installation page for{' '}
            {state.selectedRepoName}.
          </Text>
          {browserError ? <Text color="warning">{browserError}</Text> : null}
          {integration ? (
            <Link url={integration.appInstallUrl}>
              {integration.appInstallUrl}
            </Link>
          ) : null}
          <Box marginTop={1}>
            <Text dimColor>
              After granting repository access, return here and press Enter.
            </Text>
          </Box>
        </Panel>
      )
    case 'select-workflows':
      return (
        <WorkflowMultiselectDialog
          defaultSelections={state.selectedWorkflows}
          onSubmit={workflows => void selectWorkflows(workflows)}
        />
      )
    case 'credential': {
      const options: Array<{ label: string; value: string }> = []
      if (hasRayuSession()) {
        options.push({
          label: 'Use signed-in Rayu account (Recommended)',
          value: 'account',
        })
      }
      if (state.secretExists) {
        options.push({
          label: `Keep existing ${RAYU_GITHUB_SECRET_NAME}`,
          value: 'keep',
        })
      }
      if (existingApiKey) {
        options.push({
          label: 'Use current Rayu API key',
          value: 'automatic',
        })
      }
      options.push({ label: 'Enter a Rayu API key manually', value: 'manual' })
      return (
        <Panel title="Choose Rayu authentication">
          <Text>
            Rayu account authentication creates a dedicated credential for this
            repository. Your login token is never stored in GitHub.
          </Text>
          <Select
            options={options}
            onChange={value => selectCredential(String(value))}
          />
          <Text dimColor>Enter to continue · Esc to cancel</Text>
        </Panel>
      )
    }
    case 'api-key':
      return (
        <Panel title="Configure the Rayu API key">
          {state.secretExists ? (
            <Text>
              {RAYU_GITHUB_SECRET_NAME} already exists in this repository. Leave
              the field empty to keep it, or paste a replacement.
            </Text>
          ) : existingApiKey ? (
            <Text>
              A local Rayu API key is available. Leave the field empty to copy
              it to this repository, or paste a different Rayu key.
            </Text>
          ) : (
            <Text>
              Create a key at rayucode.com/dashboard/api-keys, then paste it
              below.
            </Text>
          )}
          <Box marginTop={1}>
            <TextInput
              value={state.apiKey}
              onChange={value => {
                setState(previous => ({ ...previous, apiKey: value }))
                setInputError(null)
              }}
              onSubmit={() => void runSetup(state.apiKey)}
              focus
              mask="*"
              placeholder={
                state.secretExists || existingApiKey
                  ? 'Leave empty to use the existing key'
                  : 'rayu_sk_live_...'
              }
              columns={terminalSize.columns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              showCursor
            />
          </Box>
          {inputError ? <Text color="error">{inputError}</Text> : null}
          <Text dimColor>Enter to create the setup pull request · Esc to cancel</Text>
        </Panel>
      )
    case 'creating':
      return (
        <Panel title="Creating Rayu GitHub workflows">
          <Text>{state.progress}…</Text>
        </Panel>
      )
    case 'success':
      return (
        <Panel title="Rayu GitHub setup is ready">
          <Text>
            The workflow branch and Actions secret are ready. Review and merge
            the pull request to activate @rayu.
          </Text>
          {state.pullRequestUrl ? (
            <Link url={state.pullRequestUrl}>{state.pullRequestUrl}</Link>
          ) : null}
          <Text dimColor>Press Enter to close.</Text>
        </Panel>
      )
    case 'error':
      return (
        <Panel title="Rayu GitHub setup failed">
          <Text color="error">{state.error}</Text>
          <Box marginTop={1}>
            <Text dimColor>
              Setup documentation:{' '}
              <Link url={integration?.docsUrl ?? GITHUB_ACTION_SETUP_DOCS_URL}>
                {integration?.docsUrl ?? GITHUB_ACTION_SETUP_DOCS_URL}
              </Link>
            </Text>
          </Box>
          <Text dimColor>Press Enter to close.</Text>
        </Panel>
      )
  }
}

function Panel({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
      <Text bold>{title}</Text>
      {children}
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  return <InstallGitHubApp onDone={onDone} />
}
