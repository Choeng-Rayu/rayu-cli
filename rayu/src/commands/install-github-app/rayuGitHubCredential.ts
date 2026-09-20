/**
 * Account-authenticated provisioning for the long-lived credential used by
 * GitHub Actions. The user's Rayu access token is used only for this HTTPS
 * request and is never copied to GitHub.
 */

export type GitHubCredentialFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'text'>>

type ApiKeyRow = {
  id: number
  name: string
  status: string
}

type ApiKeyWithPlaintext = ApiKeyRow & {
  key?: unknown
}

export type ProvisionGitHubCredentialOptions = {
  repoName: string
  apiBaseUrl: string
  accessToken: string
  fetch?: GitHubCredentialFetch
}

/**
 * Create or rotate a dedicated key for one repository.
 *
 * Rotation keeps the previous value alive for an hour, giving GitHub enough
 * time to accept the replacement without breaking an already-running job.
 */
export async function provisionGitHubActionsCredential({
  repoName,
  apiBaseUrl,
  accessToken,
  fetch: fetchImpl = globalThis.fetch,
}: ProvisionGitHubCredentialOptions): Promise<string> {
  const name = githubActionsCredentialName(repoName)
  const base = apiBaseUrl.replace(/\/$/, '')
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }

  const listResponse = await fetchImpl(`${base}/me/api-keys`, { headers })
  const rows = await readJson<ApiKeyRow[]>(listResponse, 'list Rayu credentials')
  const existing = rows.find(row => row.name === name && row.status === 'active')

  const response = existing
    ? await fetchImpl(`${base}/me/api-keys/${existing.id}/rotate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ graceMinutes: 60 }),
      })
    : await fetchImpl(`${base}/me/api-keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name }),
      })
  const credential = await readJson<ApiKeyWithPlaintext>(
    response,
    existing ? 'rotate the GitHub Actions credential' : 'create a GitHub Actions credential',
  )
  if (typeof credential.key !== 'string' || !credential.key.trim()) {
    throw new Error('Rayu did not return the new GitHub Actions credential.')
  }
  return credential.key.trim()
}

/** Stable, backend-valid name that remains unique when a repository name is long. */
export function githubActionsCredentialName(repoName: string): string {
  const prefix = 'GitHub Actions: '
  const full = `${prefix}${repoName}`
  if (full.length <= 64) return full
  const suffix = `-${stableHash(repoName)}`
  return `${prefix}${repoName.slice(0, 64 - prefix.length - suffix.length)}${suffix}`
}

async function readJson<T>(
  response: Pick<Response, 'ok' | 'status' | 'json' | 'text'>,
  operation: string,
): Promise<T> {
  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { message?: unknown }
      detail = typeof body.message === 'string' ? body.message : ''
    } catch {
      try {
        detail = (await response.text()).trim()
      } catch {
        // The status still gives the user an actionable failure.
      }
    }
    throw new Error(
      `Could not ${operation} (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`,
    )
  }
  return (await response.json()) as T
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
