// Bundled-engine resolution and integrity verification.
//
// This replaces the previous `CliLocator`, which searched for a `rayu`
// executable on the user's machine — the `rayucode.cliPath` setting, then
// `$PATH`, then the npm global prefix, then `~/.bun/bin`. That approach had
// three problems:
//
//   - it required the user to install the CLI separately, which is why an
//     onboarding prompt existed at all;
//   - the resolved CLI could be any version, so the extension and engine could
//     disagree about the wire protocol with nothing detecting it;
//   - a machine-scoped path setting meant the extension spawned whatever binary
//     that path pointed at.
//
// The engine is now shipped INSIDE the VSIX, so there is nothing to search for.
// What remains is to confirm the shipped artifact is the one this extension was
// built against, which is what `build-info.json` and the SHA-256 check below do.
//
// Node builtins only — no `vscode` import (R13.1, R13.5).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EditorAdapter } from "../editor/adapter.js";

/** Filename of the build manifest shipped beside the engine. */
export const BUILD_INFO_FILENAME = "build-info.json";

// `__dirname` exists in the CommonJS bundle esbuild produces for the extension
// host, but not in this package's ESM source. Declared so `typeof` guards
// typecheck without pulling in Node's CJS globals.
declare const __dirname: string | undefined;

/**
 * Best-effort default for the directory holding the engine and
 * `build-info.json`.
 *
 * `@rayucode/core` is bundled INTO `dist/extension.js`, so at runtime in the
 * extension host `__dirname` IS that `dist` directory. Hosts should still pass
 * {@link EngineResolverOptions.distDir} explicitly — the VS Code extension
 * derives it from `context.extensionUri` — because that is unambiguous and does
 * not depend on how the bundle was produced.
 *
 * Returns `""` when it cannot be determined, which makes {@link EngineResolver}
 * fail with a clear "manifest is missing" error rather than silently probing the
 * wrong place.
 */
export function defaultEngineDistDir(): string {
  return typeof __dirname === "string" ? __dirname : "";
}

/**
 * Provenance and integrity manifest generated at package time and shipped in the
 * VSIX beside the engine.
 *
 * Every field is required. See PROTOCOL.md §5.
 */
export interface BuildInfo {
  /** `rayu/package.json` version the engine was built from. */
  engineVersion: string;
  /** Engine filename, relative to the directory holding `build-info.json`. */
  engineFile: string;
  /** Lowercase hex SHA-256 of the engine file. */
  engineSha256: string;
  /** `PROTOCOL_VERSION` the extension was compiled against. */
  protocolVersion: number;
  /** Git commit the artifacts were built from. */
  gitCommit: string;
  /** Extension release version — deliberately independent of `engineVersion`. */
  extensionVersion: string;
  /** ISO 8601 UTC build timestamp. */
  builtAt: string;
}

/** A verified engine, ready to spawn. */
export interface EngineResolution {
  /** Absolute path to the engine JavaScript file. */
  enginePath: string;
  /** The verified manifest. */
  buildInfo: BuildInfo;
}

/** Raised when the engine cannot be resolved or fails verification. */
export class EngineResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineResolutionError";
  }
}

/** Injectable filesystem surface, so verification is testable without real files. */
export interface EngineFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string;
  readFileBytes(path: string): Uint8Array;
  mkdirp(path: string): void;
  writeFile(path: string, contents: string): void;
}

const nodeFileSystem: EngineFileSystem = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  readFileBytes: (p) => readFileSync(p),
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true });
  },
  writeFile: (p, contents) => {
    writeFileSync(p, contents, "utf8");
  },
};

