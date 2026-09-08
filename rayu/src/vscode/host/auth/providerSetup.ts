import type { InferenceSettingsView } from '../../shared/inferenceSettings.js'
import type { ModelOptionView } from '../../shared/webviewProtocol.js'
/**
 * Provider setup (`/connect`) from the editor.
 *
 * ── WHY THIS SPAWNS A CHILD RATHER THAN CALLING THE SERVICES ────────────────────
 *
 * Identical reasoning to `vscodeLogin.ts`, and measured the same way: the provider
 * services (`rayuEntitlements`, `rayuHostedProvider`, `rayuLogin`) each cost ~19.7 MB
 * and drag in React, because they reach `utils/log.ts` through `execFileNoThrow`. The
 * host bundle budget is 1.6 MB. The rule is settled: when a needed import blows the
 * budget, the WORK moves into the engine child; the ceiling does not move.
 *
 * The child runs the CLI's own `PROVIDER_PRESETS`, `fetchProviderModels`,
 * `upsertProvider` and `setActiveProviderModel`, so a provider connected here is
 * indistinguishable from one connected with `/connect` in the terminal.
 *
 * ── CREDENTIALS ────────────────────────────────────────────────────────────────
 *
 * An API key travels host → child ONLY, as an argument to a child this host spawned.
 * No frame carries one back, so a key cannot reach the webview, the transcript,
 * persisted webview state, or a log line. `describeAction()` exists so progress and
 * error reporting never has to stringify the action itself.
 */
import { spawn } from 'node:child_process'

import {
  CONNECT_FLAG,
  type AttachTargetFrame,
  type ConnectAction,
  type ConnectPresetView,
} from '../../shared/connectProtocol.js'
import { NdjsonReader } from '../engine/ndjsonReader.js'

/**
 * Model-list fetches hit a provider's API over the network. Generous, because a slow
 * corporate proxy is common and a premature failure here looks like a bad key.
 */
const CONNECT_TIMEOUT_MS = 90_000

export interface ProviderSetupOptions {
  /** Absolute path to the bundled `engine.mjs`. */
  enginePath: string
  cwd: string
}

export interface ConnectOutcome {
  ok: boolean
  presets?: ConnectPresetView[]
  /** Attachable CLI sessions. Carries IPC tokens; never forwarded to the webview. */
  targets?: AttachTargetFrame[]
  models?: string[]
  catalogue?: ModelOptionView[]
  inference?: InferenceSettingsView
  activeProviderId?: string
  activeModel?: string
  /** Already user-facing. Never contains a credential. */
  error?: string
}

/**
 * Enumerate CLI sessions in this workspace that the panel can attach to.
 *
 * In the child because the session registry reader costs 18.5 MB in the host bundle.
 */
export async function listAttachTargets(
  options: ProviderSetupOptions,
  cwd: string,
): Promise<ConnectOutcome> {
  return await runConnectChild(options, { action: 'attach-list', cwd })
}

/** Uses the engine process so provider/auth services never enter the host bundle. */
export async function refreshProviderCatalogue(options: ProviderSetupOptions): Promise<ConnectOutcome> {
  return runConnectChild(options, { action: 'models' })
}

/** Enumerate the providers the panel can offer. */
export async function listProviderPresets(
  options: ProviderSetupOptions,
): Promise<ConnectOutcome> {
  return await runConnectChild(options, { action: 'list' })
}

/**
 * Verify a credential and report what it can serve.
 *
 * One call answers both questions, so they cannot disagree.
 */
export async function validateProvider(
  options: ProviderSetupOptions,
  providerId: string,
  apiKey?: string,
  baseURL?: string,
): Promise<ConnectOutcome> {
  return await runConnectChild(options, {
    action: 'validate',
    providerId,
    apiKey,
    baseURL,
  })
}

/**
 * Persist the provider, make it active, and warm its model catalogue.
 *
 * The caller must then restart the session engine. A running engine resolved its
 * provider at spawn time, so it would keep using the old one; a fresh child reads the
 * new configuration and has no stale cache by construction, which is a stronger
 * guarantee than trying to invalidate caches in place.
 */
