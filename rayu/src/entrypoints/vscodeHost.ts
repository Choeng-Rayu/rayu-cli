/**
 * `vscodeHost` — the engine entrypoint the Rayucode VS Code extension spawns.
 *
 * NOTE: deliberately NO `#!/usr/bin/env node` here. `scripts/build-vscode.ts`
 * adds it as the bundle banner, exactly as the CLI build does for `cli.tsx`;
 * having it in both places emits it twice and Node then fails to parse the file
 * ("Invalid or unexpected token" on line 2).
 *
 * WHY THIS EXISTS
 * The extension previously spawned the published CLI binary and hand-assembled
 * the headless flags itself (`rayucode/packages/core/src/cli/agentProcess.ts`).
 * That made the flag set a contract duplicated in another repository: the
 * extension had to know that `stream-json` output requires `--verbose`, that
 * input must also be `stream-json`, and that `--print` is what selects headless
 * mode at all. Any change to that contract broke a consumer that could not see
 * it. This entrypoint owns the contract on the engine side, where it belongs.
 *
 * WHY IT DELEGATES INSTEAD OF REBUILDING
 * The headless setup — the tool registry, the ~98 slash commands, skills, MCP
 * clients, agent definitions, app state — is assembled in `src/main.tsx` before
 * it calls `runHeadless()` (main.tsx:2681). Reassembling any of that here would
 * create a second, drifting definition of "what the engine can do", which is the
 * exact failure this whole migration exists to remove. So this file normalises
 * `process.argv` and hands off to the SAME `main()` that `cli.tsx` calls.
 *
 * The consequence is the property the extension needs: it gets every tool,
 * command, skill and MCP server the CLI has, because it is running the CLI's
 * code with a fixed set of flags — not a reimplementation.
 *
 * WHAT IT DOES NOT DO
 * No React, no Ink, no terminal UI. `--print` selects the headless path, so the
 * TUI is never constructed. Tool execution stays in THIS process, off the
 * extension host's thread, which is why the extension spawns it rather than
 * importing the engine: tools spawn processes, write files and reach native
 * dependencies, and `src/tools.ts` transitively reaches the React UI.
 *
 * Built by `scripts/build-vscode.ts` (stage 1, emitted as
 * `dist/vscode/engine.mjs` and staged into the VSIX) with the same
 * `sharedBuildOptions()` the CLI bundle uses — mandatory, because rayu is built
 * from partial source and several `require()`d modules only disappear when a
 * `--define` folds a branch to a constant.
 */
import { loadDotEnv } from '../utils/envUtils.js'
import {
  CONNECT_FLAG,
  type ConnectAction,
  type ConnectFrame,
} from '../vscode/shared/connectProtocol.js'
import { LOGIN_FLAG, type LoginFrame } from '../vscode/shared/loginProtocol.js'

// Load .env before anything else runs, matching cli.tsx. A workspace .env is how
// a developer points the engine at a local backend, and the extension forwards
// its own resolved environment on top.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
loadDotEnv()

// Corepack auto-pinning adds yarnpkg to package.json files it touches. Same
// guard cli.tsx installs.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0'

/**
 * The flags that define headless, bidirectional, streaming operation.
 *
 * `--verbose` is not optional: `print.ts` rejects `--output-format=stream-json`
 * without it ("When using --print, --output-format=stream-json requires
 * --verbose"). Encoding that here means a consumer cannot get it wrong.
 *
 * `--permission-prompt-tool stdio` is what makes permission requests REACH the
 * host, and its absence was a real bug. `getCanUseToolFn` in print.ts branches
 * three ways:
 *
 *   'stdio'    → structuredIO.createCanUseTool(), i.e. send a `can_use_tool`
 *                control request and wait for the host's decision;
 *   undefined  → decide LOCALLY via hasPermissionsToUseTool();
 *   <mcp tool> → delegate to a named MCP tool.
 *
 * The extension spawned the engine without it, so the engine took the `undefined`
 * branch and resolved every permission by itself. The panel then reported that a
 * tool needed permission while never being asked for one — the user saw "it needs
 * permission" and had nothing to approve. `stdio` is the value the SDK path forces
 * for exactly this reason (`options.sdkUrl ? 'stdio' : ...`).
 *
 * `--include-partial-messages` is what makes STREAMING happen at all, and its
 * absence was the same class of bug. The engine defaults it to FALSE
 * (`QueryEngine.ts:232`, `:1214`), and only emits `stream_event` frames when it is
 * set (`QueryEngine.ts:820`). Without it the webview's `appendPartial` path is dead
 * code: the answer arrives in one settled `assistant` message after the turn, so the
 * panel sits silent and then blinks the whole reply into place.
 *
 * It is safe to force here because `main.tsx:1783` rejects it unless `--print` and
 * `--output-format=stream-json` are both present — and this list already guarantees
 * both. A consumer cannot end up with an invalid combination.
 */
