/**
 * Provider setup / BYOK — UI_PARITY flow 19.
 *
 * WHAT THESE TESTS PROTECT
 * Two reported problems were one missing feature: "after a reinstall only one model
 * appears" and "BYOK must work". With no provider configured the engine reports only
 * the default it can reach, and the panel had no way to add one — the CLI's
 * `/connect` is `local-jsx` and so absent from the headless registry.
 *
 * The rules pinned here are the ones that would silently corrupt configuration or
 * leak a credential if they regressed:
 *   - Rayu Auth gates BYOK (a product rule);
 *   - dismissing any step writes NOTHING, because a half-written provider reads as
 *     configured and then fails on every request;
 *   - an empty apiKey is omitted, never stored as "";
 *   - models are refreshed after a save, or BYOK appears to have done nothing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  BYOK_PRESETS,
  buildProviderRecord,
  requiresApiKey,
  runProviderSetup,
  validateApiKey,
  type ByokPreset,
  type ProviderRecord,
  type ProviderSetupDeps,
} from "../src/providerSetup.js";

const anthropic = BYOK_PRESETS.find((p) => p.id === "anthropic") as ByokPreset;
const local = BYOK_PRESETS.find((p) => p.id === "local") as ByokPreset;
const openai = BYOK_PRESETS.find((p) => p.id === "openai") as ByokPreset;

/** A wizard environment that succeeds, with each step overridable. */
function deps(overrides: Partial<ProviderSetupDeps> = {}): {
  deps: ProviderSetupDeps;
  saved: ProviderRecord[];
  warnings: string[];
  refreshed: () => number;
} {
  const saved: ProviderRecord[] = [];
  const warnings: string[] = [];
  let refreshes = 0;
  const base: ProviderSetupDeps = {
    isSignedIn: () => true,
    pickPreset: async () => anthropic,
    promptApiKey: async () => "sk-ant-abcdefghijklmnop",
    promptModel: async () => "",
    saveProvider: (record) => void saved.push(record),
    info: () => undefined,
    warn: (m) => void warnings.push(m),
    offerSignIn: () => undefined,
    refreshModels: () => void (refreshes += 1),
  };
  return {
    deps: { ...base, ...overrides },
    saved,
    warnings,
    refreshed: () => refreshes,
  };
}

describe("BYOK is gated behind Rayu Auth", () => {
  it("refuses setup when signed out and offers to sign in", async () => {
    const offerSignIn = vi.fn();
    const env = deps({ isSignedIn: () => false, offerSignIn });
    const outcome = await runProviderSetup(env.deps);

    expect(outcome.status).toBe("blocked");
    expect(offerSignIn).toHaveBeenCalledOnce();
    // Nothing written: the gate must precede every prompt.
    expect(env.saved).toEqual([]);
  });

  it("never prompts for a key when signed out", async () => {
    // A credential must not be collected only to be discarded by the gate.
    const promptApiKey = vi.fn(async () => "sk-ant-should-not-be-asked");
    const env = deps({ isSignedIn: () => false, promptApiKey });
    await runProviderSetup(env.deps);
    expect(promptApiKey).not.toHaveBeenCalled();
  });
});

describe("dismissing any step leaves configuration untouched", () => {
  it("a dismissed provider picker writes nothing", async () => {
    const env = deps({ pickPreset: async () => undefined });
    expect((await runProviderSetup(env.deps)).status).toBe("cancelled");
    expect(env.saved).toEqual([]);
  });

  it("a dismissed key prompt writes nothing", async () => {
    // Escape at the key box must not save a provider with no credential — it would
    // read as configured and fail on every request.
    const env = deps({ promptApiKey: async () => undefined });
    expect((await runProviderSetup(env.deps)).status).toBe("cancelled");
    expect(env.saved).toEqual([]);
  });

  it("a dismissed MODEL prompt still saves, using the preset default", async () => {
    // Not a cancellation: the default is a fine answer and forcing the choice adds
    // a step for no benefit.
    const env = deps({ promptModel: async () => undefined });
    const outcome = await runProviderSetup(env.deps);
    expect(outcome).toEqual({ status: "saved", providerId: "anthropic" });
    expect(env.saved[0]?.defaultModel).toBe(anthropic.defaultModel);
  });
});

