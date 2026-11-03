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
 * An API key travels host → child ONLY, on the stdin of a child this host spawned —
 * never in its argv, which every local user can read from the process table. No frame
 * carries one back, so a key cannot reach the webview, the transcript, persisted
 * webview state, or a log line. `describeAction()` exists so progress and error
 * reporting never has to stringify the action itself.
 */
import {
  CONNECT_FLAG,
  type AttachTargetFrame,
  type ConnectAction,
  type ConnectPresetView,
} from '../../shared/connectProtocol.js'
import {
  runEngineChild,
  stderrExcerpt,
  type EngineChildResult,
  type EngineLaunch,
} from '../engine/engineLaunch.js'

/**
 * Model-list fetches hit a provider's API over the network. Generous, because a slow
 * corporate proxy is common and a premature failure here looks like a bad key.
 */
const CONNECT_TIMEOUT_MS = 90_000

export interface ProviderSetupOptions {
  /** How to start the engine — see `engine/engineLaunch.ts`. */
  launch: EngineLaunch
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
  /** A caveat about `catalogue`, already user-facing. */
  notice?: string
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
export async function refreshProviderCatalogue(
  options: ProviderSetupOptions,
  model?: string,
): Promise<ConnectOutcome> {
  return runConnectChild(options, { action: 'models', model })
}

/**
 * Fetch the live image or video generation models for the chooser.
 *
 * In the child for the same reason as the chat catalogue: the media catalog
 * service would pull ~19 MB of the engine into the host bundle.
 */
export async function refreshMediaModelOptions(
  options: ProviderSetupOptions,
  mediaType: 'image' | 'video',
): Promise<ConnectOutcome> {
  return runConnectChild(options, { action: 'media-models', mediaType })
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

async function runConnectChild(
  options: ProviderSetupOptions,
  action: ConnectAction,
): Promise<ConnectOutcome> {
  let presets: ConnectPresetView[] | undefined
  let targets: AttachTargetFrame[] | undefined

  // ── THE ACTION GOES OVER STDIN, NEVER ARGV ───────────────────────────────────
  //
  // `validate` and `save` carry the user's API key. A process's argv is readable by
  // EVERY local user (`ps`, `/proc/<pid>/cmdline`) for as long as it runs, and these
  // helpers run for a network round-trip. Stdin is private to the two processes.
  const result = await runEngineChild<ConnectOutcome>(options.launch, {
    flag: CONNECT_FLAG,
    cwd: options.cwd,
    stdin: JSON.stringify(action),
    timeoutMs: CONNECT_TIMEOUT_MS,
    onFrame: parsed => {
      if (parsed.type === 'rayucode_connect_presets' && Array.isArray(parsed.presets)) {
        presets = parsed.presets as ConnectPresetView[]
        return undefined
      }
      if (parsed.type === 'rayucode_attach_targets' && Array.isArray(parsed.targets)) {
        targets = parsed.targets as AttachTargetFrame[]
        return undefined
      }
      // `rayucode_connect_progress` is intentionally not surfaced yet: the panel shows
      // its own step state, and a second progress channel would contradict it.
      if (parsed.type !== 'rayucode_connect_result') return undefined
      return connectOutcomeFrom(parsed, presets, targets)
    },
  })

  return result.kind === 'done' ? result.value : connectFailure(action, result)
}

/** The user-facing outcome for a helper that ended without a result frame. */
function connectFailure(
  action: ConnectAction,
  result: Exclude<EngineChildResult<ConnectOutcome>, { kind: 'done' }>,
): ConnectOutcome {
  switch (result.kind) {
    case 'timeout':
      return {
        ok: false,
        error: `${describeAction(action)} timed out after ${Math.round(
          CONNECT_TIMEOUT_MS / 1000,
        )}s. The provider endpoint may be unreachable.`,
      }
    case 'protocol-error':
      return { ok: false, error: `provider setup channel error: ${result.message}` }
    case 'spawn-error':
      return { ok: false, error: `could not start the provider setup helper: ${result.message}` }
    case 'exited':
    case 'aborted':
      // Exiting without a result frame means the helper died. The stderr tail is the
      // difference between an actionable error and "it failed".
      return {
        ok: false,
        error:
          `${describeAction(action)} did not complete (helper exited with code ${
            result.kind === 'exited' ? result.code : null
          }).${result.kind === 'exited' ? stderrExcerpt(result.stderrTail) : ''}`,
      }
  }
}

/** The outcome a `rayucode_connect_result` frame reports. */
function connectOutcomeFrom(
  parsed: Record<string, unknown>,
  presets: ConnectPresetView[] | undefined,
  targets: AttachTargetFrame[] | undefined,
): ConnectOutcome {
  if (parsed.ok !== true) {
    return {
      ok: false,
      error: typeof parsed.error === 'string' ? parsed.error : 'unknown error',
    }
  }
  return {
    ok: true,
    presets,
    targets,
    inference: parsed.inference as InferenceSettingsView | undefined,
    catalogue: Array.isArray(parsed.catalogue) ? parsed.catalogue as ModelOptionView[] : undefined,
    models: Array.isArray(parsed.models) ? (parsed.models as string[]) : undefined,
    activeProviderId:
      typeof parsed.activeProviderId === 'string' ? parsed.activeProviderId : undefined,
    activeModel: typeof parsed.activeModel === 'string' ? parsed.activeModel : undefined,
    notice: typeof parsed.notice === 'string' ? parsed.notice : undefined,
  }
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
    case 'media-models':
      return `Loading ${action.mediaType} generation models`
    case 'list':
      return 'Loading the provider list'
    case 'validate':
      return `Checking credentials for ${action.providerId}`
    case 'save':
      return `Saving ${action.providerId}`
  }
}
