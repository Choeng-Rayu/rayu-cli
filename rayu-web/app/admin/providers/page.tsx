'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CardSkeleton,
  ConfirmDialog,
  Field,
  Panel,
  SectionHeader,
} from '../../../components/admin/ui'
import { gatewayUrl } from '../../../lib/config'
import { formatContextWindow, parseContextWindow } from '../contextWindow'
import { useAdmin } from '../AdminProvider'
import {
  HostedModel,
  PROVIDER_AUTH_SCHEMES,
  PROVIDER_FORMAT_LABELS,
  PROVIDER_FORMATS,
  Provider,
  ProviderAuthScheme,
  ProviderFormat,
  ProviderHealth,
  ProviderKeyView,
  ProviderTestChecks,
  ProviderTestResult,
} from '../types'

/**
 * Providers — provider-first: a provider owns its API keys and its models.
 *
 * The old page was field-first (one flat form per provider, keys living in the
 * gateway's environment, models on a separate page). That made the common task —
 * "add a provider and start serving a model" — span two screens and a deploy.
 *
 * Everything here is nested under the provider it belongs to, because that is the
 * unit an admin actually thinks in: this upstream, these credentials, these
 * models. Keys are masked and write-only; the only way to know whether one works
 * is to ASK THE GATEWAY, which is what every Test button does (a real 1-token
 * request through the production adapter, charged to nobody).
 */

type ProviderDraft = Omit<Provider, 'id' | 'modelCount'>

const BLANK_PROVIDER: ProviderDraft = {
  name: '',
  label: '',
  format: 'openai_chat',
  baseUrl: '',
  endpointPath: null,
  authScheme: 'bearer',
  supportsReasoning: false,
  supportsImage: false,
  enabled: true,
}

// Mirrors the backend's FORMAT_DEFAULTS so the form previews what the server will
// fill in when the path/auth fields are left blank.
const FORMAT_DEFAULTS: Record<
  ProviderFormat,
  { endpointPath: string | null; authScheme: ProviderAuthScheme }
> = {
  anthropic_messages: { endpointPath: '/anthropic/v1/messages', authScheme: 'x_api_key' },
  openai_chat: { endpointPath: '/v1/chat/completions', authScheme: 'bearer' },
  openai_responses: { endpointPath: '/v1/responses', authScheme: 'bearer' },
  genai: { endpointPath: null, authScheme: 'x_goog_api_key' },
  // {model} is replaced with the model's own id by the gateway at request time.
  bedrock_anthropic: { endpointPath: '/model/{model}/invoke', authScheme: 'bearer' },
}

interface ModelDraft {
  /** The provider's own model id — the single field an admin must get right. */
  upstreamModelId: string
  /** Rayu code, derived from the model id unless explicitly overridden. */
  code: string
  codeOverridden: boolean
  label: string
  contextWindow: number | null
  creditMultiplier: number
  outputCreditMultiplier: number
  cacheReadCreditMultiplier: number
  cacheWriteCreditMultiplier: number
  supportsReasoning: boolean
  supportsImage: boolean
  supportsTools: boolean
}

/** What a test is about: a provider, optionally narrowed to one model or one key. */
interface TestSubject {
  providerId: number
  modelCode?: string
  apiKeyId?: number
}

/** The Rayu code a draft will be saved under (derived unless overridden). */
function draftCode(d: ModelDraft): string {
  return (d.codeOverridden ? d.code : codeFromModelId(d.upstreamModelId)).trim()
}

function blankModel(p?: Provider): ModelDraft {
  return {
    upstreamModelId: '',
    code: '',
    codeOverridden: false,
    label: '',
    contextWindow: null,
    creditMultiplier: 1,
    outputCreditMultiplier: 1,
    // Absolute charge per 1M cached-read tokens (not a fraction of input), which
    // matches how the gateway bills a cache hit.
    cacheReadCreditMultiplier: 0.1,
    cacheWriteCreditMultiplier: 1,
    supportsReasoning: p?.supportsReasoning ?? false,
    supportsImage: p?.supportsImage ?? false,
    supportsTools: true,
  }
}

/**
 * A Rayu model code derived from the provider's model id: lowercase, and only
 * characters that are safe in a CLI argument and a URL path. The admin types the
 * id once; the code follows unless they open Advanced and set it themselves.
 */
function codeFromModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * What a provider must actually satisfy to be routable, per wire format.
 *
 * This exists because the failure it prevents is expensive and silent: an
 * endpoint that is not the provider's Messages/Completions URL answers "no such
 * model" for EVERY model id, so an admin spends their time editing model ids that
 * were never the problem. Stating the required shape up front — and the known
 * cases that CANNOT be expressed — is cheaper than any error message.
 */
const FORMAT_REQUIREMENTS: Record<ProviderFormat, string> = {
  anthropic_messages:
    'One fixed URL that accepts an Anthropic Messages POST, with the model in the request BODY ' +
    '(e.g. https://api.deepseek.com + /anthropic/v1/messages). Providers whose Anthropic endpoint ' +
    'puts the model in the PATH — notably AWS Bedrock (/model/{id}/invoke) — cannot be used with ' +
    'this format.',
  openai_chat:
    'An OpenAI-compatible POST /v1/chat/completions. Model ids are exactly as that endpoint\u2019s ' +
    'GET /v1/models lists them.',
  openai_responses: 'An OpenAI Responses API POST /v1/responses.',
  genai:
    'Google GenAI. The adapter builds a per-model URL from the base URL, so leave the endpoint path blank.',
  bedrock_anthropic:
    'AWS Bedrock, e.g. base URL https://bedrock-runtime.us-east-1.amazonaws.com with path ' +
    '/model/{model}/invoke and auth "bearer" (a Bedrock API key). {model} is replaced with the ' +
    'model\u2019s id, which must be an INFERENCE PROFILE id such as us.anthropic.claude-sonnet-4-6 — ' +
    'a bare foundation id is refused with \u201Con-demand throughput isn\u2019t supported\u201D. ' +
    'Note bedrock-mantle is a different, OpenAI-only endpoint and does not serve Claude.',
}

