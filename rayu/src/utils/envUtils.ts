import memoize from 'lodash-es/memoize.js'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

/**
 * Robust .env reader: traverses up from process.cwd() to locate the .env file,
 * and loads its KEY=VALUE pairs into process.env (without overriding existing values).
 */
/**
 * Parse a raw value string from a .env line, stripping inline comments
 * and surrounding quotes.
 *
 * Rules:
 *   - Quoted values ("..." or '...') are taken literally; the `#` inside
 *     quotes is NOT treated as a comment delimiter.
 *   - Unquoted values are trimmed, and everything from the first ` #` or
 *     `\t#` (whitespace + hash) onward is stripped as an inline comment.
 *   - An empty result (e.g. `KEY=` or `KEY= # comment`) returns '' so the
 *     caller can decide whether to set it.
 */
function parseDotEnvValue(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed[0] === '#') return ''

  // Quoted value — find the matching closing quote and ignore everything after.
  const first = trimmed[0]
  if (first === '"' || first === "'") {
    const end = trimmed.indexOf(first, 1)
    if (end !== -1) return trimmed.slice(1, end)
    // No closing quote — fall through and treat as unquoted.
    return trimmed.slice(1)
  }

  // Unquoted value — strip inline comment (space/tab followed by #).
  const commentIdx = trimmed.search(/[\s]#/)
  if (commentIdx !== -1) {
    return trimmed.slice(0, commentIdx).trim()
  }
  return trimmed
}

export function loadDotEnv(): void {
  let dir = process.cwd()
  let file = join(dir, '.env')
  // Traverse up to 10 levels to find the .env file
  for (let i = 0; i < 10; i++) {
    if (existsSync(file)) {
      try {
        const content = readFileSync(file, 'utf8')
        for (const raw of content.split('\n')) {
          const line = raw.trim()
          if (!line || line.startsWith('#')) continue
          const eq = line.indexOf('=')
          if (eq <= 0) continue
          const key = line.slice(0, eq).trim()
          const val = parseDotEnvValue(line.slice(eq + 1))
          // Only set non-empty values; empty KEY= lines are intentionally
          // left as undefined so they don't shadow real env vars or trigger
          // truthy checks (e.g. auth conflict detection).
          if (key && val && process.env[key] === undefined) {
            process.env[key] = val
          }
        }
        break // found and loaded
      } catch {
        // best-effort
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break // reached root
    dir = parent
    file = join(dir, '.env')
  }

  // Run lightweight validation after loading
  validateDotEnvConfig()
}

/**
 * Lightweight startup validation for .env configuration. Warns about common
 * mistakes to stderr so the user sees them immediately. Never throws — all
 * checks are advisory.
 */
function validateDotEnvConfig(): void {
  const warnings: string[] = []

  // 1. Multiple provider backends enabled simultaneously
  const bedrock = isBoolEnvActive(process.env.CLAUDE_CODE_USE_BEDROCK)
  const vertex = isBoolEnvActive(process.env.CLAUDE_CODE_USE_VERTEX)
  const foundry = isBoolEnvActive(process.env.CLAUDE_CODE_USE_FOUNDRY)
  const openai = isBoolEnvActive(process.env.RAYU_OPENAI_COMPATIBLE)
  const activeProviders = [
    bedrock && 'Bedrock',
    vertex && 'Vertex',
    foundry && 'Foundry',
    openai && 'OpenAI-compatible',
  ].filter(Boolean)
  if (activeProviders.length > 1) {
    warnings.push(
      `Multiple providers enabled: ${activeProviders.join(', ')}. Only one provider can be active at a time.`,
    )
  }

  // 2. Anthropic auth set alongside OpenAI-compatible mode
  if (openai) {
    if (process.env.ANTHROPIC_API_KEY) {
      warnings.push(
        'ANTHROPIC_API_KEY is set while RAYU_OPENAI_COMPATIBLE=true. This may cause auth conflicts.',
      )
    }
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      warnings.push(
        'ANTHROPIC_AUTH_TOKEN is set while RAYU_OPENAI_COMPATIBLE=true. This may cause auth conflicts.',
      )
    }
  }

  // 3. Boolean env vars with non-boolean string values
  const boolVars = [
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'RAYU_OPENAI_COMPATIBLE', 'DISABLE_PROMPT_CACHING', 'CLAUDE_CODE_DISABLE_THINKING',
    'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
    'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_REMOTE',
  ]
  const validBoolValues = ['', '0', '1', 'true', 'false', 'yes', 'no', 'on', 'off']
  for (const name of boolVars) {
    const v = process.env[name]
    if (v !== undefined && !validBoolValues.includes(v.toLowerCase().trim())) {
      warnings.push(
        `${name}="${v}" is not a recognized boolean value. Use true/false, 1/0, yes/no, or on/off.`,
      )
    }
  }

  // 4. Numeric env vars with non-numeric values
  const numVars = [
    'API_TIMEOUT_MS', 'CLAUDE_CODE_MAX_RETRIES', 'MAX_STRUCTURED_OUTPUT_RETRIES',
    'CLAUDE_STREAM_IDLE_TIMEOUT_MS', 'RAYU_CONTEXT_TOKENS',
  ]
  for (const name of numVars) {
    const v = process.env[name]
    if (v !== undefined && v !== '' && (isNaN(Number(v)) || Number(v) < 0)) {
      warnings.push(
        `${name}="${v}" is not a valid positive number.`,
      )
    }
  }

  if (warnings.length > 0) {
    process.stderr.write(
      `\n⚠ .env configuration warnings:\n${warnings.map(w => `  • ${w}`).join('\n')}\n\n`,
    )
  }
}

/** Quick check if a string env var evaluates to an active/true boolean. */
function isBoolEnvActive(v: string | undefined): boolean {
  if (!v) return false
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase().trim())
}

/**
 * Pure resolver for the config home dir. Precedence:
 *   1. explicit env (RAYU_CONFIG_DIR preferred, then legacy CLAUDE_CONFIG_DIR)
 *   2. existing ~/.rayu  (Rayu's own config)
 *   3. existing ~/.claude (so existing Claude Code users work out of the box)
 *   4. default ~/.rayu   (fresh installs)
 * Both ~/.rayu and ~/.claude config layouts are therefore supported.
 */
export function resolveConfigHomeDir(
  home: string,
  envDir: string | undefined,
  dirExists: (p: string) => boolean,
): string {
  if (envDir) return envDir
  const rayu = join(home, '.rayu')
  if (dirExists(rayu)) return rayu
  const claude = join(home, '.claude')
  if (dirExists(claude)) return claude
  return rayu
}

// Memoized: 150+ callers, many on hot paths. Keyed off the config-dir env vars
// so tests that change them get a fresh value without explicit cache.clear.
export const getClaudeConfigHomeDir = memoize(
  (): string => {
    return resolveConfigHomeDir(
      homedir(),
      process.env.RAYU_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR,
      existsSync,
    ).normalize('NFC')
  },
  () => process.env.RAYU_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR,
)

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ANTHROPIC_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets CLAUDE_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    process.argv.includes('--bare')
  )
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether RAYU is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