describe("key validation refuses only genuinely unusable input", () => {
  it("rejects an empty key", () => {
    expect(validateApiKey(anthropic, "")).toContain("required");
    expect(validateApiKey(anthropic, "   ")).toContain("required");
  });

  it("rejects a key containing whitespace, which is always a paste accident", () => {
    expect(validateApiKey(anthropic, "Bearer sk-ant-abcdefgh")).toContain("space");
    expect(validateApiKey(anthropic, "sk-ant-abc\ndef")).toContain("space");
  });

  it("rejects an implausibly short key", () => {
    expect(validateApiKey(anthropic, "sk-1")).toContain("short");
  });

  it("accepts an unfamiliar PREFIX", () => {
    // Providers change prefixes; rejecting a valid key is worse than letting the
    // request report the real error.
    expect(validateApiKey(openai, "future-format-0123456789")).toBeNull();
  });

  it("requires no key for a local server", () => {
    expect(requiresApiKey(local)).toBe(false);
    expect(validateApiKey(local, "")).toBeNull();
  });

  it("blocks the save when validation fails", async () => {
    const env = deps({ promptApiKey: async () => "short" });
    expect((await runProviderSetup(env.deps)).status).toBe("blocked");
    expect(env.saved).toEqual([]);
    expect(env.warnings.join(" ")).toContain("short");
  });
});

describe("the stored record", () => {
  it("omits apiKey entirely rather than storing an empty string", () => {
    // A present-but-empty key reads as "configured" to every consumer.
    const record = buildProviderRecord(local, "   ");
    expect("apiKey" in record).toBe(false);
  });

  it("carries the preset endpoint and the chosen model", () => {
    const record = buildProviderRecord(openai, "sk-abcdefghij", "gpt-4o-mini");
    expect(record).toEqual({
      id: "openai",
      kind: "openai-compatible",
      label: "OpenAI",
      apiKey: "sk-abcdefghij",
      baseURL: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini",
    });
  });

  it("sets no baseURL for first-party Anthropic", () => {
    // The request path uses its own endpoint for kind:'anthropic'; inventing one
    // here would override it.
    expect("baseURL" in buildProviderRecord(anthropic, "sk-ant-abcdefghij")).toBe(
      false,
    );
  });

  it("trims a pasted key", () => {
    expect(buildProviderRecord(openai, "  sk-abcdefghij  ").apiKey).toBe(
      "sk-abcdefghij",
    );
  });

  it("falls back to the preset default for a blank model", () => {
    expect(buildProviderRecord(openai, "sk-abcdefghij", "   ").defaultModel).toBe(
      "gpt-4o",
    );
  });
});

describe("after a successful save", () => {
  it("refreshes models so the new provider's models appear at once", async () => {
    // Without this the picker keeps showing the old provider's models until
    // reload, which reads as "BYOK did nothing".
    const env = deps();
    await runProviderSetup(env.deps);
    expect(env.refreshed()).toBe(1);
  });

  it("reports a save failure instead of claiming success", async () => {
    const env = deps({
      saveProvider: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const outcome = await runProviderSetup(env.deps);
    expect(outcome.status).toBe("blocked");
    expect(env.warnings.join(" ")).toContain("EACCES");
    expect(env.refreshed()).toBe(0);
  });
});

describe("the preset list", () => {
  it("offers the providers the CLI supports, with real ProviderKind values", () => {
    // A kind outside rayu/src/utils/rayuConfig.ts's ProviderKind union would be
    // written to shared config and break the CLI too.
    const validKinds = new Set([
      "anthropic",
      "anthropic-compatible",
      "openai-compatible",
      "bedrock",
      "azure",
      "vertex",
      "genai",
      "kiro",
      "copilot",
      "rayu-hosted",
      "custom",
    ]);
    expect(BYOK_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const preset of BYOK_PRESETS) {
      expect(validKinds.has(preset.kind), `${preset.id}: ${preset.kind}`).toBe(true);
    }
  });

  it("gives every preset a default model, so a session is usable immediately", () => {
    for (const preset of BYOK_PRESETS) {
      expect(preset.defaultModel, preset.id).toBeTruthy();
    }
  });

  it("uses unique ids, so one preset cannot overwrite another", () => {
    const ids = BYOK_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
