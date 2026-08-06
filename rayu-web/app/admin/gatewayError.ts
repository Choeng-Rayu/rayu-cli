/**
 * Read a human-readable message out of a GATEWAY error response.
 *
 * The gateway answers with an OpenAI/Anthropic-shaped envelope —
 * `{"error":{"message","type"}}` (internal/httpx.WriteError) — where `error` is an
 * OBJECT, not a string. The dashboard used to do `err.error ?? err.message`, so
 * the object won the `??` and template interpolation rendered it as
 * "[object Object]". Every real cause was invisible: "unknown provider", "model X
 * does not belong to this provider", "this key cannot be decrypted — check that
 * the gateway and backend share the same RAYU_PROVIDER_SECRET", "too many
 * provider tests". Those messages name the field an admin has to fix, which is
 * the entire point of the provider test.
 *
 * Both shapes are accepted (object and plain string) so this keeps working for any
 * route that answers differently, with the HTTP status as the last resort.
 */
export async function gatewayErrorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown
    message?: unknown
  }
  const detail = messageFrom(body.error) ?? messageFrom(body.message)
  return detail ?? `HTTP ${res.status}`
}

/** A non-empty string, or the `.message` of an object, or nothing. */
function messageFrom(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (v && typeof v === 'object') {
    const m = (v as { message?: unknown }).message
    if (typeof m === 'string') return m.trim() || undefined
  }
  return undefined
}
