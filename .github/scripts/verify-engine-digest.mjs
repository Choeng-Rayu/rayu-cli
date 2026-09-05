// CI check: the staged engine's SHA-256 must match `build-info.json`.
//
// This is the same check the extension performs before its first spawn
// (PROTOCOL.md §6.1). Running it in CI means a mis-staged or truncated engine
// fails the build instead of failing on a user's machine — where the symptom is
// an extension that refuses to start.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = join(
  process.cwd(),
  "rayucode",
  "packages",
  "vscode",
  "dist",
);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

let buildInfo;
try {
  buildInfo = JSON.parse(readFileSync(join(DIST, "build-info.json"), "utf8"));
} catch (error) {
  fail(`could not read dist/build-info.json: ${error}`);
}

const REQUIRED = [
  "engineVersion",
  "engineFile",
  "engineSha256",
  "protocolVersion",
  "gitCommit",
  "extensionVersion",
  "builtAt",
];
for (const key of REQUIRED) {
  if (buildInfo[key] === undefined || buildInfo[key] === "") {
    fail(`build-info.json is missing required field "${key}"`);
  }
}
if (!/^[0-9a-f]{64}$/.test(buildInfo.engineSha256)) {
  fail("build-info.json engineSha256 is not a 64-character lowercase hex digest");
}

const enginePath = join(DIST, buildInfo.engineFile);
let bytes;
try {
  bytes = readFileSync(enginePath);
} catch (error) {
  fail(`the staged engine is missing at ${enginePath}: ${error}`);
}

const actual = createHash("sha256").update(bytes).digest("hex");
const sizeMb = (statSync(enginePath).size / 1024 / 1024).toFixed(1);

console.log(`engine   : ${buildInfo.engineFile} (${sizeMb} MB)`);
console.log(`manifest : ${buildInfo.engineSha256}`);
console.log(`computed : ${actual}`);

if (actual !== buildInfo.engineSha256) {
  fail(
    "the staged engine does not match build-info.json. The extension would " +
      "refuse to spawn it. Re-run the build so the manifest is regenerated.",
  );
}

// A near-empty engine means the copy silently failed and the digest was taken of
// the wrong bytes. The real engine is ~24 MB.
if (bytes.length < 1_000_000) {
  fail(
    `the staged engine is only ${bytes.length} bytes — the copy almost certainly failed.`,
  );
}

console.log(
  `\nengine digest verified — v${buildInfo.engineVersion}, protocol v${buildInfo.protocolVersion}, commit ${buildInfo.gitCommit.slice(0, 8)}`,
);
