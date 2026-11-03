// CI check: the packaged .vsix must be self-consistent.
//
// The previous checks look at the build tree. This one looks at the artifact a
// user would actually install, because that is what ships. It verifies the
// digest INSIDE the zip against the manifest INSIDE the same zip, so an archive
// assembled from mismatched inputs cannot pass.
//
// Uses only the Node standard library: a .vsix is a zip, and the two entries
// needed are read with `unzip -p`, which is present on the CI image.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const VSIX_DIR = join(process.cwd(), "rayucode", "packages", "vscode");

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const vsixNames = readdirSync(VSIX_DIR).filter((f) => f.endsWith(".vsix"));
if (vsixNames.length === 0) {
  fail("no .vsix was produced");
}
if (vsixNames.length > 1) {
  fail(
    `found ${vsixNames.length} .vsix files (${vsixNames.join(", ")}) — ` +
      `stale artifacts make it ambiguous which one shipped`,
  );
}
const vsix = join(VSIX_DIR, vsixNames[0]);
console.log(`artifact: ${vsixNames[0]}`);

function entry(path) {
  try {
    return execFileSync("unzip", ["-p", vsix, path], {
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (error) {
    fail(`could not read "${path}" from the .vsix: ${error}`);
  }
}

const listing = execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

// Nothing sensitive may ship, even if .vscodeignore is later edited carelessly.
const forbidden = listing.filter((f) =>
  /\.env($|\.)|\.pem$|\.key$|graphify-out\/|dist\/bin\/|node_modules\//i.test(f),
);
if (forbidden.length > 0) {
  fail(`the .vsix ships forbidden files: ${forbidden.join(", ")}`);
}

const buildInfo = JSON.parse(entry("extension/dist/build-info.json").toString("utf8"));
const engineBytes = entry(`extension/dist/${buildInfo.engineFile}`);
const actual = createHash("sha256").update(engineBytes).digest("hex");

console.log(`entries : ${listing.length}`);
console.log(`engine  : ${buildInfo.engineFile} (${(engineBytes.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`manifest: ${buildInfo.engineSha256}`);
console.log(`computed: ${actual}`);

if (actual !== buildInfo.engineSha256) {
  fail(
    "the engine inside the .vsix does not match the build-info.json inside the " +
      "same .vsix. The extension would refuse to spawn it on every install.",
  );
}

// The extension entry point and the webview assets must all be present, or the
// extension installs and then fails to activate.
for (const required of [
  "extension/package.json",
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/webview.css",
]) {
  if (!listing.includes(required)) {
    fail(`the .vsix is missing ${required}`);
  }
}

console.log("\npackaged VSIX is self-consistent");
