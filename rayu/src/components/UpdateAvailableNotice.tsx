import * as React from 'react'
import { useEffect, useState } from 'react'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { Box, Text } from '../ink.js'
import {
  ensureLatestNpmVersion,
  getCachedLatestNpmVersionSync,
} from '../utils/autoUpdater.js'
import {
  type ReleaseChannel,
  getAutoUpdaterDisabledReason,
  getGlobalConfig,
} from '../utils/config.js'
import {
  type InstallationType,
  getCurrentInstallationType,
} from '../utils/doctorDiagnostic.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  formatUpdateNotice,
  isUpdateNoticeAllowed,
  shouldShowUpdateNotice,
  type UpdateNoticeInput,
} from '../utils/updateNotice.js'

/**
 * One-line "update available" banner rendered above the prompt.
 *
 * Why this exists alongside the welcome-box panel (LogoV2 "Update available"
 * feed): that panel only renders when `layoutMode === 'horizontal'`, so narrow
 * and short terminals never saw it, and it reads the latest version
 * SYNCHRONOUSLY during render via getCachedLatestNpmVersionSync(). The startup
 * pre-warm (setup.ts) is fire-and-forget, so the logo usually draws before the
 * registry answers and the panel silently shows nothing on the very launch
 * where it matters most.
 *
 * This banner fixes both: it is layout-independent, and it AWAITS the version
 * lookup, re-rendering whenever it resolves. Both surfaces share one
 * single-flight request (ensureLatestNpmVersion), so this costs no extra
 * network traffic.
 *
 * Nothing here blocks startup — the component mounts with the prompt and fills
 * itself in later.
 */
/** The session/install facts the notice policy depends on. */
type NoticeEnvironment = Omit<
  UpdateNoticeInput,
  'currentVersion' | 'latestVersion' | 'installationType'
>

function readNoticeEnvironment(): NoticeEnvironment {
  return {
    disabledReason: getAutoUpdaterDisabledReason(),
    isNonInteractive: getIsNonInteractiveSession(),
    autoUpdatesEnabled: getGlobalConfig().autoUpdates === true,
  }
}

/**
 * Test seams. Each defaults to the real implementation; they exist so a render
 * test can drive the component without spawning `npm`/detecting a real install,
 * touching the network, or needing a TTY (a test process is always reported as
 * a non-interactive session, which correctly suppresses the notice). Same
 * injectable-default convention as ensureLatestNpmVersion's fetchVersion and
 * buildNpmRemediation's platform.
 */
export type UpdateAvailableNoticeProps = {
  detectInstallationType?: () => Promise<InstallationType>
  fetchLatestVersion?: (channel: ReleaseChannel) => Promise<string | null>
  currentVersion?: string
  readEnvironment?: () => NoticeEnvironment
}

export function UpdateAvailableNotice({
  detectInstallationType = getCurrentInstallationType,
  fetchLatestVersion,
  currentVersion = MACRO.VERSION,
  readEnvironment = readNoticeEnvironment,
}: UpdateAvailableNoticeProps = {}): React.ReactNode {
  // Seed from the startup pre-warm when it has already landed, so a session
  // that starts after the fetch completes renders the banner on first frame.
  const [latestVersion, setLatestVersion] = useState<string | null>(() =>
    getCachedLatestNpmVersionSync(),
  )
  // null = still detecting. Render nothing until known, so we never flash a
  // `rayu update` hint at a Homebrew/winget user (same pattern as
  // AutoUpdaterWrapper).
  const [installationType, setInstallationType] =
    useState<InstallationType | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const detected = await detectInstallationType()
        if (!cancelled) {
          setInstallationType(detected)
        }
      } catch {
        // Detection failed — stay silent rather than guess an update command.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [detectInstallationType])

  // Environment gates are cheap synchronous reads (cached config/settings and
  // process state), so they are evaluated on every render rather than stored.
  // Environment gates are cheap synchronous reads (cached config/settings and
  // process state), so they are evaluated on every render rather than stored.
  const { disabledReason, isNonInteractive, autoUpdatesEnabled } =
    readEnvironment()

  const allowed =
    installationType !== null &&
    isUpdateNoticeAllowed({
      installationType,
      disabledReason,
      isNonInteractive,
      autoUpdatesEnabled,
    })

  useEffect(() => {
    // Only ask the registry once we know the notice is permitted here: an env
    // opt-out or essential-traffic-only mode must prevent the request itself,
    // not just hide its result.
    if (!allowed || latestVersion !== null) {
      return
    }
    let cancelled = false
    void (async () => {
      const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
      const resolved = await ensureLatestNpmVersion(channel, fetchLatestVersion)
      if (!cancelled && resolved) {
        setLatestVersion(resolved)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [allowed, latestVersion, fetchLatestVersion])

  if (installationType === null) {
    return null
  }

  const show = shouldShowUpdateNotice({
    currentVersion,
    latestVersion,
    installationType,
    disabledReason,
    isNonInteractive,
    autoUpdatesEnabled,
  })

  if (!show || !latestVersion) {
    return null
  }

  return (
    <Box>
      <Text color="warning" wrap="truncate">
        {formatUpdateNotice(currentVersion, latestVersion)}
      </Text>
    </Box>
  )
}
