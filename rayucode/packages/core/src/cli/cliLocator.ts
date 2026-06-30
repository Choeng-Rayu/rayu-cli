// CliLocator (R1).
//
// Resolves a path to the Rayu CLI executable and, on success, queries its
// reported version and decides whether it is below the minimum the extension
// requires. Resolution order is fixed (R1.1, R1.3): an explicit
// `rayucode.cliPath` setting wins over a system-PATH lookup. When an executable
// is resolved, `<path> --version` is run and the reported version recorded
// (R1.4); the version is compared against `MINIMUM_RAYU_VERSION` to flag an
// incompatible build the user may still continue with (R1.5). When NOTHING is
// resolved, no version query and no comparison happen — `belowMinimum` stays
// `false` so the host suppresses any version-compatibility message (R1.6).
//
// The two side-effecting dependencies — running `<path> --version` and probing
// the PATH — are injectable, so the locator's resolution/comparison logic is
// unit-testable with no real subprocess (the default implementations use Node
// builtins). The locator depends only on the editor-agnostic `EditorAdapter`
// surface (`getSetting`, `log`); no `vscode` import (R13.1, R13.5).

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";

import type { EditorAdapter } from "../editor/adapter.js";

/**
 * The minimum Rayu CLI version rayucode supports. A resolved executable that
 * reports a version strictly below this is flagged `belowMinimum` (R1.5); the
 * user is still allowed to continue with it.
 */
export const MINIMUM_RAYU_VERSION = "1.0.0";

/** The executable name looked up on the system PATH when no explicit path is set. */
export const RAYU_BINARY_NAME = "rayu";

/** The extension setting key that holds an explicit CLI path (R1.1, R1.3). */
export const CLI_PATH_SETTING = "rayucode.cliPath";

/**
 * The outcome of resolving the Rayu CLI executable (R1).
 *
 * - `path` — the resolved executable path, or `null` when none was found.
 * - `version` — the version reported by `--version`, or `null` when nothing was
 *   resolved or the version could not be determined.
 * - `belowMinimum` — `true` only when a version was captured AND it is strictly
 *   below {@link MINIMUM_RAYU_VERSION}. It is never `true` when `path`/`version`
 *   is `null`, so a "nothing resolved" outcome never triggers a version message
 *   (R1.6).
 */
export interface CliResolution {
  path: string | null;
  version: string | null;
  belowMinimum: boolean;
}

/**
 * Runs `<path> --version` and resolves to the reported version string, or `null`
 * if the executable cannot be run or reports no parseable version (R1.4).
 * Injected so the locator is testable without spawning a real process.
 */
export type VersionRunner = (path: string) => Promise<string | null>;

/**
 * Probes the system PATH for the Rayu binary, resolving to its absolute path or
 * `null` when it is not on the PATH (R1.1). Injected for the same reason.
 */
export type PathProbe = () => Promise<string | null>;

/** Construction options for a {@link CliLocator}. */
export interface CliLocatorOptions {
  /** Editor-agnostic surface used to read the path setting and log diagnostics. */
  adapter: Pick<EditorAdapter, "getSetting" | "log">;
  /** Override the `<path> --version` runner (defaults to a Node subprocess). */
  runVersion?: VersionRunner;
  /** Override the PATH probe (defaults to a Node PATH scan for {@link binaryName}). */
  probePath?: PathProbe;
  /** Executable name probed on the PATH; defaults to {@link RAYU_BINARY_NAME}. */
  binaryName?: string;
  /** Minimum acceptable version; defaults to {@link MINIMUM_RAYU_VERSION}. */
  minimumVersion?: string;
}

// ----------------------------------------------------------------------------
// Version parsing / comparison (semver-ish, pure)
// ----------------------------------------------------------------------------

/**
 * Extract the first dotted-numeric version token from arbitrary text (e.g.
 * `"rayu 1.2.3"` → `"1.2.3"`, `"v2.0"` → `"2.0"`). Pre-release/build metadata
 * after a `-`/`+` is not part of the token. Returns `null` when no numeric
 * version is present.
 */
export function extractVersionToken(raw: string): string | null {
  const match = /\d+(?:\.\d+)*/.exec(raw);
  return match ? match[0] : null;
}

/** Split a version string into numeric components, ignoring non-numeric noise. */
function toComponents(version: string): number[] {
  const token = extractVersionToken(version);
  if (token === null) {
    return [];
  }
  return token.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

/**
 * Compare two version strings numerically by major/minor/patch (a missing
 * component is treated as `0`). Returns `-1` when `a < b`, `1` when `a > b`, and
 * `0` when they are equal. Pre-release suffixes are ignored (semver-ish, enough
 * for the minimum-version boundary check).
 */
export function compareVersions(a: string, b: string): number {
  const pa = toComponents(a);
  const pb = toComponents(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) {
      return 1;
    }
    if (da < db) {
      return -1;
    }
  }
  return 0;
}

