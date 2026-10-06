/**
 * Model-catalogue refreshes for the panel: which conversation and model each one answers
 * for, and keeping concurrent requests from answering each other.
 *
 * A refresh runs the `--rayucode-connect models` helper, which reports the provider's
 * model list plus the inference CAPABILITIES (effort support and levels, thinking) of ONE
 * model. With several open conversations on different models, three rules keep that
 * answer where it belongs:
 *
 *  1. The conversation is captured by the CALLER, at the moment the user acts. Looking it
 *     up after an await (a `set_model` round trip, an earlier refresh) could hand one
 *     conversation's capabilities — and its loading spinner — to another.
 *  2. Every write lands on that conversation, never on whichever is on screen when the
 *     helper returns. Writing through "the current one" is what left a conversation the
 *     user switched away from stuck on `loading: true`.
 *  3. An explicit model choice never shares a refresh that is already running for
 *     something else; it queues behind it. Only an identical implicit request (same
 *     conversation, no explicit model) shares the one in flight.
 *
 * The answer's effort/thinking CHOICES are not taken at all — see
 * `ChatSession.applyInitialInference`.
 *
 * No `vscode` import, so these rules are unit-testable (test/vscodeCatalogueRefresh.test.ts).
 */
import type { InferenceSettingsView } from '../../shared/inferenceSettings.js'
import type { ModelCatalogueView } from '../../shared/webviewProtocol.js'
import type { ConnectOutcome } from '../auth/providerSetup.js'

/** The model to ask about: the caller's explicit choice, else the conversation's own. */
export function catalogueRefreshModel(
  explicit: string | undefined,
  sessionRuntimeModel: string | null,
): string | undefined {
  return explicit ?? sessionRuntimeModel ?? undefined
}

/**
 * Whether the helper's inference is about the model that was asked for.
 *
 * Defensive for explicit requests — the helper echoes the requested model today — but it
 * keeps an answer for a different model (say, a future fallback to the default) from ever
 * being applied. With nothing asked for, the helper answers for the SAVED default, which
 * is trusted only while it is still what is saved.
 */
export function catalogueRefreshMatches(
  requested: string | undefined,
  outcome: { activeModel?: string; activeProviderId?: string },
  persisted: { model: string | null; provider: string | null },
): boolean {
  if (requested !== undefined) return outcome.activeModel === requested
  return (
    persisted.provider === outcome.activeProviderId && persisted.model === outcome.activeModel
  )
}

/** What a refresh needs from a conversation. `ChatSession` satisfies it. */
export interface RefreshableSession {
  readonly runtimeModel: string | null
  availableModels: ModelCatalogueView | null
  applyInitialInference(value: InferenceSettingsView): void
}

export interface CatalogueRefreshDeps<S extends RefreshableSession> {
  /** The catalogue a conversation currently shows (`buildCatalogue` in extension.ts). */
  catalogueFor(session: S): ModelCatalogueView
  /** Run the helper for one model (or the saved default). */
  fetch(model: string | undefined): Promise<ConnectOutcome>
  /** The persisted default model, to vet an answer to an implicit request. */
  readPersistedModel(): { model: string | null; provider: string | null }
  /** Whether `session` is the conversation on screen right now. */
  isActive(session: S): boolean
  /** Show a catalogue in the panel. Only ever called for the conversation on screen. */
  post(catalogue: ModelCatalogueView): void
  /** Drop process-cached config, before and after the helper writes it. */
  invalidate(): void
  /** True once the extension is shutting down. */
  isDisposed(): boolean
  /** After each completed refresh: re-render the panel from host state. */
  onSettled(): void
}

/** Serialises refreshes and applies each answer to the conversation that asked. */
export class CatalogueRefresher<S extends RefreshableSession> {
  /** Every refresh starts after the previous one has finished. */
  private tail: Promise<void> = Promise.resolve()
  private latest: { run: Promise<void>; target: S; model: string | undefined } | null = null

  constructor(private readonly deps: CatalogueRefreshDeps<S>) {}

  /** Settles once every refresh requested so far has finished; null when idle. */
  get pending(): Promise<void> | null {
    return this.latest?.run ?? null
  }

  /**
   * Refresh for `target`, asking about `explicitModel` (or `target`'s own model).
   *
   * `target` must be captured where the user acted — see rule 1 in the file header.
   */
  refresh(target: S, explicitModel?: string): Promise<void> {
    const latest = this.latest
    if (
      latest &&
      latest.target === target &&
      latest.model === undefined &&
      explicitModel === undefined
    ) {
      return latest.run
    }
    const run = this.tail.then(() => this.runOnce(target, explicitModel))
    this.tail = run.catch(() => {})
    const entry = { run, target, model: explicitModel }
    this.latest = entry
    const settle = (): void => {
      if (this.latest === entry) this.latest = null
    }
    run.then(settle, settle)
    return run
  }

  private async runOnce(target: S, explicitModel: string | undefined): Promise<void> {
    const deps = this.deps
    if (deps.isDisposed()) return
    deps.invalidate()
    const requested = catalogueRefreshModel(explicitModel, target.runtimeModel)
    const previous = deps.catalogueFor(target)
    const pending: ModelCatalogueView = { ...previous, loading: true, error: null }
    target.availableModels = pending
    if (deps.isActive(target)) deps.post(pending)

    let outcome: ConnectOutcome
    try {
      outcome = await deps.fetch(requested)
    } catch (cause) {
      // The helper reports its own failures as outcomes; this covers a spawn that threw,
      // which would otherwise leave the list on `loading: true` forever.
      outcome = { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
    if (deps.isDisposed()) return
    deps.invalidate()
    if (outcome.inference && catalogueRefreshMatches(requested, outcome, deps.readPersistedModel())) {
      target.applyInitialInference(outcome.inference)
    }
    target.availableModels = {
      options: outcome.catalogue ?? previous.options,
      loading: false,
      error: outcome.ok ? null : outcome.error ?? 'Could not refresh models.',
    }
    deps.onSettled()
  }
}
