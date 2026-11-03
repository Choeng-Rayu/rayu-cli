import { describe, expect, test } from 'bun:test'

import {
  githubActionsCredentialName,
  provisionGitHubActionsCredential,
  type GitHubCredentialFetch,
} from '../src/commands/install-github-app/rayuGitHubCredential.ts'

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe('Rayu account GitHub credential provisioning', () => {
  test('creates a repository credential with the signed-in account token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch: GitHubCredentialFetch = async (url, init) => {
      calls.push({ url, init })
      if (!init?.method) return response(200, [])
      return response(201, {
        id: 7,
        name: 'GitHub Actions: owner/repo',
        status: 'active',
        key: 'rayu_sk_live_generated',
      })
    }

    const key = await provisionGitHubActionsCredential({
      repoName: 'owner/repo',
      apiBaseUrl: 'https://rayucode.com/api/',
      accessToken: 'account-jwt',
      fetch,
    })

    expect(key).toBe('rayu_sk_live_generated')
    expect(calls.map(call => call.url)).toEqual([
      'https://rayucode.com/api/me/api-keys',
      'https://rayucode.com/api/me/api-keys',
    ])
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer account-jwt',
    })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      name: 'GitHub Actions: owner/repo',
    })
  })

  test('rotates the existing repository credential with a grace period', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch: GitHubCredentialFetch = async (url, init) => {
      calls.push({ url, init })
      if (!init?.method) {
        return response(200, [
          { id: 42, name: 'GitHub Actions: owner/repo', status: 'active' },
        ])
      }
      return response(200, {
        id: 43,
        name: 'GitHub Actions: owner/repo',
        status: 'active',
        key: 'rotated-key',
      })
    }

    await expect(
      provisionGitHubActionsCredential({
        repoName: 'owner/repo',
        apiBaseUrl: 'https://rayucode.com/api',
        accessToken: 'jwt',
        fetch,
      }),
    ).resolves.toBe('rotated-key')
    expect(calls[1]?.url).toEndWith('/me/api-keys/42/rotate')
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ graceMinutes: 60 })
  })

  test('surfaces a useful backend error without exposing the token', async () => {
    const fetch: GitHubCredentialFetch = async () =>
      response(403, { message: 'API key access requires a Pro plan or higher.' })

    await expect(
      provisionGitHubActionsCredential({
        repoName: 'owner/repo',
        apiBaseUrl: 'https://rayucode.com/api',
        accessToken: 'secret-jwt',
        fetch,
      }),
    ).rejects.toThrow('API key access requires a Pro plan or higher')
  })

  test('keeps generated backend names within the API limit and stable', () => {
    const repo = `${'very-long-owner'.repeat(3)}/${'very-long-repository'.repeat(3)}`
    const first = githubActionsCredentialName(repo)
    expect(first.length).toBeLessThanOrEqual(64)
    expect(githubActionsCredentialName(repo)).toBe(first)
    expect(githubActionsCredentialName(`${repo}-different`)).not.toBe(first)
  })
})
