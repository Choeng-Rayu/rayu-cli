import type { InferenceSettingsView } from './inferenceSettings.js'
import type { ModelOptionView } from './webviewProtocol.js'
/**
 * The provider-setup (`/connect`) child protocol.
 *
 * Shared by the two ends of an in-panel provider connection:
 *
 *   src/entrypoints/vscodeHost.ts             the child, which does the work
 *   src/vscode/host/auth/providerSetup.ts     the extension host, which spawns it
 *
 * ── WHY THIS RUNS IN THE ENGINE CHILD AT ALL ───────────────────────────────────
 *
 * Provider setup is not just a config write. Saving a provider has to be followed by
 * the same post-authentication refresh the CLI performs — entitlements, the hosted
 * provider record, model catalogues, dependent caches — or the panel ends up with a
 * provider that is written to disk but not usable in the running process.
 *
 * Those services (`rayuEntitlements`, `rayuHostedProvider`, `rayuLogin`) each pull
 * ~19 MB of the engine graph including React, because they reach `utils/log.ts` via
 * `execFileNoThrow`. Importing any of them into `extension.js` would blow the host
 * bundle budget twelve times over. The rule established for login applies unchanged:
 * if a needed import blows the budget, move the WORK into the engine child rather
 * than raising the ceiling.
 *
 * ── NOTHING HERE MAY IMPORT ANYTHING ───────────────────────────────────────────
 *
 * Same reason as `loginProtocol.ts`: `vscodeHost.ts` has top-level side effects and
 * its graph is the whole engine, so the contract cannot live beside the code that
 * reads it.
 */

/**
 * Switches the engine bundle from "run the engine" to "perform one provider-setup
 * action and exit".
 *
 * A flag rather than a separate entrypoint, so `build:vscode` keeps emitting one
 * engine bundle. The action itself is a JSON argument that follows this flag.
 */
export const CONNECT_FLAG = '--rayucode-connect'

/** Provider kinds the setup surface understands, mirroring the CLI's `ProviderKind`. */
export type ConnectProviderKind = string

/**
 * A provider offered in the panel, derived from the CLI's own `PROVIDER_PRESETS`.
 *
 * Only presentation and input-requirement fields cross the boundary. Nothing here is a
 * credential.
 */
export interface ConnectPresetView {
  id: string
  label: string
  kind: ConnectProviderKind
  /** Fixed endpoint, when the preset has one. */
  baseURL?: string
  /** True when the user must type the endpoint (self-hosted, gateways, custom). */
  requiresBaseURL: boolean
  /** True when an API key is expected. False for OAuth/ADC presets and local endpoints. */
  requiresApiKey: boolean
  /**
   * True for presets authenticated by Google OAuth / Application Default Credentials
   * rather than a typed key. The panel routes these to the CLI instead of pretending a
   * key field would work.
   */
  requiresOAuth: boolean
  /** Environment variables the CLI already reads a key from, if any are set. */
  envKeyPresent: boolean
  defaultModel?: string
}

/**
 * A CLI session the panel could attach to, as reported by the child.
 *
 * ── THIS ONE CARRIES A CREDENTIAL ──────────────────────────────────────────────
 *
 * `ipcToken` authenticates every IPC frame, and holding it is sufficient to drive the
 * session. It crosses child → host because the HOST is the process that dials the socket,
 * so it cannot do its job without it. It stops there: `AttachableSessionView`, the shape
 * that reaches the webview, has no token field.
 */
export interface AttachTargetFrame {
  pid: number
  sessionId: string
  name?: string
  cwd: string
  status?: string
  waitingFor?: string
  startedAt: number
  ipcAddress: string
  ipcToken: string
}

/** Actions the host asks the child to perform. Exactly one per child process. */
export type ConnectAction =
  /**
   * Enumerate attachable CLI sessions.
   *
   * Runs in the child because the session registry reader (`concurrentSessions.ts`)
   * costs 18.5 MB in the host bundle — measured, against a 1.6 MB budget. The resulting
   * IPC connection is only 8 KB, so ONLY discovery moves; the live socket stays in the
   * host where the panel can use it directly.
   */
  | { action: 'attach-list'; cwd: string }
  /** Enumerate the presets. No credentials involved. */
  | { action: 'list' }
  /** Refresh the same live catalogs the CLI model picker refreshes. */
  | { action: 'models' }
  /**
   * Verify a credential by asking the provider for its model list, and return the
   * models on success. The same call answers "is this key valid" and "what can it
   * serve", so there is no second round-trip and no chance of the two disagreeing.
   */
  | {
      action: 'validate'
      providerId: string
      apiKey?: string
      baseURL?: string
    }
  /**
   * Persist the provider, make it active, and run the post-authentication refresh.
   */
  | {
      action: 'save'
      providerId: string
      apiKey?: string
      baseURL?: string
      model?: string
    }

/**
 * Frames the connect child writes to stdout, one JSON object per line.
 *
 * The `rayucode_connect_` prefix keeps them distinguishable from engine protocol frames
 * and from login frames on a shared stream.
 *
 * ── NO FRAME EVER CARRIES A CREDENTIAL ─────────────────────────────────────────
 *
 * Keys travel host → child only, and only as a process argument to a child the host
 * spawned itself. Nothing sends one back, so a key cannot reach the webview, the
 * transcript, persisted webview state, or a log line.
 */
export type ConnectFrame =
  | { type: 'rayucode_connect_presets'; presets: ConnectPresetView[] }
  | { type: 'rayucode_attach_targets'; targets: AttachTargetFrame[] }
  /** Progress narration for a step that can take seconds. Never contains a key. */
  | { type: 'rayucode_connect_progress'; message: string }
  | {
      type: 'rayucode_connect_result'
      ok: true
      /** Models the provider reported, when the action discovered them. */
      models?: string[]
      catalogue?: ModelOptionView[]
      inference?: InferenceSettingsView
      /** The provider that ended up active, for the panel to display. */
      activeProviderId?: string
      activeModel?: string
    }
  | { type: 'rayucode_connect_result'; ok: false; error: string }
