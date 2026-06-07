import { expect, test } from 'bun:test'
import {
  GITHUB_RELEASES_REPO,
  getBinaryAssetName,
  getGitHubAssetBaseUrl,
} from '../src/utils/githubReleases.ts'

// Pure, deterministic helpers of the GitHub Releases distribution client.
// (Live version lookups degrade to null on 404/network error by design — see
// getLatestVersionFromGitHub's try/catch + validateStatus; not exercised here
// to avoid real network calls in the unit suite.)

test('repo constant points at the Rayu GitHub repo', () => {
  expect(GITHUB_RELEASES_REPO).toBe('Choeng-Rayu/rayu-cli')
})

test('asset base URL uses the v<version> tag and is not double-prefixed', () => {
  expect(getGitHubAssetBaseUrl('1.2.3')).toBe(
    'https://github.com/Choeng-Rayu/rayu-cli/releases/download/v1.2.3',
  )
  expect(getGitHubAssetBaseUrl('v1.2.3')).toBe(
    'https://github.com/Choeng-Rayu/rayu-cli/releases/download/v1.2.3',
  )
})

test('binary asset name matches getPlatform() values; .exe only on windows', () => {
  expect(getBinaryAssetName('linux-x64')).toBe('rayu-cli-linux-x64')
  expect(getBinaryAssetName('darwin-arm64')).toBe('rayu-cli-darwin-arm64')
  expect(getBinaryAssetName('linux-x64-musl')).toBe('rayu-cli-linux-x64-musl')
  expect(getBinaryAssetName('win32-x64')).toBe('rayu-cli-win32-x64.exe')
})
