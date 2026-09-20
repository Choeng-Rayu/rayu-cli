import { describe, expect, test } from 'bun:test'

import { setupGitHubActionsCore } from '../src/commands/install-github-app/setupGitHubActionsCore.ts'

describe('shared GitHub Actions setup core', () => {
  test('creates the secret, branch, and both workflow files through an injected runner', async () => {
    const calls: Array<{ args: string[]; input?: string }> = []
    const result = await setupGitHubActionsCore({
      repoName: 'Choeng-Rayu/example',
      apiKey: 'rayu-secret',
      secretName: 'RAYU_API_KEY',
      selectedWorkflows: ['rayu', 'rayu-review'],
      config: {
        appInstallUrl: 'https://github.com/apps/rayucode-agentic',
        actionRef: 'Choeng-Rayu/rayu-cli/rayu-action@main',
        docsUrl: 'https://rayucode.com/docs',
      },
      runGitHubCommand: async (args, input) => {
        calls.push({ args, input })
        const endpoint = args.find(value => value.startsWith('repos/')) ?? ''
        if (args.includes('.default_branch')) {
          return { stdout: 'main\n', stderr: '', code: 0 }
        }
        if (args.includes('.object.sha')) {
          return { stdout: 'abc123\n', stderr: '', code: 0 }
        }
        if (endpoint === 'repos/Choeng-Rayu/example') {
          return { stdout: '123\n', stderr: '', code: 0 }
        }
        if (args[0] === 'api' && args.length === 4 && args.includes('.sha')) {
          return { stdout: '', stderr: 'not found', code: 1 }
        }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    expect(result.branchName).toStartWith('add-rayu-github-actions-')
    expect(result.pullRequestUrl).toContain(
      'github.com/Choeng-Rayu/example/compare/main...add-rayu-github-actions-',
    )
    const secretCall = calls.find(call => call.args[0] === 'secret')
    expect(secretCall?.input).toBe('rayu-secret')
    expect(secretCall?.args.join(' ')).not.toContain('rayu-secret')

    const writes = calls.filter(
      call => call.args[0] === 'api' && call.args.includes('PUT'),
    )
    expect(writes).toHaveLength(2)
    expect(writes.some(call => call.args.includes('repos/Choeng-Rayu/example/contents/.github/workflows/rayu.yml'))).toBe(true)
    expect(writes.some(call => call.args.includes('repos/Choeng-Rayu/example/contents/.github/workflows/rayu-code-review.yml'))).toBe(true)
  })

  test('rejects an empty workflow selection before calling GitHub', async () => {
    let called = false
    await expect(
      setupGitHubActionsCore({
        repoName: 'Choeng-Rayu/example',
        apiKey: null,
        secretName: 'RAYU_API_KEY',
        selectedWorkflows: [],
        config: {
          appInstallUrl: 'https://github.com/apps/rayucode-agentic',
          actionRef: 'Choeng-Rayu/rayu-cli/rayu-action@main',
          docsUrl: 'https://rayucode.com/docs',
        },
        runGitHubCommand: async () => {
          called = true
          return { stdout: '', stderr: '', code: 0 }
        },
      }),
    ).rejects.toThrow('Select at least one Rayu workflow')
    expect(called).toBe(false)
  })
})
