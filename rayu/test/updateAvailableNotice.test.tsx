/**
 * Render tests for the "update available" banner.
 *
 * These assert what actually reaches the terminal, not just the decision logic
 * in updateNotice.test.ts. The component's two async dependencies (install-type
 * detection, which shells out to npm, and the registry lookup) are injected so
 * these tests spawn nothing and make no network requests.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import stripAnsi from 'strip-ansi'

import { UpdateAvailableNotice } from '../src/components/UpdateAvailableNotice.tsx'
import { render } from '../src/ink.ts'
import {
  type InstallStatus,
  _resetLatestNpmVersionCacheForTesting,
} from '../src/utils/autoUpdater.ts'
import type { InstallationType } from '../src/utils/doctorDiagnostic.ts'
import { CaptureStream } from './helpers/captureStream.js'

afterEach(() => {
  _resetLatestNpmVersionCacheForTesting()
})

/**
 * An ordinary interactive session on a default install: auto-updates are ON
 * (Rayu's shipped default), so disabledReason is null. The notice must show
 * regardless of the autoUpdates setting. A test process is always reported as
 * non-interactive, so this has to be injected for the banner to be reachable
 * at all.
 */
const INTERACTIVE_DEFAULT = {
  disabledReason: null,
  isNonInteractive: false,
}

async function renderNotice(options: {
  installationType: InstallationType
  latestVersion: string | null
  currentVersion: string
  columns?: number
  environment?: typeof INTERACTIVE_DEFAULT | Record<string, unknown>
  isAutoUpdating?: boolean
  autoUpdaterStatus?: InstallStatus | null
}): Promise<string> {
  const stdout = new CaptureStream({ columns: 120, rows: 40 })
  if (options.columns) stdout.columns = options.columns

  const instance = await render(
    <UpdateAvailableNotice
      detectInstallationType={async () => options.installationType}
      fetchLatestVersion={async () => options.latestVersion}
      currentVersion={options.currentVersion}
      isAutoUpdating={options.isAutoUpdating}
      autoUpdaterStatus={options.autoUpdaterStatus}
      readEnvironment={() =>
        ({
          ...INTERACTIVE_DEFAULT,
          ...options.environment,
        }) as ReturnType<
          NonNullable<
            React.ComponentProps<typeof UpdateAvailableNotice>['readEnvironment']
          >
        >
      }
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )

  // Both effects (detect install type, then fetch the version) must settle.
  await new Promise(resolve => setTimeout(resolve, 40))
  instance.unmount()
  instance.cleanup()

  return stripAnsi(stdout.output)
}

