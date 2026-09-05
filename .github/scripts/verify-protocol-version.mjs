// CI check: PROTOCOL_VERSION must agree in all three places it appears.
//
//   1. `@rayu-dev/agent-protocol` — the single source of truth.
//   2. `dist/build-info.json`     — what the extension was packaged against.
//   3. the live engine's `system/init` frame — what the engine actually emits.
//
// (1) vs (2) catches a stale build. (1) vs (3) is the one that matters most: it
// runs the real engine and reads the real frame, so a schema change that fails to
// reach the emitting code is caught here rather than by a user.
//
// This is the check that structurally prevents the drift class described in
// rayucode/TRIAGE.md. Renaming a wire field or bumping the version in only one
// place fails the build.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const ENGINE = join(repoRoot, "rayu", "dist", "rayu.js");
const BUILD_INFO = join(
  repoRoot,
  "rayucode",
  "packages",
  "vscode",
  "dist",
  "build-info.json",
);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

// --- 1: the source of truth -------------------------------------------------
const { PROTOCOL_VERSION } = await import(
  `file://${join(repoRoot, "packages", "agent-protocol", "dist", "index.js")}`
);
if (typeof PROTOCOL_VERSION !== "number") {
  fail("PROTOCOL_VERSION is not exported as a number from @rayu-dev/agent-protocol");
}
console.log(`protocol package : ${PROTOCOL_VERSION}`);

// --- 2: what the extension was packaged against ----------------------------
const buildInfo = JSON.parse(readFileSync(BUILD_INFO, "utf8"));
console.log(`build-info.json  : ${buildInfo.protocolVersion}`);
if (buildInfo.protocolVersion !== PROTOCOL_VERSION) {
  fail(
    `build-info.json records protocolVersion ${buildInfo.protocolVersion} but the ` +
      `protocol package exports ${PROTOCOL_VERSION}. Rebuild the extension.`,
  );
}

// --- 3: what the engine actually emits -------------------------------------
// Run headless in an isolated environment. The marker file is pre-created so the
// engine's first-run banner cannot corrupt the NDJSON stream (TRIAGE.md D4).
const home = mkdtempSync(join(tmpdir(), "rayucode-ci-"));
mkdirSync(join(home, ".rayu"), { recursive: true });
writeFileSync(join(home, ".rayu", ".installed"), "ci");

const emitted = await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      ENGINE,
      "--print",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--verbose",
    ],
    {
      cwd: repoRoot,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "dumb",
        // Deliberately invalid: `system/init` is emitted before any API call, so
        // no network access or real credential is needed.
        ANTHROPIC_API_KEY: "sk-ant-ci-not-a-real-key",
        USE_RAYU_OAUTH: "false",
      },
    },
  );

  let buffer = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("engine did not emit system/init within 90s"));
    }
  }, 90_000);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (const line of buffer.split("\n")) {
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout in stream-json mode is itself a defect.
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(
            new Error(
              `engine wrote a non-JSON line to stdout: ${line.slice(0, 120)}`,
            ),
          );
        }
        return;
      }
      if (frame.type === "system" && frame.subtype === "init" && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(frame);
      }
    }
  });

  child.on("error", (error) => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });

  // The engine emits `system/init` once it has a turn to run, so send a minimal
  // prompt. It never reaches the network: the API key above is invalid, and
  // `system/init` is emitted before the first API call.
  child.stdin.write(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "ci protocol version probe" },
      parent_tool_use_id: null,
    })}\n`,
  );
});

const engineVersion = emitted.protocolVersion;
console.log(`engine system/init: ${engineVersion}`);

if (engineVersion === undefined) {
  fail(
    "the engine's system/init frame has no protocolVersion field. It must be " +
      "emitted from rayu/src/utils/messages/systemInit.ts (PROTOCOL.md §4).",
  );
}
if (engineVersion !== PROTOCOL_VERSION) {
  fail(
    `the engine emits protocolVersion ${engineVersion} but the protocol package ` +
      `exports ${PROTOCOL_VERSION}. A version bump must move the constant, the ` +
      `engine's emitted value, and the extension together in one commit.`,
  );
}

console.log(`\nPROTOCOL_VERSION agrees across all three: ${PROTOCOL_VERSION}`);
