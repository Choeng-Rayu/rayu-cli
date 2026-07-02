import { describe, expect, it, vi } from "vitest";

import {
  CliLocator,
  CLI_PATH_SETTING,
  compareVersions,
  extractVersionToken,
  MINIMUM_RAYU_VERSION,
} from "../src/index.js";
import type { EditorAdapter } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers — a minimal fake of the EditorAdapter surface the locator uses.
// ---------------------------------------------------------------------------

type AdapterSurface = Pick<EditorAdapter, "getSetting" | "log">;

interface FakeAdapter extends AdapterSurface {
  logs: { channel: string; message: string }[];
}

/** Build a fake adapter whose `getSetting` is backed by a fixed map. */
function makeAdapter(settings: Record<string, unknown> = {}): FakeAdapter {
  const logs: { channel: string; message: string }[] = [];
  return {
    logs,
    getSetting: (<T>(key: string, fallback: T): T =>
      Object.prototype.hasOwnProperty.call(settings, key)
        ? (settings[key] as T)
        : fallback) as EditorAdapter["getSetting"],
    log: (channel, message) => {
      logs.push({ channel, message });
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution ordering (R1.1, R1.3)
// ---------------------------------------------------------------------------

describe("CliLocator resolution ordering", () => {
  it("uses the explicit setting in preference to PATH, and never probes PATH (R1.3)", async () => {
    const adapter = makeAdapter({ [CLI_PATH_SETTING]: "/custom/bin/rayu" });
    const probePath = vi.fn(async () => "/usr/bin/rayu");
    const runVersion = vi.fn(async () => "1.2.3");

    const locator = new CliLocator({ adapter, probePath, runVersion });
    const resolution = await locator.resolve();

    expect(resolution.path).toBe("/custom/bin/rayu");
    // The setting wins, so the PATH probe is never consulted (R1.3).
    expect(probePath).not.toHaveBeenCalled();
    // The version is queried against the resolved (setting) path (R1.4).
    expect(runVersion).toHaveBeenCalledTimes(1);
    expect(runVersion).toHaveBeenCalledWith("/custom/bin/rayu");
  });

  it("falls back to the PATH-resolved executable when no setting is present (R1.1)", async () => {
    const adapter = makeAdapter(); // no cliPath setting
    const probePath = vi.fn(async () => "/usr/local/bin/rayu");
    const runVersion = vi.fn(async () => "1.5.0");

    const locator = new CliLocator({ adapter, probePath, runVersion });
    const resolution = await locator.resolve();

    expect(probePath).toHaveBeenCalledTimes(1);
    expect(resolution.path).toBe("/usr/local/bin/rayu");
    expect(runVersion).toHaveBeenCalledWith("/usr/local/bin/rayu");
  });

  it("treats a whitespace-only setting as unset and falls back to PATH", async () => {
    const adapter = makeAdapter({ [CLI_PATH_SETTING]: "   " });
    const probePath = vi.fn(async () => "/usr/bin/rayu");
    const runVersion = vi.fn(async () => "1.0.0");

    const locator = new CliLocator({ adapter, probePath, runVersion });
    const resolution = await locator.resolve();

    expect(probePath).toHaveBeenCalledTimes(1);
    expect(resolution.path).toBe("/usr/bin/rayu");
  });

  it("trims surrounding whitespace from a configured path", async () => {
    const adapter = makeAdapter({ [CLI_PATH_SETTING]: "  /opt/rayu  " });
    const probePath = vi.fn(async () => "/usr/bin/rayu");
    const runVersion = vi.fn(async () => "1.0.0");

    const locator = new CliLocator({ adapter, probePath, runVersion });
    const resolution = await locator.resolve();

    expect(resolution.path).toBe("/opt/rayu");
    expect(runVersion).toHaveBeenCalledWith("/opt/rayu");
    expect(probePath).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Version capture (R1.4)
// ---------------------------------------------------------------------------

describe("CliLocator version capture", () => {
  it("records the version string reported by --version (R1.4)", async () => {
    const adapter = makeAdapter({ [CLI_PATH_SETTING]: "/bin/rayu" });
    const runVersion = vi.fn(async () => "2.3.4");

    const locator = new CliLocator({ adapter, runVersion });
    const resolution = await locator.resolve();

    expect(resolution.version).toBe("2.3.4");
    expect(resolution.path).toBe("/bin/rayu");
  });

  it("returns a null version (and no below-minimum flag) when --version cannot be determined", async () => {
    const adapter = makeAdapter({ [CLI_PATH_SETTING]: "/bin/rayu" });
    // Executable resolved but version unobtainable (e.g. spawn failed).
    const runVersion = vi.fn(async () => null);

    const locator = new CliLocator({ adapter, runVersion });
    const resolution = await locator.resolve();

    // Resolved path is still reported…
    expect(resolution.path).toBe("/bin/rayu");
    // …but with no version, no meaningful comparison is possible.
    expect(resolution.version).toBeNull();
    expect(resolution.belowMinimum).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Version-compare boundaries (R1.5)
// ---------------------------------------------------------------------------

describe("CliLocator minimum-version boundary", () => {
  const minimumVersion = "1.0.0";

  async function resolveWithVersion(version: string) {
    const adapter = makeAdapter({ [CLI_PATH_SETTING]: "/bin/rayu" });
    const locator = new CliLocator({
      adapter,
      minimumVersion,
      runVersion: async () => version,
    });
    return locator.resolve();
  }

  it("does not flag a version exactly at the minimum (R1.5 boundary: at)", async () => {
    const resolution = await resolveWithVersion("1.0.0");
    expect(resolution.belowMinimum).toBe(false);
    expect(resolution.version).toBe("1.0.0");
  });

  it("does not flag a version above the minimum (R1.5 boundary: above)", async () => {
    expect((await resolveWithVersion("1.0.1")).belowMinimum).toBe(false);
    expect((await resolveWithVersion("1.1.0")).belowMinimum).toBe(false);
    expect((await resolveWithVersion("2.0.0")).belowMinimum).toBe(false);
  });

  it("flags a version below the minimum (R1.5 boundary: below)", async () => {
    expect((await resolveWithVersion("0.9.9")).belowMinimum).toBe(true);
    expect((await resolveWithVersion("0.9.0")).belowMinimum).toBe(true);
    expect((await resolveWithVersion("0.0.1")).belowMinimum).toBe(true);
  });

  it("compares against MINIMUM_RAYU_VERSION by default", async () => {
    const adapter = makeAdapter({ [CLI_PATH_SETTING]: "/bin/rayu" });
    // One patch below the shipped minimum is below; the minimum itself is not.
    const below = await new CliLocator({
      adapter,
      runVersion: async () => "0.0.1",
    }).resolve();
    const atMin = await new CliLocator({
      adapter,
      runVersion: async () => MINIMUM_RAYU_VERSION,
    }).resolve();

    expect(below.belowMinimum).toBe(true);
    expect(atMin.belowMinimum).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nothing resolved ⇒ no version comparison (R1.6)
// ---------------------------------------------------------------------------

describe("CliLocator with nothing resolved", () => {
  it("returns an empty resolution and performs NO version query/comparison (R1.6)", async () => {
    const adapter = makeAdapter(); // no setting
    const probePath = vi.fn(async () => null); // not on PATH either
    const runVersion = vi.fn(async () => "1.2.3");

    const locator = new CliLocator({ adapter, probePath, runVersion });
    const resolution = await locator.resolve();

    expect(resolution).toEqual({
      path: null,
      version: null,
      belowMinimum: false,
    });
    // The PATH was probed once…
    expect(probePath).toHaveBeenCalledTimes(1);
    // …but with nothing resolved, --version is NEVER run (no comparison path).
    expect(runVersion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — version parsing & comparison
// ---------------------------------------------------------------------------

describe("extractVersionToken", () => {
  it("extracts a dotted-numeric token from CLI output", () => {
    expect(extractVersionToken("rayu 1.2.3")).toBe("1.2.3");
    expect(extractVersionToken("v2.0")).toBe("2.0");
    expect(extractVersionToken("1.2.3-beta.1")).toBe("1.2.3");
    expect(extractVersionToken("version: 0.0.1\n")).toBe("0.0.1");
  });

  it("returns null when no numeric version is present", () => {
    expect(extractVersionToken("no version here")).toBeNull();
    expect(extractVersionToken("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    expect(compareVersions("0.9.9", "1.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("treats missing components as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBe(1);
  });

  it("ignores pre-release suffixes for the boundary check", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(0);
  });
});
