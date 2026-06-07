/**
 * GitHub Releases distribution client for Rayu.
 *
 * Replaces the upstream Anthropic GCS release bucket. Native/standalone
 * installs and version checks resolve against this repo's GitHub Releases:
 *   - latest version  -> GET /repos/<repo>/releases/latest (tag_name)
 *   - binary asset     -> https://github.com/<repo>/releases/download/<tag>/<asset>
 *
 * Everything degrades gracefully: if the repo has no releases yet (404) or the
 * network is unavailable, version lookups return null so the updater simply
 * treats the current version as up to date and never crashes. (npm-based
 * updates of @rayu-dev/rayu-cli are handled separately in autoUpdater.ts.)
 */
import axios from 'axios'
import { logForDebugging } from './debug.js'

/** owner/repo that hosts Rayu's GitHub Releases. */
export const GITHUB_RELEASES_REPO = 'Choeng-Rayu/rayu-cli'

const API_BASE = `https://api.github.com/repos/${GITHUB_RELEASES_REPO}`
const DOWNLOAD_BASE = `https://github.com/${GITHUB_RELEASES_REPO}/releases/download`

const REQUEST_TIMEOUT_MS = 5000

type GitHubRelease = {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{ name?: string; browser_download_url?: string }>
}

/** Strip a leading `v` from a release tag (`v1.2.3` -> `1.2.3`). */
function tagToVersion(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag
}

/** Release channel -> version tag. Both channels use the latest published
 * (non-draft) release today; `latest` additionally accepts prereleases. */
export async function getLatestVersionFromGitHub(
  channel: 'latest' | 'stable' = 'latest',
): Promise<string | null> {
  try {
    if (channel === 'stable') {
      // /releases/latest excludes drafts and prereleases by definition.
      const res = await axios.get<GitHubRelease>(`${API_BASE}/releases/latest`, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { Accept: 'application/vnd.github+json' },
        validateStatus: s => s === 200 || s === 404,
      })
      if (res.status === 404 || !res.data?.tag_name) return null
      return tagToVersion(res.data.tag_name)
    }
    // latest channel: newest published release including prereleases.
    const res = await axios.get<GitHubRelease[]>(
      `${API_BASE}/releases?per_page=10`,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { Accept: 'application/vnd.github+json' },
        validateStatus: s => s === 200 || s === 404,
      },
    )
    if (res.status === 404 || !Array.isArray(res.data)) return null
    const published = res.data.find(r => r && !r.draft && r.tag_name)
    return published?.tag_name ? tagToVersion(published.tag_name) : null
  } catch (error) {
    logForDebugging(`GitHub release version check failed: ${error}`)
    return null
  }
}

export type ReleaseDistTags = {
  latest: string | null
  stable: string | null
}

/** Resolve both channel pointers from GitHub Releases (graceful nulls). */
export async function getGitHubDistTags(): Promise<ReleaseDistTags> {
  const [latest, stable] = await Promise.all([
    getLatestVersionFromGitHub('latest'),
    getLatestVersionFromGitHub('stable'),
  ])
  return { latest, stable }
}

/** Asset base URL for a given version's release (tag is `v<version>`). */
export function getGitHubAssetBaseUrl(version: string): string {
  const tag = version.startsWith('v') ? version : `v${version}`
  return `${DOWNLOAD_BASE}/${tag}`
}

/**
 * Flat asset name for a platform (GitHub asset names cannot contain slashes).
 * Matches the names produced by the release workflow, e.g.
 *   linux-x64       -> rayu-cli-linux-x64
 *   darwin-arm64    -> rayu-cli-darwin-arm64
 *   win32-x64       -> rayu-cli-win32-x64.exe
 */
export function getBinaryAssetName(platform: string): string {
  const base = `rayu-cli-${platform}`
  return platform.startsWith('win32') ? `${base}.exe` : base
}