const REQUIRED_FLAGS = [
  '--print',
  '--input-format=stream-json',
  '--output-format=stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-prompt-tool=stdio',
] as const

/**
 * Merge the required flags into the caller's argv without duplicating them.
 *
 * Duplicates are avoided rather than tolerated: Commander accepts a repeated
 * boolean but a repeated `--output-format` would be ambiguous, and the extension
 * may legitimately pass its own `--model`, `--resume`, `--permission-mode` or
 * `--add-dir`, which must survive untouched.
 *
 * Exported for tests — the argv contract is the whole of this file's logic.
 */
export function buildHostArgv(passthrough: readonly string[]): string[] {
  const out = [...passthrough]
  for (const flag of REQUIRED_FLAGS) {
    const name = flag.split('=')[0] as string
    const already = out.some(arg => arg === name || arg.startsWith(`${name}=`))
    if (!already) out.push(flag)
  }
  return out
}

/**
 * Login mode.
 *
 * WHY LOGIN RUNS HERE AND NOT IN THE EXTENSION HOST
 * `loginRayu()` needs a loopback HTTP server, the `/cli/token` exchange, the
 * entitlements warm-up and the hosted-provider sync. Its import graph reaches
 * `utils/browser.ts` → `execFileNoThrow.ts` → `utils/log.ts`, which reach the
 * Anthropic SDK and the React UI: measured with the project's own build config at
 * 19.7 MB, against 448 KB for the session reader alone. Putting that in
 * `extension.js` would load twenty megabytes of unrenderable React into the
 * editor's extension host merely to open a URL.
 *
 * So the extension host spawns THIS bundle for the one-off login instead. It is a
 * short-lived child, the code already lives here, and the credential it writes is
 * the same shared `~/.rayu/rayu-auth.json` the CLI uses.
 *
 * The one part that MUST happen in the editor is opening the browser, because
 * `vscode.env.asExternalUri` is what makes a loopback callback reachable from a
 * local browser when the extension host is remote. So the URL is emitted on stdout
 * and the host opens it.
 *
 * The flag and frame shapes live in `src/vscode/shared/loginProtocol.ts` — a
 * dependency-free leaf — so the host can share the contract WITHOUT importing this
 * file, which has top-level side effects and a graph the size of the whole engine.
 */
