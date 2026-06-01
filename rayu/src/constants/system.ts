// Critical system constants extracted to break circular dependencies

import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { getWorkload } from '../utils/workloadContext.js'

// Brand identity: the assistant presents itself as the active model, operated
// as the official CLI by Choeng Rayu.
function rayuIdentity(model?: string): string {
  const name = model?.trim() ? model : 'an AI assistant'
  return `You are ${name}, the official CLI powered by Choeng Rayu.`
}
const AGENT_SDK_PREFIX = `You are an AI agent, the official CLI powered by Choeng Rayu.`

export type CLISyspromptPrefix = string

/**
 * Fixed sysprompt prefixes used by splitSysPromptPrefix to identify prefix
 * blocks by content for cache scoping. The model-aware identity is dynamic so
 * it is not listed here (it is handled as a normal block).
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set([
  AGENT_SDK_PREFIX,
])

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
  model?: string
}): CLISyspromptPrefix {
  if (getAPIProvider() === 'vertex') {
    return rayuIdentity(options?.model)
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return `${rayuIdentity(options?.model)} Running within the agent SDK.`
    }
    return AGENT_SDK_PREFIX
  }
  return rayuIdentity(options?.model)
}

/**
 * Check if attribution header is enabled.
 * Enabled by default, can be disabled via env var or GrowthBook killswitch.
 */
function isAttributionHeaderEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_attribution_header', true)
}

/**
 * Get attribution header for API requests.
 * Returns a header string with cc_version (including fingerprint) and cc_entrypoint.
 * Enabled by default, can be disabled via env var or GrowthBook killswitch.
 *
 * When NATIVE_CLIENT_ATTESTATION is enabled, includes a `cch=00000` placeholder.
 * Before the request is sent, Bun's native HTTP stack finds this placeholder
 * in the request body and overwrites the zeros with a computed hash. The
 * server verifies this token to confirm the request came from a real Claude
 * Code client. See bun-anthropic/src/http/Attestation.zig for implementation.
 *
 * We use a placeholder (instead of injecting from Zig) because same-length
 * replacement avoids Content-Length changes and buffer reallocation.
 */
export function getAttributionHeader(fingerprint: string): string {
  if (!isAttributionHeaderEnabled()) {
    return ''
  }

  const version = `${MACRO.VERSION}.${fingerprint}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'

  // cch=00000 placeholder is overwritten by Bun's HTTP stack with attestation token
  const cch = feature('NATIVE_CLIENT_ATTESTATION') ? ' cch=00000;' : ''
  // cc_workload: turn-scoped hint so the API can route e.g. cron-initiated
  // requests to a lower QoS pool. Absent = interactive default. Safe re:
  // fingerprint (computed from msg chars + version only, line 78 above) and
  // cch attestation (placeholder overwritten in serialized body bytes after
  // this string is built). Server _parse_cc_header tolerates unknown extra
  // fields so old API deploys silently ignore this.
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`

  logForDebugging(`attribution header ${header}`)
  return header
}
