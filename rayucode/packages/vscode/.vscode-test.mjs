// @vscode/test-cli configuration for the extension-host integration suite
// (task 12.3). The `vscode-test` runner reads this file, downloads/launches a
// real VS Code Electron build, loads THIS package as the extension under test
// (extensionDevelopmentPath defaults to the cwd), and runs the compiled mocha
// suite inside that host.
//
// ⚠ This requires a full VS Code/Electron environment (a display or virtual
// framebuffer). It CANNOT run headless in CI without one and does not run in the
// authoring sandbox. Drive it with `npm run test:integration`, which first
// compiles the suite via esbuild (`compile-tests` → esbuild.test.mjs) into
// out/test/**/*.test.js, the glob referenced below.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defineConfig } from "@vscode/test-cli";

// A throwaway folder so the host always opens with a single workspace folder
// (required by the workspace-context / ignore tests). The committed fixture
// files are copied in so the suite has a known file to open.
const workspaceFolder = fs.mkdtempSync(
  path.join(os.tmpdir(), "rayucode-itest-"),
);
fs.cpSync(
  path.join(import.meta.dirname, "src", "test", "fixtures", "workspace"),
  workspaceFolder,
  { recursive: true },
);

export default defineConfig({
  files: "out/test/**/*.test.js",
  version: "stable",
  workspaceFolder,
  mocha: {
    ui: "tdd",
    timeout: 60_000,
    color: true,
  },
});
