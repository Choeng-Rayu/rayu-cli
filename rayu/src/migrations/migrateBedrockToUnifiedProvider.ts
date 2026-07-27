// Migrate saved Bedrock providers onto the UNIFIED shape.
//
// Before the unified-provider-format migration, /connect offered three separate
// Bedrock providers, distinguished by a stored `bedrockApi` discriminator:
//   • id 'bedrock'            bedrockApi:'converse'   (AWS Converse API)
//   • id 'bedrock-openai'     bedrockApi:'openai'     (bedrock-mantle Chat)
//   • id 'bedrock-anthropic'  bedrockApi:'anthropic'  (Anthropic Messages)
//
// There is now ONE Bedrock provider whose wire format is chosen per MODEL
// (resolveWireFormat: Claude → Anthropic Messages, everything else → OpenAI
// Chat). This migration therefore:
//   1. drops the `bedrockApi` field, and
//   2. renames the two extra ids onto 'bedrock', merging them into one entry
//      (keeping whichever entry has credentials, preferring the active one), and
//   3. clears the cached `fetchedModels` so the next /model refresh pulls the
//      full unified catalog instead of a half-catalog from one surface.
//
// The Converse API is no longer supported, so a provider that was on Converse
// keeps working for Claude and for the models Bedrock serves over OpenAI Chat,
// but loses access to Converse-only models (Amazon Nova, and Mistral/Cohere/Llama
// where no mantle endpoint exists). That trade-off was accepted when Converse was
// retired.
//
// SECURITY: providers.json holds API keys at mode 0600. This migration takes a
// timestamped backup first, writes atomically (temp file + rename) and preserves
// 0600, so a crash mid-write cannot leave the user without credentials. It is
// idempotent: with no `bedrockApi` field and no legacy ids present it does
// nothing and touches no file.
import { copyFileSync, existsSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from '../utils/envUtils.js'
import {
  _resetRayuConfigCache,
  loadRayuConfig,
  type RayuConfig,
  type RayuProvider,
} from '../utils/rayuConfig.js'
import { reportIssue } from '../utils/rayuDiagnostics.js'

const FILE_NAME = 'providers.json'
const LEGACY_BEDROCK_IDS = ['bedrock-openai', 'bedrock-anthropic'] as const
const UNIFIED_BEDROCK_ID = 'bedrock'

function configPath(): string {
  return join(getRayuConfigHomeDir(), FILE_NAME)
}

/** True when this config still carries pre-migration Bedrock shapes. */
export function needsBedrockUnification(cfg: RayuConfig): boolean {
  return cfg.providers.some(
    p =>
      p.kind === 'bedrock' &&
      (p.bedrockApi !== undefined ||
        (LEGACY_BEDROCK_IDS as readonly string[]).includes(p.id)),
  )
}

/**
 * Merge the Bedrock providers in `cfg` into a single 'bedrock' entry.
 * Pure: returns the new config, so it is directly testable.
 */
export function unifyBedrockProviders(cfg: RayuConfig): RayuConfig {
  const bedrocks = cfg.providers.filter(p => p.kind === 'bedrock')
  if (bedrocks.length === 0) return cfg

  // Prefer the ACTIVE Bedrock entry, then any entry with a key, then the first.
  const preferred =
    bedrocks.find(p => p.id === cfg.activeProvider && !!p.apiKey) ??
    bedrocks.find(p => p.id === cfg.activeProvider) ??
    bedrocks.find(p => !!p.apiKey) ??
    bedrocks[0]!

  const merged: RayuProvider = { ...preferred, id: UNIFIED_BEDROCK_ID }
  delete merged.bedrockApi
  // Fill gaps from the other entries so no credential/region/model setting is
  // silently dropped when two entries are merged.
  for (const other of bedrocks) {
    if (other === preferred) continue
    merged.apiKey ??= other.apiKey
    merged.apiKeys ??= other.apiKeys
    merged.awsRegion ??= other.awsRegion
    merged.baseURL ??= other.baseURL
    merged.defaultModel ??= other.defaultModel
    merged.smallFastModel ??= other.smallFastModel
  }
  // The cached catalog came from ONE surface; drop it so the next refresh pulls
  // the unified Claude + OpenAI-Chat catalog.
  delete merged.fetchedModels

  const wasActiveBedrock = bedrocks.some(p => p.id === cfg.activeProvider)
  return {
    ...cfg,
    providers: [
      ...cfg.providers.filter(p => p.kind !== 'bedrock'),
      merged,
    ],
    ...(wasActiveBedrock ? { activeProvider: UNIFIED_BEDROCK_ID } : {}),
    // A subagent/collaborator pinned to a legacy Bedrock id must follow the rename.
    ...(cfg.subagent &&
    (LEGACY_BEDROCK_IDS as readonly string[]).includes(cfg.subagent.providerId)
      ? { subagent: { ...cfg.subagent, providerId: UNIFIED_BEDROCK_ID } }
      : {}),
  }
}

/**
 * Back up, then atomically rewrite providers.json with the unified Bedrock shape.
 * No-op when nothing needs migrating.
 */
export function migrateBedrockToUnifiedProvider(): void {
  try {
    const path = configPath()
    if (!existsSync(path)) return
    const cfg = loadRayuConfig()
    if (!needsBedrockUnification(cfg)) return

    const next = unifyBedrockProviders(cfg)

    // 1. Timestamped backup. copyFileSync preserves the source mode (0600) on
    //    POSIX, so the backup is never more permissive than the original.
    const backup = `${path}.bak-${Date.now()}`
    copyFileSync(path, backup)

    // 2. Atomic write: temp file in the same directory, then rename.
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(tmp, path)

    // 3. Drop the in-memory cache so the next read sees the migrated config.
    _resetRayuConfigCache()
  } catch (e) {
    // Never let a migration failure block startup — the pre-migration config is
    // still valid (resolveWireFormat honors the legacy bedrockApi field).
    reportIssue(
      'rayu_config.bedrock_migration_failed',
      'Bedrock provider unification failed; leaving providers.json untouched',
      { error: e instanceof Error ? e.message : String(e) },
    )
  }
}
