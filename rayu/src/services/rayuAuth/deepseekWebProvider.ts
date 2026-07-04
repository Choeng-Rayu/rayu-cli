// Syncs the "deepseek-web" provider based on the user's plan entitlements.
//
// When USE_DEEPSEEK_OAUTH is enabled and the user has a paid plan (Basic+), the
// deepseek-web provider is registered so users can access deepseek-v4-pro-1m via
// chat.deepseek.com's browser-auth flow. When the plan is Free or OAuth is off,
// the provider is removed.
//
// Auth creds are read from env vars (DEEPSEEK_OAUTH_WEB_TOKEN,
// DEEPSEEK_OAUTH_WEB_COOKIE, DEEPSEEK_OAUTH_WEB_MODEL) or entered via /connect.
// The userToken is stored as provider.apiKey; the cookie is read from env at
// request time (never persisted — it ages and must be re-copied from browser).
import {
  loadRayuConfig,
  saveRayuConfig,
  type RayuProvider,
} from '../../utils/rayuConfig.js'
import type { RayuEntitlements } from './rayuEntitlements.js'
import { isUseDeepseekOAuthEnabled } from './rayuSession.js'

const DEEPSEEK_WEB_PROVIDER_ID = 'deepseek-web'

function defaultModel(): string {
  return process.env.DEEPSEEK_OAUTH_WEB_MODEL || 'deepseek-v4-pro-1m'
}

function envToken(): string | undefined {
  const t = process.env.DEEPSEEK_OAUTH_WEB_TOKEN?.trim()
  return t || undefined
}

/**
 * Reconcile the deepseek-web provider with entitlements. Only visible to paid
 * users (Basic plan and up). Free users never see the deepseek-web provider.
 */
export function syncDeepseekWebProvider(
  ent: RayuEntitlements | null,
  opts?: { activate?: boolean },
): void {
  try {
    const cfg = loadRayuConfig()
    const idx = cfg.providers.findIndex(
      (p) => p.id === DEEPSEEK_WEB_PROVIDER_ID,
    )

    // Gate: both USE_RAYU_OAUTH and USE_DEEPSEEK_OAUTH must be true.
    if (!isUseDeepseekOAuthEnabled()) {
      if (idx >= 0) {
        cfg.providers.splice(idx, 1)
        if (cfg.activeProvider === DEEPSEEK_WEB_PROVIDER_ID) {
          cfg.activeProvider = cfg.providers[0]?.id
        }
        saveRayuConfig(cfg)
      }
      return
    }

    const isPaidPlan =
      ent?.plan?.code && ent.plan.code !== 'free' &&
      ent?.plan?.priceCents != null && ent.plan.priceCents > 0

    if (isPaidPlan) {
      // Paid plan: upsert the provider, auto-importing the env token if set.
      const existing = idx >= 0 ? cfg.providers[idx] : undefined
      const model = defaultModel()
      const provider: RayuProvider = {
        ...existing,
        id: DEEPSEEK_WEB_PROVIDER_ID,
        kind: 'deepseek-web',
        defaultModel: existing?.defaultModel || model,
        smallFastModel: existing?.smallFastModel || model,
        models: [model],
        fetchedModels: [model],
        // Auto-import the token from env if not already configured.
        apiKey: existing?.apiKey || envToken(),
      }
      if (idx >= 0) {
        cfg.providers[idx] = provider
      } else {
        cfg.providers.push(provider)
      }
      if (opts?.activate) {
        cfg.activeProvider = DEEPSEEK_WEB_PROVIDER_ID
      }
      saveRayuConfig(cfg)
      return
    }

    // Free plan or unknown: remove the provider if it was previously registered.
    if (idx >= 0) {
      cfg.providers.splice(idx, 1)
      if (cfg.activeProvider === DEEPSEEK_WEB_PROVIDER_ID) {
        cfg.activeProvider = cfg.providers[0]?.id
      }
      saveRayuConfig(cfg)
    }
  } catch {
    // best-effort: provider sync must never break the login/entitlements flow
  }
}