/** Construction options for an {@link EngineResolver}. */
export interface EngineResolverOptions {
  /**
   * Directory containing the engine and `build-info.json` — the extension's
   * `dist/` directory at runtime.
   */
  distDir: string;
  /** Used for diagnostic logging. */
  adapter: Pick<EditorAdapter, "log">;
  /** Override the filesystem (tests). */
  fs?: EngineFileSystem;
  /** Override the digest function (tests). */
  computeSha256?: (bytes: Uint8Array) => string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Shorten a digest for human-readable error text. */
function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

/**
 * Validate an untrusted parsed value as a {@link BuildInfo}.
 *
 * Hand-written rather than schema-driven on purpose: `build-info.json` describes
 * the extension's own packaging, not the wire protocol, so it does not belong in
 * `@rayu-dev/agent-protocol` (WORKSPACE.md §4 — one definition for data crossing
 * stdin/stdout, and this never crosses it).
 */
function parseBuildInfo(raw: unknown): BuildInfo {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EngineResolutionError(
      `${BUILD_INFO_FILENAME} is not a JSON object.`,
    );
  }
  const o = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = o[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new EngineResolutionError(
        `${BUILD_INFO_FILENAME} field "${key}" is missing or not a non-empty string.`,
      );
    }
    return value;
  };
  const num = (key: string): number => {
    const value = o[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EngineResolutionError(
        `${BUILD_INFO_FILENAME} field "${key}" is missing or not a finite number.`,
      );
    }
    return value;
  };
  const sha = str("engineSha256");
  if (!/^[0-9a-fA-F]{64}$/.test(sha)) {
    throw new EngineResolutionError(
      `${BUILD_INFO_FILENAME} field "engineSha256" is not a 64-character hex digest.`,
    );
  }
  return {
    engineVersion: str("engineVersion"),
    engineFile: str("engineFile"),
    engineSha256: sha.toLowerCase(),
    protocolVersion: num("protocolVersion"),
    gitCommit: str("gitCommit"),
    extensionVersion: str("extensionVersion"),
    builtAt: str("builtAt"),
  };
}

/**
 * Resolves the bundled engine and verifies its integrity.
 *
 * The digest is computed once per instance and cached: the engine is ~24 MB, and
 * the file cannot change under a running extension without a reinstall, so
 * re-hashing on every spawn would be wasted work (PROTOCOL.md §6.1).
 */
export class EngineResolver {
  private readonly distDir: string;
  private readonly adapter: Pick<EditorAdapter, "log">;
  private readonly fs: EngineFileSystem;
  private readonly computeSha256: (bytes: Uint8Array) => string;

  /** Cached successful resolution. */
  private resolution: EngineResolution | null = null;

  constructor(options: EngineResolverOptions) {
    this.distDir = options.distDir;
    this.adapter = options.adapter;
    this.fs = options.fs ?? nodeFileSystem;
    this.computeSha256 = options.computeSha256 ?? sha256Hex;
  }

