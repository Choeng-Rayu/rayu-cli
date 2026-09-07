/**
 * Provider setup / BYOK — UI_PARITY flow 19.
 *
 * WHY THIS FLOW MATTERS MORE THAN IT LOOKS
 * Two reported bugs were really one missing feature. "After a reinstall only one
 * model appears, unlike the CLI" and "BYOK must work" are both consequences of the
 * panel having no way to configure a provider: with none configured the engine
 * reports only the default it can reach, while the CLI has `/connect` to add
 * Anthropic, OpenAI, DeepSeek, OpenRouter and the rest.
 *
 * The CLI's `/connect` is `local-jsx` (an Ink wizard), so it can never run in
 * headless mode — see localCommands.ts. The panel therefore has to own the wizard.
 *
 * ONE CONFIG, NOT A COPY
 * Writes go through `upsertProvider` from the shared library built from `rayu/src`,
 * into `~/.rayu/config.json`. Same file, same writer, same validation as the CLI,
 * so a provider added in the panel is immediately usable from `rayu` in a terminal
 * and the two cannot drift.
 *
 * GATED ON RAYU AUTH
 * A provider may only be added once signed in. That is a product rule, enforced in
 * the extension host rather than the webview so it cannot be bypassed by posting a
 * message.
 */

/** A provider the wizard can configure without free-form input. */
export type ByokPreset = {
  /** Stable provider id written to config; matches the CLI's ids. */
  readonly id: string;
  /** The wire/auth family the request path uses. */
  readonly kind: string;
  /** Shown in the picker. */
  readonly label: string;
  /** What the user is getting, shown as picker detail. */
  readonly detail: string;
  /** Preset endpoint. Undefined for first-party Anthropic, which needs none. */
  readonly baseURL?: string;
  /** A sensible default model so the session is usable immediately. */
  readonly defaultModel?: string;
  /** Where to get a key, shown in the key prompt. */
  readonly keyHint: string;
};

/**
 * The presets offered, mirroring the providers the CLI supports.
 *
 * Kinds are real `ProviderKind` values from `rayu/src/utils/rayuConfig.ts`, so the
 * request path treats these exactly as it treats CLI-configured providers.
 */
export const BYOK_PRESETS: readonly ByokPreset[] = [
  {
    id: "anthropic",
    kind: "anthropic",
    label: "Anthropic",
    detail: "Claude models with a Console API key",
    defaultModel: "claude-sonnet-4-5",
    keyHint: "console.anthropic.com → API keys (starts with sk-ant-)",
  },
  {
    id: "openai",
    kind: "openai-compatible",
    label: "OpenAI",
    detail: "GPT models",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    keyHint: "platform.openai.com → API keys (starts with sk-)",
  },
  {
    id: "deepseek",
    kind: "openai-compatible",
    label: "DeepSeek",
    detail: "DeepSeek chat and reasoning models",
    baseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    keyHint: "platform.deepseek.com → API keys",
  },
  {
    id: "openrouter",
    kind: "openai-compatible",
    label: "OpenRouter",
    detail: "Many models behind one key",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.5",
    keyHint: "openrouter.ai → Keys",
  },
  {
    id: "groq",
    kind: "openai-compatible",
    label: "Groq",
    detail: "Fast open models",
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyHint: "console.groq.com → API keys",
  },
  {
    id: "local",
    kind: "openai-compatible",
    label: "Local (Ollama / LM Studio)",
    detail: "A model running on this machine — no key needed",
    baseURL: "http://localhost:11434/v1",
    defaultModel: "qwen2.5-coder",
    keyHint: "not required for a local server",
  },
];

/** Whether a preset needs an API key, so the wizard does not demand one wrongly. */
export function requiresApiKey(preset: ByokPreset): boolean {
  // A local server accepts any or no credential; demanding one would block a
  // legitimate, and free, setup.
  return preset.id !== "local";
}

/**
 * Validate an API key before it is written.
 *
 * Returns null when acceptable, otherwise the reason. Deliberately permissive about
 * FORMAT — providers change their prefixes, and rejecting a valid key is worse than
 * passing a bad one to a request that will report the real error. Only genuinely
 * unusable input is refused.
 */
export function validateApiKey(preset: ByokPreset, key: string): string | null {
  if (!requiresApiKey(preset)) return null;
  const trimmed = key.trim();
  if (trimmed.length === 0) return "An API key is required.";
  // Whitespace inside a key is always a paste accident (a wrapped line, or a copied
  // "Bearer " prefix) and otherwise surfaces as a confusing 401 much later.
  if (/\s/.test(trimmed)) {
    return "That looks like it contains a space or line break — paste just the key.";
  }
  if (trimmed.length < 8) return "That key looks too short to be valid.";
  return null;
}

