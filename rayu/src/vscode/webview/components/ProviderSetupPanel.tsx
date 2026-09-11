/**
 * In-panel provider setup — the editor's `/connect`.
 *
 * ── THE API KEY IS WRITE-ONLY ──────────────────────────────────────────────────
 *
 * The key lives in local component state, is sent once, and is never read back from
 * host state. `ProviderSetupView` has no field that could hold one, so a key cannot end
 * up in persisted webview state, a diagnostic, or the transcript. The input is
 * `type="password"` and `autoComplete="off"` so the editor's own webview persistence and
 * the browser credential manager have nothing to capture either.
 *
 * ── VALIDATE THEN SAVE, AS TWO STEPS ───────────────────────────────────────────
 *
 * Saving straight away would write a provider that may not work and switch the session
 * onto it, so the first failure would appear as a broken session rather than a rejected
 * key. Validating first also produces the model list, so the user picks a real model
 * instead of typing one.
 */
import { useState } from 'react'

import type {
  ProviderPresetView,
  ProviderSetupView,
} from '../../shared/webviewProtocol.js'

export interface ProviderSetupPanelProps {
  setup: ProviderSetupView
  onClose: () => void
  onValidate: (providerId: string, apiKey?: string, baseURL?: string) => void
  onSave: (
    providerId: string,
    apiKey?: string,
    baseURL?: string,
    model?: string,
  ) => void
}

export function ProviderSetupPanel({
  setup,
  onClose,
  onValidate,
  onSave,
}: ProviderSetupPanelProps): JSX.Element | null {
  const [providerId, setProviderId] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [query, setQuery] = useState('')

  if (!setup.open) return null

  const preset = setup.presets?.find(p => p.id === providerId) ?? null
  const validated = setup.discoveredModels !== null

  function selectPreset(next: ProviderPresetView): void {
    setProviderId(next.id)
    // Clearing on switch is deliberate: a key typed for one provider is not a key for
    // another, and carrying it over invites saving the wrong credential.
    setApiKey('')
    setBaseURL(next.baseURL ?? '')
    setModel(next.defaultModel ?? '')
  }

  const canValidate =
    !!preset &&
    !setup.busy &&
    (!preset.requiresApiKey || apiKey.trim().length > 0 || preset.envKeyPresent) &&
    (!preset.requiresBaseURL || baseURL.trim().length > 0)

  return (
    <div className="rc-setup" role="region" aria-label="Connect a provider">
      <div className="rc-setup-head">
        <h2 className="rc-setup-title">Connect a provider</h2>
        <button type="button" className="rc-icon-button" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {setup.error ? (
        <p className="rc-setup-error" role="alert">
          {setup.error}
        </p>
      ) : null}

      {/* undefined = still loading; [] = loaded and there are none. */}
      {setup.presets === undefined ? (
        <p className="rc-dropdown-empty">Loading providers…</p>
      ) : setup.presets.length === 0 ? (
        <p className="rc-dropdown-empty">No providers are available.</p>
      ) : !preset ? (
        <>
          <input
            className="rc-dropdown-search"
            type="text"
            placeholder="Search providers…"
            aria-label="Search providers"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <ul className="rc-dropdown-list" role="listbox">
            {setup.presets
              .filter(p =>
                !query.trim()
                  ? true
                  : `${p.label} ${p.id}`.toLowerCase().includes(query.toLowerCase()),
              )
              .map(p => (
                <li key={p.id} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="rc-dropdown-item"
                    onClick={() => selectPreset(p)}
                  >
                    <span className="rc-dropdown-label">{p.label}</span>
                    <span className="rc-dropdown-detail">
                      {p.requiresOAuth
                        ? 'Browser sign-in'
                        : p.envKeyPresent
                          ? 'API key found in environment'
                          : p.requiresApiKey
                            ? 'API key'
                            : 'Uses existing credentials'}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </>
      ) : (
        <div className="rc-setup-form">
          <button
            type="button"
            className="rc-setup-back"
            onClick={() => setProviderId(null)}
          >
            ← All providers
          </button>

          <p className="rc-setup-chosen">{preset.label}</p>

          {/* An OAuth provider cannot be completed with a typed key. Saying so and
              pointing at the terminal is honest; offering a key field would not be. */}
          {preset.requiresOAuth ? (
            <p className="rc-setup-note">
              This provider signs in through your browser with Google credentials. Run{' '}
              <code>rayu</code> and use <code>/connect</code> in the terminal to complete
              it — the extension will pick up the connection automatically.
            </p>
          ) : (
            <>
              {preset.requiresBaseURL ? (
                <label className="rc-setup-label">
                  Endpoint URL
                  <input
                    className="rc-setup-input"
                    type="url"
                    value={baseURL}
                    placeholder="https://…"
                    onChange={e => setBaseURL(e.target.value)}
                  />
                </label>
              ) : null}

              {preset.requiresApiKey ? (
                <label className="rc-setup-label">
                  API key
                  <input
                    className="rc-setup-input"
                    type="password"
                    /* Nothing should offer to remember this. */
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    placeholder={
                      preset.envKeyPresent
                        ? 'Leave blank to use the environment variable'
                        : 'Paste your key'
                    }
                    onChange={e => setApiKey(e.target.value)}
                  />
                  <span className="rc-setup-hint">
                    Stored by the Rayu CLI in your local configuration. It is never sent
                    anywhere except to the provider.
                  </span>
                </label>
              ) : (
                <p className="rc-setup-note">
                  This provider uses credentials already available on this machine, so no
                  key is needed.
                </p>
              )}

              {validated ? (
                <label className="rc-setup-label">
                  Model
                  {setup.discoveredModels && setup.discoveredModels.length > 0 ? (
                    <select
                      className="rc-setup-input"
                      value={model}
                      onChange={e => setModel(e.target.value)}
                    >
                      {setup.discoveredModels.map(m => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <input
                        className="rc-setup-input"
                        type="text"
                        value={model}
                        placeholder={preset.defaultModel ?? 'Model id'}
                        onChange={e => setModel(e.target.value)}
                      />
                      {/* An empty list after a SUCCESSFUL check means the provider has no
                          list endpoint — not that the credential failed. */}
                      <span className="rc-setup-hint">
                        This provider does not publish a model list. Its default will be
                        used unless you enter one.
                      </span>
                    </>
                  )}
                </label>
              ) : null}

              <div className="rc-setup-actions">
                {!validated ? (
                  <button
                    type="button"
                    className="rc-button"
                    disabled={!canValidate}
                    onClick={() =>
                      onValidate(
                        preset.id,
                        apiKey.trim() || undefined,
                        baseURL.trim() || undefined,
                      )
                    }
                  >
                    {setup.busy ? (setup.busyMessage ?? 'Working…') : 'Check credentials'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="rc-button"
                    disabled={setup.busy}
                    onClick={() =>
                      onSave(
                        preset.id,
                        apiKey.trim() || undefined,
                        baseURL.trim() || undefined,
                        model.trim() || undefined,
                      )
                    }
                  >
                    {setup.busy
                      ? (setup.busyMessage ?? 'Working…')
                      : 'Connect and use this provider'}
                  </button>
                )}
              </div>

              {validated && !setup.busy ? (
                <p className="rc-setup-hint">
                  Connecting starts a new conversation, because the running session is
                  bound to the provider it started with.
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}
