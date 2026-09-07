// Stage the Rayu engine into dist/ and generate dist/build-info.json.
//
// The engine (`rayu/dist/rayu.js`) ships INSIDE the VSIX, so the extension never
// searches the user's machine for a CLI and cannot end up running a different
// build than the one it was tested against.
//
// `build-info.json` is the provenance and integrity manifest the extension reads
// at activation (PROTOCOL.md §5, §6.1):
//
//   - `engineSha256` is verified before the engine is spawned, so a tampered or
//     inconsistently-packaged artifact fails loudly instead of executing.
//   - `protocolVersion` is compared against the engine's `system/init`, so an
//     engine/extension mismatch is caught on the first frame.
//   - `engineVersion` / `gitCommit` / `builtAt` make a shipped VSIX traceable to
//     the exact sources it came from.
//
// The extension version is deliberately NOT forced to equal the engine version:
// they release on their own cadences, and equality would not detect the case that
// actually matters — an extension packaged against a different engine than the
// one it ships.
//
// Usage: node scripts/generate-build-info.mjs

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vscodePkgDir = resolve(here, "..");
const repoRoot = resolve(vscodePkgDir, "..", "..", "..");

/**
 * The engine staged into the VSIX.
 *
 * `rayu-vscode-host.js`, not `rayu.js`: it is built from the same `rayu/src` by
 * `rayu/scripts/build-vscode-host.ts` and delegates to the same `main()`, so it
 * exposes an identical tool / slash-command / skill / MCP inventory (asserted by
 * `rayu/test/vscodeHost.test.ts`, which diffs both bundles' `system/init`). What
 * it adds is ownership of the headless flag contract: `--print
 * --input-format=stream-json --output-format=stream-json --verbose` is defined in
 * the engine rather than duplicated in this repository, where a change to it
 * could not be seen.
 *
 * Build it with `(cd rayu && bun run build:vscode-host)`, or `npm run build` at
 * the repo root, whose `build:engine` produces all three rayu artifacts.
 */
const ENGINE_SOURCE = join(repoRoot, "rayu", "dist", "rayu-vscode-host.js");
const ENGINE_FILENAME = "rayu-vscode-host.js";
const DIST_DIR = join(vscodePkgDir, "dist");
const PROTOCOL_PKG = join(repoRoot, "packages", "agent-protocol");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  console.error(`generate-build-info: ${message}`);
  process.exit(1);
}

/**
 * Read PROTOCOL_VERSION from the protocol package's built output.
 *
 * Taken from the single source of truth rather than duplicated here, so the
 * manifest cannot drift from the constant the extension actually compiles
 * against.
 */
async function readProtocolVersion() {
  const entry = join(PROTOCOL_PKG, "dist", "index.js");
  try {
    const mod = await import(`file://${entry}`);
    if (typeof mod.PROTOCOL_VERSION !== "number") {
      fail(`PROTOCOL_VERSION is not a number in ${entry}`);
    }
    return mod.PROTOCOL_VERSION;
  } catch (error) {
    fail(
      `could not read PROTOCOL_VERSION from ${entry} — build @rayu-dev/agent-protocol first. ${error}`,
    );
  }
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    // A tarball checkout has no git metadata. Record it explicitly rather than
    // silently emitting a plausible-looking wrong value.
    return "0000000000000000000000000000000000000000";
  }
}

let engineBytes;
try {
  engineBytes = readFileSync(ENGINE_SOURCE);
} catch {
  fail(
    `the engine is missing at ${ENGINE_SOURCE}. Build it first: (cd rayu && bun run build:vscode-host)`,
  );
}

mkdirSync(DIST_DIR, { recursive: true });
// Remove any engine this package staged under a DIFFERENT name. `.vscodeignore`
// ships all of dist/, so a rename would otherwise leave the previous 24 MB
// engine in the VSIX alongside the current one — doubling the package and
// shipping a binary nothing loads.
for (const stale of ["rayu.js", "rayu-vscode-host.js"]) {
  if (stale === ENGINE_FILENAME) continue;
  const stalePath = join(DIST_DIR, stale);
  if (existsSync(stalePath)) {
    rmSync(stalePath);
    console.log(`[build-info] removed stale engine dist/${stale}`);
  }
}

const engineDest = join(DIST_DIR, ENGINE_FILENAME);
copyFileSync(ENGINE_SOURCE, engineDest);

// Digest the COPY, not the source, so the manifest describes exactly the bytes
// that ship. A truncated or failed copy is then caught by the startup check
// rather than producing a manifest that matches a file the user never receives.
const engineSha256 = createHash("sha256")
  .update(readFileSync(engineDest))
  .digest("hex");

const buildInfo = {
  engineVersion: readJson(join(repoRoot, "rayu", "package.json")).version,
  engineFile: ENGINE_FILENAME,
  engineSha256,
  protocolVersion: await readProtocolVersion(),
  gitCommit: gitCommit(),
  extensionVersion: readJson(join(vscodePkgDir, "package.json")).version,
  builtAt: new Date().toISOString(),
};

writeFileSync(
  join(DIST_DIR, "build-info.json"),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
  "utf8",
);

const mb = (engineBytes.length / 1024 / 1024).toFixed(1);
console.log(
  `[build-info] engine v${buildInfo.engineVersion} (${mb} MB) → dist/${ENGINE_FILENAME}\n` +
    `[build-info] protocol v${buildInfo.protocolVersion}, commit ${buildInfo.gitCommit.slice(0, 8)}, sha256 ${engineSha256.slice(0, 12)}…`,
);