/** A provider record ready for `upsertProvider`. */
export type ProviderRecord = {
  id: string;
  kind: string;
  label?: string;
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
};

/**
 * Build the record written to `~/.rayu/config.json`.
 *
 * Pure, so the mapping from wizard answers to stored configuration is testable
 * without touching the filesystem or VS Code.
 */
export function buildProviderRecord(
  preset: ByokPreset,
  apiKey: string,
  model?: string,
): ProviderRecord {
  const record: ProviderRecord = {
    id: preset.id,
    kind: preset.kind,
    label: preset.label,
  };
  // Omit rather than store an empty string: a present-but-empty apiKey reads as
  // "configured" to every consumer and then fails at request time instead of here.
  const trimmedKey = apiKey.trim();
  if (trimmedKey.length > 0) record.apiKey = trimmedKey;
  if (preset.baseURL !== undefined) record.baseURL = preset.baseURL;
  const chosenModel = model?.trim();
  const effectiveModel =
    chosenModel !== undefined && chosenModel.length > 0
      ? chosenModel
      : preset.defaultModel;
  if (effectiveModel !== undefined) record.defaultModel = effectiveModel;
  return record;
}

/** What the wizard needs from its environment, injected so it is testable. */
export type ProviderSetupDeps = {
  /** True when a Rayu session exists. BYOK is gated behind signing in. */
  readonly isSignedIn: () => boolean;
  /** Offer the presets; resolves undefined when dismissed. */
  readonly pickPreset: (
    presets: readonly ByokPreset[],
  ) => Promise<ByokPreset | undefined>;
  /** Prompt for the key; resolves undefined when dismissed. */
  readonly promptApiKey: (preset: ByokPreset) => Promise<string | undefined>;
  /** Prompt for a model, pre-filled with the preset default. */
  readonly promptModel: (preset: ByokPreset) => Promise<string | undefined>;
  /** Persist through the shared library. */
  readonly saveProvider: (record: ProviderRecord) => void;
  /** Tell the user what happened. */
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  /** Offer to sign in when the gate blocks setup. */
  readonly offerSignIn: () => void;
  /** Re-fetch models so the new provider's models appear immediately. */
  readonly refreshModels: () => void;
};

/** The outcome, so callers and tests can assert without reading the UI. */
export type ProviderSetupOutcome =
  | { status: "saved"; providerId: string }
  | { status: "cancelled" }
  | { status: "blocked"; reason: string };

/**
 * Run the BYOK wizard.
 *
 * Each step may be dismissed, and dismissing must leave configuration untouched —
 * a half-written provider is worse than none, because it reads as configured and
 * then fails on every request.
 */
export async function runProviderSetup(
  deps: ProviderSetupDeps,
): Promise<ProviderSetupOutcome> {
  if (!deps.isSignedIn()) {
    // The product rule: Rayu Auth first, then BYOK.
    const reason =
      "Sign in to Rayu before adding a provider. Your own API keys stay on this machine.";
    deps.warn(reason);
    deps.offerSignIn();
    return { status: "blocked", reason };
  }

  const preset = await deps.pickPreset(BYOK_PRESETS);
  if (!preset) return { status: "cancelled" };

  let apiKey = "";
  if (requiresApiKey(preset)) {
    const entered = await deps.promptApiKey(preset);
    if (entered === undefined) return { status: "cancelled" };
    const problem = validateApiKey(preset, entered);
    if (problem !== null) {
      deps.warn(problem);
      return { status: "blocked", reason: problem };
    }
    apiKey = entered;
  }

  const model = await deps.promptModel(preset);
  // A dismissed model prompt is not a cancellation — the preset default is a fine
  // answer, and forcing the choice adds a step for no benefit.
  const record = buildProviderRecord(preset, apiKey, model);

  try {
    deps.saveProvider(record);
  } catch (error) {
    const reason = `Could not save the provider: ${
      error instanceof Error ? error.message : String(error)
    }`;
    deps.warn(reason);
    return { status: "blocked", reason };
  }

  deps.info(
    `${preset.label} is now the active provider${
      record.defaultModel !== undefined ? ` (${record.defaultModel})` : ""
    }. It is shared with the rayu CLI.`,
  );
  // Without this the picker keeps showing the old provider's models until reload,
  // which reads as "BYOK did nothing".
  deps.refreshModels();
  return { status: "saved", providerId: record.id };
}
