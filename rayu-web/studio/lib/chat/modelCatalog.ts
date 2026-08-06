import type { ModelInfo } from '~/lib/modules/llm/types';
import { fetchGatewayModels, type GatewayModel } from '~/lib/rayu/gatewayClient';

/**
 * Adapts rayu-gateway's model catalog to the `ModelInfo` shape bolt.diy's UI uses.
 *
 * The two differ in more than field names, and the mismatch is silent: the gateway
 * returns an OpenAI-style `{ data: [{ id, label, contextWindow, ... }] }` while
 * bolt's model picker reads `{ modelList: [{ name, label, provider,
 * maxTokenAllowed }] }`. Handing the raw response to the picker leaves it empty
 * with no error.
 *
 * WHAT "PROVIDER" MEANS NOW
 *
 * In bolt the user picked a provider and then a model from it. The gateway
 * resolves the upstream provider itself from the model code — that is the point of
 * its single-format design — so every hosted model is reported under one synthetic
 * provider. Which upstream actually serves a request is an operational detail the
 * user no longer has to know or choose.
 */

/** Provider label shown for gateway-hosted (credit-billed) models. */
export const RAYU_HOSTED_PROVIDER = 'Rayu';

/** Conservative context window when the admin has not set one on the model. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

export function toModelInfo(model: GatewayModel): ModelInfo {
  return {
    name: model.id,
    label: model.label || model.id,
    provider: RAYU_HOSTED_PROVIDER,
    // Admin-set on the HostedModel row; the picker uses it to budget context.
    maxTokenAllowed: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  };
}

/** Capabilities the chat UI needs in order to disable unusable choices. */
export interface StudioModelCapabilities {
  supportsImage: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  contextWindow: number | null;
}

export interface StudioModelCatalog {
  modelList: ModelInfo[];
  /** Keyed by model id. */
  capabilities: Record<string, StudioModelCapabilities>;
}

/**
 * The models this user's plan allows, already filtered by the gateway.
 *
 * Capabilities are returned alongside so the UI can refuse an unsupported request
 * BEFORE spending credits on it — e.g. greying out a text-only model while an
 * image is attached, rather than surfacing a mid-stream upstream error.
 */
export async function fetchStudioModelCatalog(signal?: AbortSignal): Promise<StudioModelCatalog> {
  const models = await fetchGatewayModels(signal);
  const capabilities: Record<string, StudioModelCapabilities> = {};

  for (const m of models) {
    capabilities[m.id] = {
      supportsImage: Boolean(m.supportsImage),
      supportsTools: Boolean(m.supportsTools),
      supportsReasoning: Boolean(m.supportsReasoning),
      contextWindow: m.contextWindow ?? null,
    };
  }

  return { modelList: models.map(toModelInfo), capabilities };
}
