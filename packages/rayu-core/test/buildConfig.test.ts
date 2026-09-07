/**
 * Build-configuration tests — RAYU_CORE_MIGRATION_PLAN.md Task 3.
 *
 * The two resolution layers use DIFFERENT operators and DIFFERENT fallbacks, and
 * getting either wrong silently repoints the CLI at the wrong server. So both
 * are pinned here across the full env permutation matrix, including the two
 * irregularities that make them non-interchangeable:
 *
 *   - build time uses `??`, so `RAYU_BUILD_WEB_URL=""` bakes an empty string;
 *   - run time uses `||`, so `RAYU_WEB_URL=""` falls through to the baked value.
 *
 * A drift test on the rayu side (rayu/test/buildConfigParity.test.ts) asserts
 * these functions still agree with scripts/macroValues.ts.
 */
import { describe, expect, test } from "vitest";
import {
  BUILD_CONFIG_KEYS,
  BUILD_TIME_DEFAULTS,
  RUNTIME_FALLBACKS,
  getBakedBuildConfig,
  isEnvTruthy,
  resolveBuildConfig,
  resolveEndpoints,
  type BuildConfig,
} from "../src/index.js";

const VERSION = "1.2.3";

describe("resolveBuildConfig — the build-time layer", () => {
  test("resolves all 11 values with an empty environment", () => {
    const c = resolveBuildConfig({}, VERSION);
    expect(Object.keys(c).sort()).toEqual([...BUILD_CONFIG_KEYS].sort());
    expect(Object.keys(c)).toHaveLength(11);
    expect(c).toEqual({
      VERSION,
      BUILD_TIME: "",
      PACKAGE_URL: "@rayu-dev/rayu-cli",
      NATIVE_PACKAGE_URL: "@rayu-dev/rayu-cli",
      FEEDBACK_CHANNEL: "https://github.com/Choeng-Rayu/rayu-cli/issues",
      ISSUES_EXPLAINER:
        "report the issue at https://github.com/Choeng-Rayu/rayu-cli/issues",
      VERSION_CHANGELOG: "",
      // The shipped default is ON: a fresh build requires Rayu login.
      RAYU_OAUTH_DEFAULT: "true",
      RAYU_API_URL: "https://api.rayucode.com/api",
      RAYU_WEB_URL: "https://rayucode.com",
      RAYU_GATEWAY_URL: "https://gateway.rayucode.com",
    });
  });

  test("the three production endpoints are the documented hosts", () => {
    const c = resolveBuildConfig({}, VERSION);
    expect(c.RAYU_API_URL).toBe("https://api.rayucode.com/api");
    expect(c.RAYU_WEB_URL).toBe("https://rayucode.com");
    expect(c.RAYU_GATEWAY_URL).toBe("https://gateway.rayucode.com");
  });

  test.each([
    ["RAYU_BUILD_OAUTH", "USE_RAYU_OAUTH", "RAYU_OAUTH_DEFAULT", "true"],
    ["RAYU_BUILD_API_URL", "RAYU_API_URL", "RAYU_API_URL", "https://api.rayucode.com/api"],
    ["RAYU_BUILD_WEB_URL", "RAYU_WEB_URL", "RAYU_WEB_URL", "https://rayucode.com"],
    [
      "RAYU_BUILD_GATEWAY_URL",
      "RAYU_GATEWAY_URL",
      "RAYU_GATEWAY_URL",
      "https://gateway.rayucode.com",
    ],
  ] as const)(
    "%s beats %s beats the literal default, for %s",
    (buildVar, plainVar, key, literal) => {
      // build var wins over both
      expect(
        resolveBuildConfig({ [buildVar]: "FROM_BUILD", [plainVar]: "FROM_PLAIN" }, VERSION)[
          key as keyof BuildConfig
        ],
      ).toBe("FROM_BUILD");
      // plain var wins over the literal
      expect(
        resolveBuildConfig({ [plainVar]: "FROM_PLAIN" }, VERSION)[key as keyof BuildConfig],
      ).toBe("FROM_PLAIN");
      // neither → literal
      expect(resolveBuildConfig({}, VERSION)[key as keyof BuildConfig]).toBe(literal);
    },
  );

  test("uses ?? not ||, so an explicitly empty build var is honoured", () => {
    // An operator setting RAYU_BUILD_WEB_URL="" means "bake an empty string",
    // not "fall back to production". `||` would silently produce the latter.
    const c = resolveBuildConfig({ RAYU_BUILD_WEB_URL: "" }, VERSION);
    expect(c.RAYU_WEB_URL).toBe("");
    const d = resolveBuildConfig({ RAYU_BUILD_OAUTH: "" }, VERSION);
    expect(d.RAYU_OAUTH_DEFAULT).toBe("");
  });

  test("undefined is skipped, so an unset build var defers to the plain var", () => {
    const c = resolveBuildConfig(
      { RAYU_BUILD_API_URL: undefined, RAYU_API_URL: "http://plain" },
      VERSION,
    );
    expect(c.RAYU_API_URL).toBe("http://plain");
  });

  test("VERSION is injected, never read from a package.json", () => {
    // Core is a sibling of the CLI, not a child; reaching into
    // rayu/package.json would invert the dependency direction.
    expect(resolveBuildConfig({}, "9.9.9").VERSION).toBe("9.9.9");
  });
});