function emitLoginFrame(frame: LoginFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

/**
 * Run the interactive login and report the outcome on stdout.
 *
 * `loginRayu` is imported dynamically so the module is only evaluated in login
 * mode. Its side effects — reading provider config, touching the entitlements
 * cache — have no business running when this bundle is spawned to serve a session.
 */
async function runLogin(): Promise<void> {
  const { loginRayu } = await import('../services/rayuAuth/rayuLogin.js')
  try {
    const result = await loginRayu({
      // The child must NOT open the browser: it would open one on whichever
      // machine the extension host runs on, which for a remote workspace is the
      // wrong machine entirely.
      openBrowserAutomatically: false,
      onAuthUrl: url => emitLoginFrame({ type: 'rayucode_login_url', url }),
    })
    emitLoginFrame({
      type: 'rayucode_login_result',
      ok: true,
      displayName: result.user?.displayName ?? null,
    })
  } catch (cause) {
    emitLoginFrame({
      type: 'rayucode_login_result',
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    })
    process.exitCode = 1
  }
}

/**
 * Perform one provider-setup action and exit.
 *
 * ── EVERYTHING HEAVY LIVES HERE, NOT IN THE EXTENSION HOST ─────────────────────
 *
 * `rayuConfig` and `rayuProviders` are imported dynamically for the same reason
 * `loginRayu` is: in session mode none of this should be evaluated at all. And they are
 * imported HERE rather than in `extension.ts` because the provider services reach
 * `utils/log.ts` and pull ~19 MB including React — twelve times the host bundle budget.
 *
 * ── VALIDATION AND DISCOVERY ARE THE SAME CALL ─────────────────────────────────
 *
 * `fetchProviderModels` both proves a credential works and reports what it can serve.
 * Doing them separately would mean two round-trips that can disagree, and a "valid key,
 * no models" state that is really just a stale second answer.
 */
/**
 * Provider kinds that never take a typed API key, because they authenticate by some
 * other means: the AWS credential chain, Google ADC, the Rayu session credential, or
 * their own device sign-in.
 */
const KEYLESS_PROVIDER_KINDS = new Set<string>([
  'bedrock',
  'vertex',
  'rayu-hosted',
  'kiro',
  'copilot',
])

async function runConnect(rawAction: string | undefined): Promise<void> {
  const emit = (frame: ConnectFrame): void => {
    process.stdout.write(`${JSON.stringify(frame)}\n`)
  }

  try {
    const action = parseConnectAction(rawAction)
    const providers = await import('../utils/rayuProviders.js')
    const config = await import('../utils/rayuConfig.js')

    if (action.action === 'models') {
      const { refreshModelPickerCatalog } = await import('../utils/model/refreshModelPickerCatalog.js')
      await refreshModelPickerCatalog()
      const { getProviderModelCatalogue } = await import('../utils/model/providerModelCatalogue.js')
      const active = config.getActiveProvider()
      const { resolveInferenceSettings } = await import('../utils/model/inferenceSettings.js')
      const { getInitialEffortSetting } = await import('../utils/effort.js')
      const model = config.getValidDefaultModel(active)
      emit({ type: 'rayucode_connect_result', ok: true,
        catalogue: getProviderModelCatalogue(),
        inference: model ? resolveInferenceSettings(model, getInitialEffortSetting()) : undefined,
        activeProviderId: active?.id,
        activeModel: config.getValidDefaultModel(active),
      })
      return
    }

    if (action.action === 'attach-list') {
      const { readSessionRecords } = await import('../utils/concurrentSessions.js')
      const records = await readSessionRecords()
      emit({
        type: 'rayucode_attach_targets',
        targets: records
          .filter(
            r =>
              r.cwd === action.cwd &&
              // Without both there is nothing to dial.
              !!r.ipcAddress &&
              !!r.ipcToken,
          )
          .map(r => ({
            pid: r.pid,
            sessionId: r.sessionId,
            name: r.name,
            cwd: r.cwd,
            status: r.status,
            waitingFor: r.waitingFor,
            startedAt: r.startedAt,
            ipcAddress: r.ipcAddress as string,
            ipcToken: r.ipcToken as string,
          }))
          .sort((a, b) => b.startedAt - a.startedAt),
      })
      emit({ type: 'rayucode_connect_result', ok: true })
      return
    }

    if (action.action === 'list') {
      emit({
        type: 'rayucode_connect_presets',
        presets: providers.PROVIDER_PRESETS.map(preset => ({
          id: preset.id,
          label: preset.label,
          kind: preset.kind,
          baseURL: preset.baseURL,
          requiresBaseURL: preset.promptBaseURL === true,
          // An OAuth/ADC preset has no key to type. Neither do the kinds that
          // authenticate by some other means entirely: `bedrock` uses the AWS
          // credential chain, `vertex` uses Application Default Credentials,
          // `rayu-hosted` uses the Rayu session credential, and `kiro`/`copilot` have
          // their own device sign-in. Showing a key field for those would ask for
          // something that is not used.
          requiresApiKey:
            preset.requiresOAuth !== true &&
            !KEYLESS_PROVIDER_KINDS.has(preset.kind),
          requiresOAuth: preset.requiresOAuth === true,
          // Reported so the panel can say a key is already available from the
          // environment instead of demanding one the CLI would not have asked for.
          envKeyPresent: (preset.envKeys ?? []).some(k => !!process.env[k]?.trim()),
          defaultModel: preset.defaultModel,
        })),
      })
      emit({ type: 'rayucode_connect_result', ok: true })
      return
    }

    const preset = providers.PROVIDER_PRESETS.find(p => p.id === action.providerId)
    if (!preset) {
      emit({
        type: 'rayucode_connect_result',
        ok: false,
        error: `Unknown provider "${action.providerId}".`,
      })
      process.exitCode = 1
      return
    }

    const candidate = {
      id: preset.id,
      kind: preset.kind,
      apiKey: action.apiKey?.trim() || undefined,
      baseURL: action.baseURL?.trim() || preset.baseURL,
      defaultModel: preset.defaultModel,
      smallFastModel: preset.smallFastModel,
    }

    if (action.action === 'validate') {
      emit({ type: 'rayucode_connect_progress', message: 'Checking credentials…' })
      const models = await config.fetchProviderModels(candidate as never)
      if (models.length === 0) {
        // ── AN EMPTY LIST IS AMBIGUOUS AND MUST NOT BE REPORTED AS SUCCESS ──────
        //
        // `fetchProviderModels` returns [] on ANY failure by design — its contract is
        // "preserve whatever catalogue is cached", so the caller only overwrites on a
        // non-empty result. That makes a REJECTED CREDENTIAL indistinguishable from a
        // provider that simply has no catalogue endpoint.
        //
        // Reporting that as valid would let a user paste a bad key, be told the
        // provider "does not publish a model list", save it, and then meet the auth
        // error on their first prompt — at which point it looks like a broken session
        // rather than a wrong key. So the empty case is classified explicitly.
        const status = await probeCredential(candidate)
        if (status === 'rejected') {
          emit({
            type: 'rayucode_connect_result',
            ok: false,
            error:
              'The provider rejected these credentials. Check the key and, if the ' +
              'provider needs one, the endpoint URL.',
          })
          process.exitCode = 1
          return
        }
        if (status === 'unreachable') {
          emit({
            type: 'rayucode_connect_result',
            ok: false,
            error:
              'Could not reach the provider endpoint. Check the URL and your network ' +
              'or proxy settings.',
          })
          process.exitCode = 1
          return
        }
        // 'no-catalogue' — reachable and not rejected, but it lists nothing. A real
        // and successful outcome; the panel offers the preset default instead.
        emit({
          type: 'rayucode_connect_result',
          ok: true,
          models: [],
          activeProviderId: preset.id,
        })
        return
      }
      emit({ type: 'rayucode_connect_result', ok: true, models })
      return
    }

    // action === 'save'
    emit({ type: 'rayucode_connect_progress', message: 'Saving provider…' })
    // setActive = true: connecting a provider from the panel means "use this one".
    config.upsertProvider(candidate as never, true)

    // Warm the model cache in the SAME process that just wrote the provider, so the
    // catalogue is on disk before the panel restarts its session engine. Doing it in
    // the background as the CLI does would race the restart.
    emit({ type: 'rayucode_connect_progress', message: 'Fetching model catalogue…' })
    let models: string[] = []
    try {
      models = await config.fetchProviderModels(candidate as never)
      if (models.length > 0) {
        const cfg = config.loadRayuConfig()
        const stored = cfg.providers.find(p => p.id === preset.id)
        if (stored) {
          stored.fetchedModels = models
          config.saveRayuConfig(cfg)
        }
      }
    } catch {
      // Best-effort cache warm-up, exactly as the CLI treats it. The provider is saved
      // and usable; /model can fetch live later.
    }

    const chosen = action.model?.trim() || preset.defaultModel
    if (chosen) config.setActiveProviderModel(preset.id, chosen)

    emit({
      type: 'rayucode_connect_result',
      ok: true,
      models,
      activeProviderId: preset.id,
      activeModel: chosen,
    })
  } catch (cause) {
    emit({
      type: 'rayucode_connect_result',
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    })
    process.exitCode = 1
  }
}

/**
 * Classify why a model-list fetch came back empty.
 *
 * Distinguishes the three cases the user needs to tell apart, using the HTTP status of a
 * direct `GET {baseURL}/models`:
 *
 *   'rejected'     — 401/403. The credential is wrong. This is the case that matters.
 *   'unreachable'  — no response at all: bad host, DNS, proxy, TLS.
 *   'no-catalogue' — reachable and not rejected. The provider genuinely lists nothing.
 *
 * Without a baseURL there is nothing to probe, so the benefit of the doubt goes to the
 * credential: reporting a failure we cannot demonstrate would block a working setup.
 */
async function probeCredential(candidate: {
  apiKey?: string
  baseURL?: string
}): Promise<'rejected' | 'unreachable' | 'no-catalogue'> {
  const base = candidate.baseURL?.trim()
  if (!base) return 'no-catalogue'

  const url = `${base.replace(/\/+$/, '')}/models`
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(candidate.apiKey
          ? {
              // Both spellings: OpenAI-compatible endpoints read Authorization,
              // Anthropic-compatible ones read x-api-key. Sending both costs nothing and
              // avoids a wrong-header 401 being misread as a wrong key.
              Authorization: `Bearer ${candidate.apiKey}`,
              'x-api-key': candidate.apiKey,
              'anthropic-version': '2023-06-01',
            }
          : {}),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (response.status === 401 || response.status === 403) return 'rejected'
    return 'no-catalogue'
  } catch {
    return 'unreachable'
  }
}

