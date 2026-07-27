// Shared rate-limit key-rotation policy.
//
// Rayu supports storing MULTIPLE API keys for a provider (NVIDIA / OpenRouter /
// Ollama Cloud) and rolling over to the next key when the current one is rate
// limited or out of credits. The rotation itself is implemented twice, at two
// different layers, because the two client families differ:
//
//   • openaiAdapter.ts     — one OpenAI SDK client per key; rotates at the
//                            REQUEST layer (withKeyRotation) by retrying the
//                            call against the next client.
//   • anthropicMessagesClient.ts — a single native Anthropic SDK client
//                            (one credential); rotates at the FETCH layer
//                            (makeKeyRotatingFetch) by rewriting the
//                            Authorization header and re-issuing the request.
//
// The two implementations are justified by that structural difference, but the
// POLICY (which HTTP statuses mean "try the next key") must be identical, so it
// lives here as the single source of truth.
//
// HTTP statuses that mean "this key can't serve the request right now, but a
// DIFFERENT key might":
//   429 Too Many Requests (rate limit / quota)
//   402 Payment Required  (out of credits)
//   401 Unauthorized      (bad / expired key)
//   403 Forbidden         (key-level quota or permission)
// 404 is intentionally EXCLUDED: not-found means the model/route doesn't exist,
// which no key can fix, so rotating would just burn every key.
export const ROTATABLE_KEY_STATUSES: ReadonlySet<number> = new Set([
  429, 402, 401, 403,
])

/** True when an HTTP status warrants rotating to the next stored API key. */
export function isRotatableKeyStatus(status: number | undefined): boolean {
  return typeof status === 'number' && ROTATABLE_KEY_STATUSES.has(status)
}
