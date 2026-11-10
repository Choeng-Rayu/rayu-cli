/**
 * Update an install created by https://rayucode.com/install (or install.ps1)
 * by re-running that installer. Shared by `rayu update` (foreground) and the
 * in-session auto-updater (background).
 *
 * Two safety rules for the background path:
 *  - The installer must carry INSTALLER_API_MARKER. Only installers with that
 *    marker keep the previous version's files, so only they are safe to run
 *    underneath a live session that is still executing the previous bundle.
 *  - The local copy in $RAYU_HOME/bin is refreshed from rayucode.com first.
 *    The installer copies itself over that file on every run, so without a
 *    refresh an existing user would keep running their original installer
 *    forever and never receive installer fixes.
 */
import { spawn } from 'child_process'
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import axios from 'axios'
import { logForDebugging } from './debug.js'
import {
  getInstallerScriptPath,
  type InstallerManifest,
  readInstallerManifest,
} from './installerManifest.js'
import { acquireUpdateLock, releaseUpdateLock } from './updateLock.js'

/** Present in every installer that is safe to run under a live session. */
export const INSTALLER_API_MARKER = 'rayu-installer-api: 2'

const INSTALLER_ORIGIN = 'https://rayucode.com'
const DOWNLOAD_TIMEOUT_MS = 15_000
/** A background install that has not finished by then is treated as failed. */
const BACKGROUND_TIMEOUT_MS = 10 * 60_000

export type InstallerUpdateResult = 'success' | 'failed' | 'locked' | 'unsupported'

export function getInstallerUrl(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `${INSTALLER_ORIGIN}/install.ps1`
    : `${INSTALLER_ORIGIN}/install`
}

export function isSupportedInstaller(content: string): boolean {
  return content.length > 0 && content.includes(INSTALLER_API_MARKER)
}

/** Installer arguments, pinned to the version the caller already resolved. */
export function buildInstallerArgs(
  script: string,
  version: string | undefined,
  background: boolean,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
    if (version) args.push('-Version', version)
    if (background) args.push('-Quiet', '-NoModifyPath')
    return { command: 'powershell', args }
  }
  const args: string[] = []
  if (version) args.push('--version', version)
  if (background) args.push('--quiet', '--no-modify-path')
  return { command: script, args }
}

/**
 * Download the current installer and atomically replace the local copy.
 * Returns false on any failure, leaving the existing copy untouched. Redirects
 * are refused: rayucode.com serves both scripts directly, so a redirect means
 * something between us and the site changed.
 */
export async function refreshInstallerCopy(
  scriptPath: string,
  url: string = getInstallerUrl(),
): Promise<boolean> {
  if (!url.startsWith('https://')) return false
  const tmp = join(dirname(scriptPath), `.rayu-installer.${process.pid}.tmp`)
  try {
    const res = await axios.get<string>(url, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'text',
      transformResponse: data => data,
      validateStatus: s => s === 200,
    })
    const content = typeof res.data === 'string' ? res.data : ''
    if (!isSupportedInstaller(content)) {
      logForDebugging('[installer-update] downloaded installer lacks the API marker')
      return false
    }
    writeFileSync(tmp, content, { mode: 0o755 })
    chmodSync(tmp, 0o755)
    renameSync(tmp, scriptPath)
    return true
  } catch (error) {
    logForDebugging(`[installer-update] could not refresh installer: ${error}`)
    try {
      unlinkSync(tmp)
    } catch {}
    return false
  }
}

function localCopyIsSupported(scriptPath: string): boolean {
  try {
    return isSupportedInstaller(readFileSync(scriptPath, 'utf8'))
  } catch {
    return false
  }
}

function runInstaller(
  command: string,
  args: string[],
  background: boolean,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: background ? 'ignore' : 'inherit',
      windowsHide: background,
    })
    const timer = background
      ? setTimeout(() => child.kill(), BACKGROUND_TIMEOUT_MS)
      : undefined
    child.on('error', error => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      resolve(code)
    })
  })
}

export async function runInstallerUpdate({
  version,
  background,
  manifest = readInstallerManifest(),
}: {
  version?: string
  background: boolean
  manifest?: InstallerManifest | null
}): Promise<InstallerUpdateResult> {
  const script = getInstallerScriptPath(manifest)
  if (!script) return 'unsupported'

  if (!(await acquireUpdateLock())) return 'locked'
  try {
    const refreshed = await refreshInstallerCopy(script)
    if (!refreshed && background && !localCopyIsSupported(script)) {
      // An old installer would delete the bundle this session is running.
      return 'unsupported'
    }
    const { command, args } = buildInstallerArgs(script, version, background)
    const code = await runInstaller(command, args, background)
    return code === 0 ? 'success' : 'failed'
  } catch (error) {
    logForDebugging(`[installer-update] installer failed: ${error}`)
    return 'failed'
  } finally {
    await releaseUpdateLock()
  }
}
