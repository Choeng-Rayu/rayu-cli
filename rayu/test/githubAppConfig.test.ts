import { afterEach, describe, expect, test } from 'bun:test'
import { parse as parseYaml } from 'yaml'

import {
  buildRayuAssistantWorkflow,
  buildRayuReviewWorkflow,
  getRayuGitHubIntegrationConfig,
  normalizeGitHubRepo,
  validateGitHubSecretName,
} from '../src/constants/github-app.ts'

const ORIGINAL_ENV = {
  appUrl: process.env.RAYU_GITHUB_APP_INSTALL_URL,
  actionRef: process.env.RAYU_GITHUB_ACTION_REF,
  docsUrl: process.env.RAYU_GITHUB_ACTION_DOCS_URL,
}

afterEach(() => {
  restore('RAYU_GITHUB_APP_INSTALL_URL', ORIGINAL_ENV.appUrl)
  restore('RAYU_GITHUB_ACTION_REF', ORIGINAL_ENV.actionRef)
  restore('RAYU_GITHUB_ACTION_DOCS_URL', ORIGINAL_ENV.docsUrl)
})

describe('Rayu GitHub integration configuration', () => {
  test('reports the two required publisher settings when absent', () => {
    delete process.env.RAYU_GITHUB_APP_INSTALL_URL
    delete process.env.RAYU_GITHUB_ACTION_REF

    const result = getRayuGitHubIntegrationConfig()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toEqual([
        'RAYU_GITHUB_APP_INSTALL_URL',
        'RAYU_GITHUB_ACTION_REF',
      ])
    }
  })

  test('accepts a GitHub App URL and pinned action reference', () => {
    process.env.RAYU_GITHUB_APP_INSTALL_URL = 'https://github.com/apps/rayu-code'
    process.env.RAYU_GITHUB_ACTION_REF = 'Choeng-Rayu/rayucode-action@v1'
    process.env.RAYU_GITHUB_ACTION_DOCS_URL =
      'https://github.com/Choeng-Rayu/rayucode-action'

    expect(getRayuGitHubIntegrationConfig()).toEqual({
      ok: true,
      config: {
        appInstallUrl: 'https://github.com/apps/rayu-code',
        actionRef: 'Choeng-Rayu/rayucode-action@v1',
        docsUrl: 'https://github.com/Choeng-Rayu/rayucode-action',
      },
    })
  })

  test('accepts an action stored in a repository subdirectory', () => {
    process.env.RAYU_GITHUB_APP_INSTALL_URL =
      'https://github.com/apps/rayucode-agentic'
    process.env.RAYU_GITHUB_ACTION_REF =
      'Choeng-Rayu/rayu-cli/rayu-action@main'

    expect(getRayuGitHubIntegrationConfig()).toEqual({
      ok: true,
      config: {
        appInstallUrl: 'https://github.com/apps/rayucode-agentic',
        actionRef: 'Choeng-Rayu/rayu-cli/rayu-action@main',
        docsUrl: 'https://rayucode.com/docs',
      },
    })
  })

  test('rejects unsafe values before they can enter YAML or browser navigation', () => {
    process.env.RAYU_GITHUB_APP_INSTALL_URL = 'javascript:alert(1)'
    process.env.RAYU_GITHUB_ACTION_REF = 'owner/action@v1\nrun: curl bad.example'

    const result = getRayuGitHubIntegrationConfig()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.invalid).toHaveLength(2)
    }
  })
})

describe('Rayu GitHub workflow generation', () => {
  test('generates Rayu-only assistant and review workflows', () => {
    const assistant = buildRayuAssistantWorkflow(
      'Choeng-Rayu/rayucode-action@v1',
      'RAYU_API_KEY',
    )
    const review = buildRayuReviewWorkflow(
      'Choeng-Rayu/rayucode-action@v1',
      'RAYU_API_KEY',
    )
    const workflows = `${assistant}\n${review}`

    expect(assistant).toContain("contains(github.event.comment.body, '@rayu')")
    expect(assistant).toContain('uses: Choeng-Rayu/rayucode-action@v1')
    expect(workflows).toContain('rayu_api_key: ${{ secrets.RAYU_API_KEY }}')
    expect(workflows).toContain('github_token: ${{ secrets.GITHUB_TOKEN }}')
    expect(workflows.toLowerCase()).not.toContain('claude')
    expect(workflows.toLowerCase()).not.toContain('anthropic')
    expect(() => parseYaml(assistant)).not.toThrow()
    expect(() => parseYaml(review)).not.toThrow()
  })

  test('validates secret names', () => {
    expect(validateGitHubSecretName('RAYU_API_KEY')).toBe(true)
    expect(validateGitHubSecretName('TEAM_RAYU_KEY_2')).toBe(true)
    expect(validateGitHubSecretName('bad-name')).toBe(false)
    expect(validateGitHubSecretName('${{ secrets.BAD }}')).toBe(false)
  })
})

describe('GitHub repository normalization', () => {
  test('accepts owner/repo and common GitHub remote forms', () => {
    expect(normalizeGitHubRepo('Choeng-Rayu/rayu-cli')).toBe(
      'Choeng-Rayu/rayu-cli',
    )
    expect(normalizeGitHubRepo('https://github.com/Choeng-Rayu/rayu-cli.git')).toBe(
      'Choeng-Rayu/rayu-cli',
    )
    expect(normalizeGitHubRepo('git@github.com:Choeng-Rayu/rayu-cli.git')).toBe(
      'Choeng-Rayu/rayu-cli',
    )
  })

  test('rejects non-GitHub and path-injection values', () => {
    expect(normalizeGitHubRepo('https://example.com/owner/repo')).toBeNull()
    expect(normalizeGitHubRepo('owner/repo/contents')).toBeNull()
    expect(normalizeGitHubRepo('../owner/repo')).toBeNull()
    expect(normalizeGitHubRepo('owner/repo?ref=main')).toBeNull()
  })
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
