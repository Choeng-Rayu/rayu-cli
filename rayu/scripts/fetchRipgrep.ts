#!/usr/bin/env bun
/**
 * Fetch the ripgrep binary a platform VSIX ships as `bin/rg[.exe]`.
 *
 * WHY THE EXTENSION SHIPS ITS OWN
 * Grep and Glob run `rg`. The engine looks for a vendored copy beside its bundle and
 * otherwise falls back to an `rg` on PATH, and no VSIX has ever carried one — so in VS
 * Code, search worked only on machines that happened to have ripgrep installed. The
 * host now points the engine at a known binary (`RAYU_RIPGREP_PATH`), and a platform
 * VSIX carries that binary.
 *
 * WHERE IT COMES FROM
 * microsoft/ripgrep-prebuilt — the builds VS Code itself ships. Every archive is pinned
 * by SHA-256 (the digests GitHub publishes for the release's assets) and verified
 * before anything is extracted, so a changed or tampered download fails the build
 * instead of being packaged. Linux uses the static musl builds, which run on glibc and
 * musl distributions alike.
 *
 * Downloads are cached under dist/ripgrep-cache/, so repeated builds are offline.
 *
 *   bun run scripts/fetchRipgrep.ts <target>     # e.g. linux-x64; prints the binary path
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { NATIVE_TARGETS, type VscodeTarget } from './vscodeTargets.ts'

export const RIPGREP_VERSION = 'v15.0.1'

/** SHA-256 of each release archive, keyed by target triple. */
export const RIPGREP_PINS: Readonly<Record<string, string>> = {
  'x86_64-unknown-linux-musl': '4499958bfd5252df3d9e7504127fd448e4a14fbf2805ef4f14baaa1bcf775188',
  'aarch64-unknown-linux-musl': 'dd3738a4b6e8df0fb3bc3edc5af352c4c39e0d97ad118a23e5176bdc5d48ba08',
  'x86_64-apple-darwin': '591c693e80bb444ef1907b2a906feb9c77bcafe1cdf509107cc75dcf0e875bd2',
  'aarch64-apple-darwin': '2fa16464fd8638588a67c7fc172d3c4b57fbdc65dff366e10b0b0e90734628a6',
  'x86_64-pc-windows-msvc': 'bd28761f4918ea8fcb7a95f636b4422a915d55af268d9805be82d8ce0fdfc823',
}

const DEFAULT_CACHE_DIR = resolve(import.meta.dir, '../dist/ripgrep-cache')
const DOWNLOAD_TIMEOUT_MS = 120_000

export function archiveName(triple: string): string {
  const ext = triple.includes('windows') ? 'zip' : 'tar.gz'
  return `ripgrep-${RIPGREP_VERSION}-${triple}.${ext}`
}

export function archiveUrl(triple: string): string {
  return `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${RIPGREP_VERSION}/${archiveName(triple)}`
}

/** Throws unless `bytes` hash to the pinned digest for `triple`. */
export function verifyArchive(
  triple: string,
  bytes: Uint8Array,
  pins: Readonly<Record<string, string>> = RIPGREP_PINS,
): void {
  const expected = pins[triple]
  if (!expected) throw new Error(`No pinned ripgrep checksum for ${triple}.`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `ripgrep archive checksum mismatch for ${archiveName(triple)}: ` +
        `expected ${expected}, got ${actual}. Refusing to package it.`,
    )
  }
}

export interface FetchRipgrepOptions {
  cacheDir?: string
  /** Injectable for tests. Defaults to an HTTPS download. */
  download?: (url: string) => Promise<Uint8Array>
  pins?: Readonly<Record<string, string>>
}

async function httpsDownload(url: string): Promise<Uint8Array> {
  // GitHub serves release assets through a redirect to its object store; the checksum,
  // not the host, is what makes the result trustworthy.
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** The verified archive for `triple`, from the cache or freshly downloaded. */
async function verifiedArchive(triple: string, options: FetchRipgrepOptions): Promise<string> {
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR
  const archive = join(cacheDir, archiveName(triple))
  if (existsSync(archive)) {
    try {
      verifyArchive(triple, readFileSync(archive), options.pins)
      return archive
    } catch {
      // A truncated or stale cache entry: fetch it again rather than failing.
    }
  }
  const bytes = await (options.download ?? httpsDownload)(archiveUrl(triple))
  verifyArchive(triple, bytes, options.pins)
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(archive, bytes)
  return archive
}

/**
 * Return the path of a verified `rg` (or `rg.exe`) for `target`, extracted into the
 * cache. Both archive formats hold the binary at their root.
 */
export async function fetchRipgrep(
  target: Pick<VscodeTarget, 'rgTriple' | 'exe'>,
  options: FetchRipgrepOptions = {},
): Promise<string> {
  const archive = await verifiedArchive(target.rgTriple, options)
  const outDir = join(options.cacheDir ?? DEFAULT_CACHE_DIR, target.rgTriple)
  mkdirSync(outDir, { recursive: true })
  const command = archive.endsWith('.zip')
    ? ['unzip', '-o', '-q', archive, '-d', outDir]
    : ['tar', '-xzf', archive, '-C', outDir]
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`Extracting ${archive} failed: ${result.stderr.toString().trim()}`)
  }
  const binary = join(outDir, `rg${target.exe}`)
  if (!existsSync(binary)) throw new Error(`${archive} did not contain rg${target.exe}`)
  chmodSync(binary, 0o755)
  return binary
}

if (import.meta.main) {
  const id = process.argv[2]
  const target = NATIVE_TARGETS.find(t => t.id === id)
  if (!target) {
    console.error(`usage: bun run scripts/fetchRipgrep.ts <${NATIVE_TARGETS.map(t => t.id).join('|')}>`)
    process.exit(2)
  }
  console.log(await fetchRipgrep(target))
}