export async function saveProvider(
  options: ProviderSetupOptions,
  providerId: string,
  apiKey?: string,
  baseURL?: string,
  model?: string,
): Promise<ConnectOutcome> {
  return await runConnectChild(options, {
    action: 'save',
    providerId,
    apiKey,
    baseURL,
    model,
  })
}

function runConnectChild(
  options: ProviderSetupOptions,
  action: ConnectAction,
): Promise<ConnectOutcome> {
  return new Promise<ConnectOutcome>(resolve => {
    let settled = false
    let stderrTail = ''
    let presets: ConnectPresetView[] | undefined
    let targets: AttachTargetFrame[] | undefined

    const child = spawn(
      process.execPath,
      [options.enginePath, CONNECT_FLAG, JSON.stringify(action)],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          // The extension host's execPath is the Electron binary. This makes it behave
          // as the Node it embeds, with no dependency on a `node` on the user's PATH.
          ELECTRON_RUN_AS_NODE: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )

    function finish(outcome: ConnectOutcome): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `${describeAction(action)} timed out after ${Math.round(
          CONNECT_TIMEOUT_MS / 1000,
        )}s. The provider endpoint may be unreachable.`,
      })
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()

    const reader = new NdjsonReader({
      onFrame: frame => {
        const parsed = frame as Record<string, unknown>
        if (parsed.type === 'rayucode_connect_presets' && Array.isArray(parsed.presets)) {
          presets = parsed.presets as ConnectPresetView[]
          return
        }
        if (parsed.type === 'rayucode_attach_targets' && Array.isArray(parsed.targets)) {
          targets = parsed.targets as AttachTargetFrame[]
          return
        }
        if (parsed.type === 'rayucode_connect_result') {
          finish(
            parsed.ok === true
              ? {
                  ok: true,
                  presets,
                  targets,
                  inference: parsed.inference as InferenceSettingsView | undefined,
                  catalogue: Array.isArray(parsed.catalogue) ? parsed.catalogue as ModelOptionView[] : undefined,
                  models: Array.isArray(parsed.models)
                    ? (parsed.models as string[])
                    : undefined,
                  activeProviderId:
                    typeof parsed.activeProviderId === 'string'
                      ? parsed.activeProviderId
                      : undefined,
                  activeModel:
                    typeof parsed.activeModel === 'string' ? parsed.activeModel : undefined,
                }
              : {
                  ok: false,
                  error:
                    typeof parsed.error === 'string' ? parsed.error : 'unknown error',
                },
          )
        }
        // `rayucode_connect_progress` is intentionally not surfaced yet: the panel shows
        // its own step state, and a second progress channel would contradict it.
      },
      onError: error => {
        finish({ ok: false, error: `provider setup channel error: ${error.message}` })
      },
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => reader.push(chunk))
    child.stdout.on('end', () => reader.end())

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2_000)
    })

    child.on('error', err => {
      finish({
        ok: false,
        error: `could not start the provider setup helper: ${err.message}`,
      })
    })

    // Exiting without a result frame means the helper died. The stderr tail is the
    // difference between an actionable error and "it failed".
    child.on('close', code => {
      finish({
        ok: false,
        error:
          `${describeAction(action)} did not complete (helper exited with code ${code}).` +
          (stderrTail.trim() ? ` ${stderrTail.trim().slice(-400)}` : ''),
      })
    })
  })
}

/**
 * A human description of an action, for messages.
 *
 * Exists so no error path is ever tempted to stringify the action object, which would
 * put an API key into a message.
 */
function describeAction(action: ConnectAction): string {
  switch (action.action) {
    case 'attach-list':
      return 'Looking for running Rayu sessions'
    case 'models':
      return 'Refreshing available models'
    case 'list':
      return 'Loading the provider list'
    case 'validate':
      return `Checking credentials for ${action.providerId}`
    case 'save':
      return `Saving ${action.providerId}`
  }
}
