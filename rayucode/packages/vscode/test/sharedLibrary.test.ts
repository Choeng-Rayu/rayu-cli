/**
 * The extension consumes `rayu/src` — one source tree, two consumers.
 *
 * See RAYU_LIBRARY_SURFACE_DESIGN.md. `rayu` emits a second Bun bundle,
 * `dist/rayu-lib.js`, from `src/entrypoints/library.ts` using the CLI's exact
 * build configuration. The extension imports it as `@rayu-dev/rayu-cli/lib`, so
 * auth and endpoint resolution run the SAME code as the CLI instead of a
 * re-implementation. `rayu/src` was not restructured to achieve this.
 *
 * Why this matters beyond deduplication: the extension's previous local
 * endpoint helpers could not see the CLI's baked `MACRO.*` values, so a packaged
 * extension resolved `localhost:4000` where the packaged CLI resolved the baked
 * production host. Those are different servers.
 */
import { describe, expect, it } from "vitest";

import { getBakedBuildConfig, resolveEndpoints } from "@rayu-dev/rayu-cli/lib";

import { rayuApiBaseUrl, rayuWebBaseUrl } from "../src/rayuSession.js";

describe("the shared library surface is importable from the extension", () => {
  it("exposes the CLI's auth and config functions", async () => {
    const lib = await import("@rayu-dev/rayu-cli/lib");
    for (const name of [
      "readRayuSession",
      "writeRayuSession",
      "hasRayuSession",
      "clearRayuSession",
      "getValidRayuAccessToken",
      "getRayuApiBaseUrl",
      "getRayuWebBaseUrl",
      "getRayuGatewayBaseUrl",
      "isUseRayuOAuthEnabled",
      "resolveEndpoints",
      "getBakedBuildConfig",
    ]) {
      expect(typeof (lib as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("carries no terminal UI — it is a tree-shaken surface, not the CLI", async () => {
    // The library entry's import closure is 2037 files and includes the React UI,
    // because 74% of rayu/src sits in one import cycle. Bun tree-shakes at the
    // symbol level, so only what the exports reach survives. If React ever
    // appears here, an export was widened past the boundary.
    const lib = (await import("@rayu-dev/rayu-cli/lib")) as Record<string, unknown>;
    expect(lib.createElement).toBeUndefined();
    expect(lib.render).toBeUndefined();
    expect(lib.useState).toBeUndefined();
  });
});

describe("endpoint resolution is one code path, not two", () => {
  it("the extension's helpers delegate to the shared library", () => {
    const env = { RAYU_API_URL: "http://from-env:1/api", RAYU_WEB_URL: "http://from-env:2" };
    expect(rayuApiBaseUrl(env)).toBe(resolveEndpoints(env, getBakedBuildConfig()).apiBaseUrl);
    expect(rayuWebBaseUrl(env)).toBe(resolveEndpoints(env, getBakedBuildConfig()).webBaseUrl);
  });

  it("runtime env still wins, so a workspace .env override keeps working", () => {
    // childEnv in extension.ts is `{...process.env, ...dotEnv}`, so this
    // precedence is load-bearing and not merely a test convenience.
    expect(rayuApiBaseUrl({ RAYU_API_URL: "http://custom/api" })).toBe("http://custom/api");
    expect(rayuWebBaseUrl({ RAYU_WEB_URL: "http://custom" })).toBe("http://custom");
  });

  it("strips a trailing slash exactly as the CLI does", () => {
    expect(rayuApiBaseUrl({ RAYU_API_URL: "http://custom/api/" })).toBe("http://custom/api");
  });

  it("with no env, it resolves the values the CLI baked in — not localhost", () => {
    // The divergence this fixes. The baked config is inlined into the library
    // bundle by the same --define the CLI build uses, so an empty environment
    // yields the release endpoints rather than a developer's localhost stack.
    const baked = getBakedBuildConfig();
    expect(baked, "the library bundle must carry the baked build config").toBeDefined();
    expect(rayuApiBaseUrl({})).toBe(baked?.RAYU_API_URL);
    expect(rayuApiBaseUrl({})).not.toContain("localhost");
    expect(rayuWebBaseUrl({})).toBe(baked?.RAYU_WEB_URL);
  });
});
