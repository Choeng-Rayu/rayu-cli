/**
 * Curated environment for spawned external agent processes.
 *
 * ## Why not `process.env`
 *
 * RAYU's own environment routinely holds credentials for every provider the user
 * has configured — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `NVIDIA_API_KEY`,
 * AWS keys, gateway tokens. Forwarding all of it to a third-party agent binary
 * hands that agent every credential the user owns, for no functional reason: an
 * agent CLI authenticates through its *own* stored credentials.
 *
 * ## Why not an empty environment either
 *
 * A child with no `PATH` cannot resolve its own subprocesses, and one with no
 * `HOME` cannot find its config or credential store. Both fail in confusing
 * ways that look like RAYU bugs.
 *
 * So: an allowlist. Process-wide variables needed to *function* are forwarded;
 * anything that could be a secret is not, unless the adapter names it explicitly
 * (Codex needs `CODEX_HOME`, Claude Code needs `CLAUDE_CONFIG_DIR`).
 */

/**
 * Variables every child needs to behave like a normal process.
 *
 * Deliberately excludes proxy variables: routing a foreign agent's traffic
 * through RAYU's configured proxy is a decision the user should make in that
 * agent's own config, not one RAYU makes silently.
 */
const BASE_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Windows equivalents — a missing one of these breaks spawn on win32.
  'SystemRoot',
  'SystemDrive',
  'windir',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ComSpec',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
] as const

/**
 * Patterns that must never be forwarded even if an adapter asks by name.
 *
 * A backstop against an adapter (or a future contributor) passing something
 * broad through `extra`. Checked last, so it overrides every other rule.
 */
const NEVER_FORWARD = /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIALS|AWS_|ANTHROPIC_|OPENAI_)/i

export type ChildEnvOptions = {
  /**
   * Extra variables this agent genuinely needs, e.g. `CODEX_HOME`.
   * Forwarded from `process.env` when present, by name only.
   */
  readonly forward?: readonly string[]
  /** Values set explicitly by the adapter. Not subject to the allowlist. */
  readonly set?: Readonly<Record<string, string>>
}

/**
 * Build the environment for a child agent process.
 *
 * `set` wins over forwarded values, so an adapter can override a variable it
 * also forwards. `NEVER_FORWARD` is applied to forwarded names only — an
 * explicit `set` is the adapter's own considered choice and is honoured.
 */
export function buildChildEnv(
  options: ChildEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const key of BASE_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  for (const key of options.forward ?? []) {
    if (NEVER_FORWARD.test(key)) continue
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  for (const [key, value] of Object.entries(options.set ?? {})) {
    env[key] = value
  }

  return env
}

/** Names that `buildChildEnv` would refuse to forward. Exposed for diagnostics. */
export function isForwardableEnvName(name: string): boolean {
  return !NEVER_FORWARD.test(name)
}
