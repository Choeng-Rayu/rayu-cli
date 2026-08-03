/*
 * Token limits and file-ignore patterns lifted out of bolt.diy's app/lib/.server/llm/constants.ts.
 *
 * They were under `.server/` only because bolt assembled its LLM request in a
 * Remix server route. Rayu Studio builds that request in the BROWSER and streams
 * from rayu-gateway directly, so the same logic is needed client-side. Nothing
 * here touches a server API — it is string and object manipulation.
 */
/*
 * Maximum tokens for response generation (updated for modern model capabilities)
 * This serves as a fallback when model-specific limits are unavailable
 * Modern models like Claude 3.5, GPT-4o, and Gemini Pro support 128k+ tokens
 */
export const MAX_TOKENS = 128000;

/*
 * Provider-specific default completion token limits
 * Used as fallbacks when model doesn't specify maxCompletionTokens
 */
export const PROVIDER_COMPLETION_LIMITS: Record<string, number> = {
  OpenAI: 4096, // Standard GPT models (o1 models have much higher limits)
  Github: 4096, // GitHub Models use OpenAI-compatible limits
  Anthropic: 64000, // Conservative limit for Claude 4 models (Opus: 32k, Sonnet: 64k)
  Google: 8192, // Gemini 1.5 Pro/Flash standard limit
  Cohere: 4000,
  DeepSeek: 8192,
  Groq: 8192,
  HuggingFace: 4096,
  Mistral: 8192,
  Ollama: 8192,
  OpenRouter: 8192,
  Perplexity: 8192,
  Together: 8192,
  xAI: 8192,
  LMStudio: 8192,
  OpenAILike: 8192,
  AmazonBedrock: 8192,
  Hyperbolic: 8192,
};

/*
 * Reasoning models that require maxCompletionTokens instead of maxTokens
 * These models use internal reasoning tokens and have different API parameter requirements
 */
export function isReasoningModel(modelName: string): boolean {
  // bolt.diy logged the outcome of this test on every call; dropped as console noise.
  return /^(o1|o3|gpt-5)/i.test(modelName);
}

// limits the number of model responses that can be returned in a single request
export const MAX_RESPONSE_SEGMENTS = 2;

export interface File {
  type: 'file';
  content: string;
  isBinary: boolean;
  isLocked?: boolean;
  lockedByFolder?: string;
}

export interface Folder {
  type: 'folder';
  isLocked?: boolean;
  lockedByFolder?: string;
}

type Dirent = File | Folder;

export type FileMap = Record<string, Dirent | undefined>;

export const IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  '.next/**',
  'coverage/**',
  '.cache/**',
  '.vscode/**',
  '.idea/**',
  '**/*.log',
  '**/.DS_Store',
  '**/npm-debug.log*',
  '**/yarn-debug.log*',
  '**/yarn-error.log*',
  '**/*lock.json',
  '**/*lock.yml',
];


/**
 * Completion-token budget for a model code.
 *
 * bolt.diy resolved this from a ModelInfo object it had server-side
 * (`maxCompletionTokens`, else a per-provider default). Rayu Studio talks to the
 * gateway, which knows the model's real limits from the admin-managed catalog, so
 * the value here only needs to be a safe request-time ceiling: the gateway
 * rejects or clamps anything beyond the model's actual capability.
 *
 * The per-provider table is still consulted when the model code identifies its
 * family, so a Claude request is not needlessly capped at an OpenAI-sized budget.
 */
export function getCompletionTokenLimit(modelCode: string): number {
  const code = (modelCode ?? '').toLowerCase();

  // Match the model code against the provider families in the table above.
  const family: Array<[RegExp, keyof typeof PROVIDER_COMPLETION_LIMITS]> = [
    [/^claude|sonnet|opus|haiku/, 'Anthropic'],
    [/^gemini/, 'Google'],
    [/^deepseek/, 'DeepSeek'],
    [/^mistral|mixtral/, 'Mistral'],
    [/^grok/, 'xAI'],
    [/^command/, 'Cohere'],
    [/^gpt|^o1|^o3/, 'OpenAI'],
  ];

  for (const [pattern, provider] of family) {
    if (pattern.test(code)) {
      return PROVIDER_COMPLETION_LIMITS[provider];
    }
  }

  // Conservative default, matching bolt's final fallback.
  return Math.min(MAX_TOKENS, 16384);
}