export default function ProvidersPage() {
  const { apiFetch, token } = useAdmin()
  const [providers, setProviders] = useState<Provider[]>([])
  const [keys, setKeys] = useState<Record<number, ProviderKeyView[]>>({})
  const [models, setModels] = useState<HostedModel[]>([])
  const [health, setHealth] = useState<Record<number, ProviderHealth>>({})
  const [healthError, setHealthError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  // Test results keyed by subject: `key:<id>` or `model:<code>`.
  const [tests, setTests] = useState<Record<string, ProviderTestResult>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [newKey, setNewKey] = useState<Record<number, { key: string; label: string }>>({})
  // Which keys have their Replace field open, and the secret typed so far. Kept
  // separate from the key list so a reload never resurrects typed plaintext.
  const [replaceOpen, setReplaceOpen] = useState<Record<number, boolean>>({})
  const [replaceSecret, setReplaceSecret] = useState<Record<number, string>>({})
  const [modelDraft, setModelDraft] = useState<Record<number, ModelDraft>>({})
  const [delProvider, setDelProvider] = useState<Provider | null>(null)
  const [delKey, setDelKey] = useState<{ provider: Provider; key: ProviderKeyView } | null>(null)
  const [delModel, setDelModel] = useState<HostedModel | null>(null)
  // The result of the LAST test, shown as a modal. A test is a deliberate act
  // with a real upstream call behind it, and its answer is several facts
  // (classification + which stage failed + the exact config that was used) —
  // easy to miss as a line of small text under a button, which is where admins
  // were missing it.
  const [testModal, setTestModal] = useState<ProviderTestResult | null>(null)

  const reload = useCallback(async () => {
    const [pRes, mRes] = await Promise.all([apiFetch('/admin/providers'), apiFetch('/admin/models')])
    let list: Provider[] = []
    if (pRes.ok) {
      list = (await pRes.json()) as Provider[]
      setProviders(list)
    }
    if (mRes.ok) setModels((await mRes.json()) as HostedModel[])
    setLoaded(true)

    // Keys come from the backend MASKED (it never returns a secret). Whether a key
    // actually WORKS is a different question, answered only by the gateway.
    const entries = await Promise.all(
      list.map(async (p) => {
        const res = await apiFetch(`/admin/providers/${p.name}/keys`)
        return [p.id, res.ok ? ((await res.json()) as ProviderKeyView[]) : []] as const
      }),
    )
    setKeys(Object.fromEntries(entries))

    if (!token) return
    try {
      const h = await fetch(gatewayUrl('/v1/_provider-health'), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!h.ok) {
        setHealthError(`Gateway health unavailable (${h.status})`)
        return
      }
      const data = (await h.json()) as { providers: ProviderHealth[] }
      setHealth(Object.fromEntries(data.providers.map((p) => [p.providerId, p])))
      setHealthError('')
    } catch {
      setHealthError('Gateway unreachable — live key status unknown')
    }
  }, [apiFetch, token])

  useEffect(() => {
    if (token) void reload()
  }, [token, reload])

  const modelsFor = useMemo(() => {
    const out = new Map<number, HostedModel[]>()
    for (const m of models) {
      const list = out.get(m.providerId) ?? []
      list.push(m)
      out.set(m.providerId, list)
    }
    return out
  }, [models])

  function working(id: string, v: boolean) {
    setBusy((x) => ({ ...x, [id]: v }))
  }
  function say(id: string, text: string) {
    setMsg((x) => ({ ...x, [id]: text }))
  }
  function patchProvider(name: string, patch: Partial<Provider>) {
    setProviders((prev) => prev.map((p) => (p.name === name ? { ...p, ...patch } : p)))
  }
  function patchModel(code: string, patch: Partial<HostedModel>) {
    setModels((prev) => prev.map((m) => (m.code === code ? { ...m, ...patch } : m)))
  }
  function draftFor(p: Provider): ModelDraft {
    return modelDraft[p.id] ?? blankModel(p)
  }
  function patchDraft(p: Provider, patch: Partial<ModelDraft>) {
    setModelDraft((prev) => ({ ...prev, [p.id]: { ...draftFor(p), ...patch } }))
  }

  /**
   * Run a real test through the gateway. `subject` is what the UI is asking about
   * (a key or a model) so the result lands next to the row that triggered it.
   */
  async function runTest(
    subject: string,
    body: TestSubject,
  ): Promise<ProviderTestResult | null> {
    if (!token) return null
    working(subject, true)
    try {
      const res = await fetch(gatewayUrl('/v1/_provider-test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
        const detail = err.error ?? err.message ?? `HTTP ${res.status}`
        say(subject, `Test failed: ${detail}`)
        // The gateway refused to even run the test (not admin, unknown provider,
        // rate limited, …). That is still a result the admin needs to see.
        setTestModal({
          ok: false,
          classification: 'upstream_error',
          message: `The gateway did not run the test: ${detail}`,
          checks: { reachable: null, keyAccepted: null, modelAccepted: null },
          latencyMs: 0,
          providerName: '',
          format: '',
          endpoint: '',
        })
        return null
      }
      const result = (await res.json()) as ProviderTestResult
      setTests((t) => ({ ...t, [subject]: result }))
      setTestModal(result)
      say(subject, '')
      return result
    } catch {
      say(subject, 'Gateway unreachable — cannot test from here.')
      return null
    } finally {
      working(subject, false)
    }
  }

  // --- Provider ---------------------------------------------------------------

  async function saveProvider(p: Provider) {
    working(`prov:${p.name}`, true)
    const res = await apiFetch(`/admin/providers/${p.name}`, {
      method: 'PATCH',
      body: JSON.stringify({
        label: p.label,
        format: p.format,
        baseUrl: p.baseUrl,
        endpointPath: p.endpointPath === '' ? null : p.endpointPath,
        authScheme: p.authScheme,
        supportsReasoning: p.supportsReasoning,
        supportsImage: p.supportsImage,
        enabled: p.enabled,
      }),
    })
    say(`prov:${p.name}`, res.ok ? 'Saved.' : await errorText(res))
    working(`prov:${p.name}`, false)
    if (res.ok) await reload()
  }

  async function removeProvider(p: Provider) {
    const res = await apiFetch(`/admin/providers/${p.name}`, { method: 'DELETE' })
    setDelProvider(null)
    if (!res.ok) say(`prov:${p.name}`, await errorText(res))
    await reload()
  }

  // --- Keys -------------------------------------------------------------------

  async function addKey(p: Provider) {
    const draft = newKey[p.id] ?? { key: '', label: '' }
    if (!draft.key.trim()) return
    working(`newkey:${p.id}`, true)
    const res = await apiFetch(`/admin/providers/${p.name}/keys`, {
      method: 'POST',
      body: JSON.stringify({ key: draft.key.trim(), label: draft.label.trim() || undefined }),
    })
    if (!res.ok) {
      say(`newkey:${p.id}`, await errorText(res))
      working(`newkey:${p.id}`, false)
      return
    }
    const created = (await res.json()) as ProviderKeyView
    // Clear the plaintext from component state the moment it is stored.
    setNewKey((x) => ({ ...x, [p.id]: { key: '', label: '' } }))
    say(`newkey:${p.id}`, 'Key added.')
    working(`newkey:${p.id}`, false)
    await reload()
    // Test immediately: an admin pasting a key wants to know NOW whether it works,
    // not the next time a user hits the model.
    await runTest(`key:${created.id}`, { providerId: p.id, apiKeyId: created.id })
  }

  async function replaceKey(p: Provider, k: ProviderKeyView) {
    const secret = (replaceSecret[k.id] ?? '').trim()
    if (!secret) return
    working(`key:${k.id}`, true)
    const res = await apiFetch(`/admin/providers/${p.name}/keys/${k.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ key: secret }),
    })
    say(`key:${k.id}`, res.ok ? 'Replaced.' : await errorText(res))
    setReplaceSecret((x) => ({ ...x, [k.id]: '' }))
    setReplaceOpen((x) => ({ ...x, [k.id]: false }))
    working(`key:${k.id}`, false)
    if (res.ok) {
      await reload()
      await runTest(`key:${k.id}`, { providerId: p.id, apiKeyId: k.id })
    }
  }

  async function toggleKey(p: Provider, k: ProviderKeyView) {
    working(`key:${k.id}`, true)
    const res = await apiFetch(`/admin/providers/${p.name}/keys/${k.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !k.enabled }),
    })
    if (!res.ok) say(`key:${k.id}`, await errorText(res))
    working(`key:${k.id}`, false)
    await reload()
  }

  async function removeKey(p: Provider, k: ProviderKeyView) {
    const res = await apiFetch(`/admin/providers/${p.name}/keys/${k.id}`, { method: 'DELETE' })
    setDelKey(null)
    if (!res.ok) say(`key:${k.id}`, await errorText(res))
    await reload()
  }

  // --- Models -----------------------------------------------------------------

  async function addModel(p: Provider) {
    const d = draftFor(p)
    const code = (d.codeOverridden ? d.code : codeFromModelId(d.upstreamModelId)).trim()
    if (!d.upstreamModelId.trim() || !code) return
    working(`newmodel:${p.id}`, true)
    const res = await apiFetch('/admin/models', {
      method: 'POST',
      body: JSON.stringify({
        code,
        label: d.label.trim() || d.upstreamModelId.trim(),
        providerId: p.id,
        upstreamModelId: d.upstreamModelId.trim(),
        contextWindow: d.contextWindow,
        creditMultiplier: d.creditMultiplier,
        outputCreditMultiplier: d.outputCreditMultiplier,
        cacheReadCreditMultiplier: d.cacheReadCreditMultiplier,
        cacheWriteCreditMultiplier: d.cacheWriteCreditMultiplier,
        supportsReasoning: d.supportsReasoning,
        supportsImage: d.supportsImage,
        supportsTools: d.supportsTools,
        // Saved DISABLED, then enabled only if the test passes: a model nobody has
        // proven should never be offered to users.
        enabled: false,
      }),
    })
    if (!res.ok) {
      say(`newmodel:${p.id}`, await errorText(res))
      working(`newmodel:${p.id}`, false)
      return
    }
    setModelDraft((x) => ({ ...x, [p.id]: blankModel(p) }))
    working(`newmodel:${p.id}`, false)
    await reload()

    const result = await runTest(`model:${code}`, { providerId: p.id, modelCode: code })
    if (result?.ok) {
      await apiFetch(`/admin/models/${code}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      })
      say(`newmodel:${p.id}`, 'Model added, tested, and enabled.')
      await reload()
    } else {
      say(
        `newmodel:${p.id}`,
        'Model added but left DISABLED — the test did not pass. Fix it and test again.',
      )
    }
  }

  async function saveModel(m: HostedModel) {
    working(`model:${m.code}`, true)
    const res = await apiFetch(`/admin/models/${m.code}`, {
      method: 'PATCH',
      body: JSON.stringify({
        label: m.label,
        upstreamModelId: m.upstreamModelId,
        contextWindow: m.contextWindow,
        creditMultiplier: m.creditMultiplier,
        outputCreditMultiplier: m.outputCreditMultiplier,
        cacheReadCreditMultiplier: m.cacheReadCreditMultiplier ?? 0,
        cacheWriteCreditMultiplier: m.cacheWriteCreditMultiplier ?? m.creditMultiplier,
        supportsReasoning: m.supportsReasoning,
        supportsImage: m.supportsImage,
        supportsTools: m.supportsTools,
        enabled: m.enabled,
      }),
    })
    say(`model:${m.code}`, res.ok ? 'Saved.' : await errorText(res))
    working(`model:${m.code}`, false)
    if (res.ok) await reload()
  }

  async function removeModel(m: HostedModel) {
    const res = await apiFetch(`/admin/models/${m.code}`, { method: 'DELETE' })
    setDelModel(null)
    if (!res.ok) say(`model:${m.code}`, await errorText(res))
    await reload()
  }

  if (!loaded) return <CardSkeleton rows={5} />

  return (
    <div>
      <SectionHeader
        title="Providers"
        subtitle="Each provider owns its API keys and its models. Keys are encrypted on save and never shown again; the Test buttons ask the gateway to make a real 1-token request, which costs no credits."
      />

      {healthError && (
        <Panel>
          <div style={{ fontSize: '0.85rem', color: 'var(--red)' }}>{healthError}</div>
        </Panel>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {providers.map((p) => {
          const h = health[p.id]
          const pKeys = keys[p.id] ?? []
          const pModels = modelsFor.get(p.id) ?? []
          const liveByKeyID = new Map((h?.keys ?? []).map((k) => [k.id, k]))
          const open = expanded[`prov:${p.id}`] ?? false
          return (
            <Panel key={p.name}>
              {/* Header: identity + whether the gateway can route it right now */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <strong style={{ fontFamily: 'Orbitron, sans-serif' }}>
                  {p.label} <span style={{ opacity: 0.4 }}>({p.name})</span>
                </strong>
                <HealthBadge health={h} />
                <span style={{ fontSize: '0.78rem', opacity: 0.5 }}>
                  {PROVIDER_FORMAT_LABELS[p.format]} · {pKeys.length} key{pKeys.length === 1 ? '' : 's'} ·{' '}
                  {pModels.length} model{pModels.length === 1 ? '' : 's'}
                </span>
                <label style={{ marginLeft: 'auto', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => patchProvider(p.name, { enabled: e.target.checked })}
                  />{' '}
                  enabled
                </label>
                <button
                  className="btn-ghost"
                  style={{ fontSize: '0.8rem' }}
                  onClick={() => setExpanded((x) => ({ ...x, [`prov:${p.id}`]: !open }))}
                >
                  {open ? 'Hide connection' : 'Connection'}
                </button>
              </div>

              {h && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.78rem', opacity: 0.55 }}>
                  <code>{h.endpoint}</code>
                  {h.keyCount > 0 && ` · ${h.usableKeys}/${h.keyCount} keys usable`}
                  {h.configError && (
                    <div style={{ color: 'var(--red)', marginTop: 4 }}>Config rejected: {h.configError}</div>
                  )}
                </div>
              )}

              {/* Why a provider is switched off is not obvious from a badge: the
                  Add-provider flow deliberately leaves it disabled until a model
                  test passes, which otherwise reads as "the provider is broken". */}
              {!p.enabled && (
                <div
                  style={{
                    marginTop: '0.5rem',
                    fontSize: '0.78rem',
                    padding: '0.45rem 0.6rem',
                    borderRadius: 6,
                    border: '1px solid rgba(255,189,46,0.35)',
                    background: 'rgba(255,189,46,0.06)',
                  }}
                >
                  Disabled — users cannot see its models. New providers start disabled and are
                  switched on automatically once a model test passes; you can also tick{' '}
                  <strong>enabled</strong> above and save.
                </div>
              )}

              {/* Connection details — collapsed, because they are set once */}
              {open && (
                <div style={{ marginTop: '0.9rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                    <Field label="Label">
                      <input className="admin-input" style={{ width: '100%' }} value={p.label}
                        onChange={(e) => patchProvider(p.name, { label: e.target.value })} />
                    </Field>
                    <Field label="Provider format">
                      <select className="admin-input" style={{ width: '100%' }} value={p.format}
                        onChange={(e) => {
                          const format = e.target.value as ProviderFormat
                          patchProvider(p.name, {
                            format,
                            endpointPath: FORMAT_DEFAULTS[format].endpointPath,
                            authScheme: FORMAT_DEFAULTS[format].authScheme,
                          })
                        }}>
                        {PROVIDER_FORMATS.map((f) => (
                          <option key={f} value={f}>{PROVIDER_FORMAT_LABELS[f]}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Base URL">
                      <input className="admin-input" style={{ width: '100%' }} placeholder="https://api.example.com"
                        value={p.baseUrl} onChange={(e) => patchProvider(p.name, { baseUrl: e.target.value })} />
                    </Field>
                    <Field label="Endpoint path (blank = default)">
                      <input className="admin-input" style={{ width: '100%' }}
                        placeholder={FORMAT_DEFAULTS[p.format].endpointPath ?? 'built by the adapter'}
                        value={p.endpointPath ?? ''}
                        onChange={(e) => patchProvider(p.name, { endpointPath: e.target.value || null })} />
                    </Field>
                    <Field label="Auth scheme">
                      <select className="admin-input" style={{ width: '100%' }} value={p.authScheme}
                        onChange={(e) => patchProvider(p.name, { authScheme: e.target.value as ProviderAuthScheme })}>
                        {PROVIDER_AUTH_SCHEMES.map((a) => (
                          <option key={a} value={a}>{a}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div style={{ marginTop: '0.6rem', display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={p.supportsReasoning}
                        onChange={(e) => patchProvider(p.name, { supportsReasoning: e.target.checked })} />
                      reasoning by default for new models
                    </label>
                    <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={p.supportsImage}
                        onChange={(e) => patchProvider(p.name, { supportsImage: e.target.checked })} />
                      image input by default for new models
                    </label>
                  </div>
                  <p style={{ fontSize: '0.75rem', opacity: 0.5, margin: '0.6rem 0 0' }}>
                    <strong>{PROVIDER_FORMAT_LABELS[p.format]} needs:</strong>{' '}
                    {FORMAT_REQUIREMENTS[p.format]}
                  </p>
                  <div style={{ marginTop: '0.8rem', display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                    <button className="btn-primary" disabled={busy[`prov:${p.name}`]} onClick={() => saveProvider(p)}>
                      {busy[`prov:${p.name}`] ? 'Saving…' : 'Save connection'}
                    </button>
                    <button
                      className="btn-ghost"
                      style={{ color: 'var(--red)', borderColor: 'rgba(255,51,102,0.3)' }}
                      disabled={p.modelCount > 0}
                      title={p.modelCount > 0 ? 'Delete or move its models first' : undefined}
                      onClick={() => setDelProvider(p)}
                    >
                      Delete provider
                    </button>
                    <Msg text={msg[`prov:${p.name}`]} />
                  </div>
                </div>
              )}

              {/* API KEYS */}
              <Subheading>API keys</Subheading>
              {pKeys.length === 0 ? (
                <p style={{ fontSize: '0.82rem', opacity: 0.55, margin: '0 0 0.5rem' }}>
                  No key yet — this provider cannot serve any request until one is added.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {pKeys.map((k) => {
                    const live = liveByKeyID.get(k.id)
                    const status = live?.status ?? k.status
                    const test = tests[`key:${k.id}`]
                    return (
                      <div
                        key={k.id}
                        style={{
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: 8,
                          padding: '0.5rem 0.65rem',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                          <code style={{ fontSize: '0.82rem' }}>{k.maskedKey}</code>
                          {k.label && <span style={{ fontSize: '0.78rem', opacity: 0.6 }}>{k.label}</span>}
                          <KeyStatusBadge status={status} cooldownUntil={live?.cooldownUntil ?? k.cooldownUntil} />
                          {k.lastError && (
                            <span style={{ fontSize: '0.72rem', opacity: 0.5 }} title={k.lastError}>
                              last error: {k.lastError.slice(0, 40)}
                            </span>
                          )}
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.35rem' }}>
                            <button
                              className="btn-ghost"
                              style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                              disabled={busy[`key:${k.id}`]}
                              onClick={() => runTest(`key:${k.id}`, { providerId: p.id, apiKeyId: k.id })}
                            >
                              {busy[`key:${k.id}`] ? 'Testing…' : 'Test'}
                            </button>
                            <button
                              className="btn-ghost"
                              style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                              onClick={() => setReplaceOpen((x) => ({ ...x, [k.id]: !x[k.id] }))}
                            >
                              Replace
                            </button>
                            <button
                              className="btn-ghost"
                              style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                              onClick={() => toggleKey(p, k)}
                            >
                              {k.enabled ? 'Disable' : 'Enable'}
                            </button>
                            <button
                              className="btn-ghost"
                              style={{ fontSize: '0.75rem', padding: '3px 10px', color: 'var(--red)' }}
                              onClick={() => setDelKey({ provider: p, key: k })}
                            >
                              Delete
                            </button>
                          </div>
                        </div>

                        {replaceOpen[k.id] && (
                          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.45rem', alignItems: 'center' }}>
                            <input
                              type="password"
                              className="admin-input"
                              style={{ flex: 1, minWidth: 200 }}
                              placeholder="paste the new secret — stored encrypted, never shown again"
                              value={replaceSecret[k.id] ?? ''}
                              onChange={(e) => setReplaceSecret((x) => ({ ...x, [k.id]: e.target.value }))}
                            />
                            <button
                              className="btn-primary"
                              style={{ fontSize: '0.78rem', padding: '6px 12px' }}
                              disabled={!replaceSecret[k.id] || busy[`key:${k.id}`]}
                              onClick={() => replaceKey(p, k)}
                            >
                              Save & test
                            </button>
                          </div>
                        )}
                        <TestLine result={test} error={msg[`key:${k.id}`]} />
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Add key */}
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.55rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="password"
                  className="admin-input"
                  style={{ flex: 1, minWidth: 220 }}
                  placeholder="new API key (encrypted on save, never displayed again)"
                  value={newKey[p.id]?.key ?? ''}
                  onChange={(e) =>
                    setNewKey((x) => ({ ...x, [p.id]: { key: e.target.value, label: x[p.id]?.label ?? '' } }))
                  }
                />
                <input
                  className="admin-input"
                  style={{ width: 150 }}
                  placeholder="label (optional)"
                  value={newKey[p.id]?.label ?? ''}
                  onChange={(e) =>
                    setNewKey((x) => ({ ...x, [p.id]: { key: x[p.id]?.key ?? '', label: e.target.value } }))
                  }
                />
                <button
                  className="btn-primary"
                  style={{ fontSize: '0.8rem', padding: '7px 14px' }}
                  disabled={!newKey[p.id]?.key || busy[`newkey:${p.id}`]}
                  onClick={() => addKey(p)}
                >
                  {busy[`newkey:${p.id}`] ? 'Adding…' : 'Add key & test'}
                </button>
                <Msg text={msg[`newkey:${p.id}`]} />
              </div>

              {/* MODELS */}
              <Subheading>Models</Subheading>
              <p style={{ fontSize: '0.75rem', opacity: 0.45, margin: '-0.2rem 0 0.5rem' }}>
                Charges are credits per 1M tokens and are used verbatim by the gateway. A model is only visible to
                users once a plan grants access to it on <strong>Plans &amp; Credits</strong>.
              </p>
              {pModels.length === 0 ? (
                <p style={{ fontSize: '0.82rem', opacity: 0.55, margin: '0 0 0.5rem' }}>
                  No models yet. Add the provider&apos;s model id below; it is tested before it goes live.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ marginTop: 0, fontSize: '0.82rem' }}>
                    <thead>
                      <tr>
                        <th>On</th>
                        <th>Model id (provider&apos;s)</th>
                        <th>Name</th>
                        <th title="Context window in tokens">Context</th>
                        <th title="Credits per 1M input tokens">In</th>
                        <th title="Credits per 1M output tokens">Out</th>
                        <th title="Credits per 1M cache-read tokens">C-read</th>
                        <th title="Credits per 1M cache-write tokens">C-write</th>
                        <th>Capabilities</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {pModels.map((m) => (
                        <tr key={m.code}>
                          <td>
                            <input
                              type="checkbox"
                              checked={m.enabled}
                              onChange={(e) => patchModel(m.code, { enabled: e.target.checked })}
                            />
                          </td>
                          <td>
                            <input
                              className="admin-input"
                              style={{ width: 180 }}
                              value={m.upstreamModelId}
                              onChange={(e) => patchModel(m.code, { upstreamModelId: e.target.value })}
                            />
                            <div style={{ fontSize: '0.68rem', opacity: 0.45 }}>code: {m.code}</div>
                          </td>
                          <td>
                            <input
                              className="admin-input"
                              style={{ width: 140 }}
                              value={m.label}
                              onChange={(e) => patchModel(m.code, { label: e.target.value })}
                            />
                          </td>
                          <td>
                            <ContextInput
                              tokens={m.contextWindow}
                              width={90}
                              onChange={(tokens) => patchModel(m.code, { contextWindow: tokens })}
                            />
                          </td>
                          <ChargeCell
                            value={m.creditMultiplier}
                            onChange={(v) => patchModel(m.code, { creditMultiplier: v })}
                          />
                          <ChargeCell
                            value={m.outputCreditMultiplier}
                            onChange={(v) => patchModel(m.code, { outputCreditMultiplier: v })}
                          />
                          <ChargeCell
                            value={m.cacheReadCreditMultiplier ?? 0}
                            onChange={(v) => patchModel(m.code, { cacheReadCreditMultiplier: v })}
                          />
                          <ChargeCell
                            value={m.cacheWriteCreditMultiplier ?? m.creditMultiplier}
                            onChange={(v) => patchModel(m.code, { cacheWriteCreditMultiplier: v })}
                          />
                          <td>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              <Chip
                                on={m.supportsReasoning}
                                label="think"
                                onClick={() => patchModel(m.code, { supportsReasoning: !m.supportsReasoning })}
                              />
                              <Chip
                                on={m.supportsImage}
                                label="image"
                                onClick={() => patchModel(m.code, { supportsImage: !m.supportsImage })}
                              />
                              <Chip
                                on={m.supportsTools}
                                label="tools"
                                onClick={() => patchModel(m.code, { supportsTools: !m.supportsTools })}
                              />
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button
                                className="btn-ghost"
                                style={{ fontSize: '0.72rem', padding: '3px 8px' }}
                                disabled={busy[`model:${m.code}`]}
                                onClick={() => runTest(`model:${m.code}`, { providerId: p.id, modelCode: m.code })}
                              >
                                Test
                              </button>
                              <button
                                className="btn-primary"
                                style={{ fontSize: '0.72rem', padding: '3px 8px' }}
                                disabled={busy[`model:${m.code}`]}
                                onClick={() => saveModel(m)}
                              >
                                Save
                              </button>
                              <button
                                className="btn-ghost"
                                style={{ fontSize: '0.72rem', padding: '3px 8px', color: 'var(--red)' }}
                                onClick={() => setDelModel(m)}
                              >
                                ✕
                              </button>
                            </div>
                            <TestLine result={tests[`model:${m.code}`]} error={msg[`model:${m.code}`]} compact />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Add model */}
              <AddModelRow
                draft={draftFor(p)}
                busy={!!busy[`newmodel:${p.id}`]}
                message={msg[`newmodel:${p.id}`]}
                testResult={tests[`model:${draftCode(draftFor(p))}`]}
                onPatch={(patch) => patchDraft(p, patch)}
                onSubmit={() => addModel(p)}
              />
            </Panel>
          )
        })}

        <AddProviderWizard
          apiFetch={apiFetch}
          runTest={runTest}
          onCreated={async (created, firstKeyID, modelCode) => {
            await reload()
            if (firstKeyID) await runTest(`key:${firstKeyID}`, { providerId: created.id, apiKeyId: firstKeyID })
            if (modelCode) await runTest(`model:${modelCode}`, { providerId: created.id, modelCode })
          }}
        />
      </div>

      <TestResultDialog result={testModal} onClose={() => setTestModal(null)} />

      <ConfirmDialog
        open={!!delProvider}
        title="Delete provider?"
        message={`Remove "${delProvider?.name}" and ALL of its stored API keys. This cannot be undone — the keys would have to be re-entered.`}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => delProvider && removeProvider(delProvider)}
        onCancel={() => setDelProvider(null)}
      />
      <ConfirmDialog
        open={!!delKey}
        title="Delete API key?"
        message={`Remove ${delKey?.key.maskedKey} from "${delKey?.provider.name}". The secret cannot be recovered; you would have to paste it again.`}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => delKey && removeKey(delKey.provider, delKey.key)}
        onCancel={() => setDelKey(null)}
      />
      <ConfirmDialog
        open={!!delModel}
        title="Delete model?"
        message={`Remove "${delModel?.code}". Users on plans that allow it will no longer see it.`}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => delModel && removeModel(delModel)}
        onCancel={() => setDelModel(null)}
      />
    </div>
  )

}

/**
 * Add a provider in three steps: connection → key → first model. Each step
 * SAVES as it completes, so a failure never loses the work before it, and the
 * model is auto-tested: it goes live only if the test passes.
 */
function AddProviderWizard({
  apiFetch,
  runTest,
  onCreated,
}: {
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>
  runTest: (subject: string, body: TestSubject) => Promise<ProviderTestResult | null>
  onCreated: (created: Provider, firstKeyID?: number, modelCode?: string) => Promise<void>
}) {
  const [step, setStep] = useState(1)
  const [draft, setDraft] = useState<ProviderDraft>(BLANK_PROVIDER)
  const [created, setCreated] = useState<Provider | null>(null)
  const [secret, setSecret] = useState('')
  const [keyID, setKeyID] = useState<number | undefined>()
  const [model, setModel] = useState<ModelDraft>(blankModel())
  const [note, setNote] = useState('')
  const [working, setWorking] = useState(false)
  const [advanced, setAdvanced] = useState(false)

  async function createProvider() {
    setWorking(true)
    setNote('')
    const res = await apiFetch('/admin/providers', {
      method: 'POST',
      body: JSON.stringify({
        ...draft,
        label: draft.label || draft.name,
        endpointPath: draft.endpointPath || null,
        // Created DISABLED: an untested provider must not start taking traffic
        // the moment it is saved.
        enabled: false,
      }),
    })
    setWorking(false)
    if (!res.ok) {
      setNote(await errorText(res))
      return
    }
    setCreated((await res.json()) as Provider)
    setStep(2)
  }

  async function addFirstKey() {
    if (!created) return
    setWorking(true)
    setNote('')
    const res = await apiFetch(`/admin/providers/${created.name}/keys`, {
      method: 'POST',
      body: JSON.stringify({ key: secret.trim() }),
    })
    setWorking(false)
    if (!res.ok) {
      setNote(await errorText(res))
      return
    }
    const k = (await res.json()) as ProviderKeyView
    setKeyID(k.id)
    setSecret('') // drop the plaintext as soon as it is stored
    setStep(3)
  }

  async function addFirstModel() {
    if (!created) return
    setWorking(true)
    setNote('')
    const code = (advanced && model.code ? model.code : codeFromModelId(model.upstreamModelId)).trim()
    const res = await apiFetch('/admin/models', {
      method: 'POST',
      body: JSON.stringify({
        code,
        label: model.label.trim() || model.upstreamModelId.trim(),
        providerId: created.id,
        upstreamModelId: model.upstreamModelId.trim(),
        contextWindow: model.contextWindow,
        creditMultiplier: model.creditMultiplier,
        outputCreditMultiplier: model.outputCreditMultiplier,
        cacheReadCreditMultiplier: model.cacheReadCreditMultiplier,
        cacheWriteCreditMultiplier: model.cacheWriteCreditMultiplier,
        supportsReasoning: model.supportsReasoning,
        supportsImage: model.supportsImage,
        supportsTools: model.supportsTools,
        enabled: false,
      }),
    })
    if (!res.ok) {
      setNote(await errorText(res))
      setWorking(false)
      return
    }
    // Test through the gateway, then enable ONLY what passed. A failure is kept
    // (not rolled back) so the admin can fix a typo instead of retyping
    // everything — it just stays invisible to users.
    const result = await runTest(`model:${code}`, { providerId: created.id, modelCode: code })
    if (result?.ok) {
      await apiFetch(`/admin/models/${code}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) })
      await apiFetch(`/admin/providers/${created.name}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true }),
      })
      setNote('Tested successfully — provider and model are live.')
    } else {
      setNote(
        `Saved, but the test failed (${result?.classification ?? 'no result'}). ` +
          'The provider and model stay DISABLED until a test passes.',
      )
    }
    setWorking(false)
    await onCreated(created, keyID, code)
    if (result?.ok) {
      // Reset for the next provider.
      setStep(1)
      setDraft(BLANK_PROVIDER)
      setCreated(null)
      setKeyID(undefined)
      setModel(blankModel())
    }
  }

  return (
    <Panel title="Add a provider">
      <div style={{ display: 'flex', gap: '1rem', fontSize: '0.78rem', opacity: 0.6, marginBottom: '0.8rem' }}>
        <StepLabel n={1} step={step} label="Connection" />
        <StepLabel n={2} step={step} label="API key" />
        <StepLabel n={3} step={step} label="First model" />
      </div>

      {step === 1 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
            <Field label="Name (slug)">
              <input className="admin-input" style={{ width: '100%' }} placeholder="openrouter"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
            </Field>
            <Field label="Display name">
              <input className="admin-input" style={{ width: '100%' }} placeholder="OpenRouter"
                value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </Field>
            <Field label="Provider format">
              <select className="admin-input" style={{ width: '100%' }} value={draft.format}
                onChange={(e) => {
                  const format = e.target.value as ProviderFormat
                  setDraft({
                    ...draft,
                    format,
                    endpointPath: FORMAT_DEFAULTS[format].endpointPath,
                    authScheme: FORMAT_DEFAULTS[format].authScheme,
                  })
                }}>
                {PROVIDER_FORMATS.map((f) => (
                  <option key={f} value={f}>{PROVIDER_FORMAT_LABELS[f]}</option>
                ))}
              </select>
            </Field>
            <Field label="Base URL">
              <input className="admin-input" style={{ width: '100%' }} placeholder="https://openrouter.ai/api"
                value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
            </Field>
            <Field label="Endpoint path (blank = default)">
              <input className="admin-input" style={{ width: '100%' }}
                placeholder={FORMAT_DEFAULTS[draft.format].endpointPath ?? 'built by the adapter'}
                value={draft.endpointPath ?? ''}
                onChange={(e) => setDraft({ ...draft, endpointPath: e.target.value || null })} />
            </Field>
            <Field label="Auth scheme">
              <select className="admin-input" style={{ width: '100%' }} value={draft.authScheme}
                onChange={(e) => setDraft({ ...draft, authScheme: e.target.value as ProviderAuthScheme })}>
                {PROVIDER_AUTH_SCHEMES.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </Field>
          </div>
          <p style={{ fontSize: '0.78rem', opacity: 0.55, marginBottom: 0 }}>
            Base URL must be https to a public host — the provider key is sent to it.
            <br />
            <strong>{PROVIDER_FORMAT_LABELS[draft.format]} needs:</strong>{' '}
            {FORMAT_REQUIREMENTS[draft.format]}
          </p>
          <div style={{ marginTop: '0.8rem', display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
            <button className="btn-primary" disabled={!draft.name || !draft.baseUrl || working} onClick={createProvider}>
              {working ? 'Saving…' : 'Save & continue'}
            </button>
            <Msg text={note} />
          </div>
        </>
      )}

      {step === 2 && created && (
        <>
          <p style={{ fontSize: '0.85rem', opacity: 0.7, marginTop: 0 }}>
            Paste an API key for <strong>{created.label}</strong>. It is encrypted immediately and never shown
            again — only a mask. You can add more keys later; the gateway rotates them and fails over
            automatically.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="password"
              className="admin-input"
              style={{ flex: 1, minWidth: 260 }}
              placeholder="sk-…"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <button className="btn-primary" disabled={!secret.trim() || working} onClick={addFirstKey}>
              {working ? 'Saving…' : 'Save key & continue'}
            </button>
            <Msg text={note} />
          </div>
        </>
      )}

      {step === 3 && created && (
        <>
          <p style={{ fontSize: '0.85rem', opacity: 0.7, marginTop: 0 }}>
            Add the first model. Use the provider&apos;s <strong>exact</strong> model id — the gateway sends that
            id upstream. It is saved disabled, tested through the real adapter, and enabled only if the test
            passes.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem' }}>
            <Field label="Model id (from the provider)">
              <input className="admin-input" style={{ width: '100%' }} placeholder="deepseek-chat"
                value={model.upstreamModelId}
                onChange={(e) => setModel({ ...model, upstreamModelId: e.target.value })} />
              <div style={{ fontSize: '0.7rem', opacity: 0.45, marginTop: 2 }}>
                Rayu code: <code>{codeFromModelId(model.upstreamModelId) || '—'}</code>
              </div>
            </Field>
            <Field label="Display name">
              <input className="admin-input" style={{ width: '100%' }} placeholder="DeepSeek Chat"
                value={model.label} onChange={(e) => setModel({ ...model, label: e.target.value })} />
            </Field>
            <Field label="Context window">
              <ContextInput
                tokens={model.contextWindow}
                width="100%"
                onChange={(tokens) => setModel({ ...model, contextWindow: tokens })}
              />
            </Field>
            <Field label="Credits / 1M input">
              <NumInput value={model.creditMultiplier} onChange={(v) => setModel({ ...model, creditMultiplier: v })} />
            </Field>
            <Field label="Credits / 1M output">
              <NumInput value={model.outputCreditMultiplier} onChange={(v) => setModel({ ...model, outputCreditMultiplier: v })} />
            </Field>
            <Field label="Credits / 1M cache read">
              <NumInput value={model.cacheReadCreditMultiplier} onChange={(v) => setModel({ ...model, cacheReadCreditMultiplier: v })} />
            </Field>
            <Field label="Credits / 1M cache write">
              <NumInput value={model.cacheWriteCreditMultiplier} onChange={(v) => setModel({ ...model, cacheWriteCreditMultiplier: v })} />
            </Field>
          </div>
          <div style={{ marginTop: '0.6rem', display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip on={model.supportsReasoning} label="think" onClick={() => setModel({ ...model, supportsReasoning: !model.supportsReasoning })} />
            <Chip on={model.supportsImage} label="image" onClick={() => setModel({ ...model, supportsImage: !model.supportsImage })} />
            <Chip on={model.supportsTools} label="tools" onClick={() => setModel({ ...model, supportsTools: !model.supportsTools })} />
            <button className="btn-ghost" style={{ fontSize: '0.75rem' }} onClick={() => setAdvanced((v) => !v)}>
              {advanced ? 'Hide advanced' : 'Advanced'}
            </button>
          </div>
          {advanced && (
            <div style={{ marginTop: '0.6rem', maxWidth: 320 }}>
              <Field label="Rayu model code (override)">
                <input className="admin-input" style={{ width: '100%' }}
                  placeholder={codeFromModelId(model.upstreamModelId)}
                  value={model.code}
                  onChange={(e) => setModel({ ...model, code: e.target.value, codeOverridden: true })} />
                <div style={{ fontSize: '0.7rem', opacity: 0.45, marginTop: 2 }}>
                  What users select in the CLI. Defaults to the model id; only change it if two providers expose
                  the same id.
                </div>
              </Field>
            </div>
          )}
          <div style={{ marginTop: '0.8rem', display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
            <button className="btn-primary" disabled={!model.upstreamModelId.trim() || working} onClick={addFirstModel}>
              {working ? 'Saving & testing…' : 'Save, test & finish'}
            </button>
            <Msg text={note} />
          </div>
        </>
      )}
    </Panel>
  )
}

/** Inline "add a model to this provider" row (same rules as the wizard step 3). */
function AddModelRow({
  draft,
  busy: isBusy,
  message,
  testResult,
  onPatch,
  onSubmit,
}: {
  draft: ModelDraft
  busy: boolean
  message?: string
  testResult?: ProviderTestResult
  onPatch: (patch: Partial<ModelDraft>) => void
  onSubmit: () => void
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const derived = codeFromModelId(draft.upstreamModelId)
  return (
    <div
      style={{
        marginTop: '0.7rem',
        borderTop: '1px dashed rgba(255,255,255,0.1)',
        paddingTop: '0.7rem',
      }}
    >
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Model id (provider's)">
          <input
            className="admin-input"
            style={{ width: 190 }}
            placeholder="deepseek-chat"
            value={draft.upstreamModelId}
            onChange={(e) => onPatch({ upstreamModelId: e.target.value })}
          />
        </Field>
        <Field label="Name">
          <input
            className="admin-input"
            style={{ width: 150 }}
            placeholder={draft.upstreamModelId || 'DeepSeek Chat'}
            value={draft.label}
            onChange={(e) => onPatch({ label: e.target.value })}
          />
        </Field>
        <Field label="Context">
          <ContextInput
            tokens={draft.contextWindow}
            width={100}
            onChange={(tokens) => onPatch({ contextWindow: tokens })}
          />
        </Field>
        <Field label="In">
          <NumInput value={draft.creditMultiplier} onChange={(v) => onPatch({ creditMultiplier: v })} width={70} />
        </Field>
        <Field label="Out">
          <NumInput value={draft.outputCreditMultiplier} onChange={(v) => onPatch({ outputCreditMultiplier: v })} width={70} />
        </Field>
        <Field label="C-read">
          <NumInput value={draft.cacheReadCreditMultiplier} onChange={(v) => onPatch({ cacheReadCreditMultiplier: v })} width={70} />
        </Field>
        <Field label="C-write">
          <NumInput value={draft.cacheWriteCreditMultiplier} onChange={(v) => onPatch({ cacheWriteCreditMultiplier: v })} width={70} />
        </Field>
        <div style={{ display: 'flex', gap: 4, paddingBottom: 8 }}>
          <Chip on={draft.supportsReasoning} label="think" onClick={() => onPatch({ supportsReasoning: !draft.supportsReasoning })} />
          <Chip on={draft.supportsImage} label="image" onClick={() => onPatch({ supportsImage: !draft.supportsImage })} />
          <Chip on={draft.supportsTools} label="tools" onClick={() => onPatch({ supportsTools: !draft.supportsTools })} />
        </div>
        <button
          className="btn-primary"
          style={{ fontSize: '0.8rem', padding: '7px 14px', marginBottom: 8 }}
          disabled={!draft.upstreamModelId.trim() || isBusy}
          onClick={onSubmit}
        >
          {isBusy ? 'Saving & testing…' : 'Add model & test'}
        </button>
        <button
          className="btn-ghost"
          style={{ fontSize: '0.75rem', marginBottom: 8 }}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? 'Hide advanced' : 'Advanced'}
        </button>
      </div>
      <div style={{ fontSize: '0.7rem', opacity: 0.45 }}>
        Rayu code: <code>{(draft.codeOverridden ? draft.code : derived) || '—'}</code> · saved disabled, then
        enabled automatically if the test passes
      </div>
      {showAdvanced && (
        <div style={{ marginTop: '0.4rem', maxWidth: 300 }}>
          <Field label="Rayu model code (override)">
            <input
              className="admin-input"
              style={{ width: '100%' }}
              placeholder={derived}
              value={draft.code}
              onChange={(e) => onPatch({ code: e.target.value, codeOverridden: true })}
            />
          </Field>
        </div>
      )}
      <Msg text={message} />
      <TestLine result={testResult} />
    </div>
  )
}

// --- Presentational helpers ---------------------------------------------------

function Subheading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: '0.75rem',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        opacity: 0.45,
        margin: '1rem 0 0.45rem',
      }}
    >
      {children}
    </div>
  )
}

function Msg({ text }: { text?: string }) {
  if (!text) return null
  const bad = /error|fail|disabled|unreachable/i.test(text)
  return <span style={{ fontSize: '0.8rem', color: bad ? 'var(--red)' : 'var(--green)' }}>{text}</span>
}

function NumInput({
  value,
  onChange,
  width = 100,
}: {
  value: number
  onChange: (v: number) => void
  width?: number
}) {
  return (
    <input
      type="number"
      min={0}
      step={0.01}
      className="admin-input"
      style={{ width }}
      value={value}
      onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
    />
  )
}

/**
 * Context window input. Admins think in "200K" / "1M" but the API stores TOKENS,
 * and the CLI budgets auto-compaction against that number — so the shorthand is
 * parsed exactly (see ../contextWindow) rather than guessed, and blank means
 * "unknown", which leaves the CLI on its own default.
 */
function ContextInput({
  tokens,
  onChange,
  width = 100,
}: {
  tokens: number | null
  onChange: (tokens: number | null) => void
  width?: number | string
}) {
  // Typed text is kept locally so a half-finished "1" in "1M" is not clobbered.
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? formatContextWindow(tokens)
  return (
    <input
      className="admin-input"
      style={{ width }}
      placeholder="200K"
      title="Tokens. Accepts 200K, 1M, or a raw count; blank = unknown."
      value={shown}
      onChange={(e) => {
        setText(e.target.value)
        onChange(parseContextWindow(e.target.value))
      }}
      onBlur={() => setText(null)}
    />
  )
}

function ChargeCell({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <td>
      <NumInput value={value} onChange={onChange} width={72} />
    </td>
  )
}

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={on ? `${label}: enabled` : `${label}: disabled`}
      style={{
        fontSize: '0.7rem',
        padding: '2px 8px',
        borderRadius: 999,
        cursor: 'pointer',
        background: on ? 'rgba(0,255,153,0.12)' : 'rgba(255,255,255,0.05)',
        border: `1px solid ${on ? 'var(--green)' : 'rgba(255,255,255,0.15)'}`,
        color: on ? 'var(--green)' : 'inherit',
        opacity: on ? 1 : 0.5,
      }}
    >
      {label}
    </button>
  )
}

function StepLabel({ n, step, label }: { n: number; step: number; label: string }) {
  const done = step > n
  const active = step === n
  return (
    <span style={{ color: active ? 'var(--green)' : undefined, opacity: done ? 0.55 : active ? 1 : 0.4 }}>
      {done ? '✓' : n}. {label}
    </span>
  )
}

/** One key's live rotation state, as the gateway sees it. */
function KeyStatusBadge({ status, cooldownUntil }: { status: string; cooldownUntil?: string | null }) {
  const tone: Record<string, string> = {
    active: 'var(--green)',
    rate_limited: '#ffbd2e',
    invalid: 'var(--red)',
    disabled: 'rgba(255,255,255,0.4)',
  }
  const color = tone[status] ?? 'rgba(255,255,255,0.4)'
  const cooling =
    status === 'rate_limited' && cooldownUntil ? ` until ${new Date(cooldownUntil).toLocaleTimeString()}` : ''
  return (
    <span
      style={{
        fontSize: '0.7rem',
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${color}`,
        color,
      }}
      title={
        status === 'invalid'
          ? 'Rejected by the provider — replace it; the gateway will not retry it'
          : status === 'rate_limited'
            ? 'Throttled — skipped until the cooldown passes'
            : undefined
      }
    >
      {status.replace('_', ' ')}
      {cooling}
    </span>
  )
}

