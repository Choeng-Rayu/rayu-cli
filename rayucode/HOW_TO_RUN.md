# How to Run Rayucode in VS Code

This guide covers how to build, run, debug, and package the **Rayucode** extension from this repository.

---

## 1. Prerequisites

1. **Rayu CLI**: Ensure the Rayu CLI binary is installed and authenticated:
   ```bash
   which rayu
   rayu --version
   ```
   If not already configured, run `rayu` in your terminal once to authenticate your preferred LLM provider.

2. **Node.js & npm**: Node.js >= 18 (`node -v`, `npm -v`).

3. **VS Code**: VS Code version >= 1.100.0 (`code -v`).

---

## 2. Option A: Run in Development / Debug Mode (F5)

Use this mode when making changes to extension code and testing them live with breakpoints and hot reloading.

### Using VS Code UI (F5)
1. Open the root monorepo in VS Code:
   ```bash
   code /home/rayu/rayu/rayu-cli/rayucode
   ```
2. Switch to the **Run and Debug** view (`Ctrl+Shift+D` / `Cmd+Shift+D`).
3. Select **"Run Rayucode Extension"** from the configuration dropdown.
4. Press **`F5`**.
   * VS Code will automatically run the build task (`npm run build`).
   * A new VS Code window titled **`[Extension Development Host]`** will open with the extension loaded and the debugger attached.

### Using the Terminal
1. Start the file watcher:
   ```bash
   cd /home/rayu/rayu/rayu-cli/rayucode/packages/vscode
   npm run watch
   ```
2. In a second terminal, launch the Extension Development Host:
   ```bash
   code --extensionDevelopmentPath=/home/rayu/rayu/rayu-cli/rayucode/packages/vscode /path/to/any/project
   ```

---

## 3. Option B: Build and Install the VSIX (Production Mode)

Pay attention to your current working directory when running these commands:

### If you are in `packages/vscode` (`~/rayu/rayu-cli/rayucode/packages/vscode`):
```bash
# 1. Build & package into .vsix
npm run package

# 2. Install into VS Code
code --install-extension rayucode-0.1.0.vsix --force
```

### If you are in the root directory (`~/rayu/rayu-cli/rayucode`):
```bash
# 1. Build core & vscode
npm run build

# 2. Package into .vsix
npm run package --workspace packages/vscode

# 3. Install into VS Code
code --install-extension packages/vscode/rayucode-0.1.0.vsix --force
```

### Alternative: Install via VS Code GUI
Open VS Code → Extensions view (`Ctrl+Shift+X`) → Click `...` in top-right of Extensions panel → **Install from VSIX...** → Select `/home/rayu/rayu/rayu-cli/rayucode/packages/vscode/rayucode-0.1.0.vsix`.

### Reload VS Code
After installing, reload VS Code window:
Press `Ctrl+Shift+P` (or `Cmd+Shift+P`) → type **`Developer: Reload Window`** → hit `Enter`.

---

## 4. How to Use the Extension in VS Code

Once running (either in Dev Host or installed):

* **Agent Panel**: Click the **Rayucode** sparkle icon in the left Activity Bar, or run `Rayucode: Open Agent Panel` from the Command Palette (`Ctrl+Shift+P`).
* **Chat Participant**: Open the VS Code Chat panel and type `@rayucode` followed by your request. Supports slash commands:
  * `@rayucode /explain`
  * `@rayucode /fix`
  * `@rayucode /review`
  * `@rayucode /test`
* **Editor Actions**: Select any code in an editor, right-click, and select:
  * `Rayucode: Explain selection`
  * `Rayucode: Fix selection`
  * `Rayucode: Review selection`
  * `Add Selection to Prompt`

---

## 5. Helpful Commands & Verification

### From Root (`rayucode/`):
* `npm run build` — Build all packages
* `npm run typecheck` — Typecheck all packages
* `npm run test:core` — Run Core unit tests
* `npm run package --workspace packages/vscode` — Package VSIX

### From `packages/vscode/`:
* `npm run build` — Build extension and webview
* `npm run package` — Build and package into `rayucode-0.1.0.vsix`
* `npm test` — Run vitest unit tests
* `npm run test:integration` — Run VS Code integration tests

---

## 6. Troubleshooting & Diagnostics

* **View Logs**: Open `View -> Output` in VS Code and select **Rayucode** from the output dropdown.
* **Enable Protocol Tracing**: In VS Code Settings (`Ctrl+,`), search for `rayucode.diagnosticLogging` and enable it to log all NDJSON control-protocol packets and process lifecycle events.
* **CLI Path Override**: If the extension cannot find your `rayu` executable, set `rayucode.cliPath` in Settings to the absolute path of your binary (e.g. `/home/rayu/.npm-global/bin/rayu`).
