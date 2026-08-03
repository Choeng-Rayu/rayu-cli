/**
 * Auth gate reporting for RAYU's MCP surface.
 *
 * **This module does not gate anything.** Entitlement enforcement already lives
 * inside the tools themselves — `ImageGenTool.call()` / `VideoGenTool.call()`
 * consult `isPaidFeatureLocked()` / `featureLimitReached()` before doing any
 * work — and the MCP server invokes tools through `tool.call()`, so a host
 * agent inherits exactly the same soft paid-gate, credit accounting and
 * gateway routing as the RAYU TUI. Re-checking here would be a second source of
 * truth that could drift from the first.
 *
 * What was missing is *visibility*: before wiring RAYU into Claude Code or
 * Codex, a user needs to know which of the exposed tools will refuse to run on
 * their current plan. `/rayu-plugin status` reports that, and this module is
 * where the (tool → feature key) mapping lives.
 */

import {
  featureLimitReached,
  isPaidFeatureLocked,
  upgradeTargetLabel,
} from '../../services/rayuAuth/paidFeatureGate.js'
import {
  IMAGE_GEN_FEATURE,
  IMAGE_GEN_LABEL,
  IMAGE_GEN_TOOL_NAME,
} from '../../tools/ImageGenTool/constants.js'
import {
  VIDEO_GEN_FEATURE,
  VIDEO_GEN_LABEL,
  VIDEO_GEN_TOOL_NAME,
} from '../../tools/VideoGenTool/constants.js'

/** MCP-exposed tools whose execution is entitlement-gated, and their keys. */
const GATED_TOOLS: readonly {
  toolName: string
  featureKey: string
  label: string
}[] = [
  {
    toolName: IMAGE_GEN_TOOL_NAME,
    featureKey: IMAGE_GEN_FEATURE,
    label: IMAGE_GEN_LABEL,
  },
  {
    toolName: VIDEO_GEN_TOOL_NAME,
    featureKey: VIDEO_GEN_FEATURE,
    label: VIDEO_GEN_LABEL,
  },
]

export type ToolAuthStatus = {
  toolName: string
  label: string
  /** Plan does not include this feature — `call()` will return an upgrade ask. */
  planLocked: boolean
  /** Plan includes it but the period allowance is spent. */
  limitReached: boolean
}

/**
 * Reports the entitlement state of every billing-gated tool RAYU exposes.
 *
 * Fail-open by construction: `isPaidFeatureLocked` returns false for paid users
 * and for the BYOK / Rayu-OAuth-off path, so a self-hosted user sees everything
 * as available — which is correct, because that is what the tools will do.
 */
export function describeToolAuthRequirements(): ToolAuthStatus[] {
  return GATED_TOOLS.map(({ toolName, featureKey, label }) => ({
    toolName,
    label,
    planLocked: isPaidFeatureLocked(featureKey),
    limitReached: featureLimitReached(featureKey),
  }))
}

/**
 * One-line summary for `/rayu-plugin status`, or `undefined` when nothing is
 * gated (the common case: paid plan or BYOK).
 */
export function summarizeGatedTools(): string | undefined {
  const blocked = describeToolAuthRequirements().filter(
    s => s.planLocked || s.limitReached,
  )
  if (blocked.length === 0) return undefined

  const parts = blocked.map(s =>
    s.planLocked ? `${s.toolName} (plan)` : `${s.toolName} (limit reached)`,
  )
  return `Gated over MCP: ${parts.join(', ')} — unlock with ${upgradeTargetLabel()}`
}