describe('UpdateAvailableNotice', () => {
  test('renders the notice when a newer version is published', async () => {
    const output = await renderNotice({
      installationType: 'npm-global',
      latestVersion: '1.5.12',
      currentVersion: '1.5.0',
    })

    expect(output).toContain('Update available')
    expect(output).toContain('1.5.12')
    expect(output).toContain('1.5.0')
    expect(output).toContain('rayu update')
    expect(output).toContain('rayucode.com/changelog')
  })

  test('renders nothing when already up to date', async () => {
    const output = await renderNotice({
      installationType: 'npm-global',
      latestVersion: '1.5.12',
      currentVersion: '1.5.12',
    })

    expect(output).not.toContain('Update available')
  })

  test('renders nothing when the registry lookup fails (offline)', async () => {
    const output = await renderNotice({
      installationType: 'npm-global',
      latestVersion: null,
      currentVersion: '1.5.0',
    })

    expect(output).not.toContain('Update available')
  })

  test('never tells a package-manager install to run rayu update', async () => {
    // brew/winget/apk users get the correct command from
    // PackageManagerAutoUpdater instead.
    const output = await renderNotice({
      installationType: 'package-manager',
      latestVersion: '1.5.12',
      currentVersion: '1.5.0',
    })

    expect(output).not.toContain('Update available')
    expect(output).not.toContain('rayu update')
  })

  test('stays silent for development installs', async () => {
    const output = await renderNotice({
      installationType: 'development',
      latestVersion: '1.5.12',
      currentVersion: '1.5.0',
    })

    expect(output).not.toContain('Update available')
  })

  test('survives a narrow terminal, keeping the version visible', async () => {
    // The welcome-box panel is horizontal-layout-only, so this banner is the
    // narrow-terminal path. wrap="truncate" must clip it to one line rather
    // than wrapping, and the clipped part must still carry the useful facts.
    const columns = 44
    const output = await renderNotice({
      installationType: 'npm-global',
      latestVersion: '1.5.12',
      currentVersion: '1.5.0',
      columns,
    })

    // Exactly one line: truncated, never wrapped onto a second row.
    expect(output.split('\n').filter(line => line.trim()).length).toBe(1)
    expect(output).toContain('…')

    // The captured stream holds one frame per render pass (the renderer redraws
    // in place with cursor moves that stripAnsi removes), so assert on a single
    // frame's worth of output.
    const frame = output.trimEnd().split('…')[0]!
    expect(frame.length).toBeLessThanOrEqual(columns)
    expect(frame).toContain('Update available')
    expect(frame).toContain('1.5.12')
  })

  test('renders for every install type that should see it', async () => {
    for (const installationType of [
      'npm-global',
      'npm-local',
      'native',
      // Installer-managed installs get the notice too: the in-session
      // auto-updater deliberately skips them (it would swap lib/current under a
      // live process), so the notice pointing at `rayu update` is the ONLY thing
      // that tells these users a new version exists.
      'installer',
      'unknown',
    ] satisfies InstallationType[]) {
      const output = await renderNotice({
        installationType,
        latestVersion: '1.5.12',
        currentVersion: '1.5.0',
      })
      expect(output).toContain('Update available')
    }
  })

  test('the autoUpdates setting never hides the notice (ON or config-off)', async () => {
    // The whole point of the feature: before this, no npm user was ever told.
    // null is the shipped default (auto-updates ON); config-off must show too.
    for (const disabledReason of [{ type: 'config' } as const, null]) {
      const output = await renderNotice({
        installationType: 'npm-global',
        latestVersion: '1.5.12',
        currentVersion: '1.5.0',
        environment: { disabledReason },
      })
      expect(output).toContain('Update available')
    }
  })

  test('an explicit env opt-out silences it', async () => {
    const output = await renderNotice({
      installationType: 'npm-global',
      latestVersion: '1.5.12',
      currentVersion: '1.5.0',
      environment: {
        disabledReason: { type: 'env', envVar: 'DISABLE_AUTOUPDATER' },
      },
    })

    expect(output).not.toContain('Update available')
  })

  test('a non-interactive session prints nothing (pipelines stay clean)', async () => {
    const output = await renderNotice({
      installationType: 'npm-global',
      latestVersion: '1.5.12',
      currentVersion: '1.5.0',
      environment: { isNonInteractive: true },
    })

    expect(output).not.toContain('Update available')
  })

  test('hides while the auto-updater is itself reporting', async () => {
    // success / install_failed / no_permissions mean the updater already told
    // the user about this update; the banner must not duplicate that line.
    for (const autoUpdaterStatus of [
      'success',
      'install_failed',
      'no_permissions',
    ] satisfies InstallStatus[]) {
      const output = await renderNotice({
        installationType: 'npm-global',
        latestVersion: '1.5.12',
        currentVersion: '1.5.0',
        autoUpdaterStatus,
      })
      expect(output).not.toContain('Update available')
    }

    // Actively installing: same rule, via the boolean flag.
    const installing = await renderNotice({
      installationType: 'npm-global',
      latestVersion: '1.5.12',
      currentVersion: '1.5.0',
      isAutoUpdating: true,
    })
    expect(installing).not.toContain('Update available')
  })

  test('shows by default while the updater is silent', async () => {
    // Auto-updates ON (disabledReason: null), no updater result yet — the
    // default-user case this whole fix targets.
    const output = await renderNotice({
      installationType: 'npm-global',
      latestVersion: '1.5.12',
      currentVersion: '1.5.0',
      environment: { disabledReason: null },
    })

    expect(output).toContain('Update available')
  })

  test("an 'in_progress' status does not suppress the banner", async () => {
    // The updater renders nothing while in_progress, so a silent no-op must
    // still leave the banner visible.
    const output = await renderNotice({
      installationType: 'npm-global',
      latestVersion: '1.5.12',
      currentVersion: '1.5.0',
      autoUpdaterStatus: 'in_progress',
    })

    expect(output).toContain('Update available')
  })

  test('does not hit the registry when the notice is not permitted', async () => {
    // An env opt-out must prevent the request itself, not just hide its result.
    let fetches = 0
    const stdout = new CaptureStream({ columns: 120, rows: 40 })
    const instance = await render(
      <UpdateAvailableNotice
        detectInstallationType={async () => 'npm-global'}
        fetchLatestVersion={async () => {
          fetches++
          return '1.5.12'
        }}
        currentVersion="1.5.0"
        readEnvironment={() => ({
          ...INTERACTIVE_DEFAULT,
          disabledReason: { type: 'env', envVar: 'DISABLE_AUTOUPDATER' },
        })}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    await new Promise(resolve => setTimeout(resolve, 40))
    instance.unmount()
    instance.cleanup()

    expect(fetches).toBe(0)
  })
})
