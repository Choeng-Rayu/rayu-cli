/**
 * Passive "update available" notice: decide whether to show it, and format it.
 *
 * Both helpers here are PURE so the policy is testable without a terminal, a
 * network, or a real install. The two surfaces that render the notice — the
 * banner above the prompt (src/components/UpdateAvailableNotice.tsx) and the
 * welcome-box panel (src/components/LogoV2/feedConfigs.tsx) — both go through
 * formatUpdateNotice/UPDATE_COMMAND so their wording cannot drift apart.
 *
 * This notice is deliberately INDEPENDENT of the auto-updater. Auto-updates are
 * off by default in Rayu (getAutoUpdaterDisabledReason() returns
 * `{type:'config'}` unless `autoUpdates: true`), and the pre-existing
 * PackageManagerAutoUpdater banner returns early on isAutoUpdaterDisabled() —
 * so before this module there was no path that ever told an npm user a new
 * version existed. Telling someone a version exists is not the same as silently
 * replacing their binary, so the "off by default" config reason must NOT
 * suppress the notice. An explicit opt-out still must; see
 * shouldShowUpdateNotice.
 */
import { CHANGELOG_WEB_URL, PRODUCT_COMMAND } from 'src/constants/product.js'
import type { AutoUpdaterDisabledReason } from './config.js'
import type { InstallationType } from './doctorDiagnostic.js'
import { gt } from './semver.js'

/** The command we tell users to run. `rayu update`. */
export const UPDATE_COMMAND = `${PRODUCT_COMMAND} update`

export type UpdateNoticeInput = {
  /** The running build's version (MACRO.VERSION). */
  currentVersion: string
  /** Latest published version, or null while unknown/offline. */
  latestVersion: string | null
  installationType: InstallationType
  /** Result of getAutoUpdaterDisabledReason(). */
  disabledReason: AutoUpdaterDisabledReason | null
  /** True for --print / piped / bare sessions. */
  isNonInteractive: boolean
  /** True when the user opted in with `autoUpdates: true`. */
  autoUpdatesEnabled: boolean
}

/**
 * Everything except the version comparison: is this session/install allowed to
 * show an update notice at all?
 *
 * Split out from shouldShowUpdateNotice so the banner can decide whether to
 * even *ask* the registry. An env opt-out or essential-traffic-only mode must
 * suppress the network request, not merely hide the result. Keeping it as one
 * shared predicate means the "may I check?" and "may I show?" decisions cannot
 * drift apart.
 *
 * Suppressed when:
 *  - the user explicitly opted out via env (DISABLE_AUTOUPDATER, or an
 *    essential-traffic-only var) or this is a development build;
 *  - the install is managed by a package manager (brew/winget/apk): the
 *    existing PackageManagerAutoUpdater prints the correct upgrade command for
 *    that manager, whereas `rayu update` would be wrong there;
 *  - the session is non-interactive: nobody is watching, and polluting
 *    --print/JSON output would corrupt pipelines;
 *  - auto-updates are ON: the updater installs the new version itself and
 *    reports its own progress, so a "run rayu update" nag would be noise.
 *
 * Note the deliberate asymmetry: `{type:'config'}` (auto-updates merely off by
 * default) does NOT suppress the notice, while `{type:'env'}` does.
 */
export function isUpdateNoticeAllowed({
  installationType,
  disabledReason,
  isNonInteractive,
  autoUpdatesEnabled,
}: Omit<UpdateNoticeInput, 'currentVersion' | 'latestVersion'>): boolean {
  if (isNonInteractive) return false
  if (autoUpdatesEnabled) return false

  // Explicit opt-out or a dev build. `config` is intentionally allowed through.
  if (disabledReason?.type === 'env' || disabledReason?.type === 'development') {
    return false
  }

  return (
    installationType !== 'development' && installationType !== 'package-manager'
  )
}

/**
 * Should the "update available" notice be shown? Session/install must permit it
 * (isUpdateNoticeAllowed) AND a strictly newer version must be published.
 */
export function shouldShowUpdateNotice({
  currentVersion,
  latestVersion,
  ...environment
}: UpdateNoticeInput): boolean {
  return (
    isUpdateNoticeAllowed(environment) &&
    isNewerVersion(currentVersion, latestVersion)
  )
}

/**
 * Is `latestVersion` strictly newer than `currentVersion`?
 *
 * Returns false — never throws — for null/empty/unparsable input. A malformed
 * version from the registry (or a locally built binary with an odd version
 * string) must degrade to "no update available" rather than crash the render
 * path this feeds. Bun.semver.order and node-semver both throw on invalid
 * input, so the try/catch is load-bearing, not defensive noise.
 */
export function isNewerVersion(
  currentVersion: string,
  latestVersion: string | null,
): boolean {
  if (!latestVersion || !currentVersion) return false
  try {
    return gt(latestVersion, currentVersion)
  } catch {
    return false
  }
}

/**
 * The single line rendered by both surfaces, e.g.
 *   Update available: v1.5.11 (current v1.5.0) · run rayu update · https://rayucode.com/changelog
 *
 * Kept to one line so it can be truncated safely in a narrow terminal, with the
 * most important information (that an update exists, and the new version)
 * first — a truncated line still tells the user what they need to know.
 */
export function formatUpdateNotice(
  currentVersion: string,
  latestVersion: string,
): string {
  return `Update available: v${latestVersion} (current v${currentVersion}) · run ${UPDATE_COMMAND} · ${CHANGELOG_WEB_URL}`
}

/**
 * Two short lines for the welcome-box panel, which renders a title separately
 * and has a narrow fixed column, so the single-line form would truncate.
 */
export function formatUpdateNoticeLines(
  currentVersion: string,
  latestVersion: string,
): string[] {
  return [
    `v${latestVersion} is available (current v${currentVersion})`,
    `Run ${UPDATE_COMMAND}`,
    CHANGELOG_WEB_URL,
  ]
}
