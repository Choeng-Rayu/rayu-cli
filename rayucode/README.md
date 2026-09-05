# Rayucode Monorepo

Rayucode is the official VS Code extension for the **Rayu AI coding agent** (`@rayu-dev/rayu-cli`).

## Repository Structure

```
rayucode/
├── packages/
│   ├── core/      # @rayucode/core — editor-agnostic engine, NDJSON protocol codec, session store
│   └── vscode/    # rayucode — VS Code extension host, webview panel, chat participant
├── .vscode/       # VS Code launch and task configs (F5 debug runner)
└── HOW_TO_RUN.md  # Step-by-step instructions to run, debug, and package the extension
```

## Quick Start

For complete instructions on running, debugging with F5, or packaging as a `.vsix`, see:
👉 **[HOW_TO_RUN.md](./HOW_TO_RUN.md)**

### Fast Commands

**From root directory (`~/rayu/rayu-cli/rayucode`):**
```bash
npm install
npm run build
npm run package --workspace packages/vscode
code --install-extension packages/vscode/rayucode-0.1.0.vsix --force
```

**Or from `packages/vscode` (`~/rayu/rayu-cli/rayucode/packages/vscode`):**
```bash
npm run package
code --install-extension rayucode-0.1.0.vsix --force
```
