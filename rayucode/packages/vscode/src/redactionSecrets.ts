// Redaction secret collection (R8.4, R15.5).
//
// The core's `Redactor` strips configured secrets from every string routed to the
// Agent_Panel and the log channel — but it can only redact values it was GIVEN.
// Constructed with an empty set (the `SessionManager` default) it is a no-op, so
// something has to supply the secret values. That is this module's job.
//
// ── Threat model ────────────────────────────────────────────────────────────
// `AgentProcess` deliberately inherits `process.env` unchanged so the CLI resolves
// its own `~/.rayu` config and MCP servers (R8.1, R8.2). That means any provider
// credential present in the extension host's environment is also in the agent's
// environment — and a single `Bash` tool call running `env`, a stack trace, a
// config dump, or a tool that reads `.env` will echo it back over stdout. Without
// redaction that value is rendered into the panel and written to the log channel,
// where it can be copied into a bug report.
//
// So we collect the credential-looking environment values up front and hand them
// to the Redactor. This does NOT read or transmit anything: the values are already
// in this process, and they are used only to recognise and remove themselves.
//
// ── Why the filters are conservative ────────────────────────────────────────
// A redactor entry is a search-and-replace over ALL displayed text, so a bad
// entry is actively harmful: a short or common value (`true`, `production`, a
// 2-char token) would blank out unrelated output and make the panel misleading.
// A candidate therefore has to clear three bars:
//   1. its NAME looks like a credential (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, …),
//   2. its VALUE is long enough to be a real credential, and
//   3. its VALUE is not an obvious non-secret (a boolean, a number, a path, a
//      URL without embedded credentials, a placeholder like `changeme`).
//
// Everything here is pure and injectable, so the policy is unit-testable without
// touching the real environment.

/**
 * Environment variable NAME patterns treated as credential-bearing. Matched
 * case-insensitively against the whole name.
 */
const CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)API[_-]?KEY$/i,
  /(^|_)ACCESS[_-]?KEY(_ID)?$/i,
  /(^|_)SECRET([_-]?(KEY|ACCESS[_-]?KEY))?$/i,
  /(^|_)TOKEN$/i,
  /(^|_)AUTH[_-]?TOKEN$/i,
  /(^|_)SESSION[_-]?TOKEN$/i,
  /(^|_)PASSWORD$/i,
  /(^|_)CREDENTIALS?$/i,
  /(^|_)PRIVATE[_-]?KEY$/i,
  /^RAYU_.*(KEY|TOKEN|SECRET)$/i,
];

/**
 * Minimum credential length. Real provider keys are long, opaque strings; a
 * shorter value is far more likely to be a flag or an id whose redaction would
 * corrupt unrelated output.
 */
const MIN_SECRET_LENGTH = 12;

/** Values that match a credential-ish name but are plainly not secrets. */
const NON_SECRET_VALUES: ReadonlySet<string> = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "none",
  "default",
  "changeme",
  "your-api-key",
  "your_api_key",
  "xxx",
  "todo",
]);

/** Whether `name` looks like it holds a credential. */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Whether `value` is plausible as a real credential, and therefore safe to use
 * as a redaction needle.
 *
 * Rejects values that would over-match: too short, whitespace-bearing (a
 * credential has none, and a phrase would blank out prose), filesystem paths
 * (a credential FILE path is not itself the secret), plain numbers, and known
 * placeholders. A URL is rejected unless it carries embedded userinfo, in which
 * case the whole URL is worth redacting.
 */
export function isPlausibleSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) {
    return false;
  }
  if (trimmed !== value) {
    // Surrounding whitespace means the redaction needle would not match the
    // value as it actually appears in output.
    return false;
  }
  if (/\s/.test(trimmed)) {
    return false;
  }
  if (NON_SECRET_VALUES.has(trimmed.toLowerCase())) {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return false;
  }
  // A path (`/home/u/.config/key.json`, `C:\keys\k.pem`) points AT a secret; the
  // path itself is not sensitive and redacting it would obscure diagnostics.
  if (/^([a-zA-Z]:[\\/]|[\\/~])/.test(trimmed)) {
    return false;
  }
  // A bare URL is not a secret. One with `user:pass@` is.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@\s]+@/.test(trimmed);
  }
  return true;
}

/**
 * Collect redaction needles from an environment map (defaults to the real
 * `process.env`).
 *
 * Returns the credential VALUES — never the names — deduplicated. The result is
 * intended solely for constructing a `Redactor`; it must never be logged,
 * displayed, or sent anywhere.
 */
export function collectEnvironmentSecrets(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !isCredentialName(name)) {
      continue;
    }
    if (isPlausibleSecret(value)) {
      secrets.add(value);
    }
  }
  return [...secrets];
}