describe("resolveEndpoints — the run-time layer", () => {
  test("falls back to LOCALHOST, not production, when nothing is baked", () => {
    // This asymmetry is the whole reason the two layers are separate functions:
    // a from-source run with no baked MACRO must hit the developer's own stack.
    expect(resolveEndpoints({})).toEqual({
      apiBaseUrl: "http://localhost:4000/api",
      webBaseUrl: "http://localhost:3000",
      gatewayBaseUrl: "http://localhost:8080",
    });
    expect(RUNTIME_FALLBACKS.RAYU_API_URL).toBe("http://localhost:4000/api");
  });

  test("runtime env beats the baked value beats localhost", () => {
    const baked = resolveBuildConfig({}, VERSION);
    expect(resolveEndpoints({}, baked).apiBaseUrl).toBe(
      "https://api.rayucode.com/api",
    );
    expect(
      resolveEndpoints({ RAYU_API_URL: "http://dev:1234/api" }, baked).apiBaseUrl,
    ).toBe("http://dev:1234/api");
  });

  test("uses || not ??, so an empty runtime var falls through to the baked value", () => {
    // Opposite of the build layer. Asserted explicitly because swapping the
    // operators would look harmless and change which host is contacted.
    const baked = resolveBuildConfig({}, VERSION);
    expect(resolveEndpoints({ RAYU_WEB_URL: "" }, baked).webBaseUrl).toBe(
      "https://rayucode.com",
    );
    expect(resolveEndpoints({ RAYU_WEB_URL: "" }).webBaseUrl).toBe(
      "http://localhost:3000",
    );
  });

  test("strips exactly one trailing slash", () => {
    expect(resolveEndpoints({ RAYU_API_URL: "https://x/api/" }).apiBaseUrl).toBe(
      "https://x/api",
    );
    // Only one, matching /\/$/ in rayuSession.ts — a double slash keeps one.
    expect(resolveEndpoints({ RAYU_API_URL: "https://x/api//" }).apiBaseUrl).toBe(
      "https://x/api/",
    );
    expect(resolveEndpoints({ RAYU_API_URL: "https://x/api" }).apiBaseUrl).toBe(
      "https://x/api",
    );
  });

  test("each endpoint reads only its own env var", () => {
    const r = resolveEndpoints({
      RAYU_API_URL: "http://a",
      RAYU_WEB_URL: "http://w",
      RAYU_GATEWAY_URL: "http://g",
    });
    expect(r).toEqual({
      apiBaseUrl: "http://a",
      webBaseUrl: "http://w",
      gatewayBaseUrl: "http://g",
    });
  });
});

describe("isEnvTruthy is an allowlist, not a negation", () => {
  test.each(["1", "true", "TRUE", "yes", "on", " true ", "On"])("%s is truthy", (v) => {
    expect(isEnvTruthy(v)).toBe(true);
  });

  test.each(["0", "false", "no", "off", "", "maybe", "2"])("%s is falsy", (v) => {
    expect(isEnvTruthy(v)).toBe(false);
  });

  test("booleans pass through and undefined is false", () => {
    expect(isEnvTruthy(true)).toBe(true);
    expect(isEnvTruthy(false)).toBe(false);
    expect(isEnvTruthy(undefined)).toBe(false);
  });
});

describe("getBakedBuildConfig", () => {
  test("returns undefined under plain Node with no globals", () => {
    // The VS Code extension case: no --define, no preload. Must not throw on the
    // undeclared identifier.
    const prior = (globalThis as { MACRO?: unknown }).MACRO;
    delete (globalThis as { MACRO?: unknown }).MACRO;
    try {
      expect(getBakedBuildConfig()).toBeUndefined();
    } finally {
      if (prior !== undefined) (globalThis as { MACRO?: unknown }).MACRO = prior;
    }
  });

  test("reads globalThis.MACRO, which is what the dev/test preload sets", () => {
    const prior = (globalThis as { MACRO?: unknown }).MACRO;
    (globalThis as { MACRO?: unknown }).MACRO = { RAYU_API_URL: "http://from-global" };
    try {
      expect(getBakedBuildConfig()?.RAYU_API_URL).toBe("http://from-global");
    } finally {
      if (prior === undefined) delete (globalThis as { MACRO?: unknown }).MACRO;
      else (globalThis as { MACRO?: unknown }).MACRO = prior;
    }
  });
});