/** The outcome of a real gateway test, in the language of the fix it needs. */
function TestLine({
  result,
  error,
  compact,
}: {
  result?: ProviderTestResult
  error?: string
  compact?: boolean
}) {
  if (error) return <div style={{ fontSize: '0.75rem', color: 'var(--red)', marginTop: 4 }}>{error}</div>
  if (!result) return null
  const color = result.ok ? 'var(--green)' : 'var(--red)'
  return (
    <div style={{ fontSize: compact ? '0.68rem' : '0.75rem', marginTop: 4, color, lineHeight: 1.5 }}>
      <strong>{result.ok ? 'OK' : result.classification.replace(/_/g, ' ')}</strong>
      {` · ${result.latencyMs}ms`}
      {!compact && result.message ? ` — ${result.message}` : ''}
      {/* What WORKED, not just what failed: this is what narrows a broken
          provider to a single field instead of re-checking the URL, the key and
          the format all at once. */}
      <StageChecks checks={result.checks} />
      {result.suggestion && (
        <div style={{ opacity: 0.8, color: 'inherit' }}>{result.suggestion}</div>
      )}
    </div>
  )
}

/**
 * The outcome of a Test, as a modal.
 *
 * A test is a deliberate act that makes a real upstream call, and its answer is
 * several facts at once: pass/fail, which stage failed, what to change, and — the
 * part that was missing — the EXACT configuration that produced it. Showing the
 * config back is what turns "unknown model" into "…and here is the URL it was
 * sent to", which is how a wrong endpoint gets noticed instead of being mistaken
 * for a wrong model id.
 */
