// Validation for USER-DEFINED providers (/connect → Custom).
//
// Everything here is untrusted input that feeds URL construction, config keys and
// the model-routing string, so each field is validated before anything is
// persisted or sent:
//
//   • provider id  — becomes a key in providers.json and is embedded in the
//     `providerId\u0000model` routing string, so it must not contain the separator,
//     path characters, or collide with a built-in preset id.
//   • base URL     — receives the API key, so plaintext http to a remote host is
//     refused and URL-embedded credentials are rejected.
//   • model ids    — are embedded in the same routing string; a `\u0000` in one
//     could spoof the provider a request is routed to.
//
// Pure and dependency-light so it is directly testable.

/** Provider ids that are reserved by built-in presets or internal use. */
const RESERVED_PROVIDER_IDS = new Set([
  'anthropic',
  'azure',
  'bedrock',
  'bedrock-anthropic',
  'bedrock-openai',
  'copilot',
  'gemini-login',
  'gemini-vertex',
  'kiro',
  'longcat',
  'ollama',
  'ollama-cloud',
  'rayu-hosted',
])

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * Derive a safe provider id from a user-supplied display name.
 *
 * Lower-cased, non-alphanumerics collapsed to single hyphens, trimmed. Rejects
 * anything that ends up empty or collides with a reserved id — a collision would
 * silently overwrite a built-in provider's saved credentials.
 */
export function normalizeCustomProviderId(name: string): Validation<string> {
  const raw = (name ?? '').trim()
  if (!raw) return { ok: false, reason: 'Enter a name for this provider.' }
  if (raw.length > 64) {
    return { ok: false, reason: 'Name is too long (max 64 characters).' }
  }
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!id) {
    return {
      ok: false,
      reason: 'Name must contain at least one letter or number.',
    }
  }
  if (RESERVED_PROVIDER_IDS.has(id)) {
    return {
      ok: false,
      reason: `"${id}" is a built-in provider id. Pick a different name.`,
    }
  }
  return { ok: true, value: id }
}

/** True when the id is already taken by a saved provider. */
export function isProviderIdTaken(
  id: string,
  existing: ReadonlyArray<{ id: string }>,
): boolean {
  return existing.some(p => p.id === id)
}

/**
 * Validate a user-supplied base URL.
 *
 * The API key is sent to this host, so: http(s) only, no embedded credentials, and
 * no plaintext http to anything but loopback (a local model server is the
 * legitimate http case).
 */
export function validateCustomBaseURL(input: string): Validation<string> {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, reason: 'Enter the endpoint base URL.' }
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
  if (!scheme) {
    return {
      ok: false,
      reason: 'Include the scheme, e.g. https://api.example.com/v1',
    }
  }
  if (scheme !== 'http' && scheme !== 'https') {
    return { ok: false, reason: 'Only http:// and https:// endpoints are supported.' }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' }
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'Remove the credentials from the URL — the API key is entered separately.',
    }
  }
  const host = url.hostname.toLowerCase()
  const loopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (url.protocol === 'http:' && !loopback) {
    return {
      ok: false,
      reason: 'Refusing to send an API key over plaintext http:// to a remote host. Use https://.',
    }
  }
  // Strip trailing slashes so the adapters' `${base}/path` never doubles up.
  return { ok: true, value: raw.replace(/\/+$/, '') }
}

/**
 * Validate ONE user-typed model id.
 *
 * Model ids are embedded in the `providerId\u0000model` routing string, so a
 * control character — the NUL separator above all — could spoof which provider a
 * request is routed to. The charset matches what real provider catalogs use
 * (verified against live Bedrock, Vertex, Azure, Copilot and OpenAI-compatible
 * listings): alphanumerics plus `. - _ : / @ +`.
 */
export function validateCustomModelId(input: string): Validation<string> {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, reason: 'Enter a model id.' }
  if (raw.length > 512) return { ok: false, reason: 'Model id is too long.' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, reason: 'Model id contains control characters.' }
  }
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(raw)) {
    return {
      ok: false,
      reason: 'Model id may only contain letters, digits and . - _ : / @ +',
    }
  }
  return { ok: true, value: raw }
}

/**
 * Parse a comma/whitespace/newline-separated list of model ids, keeping order and
 * dropping duplicates. Returns the first validation failure so the user can fix it.
 */
export function parseCustomModelIds(input: string): Validation<string[]> {
  const parts = (input ?? '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)
  if (parts.length === 0) {
    return { ok: false, reason: 'Enter at least one model id.' }
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const v = validateCustomModelId(part)
    if (!v.ok) return v
    if (!seen.has(v.value)) {
      seen.add(v.value)
      out.push(v.value)
    }
  }
  return { ok: true, value: out }
}