function parseConnectAction(raw: string | undefined): ConnectAction {
  if (!raw) throw new Error('No provider-setup action was supplied.')
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as ConnectAction).action !== 'string') {
    throw new Error('Malformed provider-setup action.')
  }
  return parsed as ConnectAction
}

async function main(): Promise<void> {
  const passthrough = process.argv.slice(2)

  // Login mode short-circuits before any engine setup: it must not build the tool
  // registry, connect MCP servers or read a transcript. None of that is needed to
  // sign in, all of it is slow, and any of it could fail independently.
  if (passthrough.includes(LOGIN_FLAG)) {
    await runLogin()
    return
  }

  // Provider setup short-circuits for the same reasons. It also must not inherit the
  // engine's provider resolution, since the whole point is to change it.
  const connectAt = passthrough.indexOf(CONNECT_FLAG)
  if (connectAt !== -1) {
    await runConnect(passthrough[connectAt + 1])
    return
  }

  // process.argv is [node, thisScript, ...args]; main() re-reads process.argv,
  // so the merged flags have to be written back into it rather than passed.
  process.argv = [
    process.argv[0] as string,
    process.argv[1] as string,
    ...buildHostArgv(passthrough),
  ]

  const { main: cliMain } = await import('../main.js')
  await cliMain()
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main()