function TestResultDialog({
  result,
  onClose,
}: {
  result: ProviderTestResult | null
  onClose: () => void
}) {
  if (!result) return null
  const tone = result.ok ? 'var(--green)' : 'var(--red)'
  const rows: Array<[string, string]> = [
    ['Provider', result.providerName || '—'],
    ['Wire format', result.format || '—'],
    ['URL called', result.endpoint || '—'],
    ['Model (Rayu code)', result.modelCode || '—'],
    ['Model id sent upstream', result.upstreamModelId || '—'],
    ['API key', result.maskedKey ? `${result.maskedKey} (#${result.keyId})` : '—'],
    ['HTTP status', result.httpStatus ? String(result.httpStatus) : '—'],
    ['Latency', `${result.latencyMs} ms`],
  ]
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, color: tone }}>
          {result.ok ? 'Test passed' : `Test failed — ${result.classification.replace(/_/g, ' ')}`}
        </h3>

        <div style={{ margin: '0.5rem 0 0.9rem' }}>
          <StageChecks checks={result.checks} />
        </div>

        {result.message && (
          <p style={{ fontSize: '0.86rem', lineHeight: 1.6, margin: '0 0 0.6rem' }}>{result.message}</p>
        )}
        {result.suggestion && (
          <p
            style={{
              fontSize: '0.85rem',
              lineHeight: 1.6,
              margin: '0 0 0.9rem',
              padding: '0.5rem 0.65rem',
              borderRadius: 6,
              border: '1px solid rgba(255,189,46,0.35)',
              background: 'rgba(255,189,46,0.06)',
            }}
          >
            {result.suggestion}
          </p>
        )}

        <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.45, marginBottom: '0.35rem' }}>
          Configuration used
        </div>
        <table style={{ marginTop: 0, fontSize: '0.8rem' }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>{k}</td>
                <td style={{ fontFamily: 'DM Mono, monospace', wordBreak: 'break-all' }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p style={{ fontSize: '0.75rem', opacity: 0.45, marginTop: '0.8rem', marginBottom: 0 }}>
          The test sent one 1-token request through the same adapter and key rotation as production. It charged
          no credits and used no daily turn.
        </p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button className="btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/** Reachable / key accepted / model accepted, as the gateway observed them. */
function StageChecks({ checks }: { checks?: ProviderTestChecks }) {
  if (!checks) return null
  const stages: Array<[string, boolean | null]> = [
    ['endpoint reachable', checks.reachable],
    ['key accepted', checks.keyAccepted],
    ['model id accepted', checks.modelAccepted],
  ]
  // A stage that was never reached says nothing useful, so it renders as "—"
  // rather than as a failure an admin would go and "fix".
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2, opacity: 0.95 }}>
      {stages.map(([label, state]) => (
        <span
          key={label}
          style={{ color: state === true ? 'var(--green)' : state === false ? 'var(--red)' : 'inherit', opacity: state === null ? 0.5 : 1 }}
          title={state === null ? 'not reached — nothing to conclude' : undefined}
        >
          {state === true ? '✓' : state === false ? '✕' : '—'} {label}
        </span>
      ))}
    </div>
  )
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[] }
  const message = Array.isArray(body.message) ? body.message.join(', ') : body.message
  return `Error: ${message ?? res.status}`
}

/** Whether the GATEWAY can actually route this provider right now. */
function HealthBadge({ health }: { health?: ProviderHealth }) {
  if (!health) {
    return (
      <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: 999, background: 'rgba(255,255,255,0.06)', opacity: 0.6 }}>
        gateway status unknown
      </span>
    )
  }
  const [text, color] = health.routable
    ? ['routable', 'var(--green)']
    : health.configError
      ? ['config invalid', 'var(--red)']
      : !health.enabled
        ? ['disabled', '#ffbd2e']
        : health.keyCount === 0
          ? ['no API key', 'var(--red)']
          : ['no usable key', 'var(--red)']
  return (
    <span
      style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: 999, border: `1px solid ${color}`, color }}
      title={health.configError ?? health.keys.map((k) => `${k.maskedKey}: ${k.status}`).join('\n')}
    >
      {text}
    </span>
  )
}