  /**
   * Resolve and verify the bundled engine.
   *
   * @throws {EngineResolutionError} when the manifest is missing or malformed,
   *   the engine file is absent, or its digest does not match. In every case the
   *   engine is NOT spawned: a digest mismatch means the shipped artifact was
   *   altered or the packaging step was inconsistent, and neither is safe to
   *   execute.
   */
  resolve(): EngineResolution {
    if (this.resolution !== null) {
      return this.resolution;
    }

    const manifestPath = join(this.distDir, BUILD_INFO_FILENAME);
    if (!this.fs.exists(manifestPath)) {
      throw new EngineResolutionError(
        `${BUILD_INFO_FILENAME} is missing from the extension (expected at ${manifestPath}). ` +
          `Without it neither the integrity check nor the protocol compatibility check can run. ` +
          `Reinstall the extension.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.fs.readFile(manifestPath));
    } catch (error) {
      throw new EngineResolutionError(
        `${BUILD_INFO_FILENAME} is not valid JSON: ${String(error)}. Reinstall the extension.`,
      );
    }
    const buildInfo = parseBuildInfo(parsed);

    const enginePath = join(this.distDir, buildInfo.engineFile);
    if (!this.fs.exists(enginePath)) {
      throw new EngineResolutionError(
        `The bundled Rayu engine is missing (expected at ${enginePath}). Reinstall the extension.`,
      );
    }

    const actual = this.computeSha256(
      this.fs.readFileBytes(enginePath),
    ).toLowerCase();
    if (actual !== buildInfo.engineSha256) {
      throw new EngineResolutionError(
        `The bundled Rayu engine failed its integrity check and will not be run. ` +
          `Expected SHA-256 ${shortDigest(buildInfo.engineSha256)}…, ` +
          `computed ${shortDigest(actual)}…. ` +
          `The shipped file was altered or the extension was packaged inconsistently. ` +
          `Reinstall the extension.`,
      );
    }

    this.adapter.log(
      "lifecycle",
      `Bundled Rayu engine verified: v${buildInfo.engineVersion} ` +
        `(protocol v${buildInfo.protocolVersion}, commit ${buildInfo.gitCommit.slice(0, 8)}, ` +
        `sha256 ${shortDigest(actual)}…)`,
    );

    this.resolution = { enginePath, buildInfo };
    return this.resolution;
  }
}

// ----------------------------------------------------------------------------
// First-run banner suppression
// ----------------------------------------------------------------------------

/**
 * Resolve the engine's config home directory, mirroring the engine's own
 * precedence: `RAYU_CONFIG_DIR`, else `~/.rayu`.
 */
export function resolveEngineConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.RAYU_CONFIG_DIR;
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return join(home, ".rayu");
}

/**
 * Ensure the engine's first-run marker exists, so it does not print a welcome
 * banner to stdout on this machine's first session.
 *
 * ## Why this is necessary
 *
 * `rayu/src/utils/firstRun.ts` writes a 17-line ASCII welcome banner with
 * `process.stdout.write`, guarded only by the presence of a marker file. It is
 * called unconditionally from `rayu/src/entrypoints/cli.tsx` BEFORE
 * `installStreamJsonStdoutGuard()` runs inside the headless path, so the guard
 * cannot suppress output that has already been written.
 *
 * In `--output-format=stream-json` mode stdout must carry NDJSON exclusively.
 * Those 17 lines are not JSON, so the decode boundary correctly fails the
 * session. Reproduced: a fresh config directory yields 17 banner lines and ZERO
 * protocol frames (rayucode/TRIAGE.md D4).
 *
 * Because the engine now ships inside the VSIX, every new machine has a fresh
 * config directory — so this would break the FIRST session after every install.
 *
 * ## Why the workaround lives here
 *
 * The correct fix is one line in the engine: gate that write on the output mode,
 * or send it to stderr. That is outside the agreed `rayu/src` change scope, so
 * the extension pre-creates the marker instead. Creating it is exactly what the
 * engine itself does after printing once.
 *
 * Trade-off: a user who later runs `rayu` in a terminal for the first time will
 * not see the welcome banner. That is a cosmetic loss, weighed against a broken
 * first session.
 *
 * Best-effort: any failure is logged and ignored. If the marker cannot be
 * written the banner may appear, and the decode boundary will then fail the
 * session with a clear protocol error rather than hanging.
 *
 * @returns `true` if the marker exists (or was just created).
 */
export function ensureFirstRunMarkerSuppressed(options: {
  adapter: Pick<EditorAdapter, "log">;
  fs?: EngineFileSystem;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): boolean {
  const fs = options.fs ?? nodeFileSystem;
  const configDir = resolveEngineConfigDir(options.env, options.home);
  const marker = join(configDir, ".installed");

  try {
    if (fs.exists(marker)) {
      return true;
    }
    fs.mkdirp(configDir);
    // Contents are never read by the engine — only the file's existence matters.
    fs.writeFile(
      marker,
      "created by the rayucode extension to suppress the engine's first-run stdout banner\n",
    );
    options.adapter.log(
      "lifecycle",
      `Created ${marker} to keep the engine's first-run welcome banner off the NDJSON stream.`,
    );
    return true;
  } catch (error) {
    options.adapter.log(
      "error",
      `Could not create the engine first-run marker at ${marker}: ${String(error)}. ` +
        `If the engine prints its welcome banner, the session will fail with a protocol error.`,
    );
    return false;
  }
}
