# @rayu-dev/rayu-cli (Rayu-CLI)

> **Rayu-CLI** is a terminal-based AI coding agent. It lets you **bring your own API key** and use **any OpenAI-compatible provider** (NVIDIA, DeepSeek, Kimi/Moonshot, OpenAI, OpenRouter, local servers) as well as Anthropic and AWS Bedrock — with free model switching, MCP support, and the full built-in tool suite.

---

## 🚀 Quick Start

You don't even need to clone the repository to use Rayu-CLI. Since it is published on npm as `@rayu-dev/rayu-cli`, you can run or install it instantly.

### Method 1: Run instantly with NPX (No installation required)
```bash
npx @rayu-dev/rayu-cli
```

### Method 2: Global Installation
Install Rayu-CLI globally on your machine using your favorite package manager:

```bash
# Using npm
npm install -g @rayu-dev/rayu-cli

# Using bun
bun install -g @rayu-dev/rayu-cli

# Using pnpm
pnpm add -g @rayu-dev/rayu-cli

# Using yarn
yarn global add @rayu-dev/rayu-cli
```

Once installed, simply start the interactive TUI from any folder:
```bash
rayu
```

---

## 🛠️ Interactive TUI Mode

When you start Rayu-CLI without any arguments, it drops you into a beautiful, full-screen Terminal User Interface (TUI) powered by React & Ink. 

### First-Time Setup
On your very first run, Rayu will guide you through:
1. **Theme selection:** Choose a color theme matching your terminal.
2. **Provider configuration:** Select a provider and paste your **API Key**.
3. **Workspace trust:** Confirm you trust the current directory so Rayu can safely use tools to read and edit code.

### Useful In-Session Commands
In the terminal chat, type `/` to see all available slash commands:

| Command | Action / Description |
|:---|:---|
| `/connect` | Connect a new provider, update keys, or switch active provider |
| `/model` | Search and switch models across all connected providers |
| `/context` | Monitor current context-window usage and token count |
| `/cost` | Display cumulative token usage and costs for the session |
| `/clear` | Clear conversation history and start a fresh session |
| `/help` | Display a complete list of in-session slash commands |
| `/exit` | Exit the Rayu CLI session safely |

---

## 🤖 Headless & Scripted Mode (Print Mode)

For automation, CI/CD pipelines, or quick scripting, use the `--print` (or `-p`) option to execute a single prompt and output the results directly without entering the interactive TUI.

### Basic CLI Usage:
```bash
rayu --print "Analyze package.json and write a one-sentence summary"
```

### Run on the fly with NPX:
```bash
npx @rayu-dev/rayu-cli --print "Check if there are any linting issues in src/"
```

### Pass credentials via Environment Variables:
No saved configuration is needed. Prepend the API keys and endpoints directly:
```bash
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
RAYU_OPENAI_API_KEY=nvapi-xxxxx \
rayu --print --model meta/llama-3.3-70b-instruct "explain this repo"
```

### JSON Outputs for Pipelines:
```bash
rayu --print --output-format json "list top-level folders" | jq .result
```

### Automatic Permissions (Safe/Sandboxed Environments):
By default, Rayu asks for user approval before modifying files or executing terminal commands. If you are running in a sandbox, Docker container, or CI/CD runner, you can auto-approve all operations:
```bash
rayu --print --permission-mode bypassPermissions "Refactor src/utils/format.ts to use snake_case"
```

---

## 🔌 Core Concepts & Architecture

* **Multi-Provider BYOK (Bring Your Own Key):** Supports three main provider categories:
  1. `anthropic` (Anthropic SDK)
  2. `bedrock` (AWS Bedrock SDK integration)
  3. `openai-compatible` (NVIDIA, DeepSeek, OpenAI, OpenRouter, Kimi, local endpoints, etc. via a translation layer)
* **Configuration Home:** Rayu stores its keys and settings in `~/.rayu`.
* **Diagnostics:** Detailed logs about runtime errors and system events are saved to `~/.rayu/diagnostics.jsonl` for troubleshooting.

---

## 📚 Detailed Documentation Map

| Document | Description |
|:---|:---|
| 📦 **[Installation](./documentations/01-installation.md)** | Requirements, build scripts, native binaries, and global NPM instructions. |
| 🚀 **[Quickstart](./documentations/02-quickstart.md)** | Step-by-step interactive setup, chat commands, and headless print examples. |
| 🔑 **[Providers](./documentations/03-providers.md)** | Detailed setup for DeepSeek, NVIDIA, OpenAI, Bedrock, and custom APIs. |
| 🧠 **[Models](./documentations/04-models.md)** | Supported models, context limits, and searchable model selector info. |
| ⚙️ **[Configuration](./documentations/05-configuration.md)** | Structure of `~/.rayu/`, environment variables, and system settings. |
| 📋 **[CLI Reference](./documentations/06-cli-reference.md)** | Comprehensive list of commands, flags, permission modes, and exit codes. |
| 💬 **[Slash Commands](./documentations/07-slash-commands.md)** | Descriptions of all interactive terminal slash commands. |
| 🔗 **[MCP Servers](./documentations/08-mcp.md)** | Model Context Protocol integration and remote service configuration. |
| 🛡️ **[Diagnostics & Privacy](./documentations/09-diagnostics-privacy.md)** | Privacy configurations, telemetry sinks, and local logging policies. |
| 🔧 **[Troubleshooting](./documentations/10-troubleshooting.md)** | Common issues, API errors (e.g. 404, rate limits) and quick fixes. |
| 📊 **[Codebase Knowledge Graph](./documentations/11-knowledge-graph.md)** | Local indexing, querying, and code tracing using `/graphify`. |
| 🎨 **[Image Generation](./documentations/12-image-generation.md)** | Using NVIDIA flux models to generate and preview image assets inline. |
| 🛠️ **[Building Binaries](./documentations/13-binaries.md)** | Cross-compiling single-file native executables and building `.deb`/`.rpm` Linux packages. |

---

## 🧪 Development & Local Setup

If you want to clone this repository and modify the source code:

1. **Clone the Repo:**
   ```bash
   git clone https://github.com/rayu-dev/rayu-cli.git
   cd rayu-cli
   ```
2. **Install Dependencies:**
   ```bash
   cd rayu
   bun install
   ```
3. **Build the Bundle:**
   ```bash
   bun run build
   ```
4. **Run from the Source directly:**
   ```bash
   bun run dev
   ```

---

*Educational/research purpose. Not affiliated with or endorsed by Anthropic or any other provider.*
