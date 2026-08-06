import type { IProviderSetting } from '~/types/model';

export interface ModelInfo {
  name: string;
  label: string;
  provider: string;

  /** Maximum context window size (input tokens) - how many tokens the model can process */
  maxTokenAllowed: number;

  /** Maximum completion/output tokens - how many tokens the model can generate. If not specified, falls back to provider defaults */
  maxCompletionTokens?: number;
}

export interface ProviderInfo {
  name: string;
  staticModels: ModelInfo[];
  getDynamicModels?: (
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv?: Record<string, string>,
  ) => Promise<ModelInfo[]>;
  /*
   * NOTE: bolt.diy also required `getModelInstance()` here, returning a Vercel AI
   * SDK LanguageModelV1 for a server-side streamText() call. Rayu Studio has no
   * server route of its own — the browser streams from rayu-gateway directly — so
   * no model instance is ever constructed and the member was removed along with
   * the 11 @ai-sdk provider packages it required. What remains is the provider
   * CATALOG, which the settings UI and model picker do use.
   */
  getApiKeyLink?: string;
  labelForGetApiKey?: string;
  icon?: string;
}
export interface ProviderConfig {
  baseUrlKey?: string;
  baseUrl?: string;
  apiTokenKey?: string;
}