// ----------------------------------------------------------------------------
// Default (Node-backed) side-effecting dependencies
// ----------------------------------------------------------------------------

/** Default runner: spawn `<path> --version`, parse a version token from stdout. */
function defaultRunVersion(path: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      path,
      ["--version"],
      { timeout: 10_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        // The version may be printed to either stream depending on the build.
        resolve(extractVersionToken(stdout) ?? extractVersionToken(stderr));
      },
    );
  });
}

/** Default PATH probe: scan `PATH` entries for an executable named `binaryName`. */
function defaultProbePath(binaryName: string): Promise<string | null> {
  const pathEnv = process.env["PATH"];
  if (!pathEnv) {
    return Promise.resolve(null);
  }
  const isWindows = process.platform === "win32";
  // On Windows an executable is resolved via PATHEXT; on POSIX the bare name is
  // tested for the execute bit.
  const extensions = isWindows
    ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .map((ext) => ext.toLowerCase())
    : [""];
  const mode = isWindows ? fsConstants.F_OK : fsConstants.X_OK;

  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const ext of extensions) {
      const candidate = join(dir, `${binaryName}${ext}`);
      try {
        accessSync(candidate, mode);
        return Promise.resolve(candidate);
      } catch {
        // Not present / not executable here; try the next candidate.
      }
    }
  }
  return Promise.resolve(null);
}

// ----------------------------------------------------------------------------
// Locator
// ----------------------------------------------------------------------------

/**
 * Resolves the Rayu CLI executable and its version compatibility. Construct with
 * an {@link EditorAdapter} (for the path setting and logging) and call
 * {@link resolve}.
 */
export class CliLocator {
  private readonly adapter: Pick<EditorAdapter, "getSetting" | "log">;
  private readonly runVersion: VersionRunner;
  private readonly probePath: PathProbe;
  private readonly minimumVersion: string;

  constructor(options: CliLocatorOptions) {
    this.adapter = options.adapter;
    const binaryName = options.binaryName ?? RAYU_BINARY_NAME;
    this.runVersion = options.runVersion ?? defaultRunVersion;
    this.probePath = options.probePath ?? (() => defaultProbePath(binaryName));
    this.minimumVersion = options.minimumVersion ?? MINIMUM_RAYU_VERSION;
  }

  /**
   * Resolve the executable, query its version, and decide compatibility.
   *
   * - Nothing resolved ⇒ `{ path: null, version: null, belowMinimum: false }`;
   *   `--version` is NOT run and no comparison is performed (R1.6).
   * - Resolved ⇒ `--version` is run (R1.4). If a version is reported it is
   *   compared against the minimum (R1.5); if it cannot be determined,
   *   `version` is `null` and `belowMinimum` is `false`.
   */
  async resolve(): Promise<CliResolution> {
    const path = await this.resolvePath();
    if (path === null) {
      // R1.6: no executable resolved ⇒ no version query, no comparison.
      return { path: null, version: null, belowMinimum: false };
    }

    // R1.4: a resolved executable ⇒ query the reported version.
    const version = await this.runVersion(path);
    if (version === null) {
      // Resolved, but the version could not be determined; no meaningful
      // comparison is possible, so it is not flagged below minimum.
      return { path, version: null, belowMinimum: false };
    }

    // R1.5: flag a version strictly below the minimum (continuation allowed).
    const belowMinimum = compareVersions(version, this.minimumVersion) < 0;
    return { path, version, belowMinimum };
  }

  /**
   * Resolve only the executable path, honouring the resolution order: an
   * explicit `rayucode.cliPath` setting wins over a PATH lookup (R1.1, R1.3).
   * Returns `null` when neither yields a path.
   */
  private async resolvePath(): Promise<string | null> {
    const configured = this.adapter.getSetting<string>(CLI_PATH_SETTING, "");
    const trimmed = typeof configured === "string" ? configured.trim() : "";
    if (trimmed.length > 0) {
      // R1.3: the explicit setting takes precedence; PATH is not consulted.
      this.adapter.log(
        "lifecycle",
        `Rayu CLI path from setting "${CLI_PATH_SETTING}": ${trimmed}`,
      );
      return trimmed;
    }

    const probed = await this.probePath();
    if (probed) {
      this.adapter.log("lifecycle", `Rayu CLI resolved on PATH: ${probed}`);
      return probed;
    }

    this.adapter.log(
      "lifecycle",
      "Rayu CLI not found via setting or system PATH.",
    );
    return null;
  }
}
