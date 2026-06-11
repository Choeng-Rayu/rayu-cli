# Rayu-CLI Complete Software Architecture Guide

Welcome to the official architectural documentation for **Rayu-CLI**. This document details the high-level design, boot sequence, key layers, and core execution flows of the codebase, ensuring alignment with the actual directory structures and execution paths.

---

## 🗺️ Architectural Diagram

The diagram below outlines the key subsystems of Rayu-CLI and their operational relationships:

```mermaid
graph TD
    A[Command-Line Bootstrap<br><code>src/entrypoints/cli.tsx</code>] -->|Fast Path| B[Bridge / Remote Control<br><code>src/bridge/</code>]
    A -->|Fast Path| C[Daemon Worker<br><code>src/daemon/</code>]
    A -->|Interactive| D[Main TUI Session<br><code>src/main.tsx</code> & <code>src/ink/</code>]
    
    D --> E[Multi-Provider Router<br><code>src/utils/model/providers.ts</code> & <code>src/utils/rayuProviders.ts</code>]
    E --> F[Anthropic SDK]
    E --> G[Unified OpenAI Adapter]

    G --> H[OpenAI / NVIDIA NIM / DeepSeek / Kimi / etc]
    G --> I[AWS Bedrock Runtime<br><i>(OpenAI API endpoint)</i>]
    G --> J[Vertex AI Gemini<br><i>(OAuth + OpenAPI endpoint)</i>]

    D --> K[Extensibility Hooks<br>Pre/PostToolUse]
    D --> L[Tools Subsystem<br><code>src/tools/</code>]
    
    L --> M[Bash / File IO]
    L --> N[Image/Video Gen]
    L --> O[MCP Integrations<br><code>src/commands/mcp/</code>]
```

---

## 🚀 1. Command-Line Bootstrap (`src/entrypoints/`)

The bootstrapping stage is designed for **extreme performance** and minimal startup latency. Dynamic imports are utilized extensively to guarantee that "fast paths" do not trigger unnecessary module evaluation.

### High-Level Boot Sequence:
1. **Environment Load**: Loads `.env` via `loadDotEnv()` before any module evaluation starts.
2. **Resource Alignment**: Restricts Corepack auto-pinning and caps node process memory limits (`--max-old-space-size=8192`) in heavy execution environments.
3. **Fast-Paths Evaluation**:
   - **Version Checks (`-v` / `--version`)**: Zero import overhead. Immediately prints the version.
   - **System Prompt Dump (`--dump-system-prompt`)**: Resolves the selected active model, fetches its default system prompt configuration, prints it, and exits.
   - **Daemon Worker (`--daemon-worker=<kind>`)**: Directly invokes the worker registration registry with zero config/auth overhead.
   - **Bridge / Remote Control (`remote-control` / `rc`)**: Authenticates with OAuth tokens, loads policy limit rules, and invokes `bridgeMain` to initiate remote orchestration.
4. **Interactive CLI Activation**: If no fast-path is triggered, captures early piped stdin, loads `src/main.tsx`, and enters the full interactive loop.

---

## 🎨 2. TUI & Interactive Session (`src/main.tsx` & `src/ink/`)

The main interface is powered by a heavily customized React-based **Ink TUI framework**.

### Performance-Critical Optimizations:
- **Parallel Pre-fetching**: Launches settings, remote fetching, and auth token checks simultaneously during module load to cut startup delay.
- **Custom React Reconciler (`src/ink/`)**: Rayu-CLI ships with a custom rendering tree optimized for performance in deep text and layout operations, complete with layout cache and terminal-focus tracking.
- **Dynamic Diagnostics**: Validates project repository alignment, workspace path maps, and git branches before rendering the session interface.

---

## 🔌 3. Remote Control Bridge (`src/bridge/`)

Rayu-CLI supports a remote-control proxy, enabling off-device control loops and web/mobile client integrations.
- **Initialization**: Validates inbound connections and applies local policy limits.
- **Message Transport**: Over WebSockets or trusted tunnels (`replBridgeTransport.ts`).
- **Safety Boundaries**: Implements a strict `isBridgeSafeCommand` check within `src/commands.ts` to ensure destructive operations cannot be triggered maliciously by external RC proxies.

---

## 🛠️ 4. Tools & MCP Subsystems (`src/tools/` & `src/commands/mcp/`)

Rayu-CLI provides the Agent stack with a highly capable set of isolated tools:
- **File System / System**: `BashTool`, `FileReadTool`, `FileWriteTool`, `GlobTool`, `GrepTool`.
- **Advanced Integrations**:
  - `ImageGenTool` & `VideoGenTool`: Leverage NVIDIA genai and Cosmos models for rapid asset synthesis.
  - `MCPTool`: Facilitates standard Model Context Protocol integrations to pipe model requests out to specialized external servers.
- **Command Management**: The `mcp` subsystem is located in `src/commands/mcp/`, enabling dynamic addition and indexing of resources.

---

## 🧠 5. Multi-Provider Orchestration & Dynamic Effort Scaling (`src/utils/model/providers.ts`)

Rayu-CLI implements a highly abstract, multi-provider layout supporting state-of-the-art AI models:

```text
               [ User Input Prompt / Task ]
                            │
                            ▼
               [ Multi-Provider Router ]
             (src/utils/model/providers.ts)
                            │
         ┌──────────────────┴──────────────────┐
         ▼                                     ▼
   [ Anthropic SDK ]               [ Unified OpenAI Adapter ]
 (Native 1P Messages)            (Handles tool use, streams, auth)
                                               │
               ┌───────────────────────┬───────┴───────────────┐
               ▼                       ▼                       ▼
     [ AWS Bedrock Runtime ]   [ Vertex AI Gemini ]   [ Custom OpenAI APIs ]
      (bedrock-runtime API)     (GCP OAuth + Prefix)   (NVIDIA, DeepSeek, etc)
```

### Supported API Backends:
- **Anthropic**: Uses the official SDK for 1P models.
- **Unified OpenAI Adapter**: A powerful, generalized client used for:
  - **AWS Bedrock**: Uses the Bedrock Runtime's OpenAI-compatible endpoint with AWS bearer tokens.
  - **Vertex Gemini**: Connects to the regional OpenAPI endpoint via GCP OAuth tokens.
  - **OpenAI-compatible**: Directly connects to OpenAI, OpenRouter, NVIDIA NIM, DeepSeek, Kimi, and custom local servers.
The router natively supports dynamic reasoning scaling (`low`, `medium`, `high`, `max`) via the `/effort` command and environment variable configuration (`CLAUDE_CODE_EFFORT_LEVEL`). This aligns speed, cost, and rate limits dynamically for reasoning models like Opus 4.6 and Sonnet 4.6.

---

## ⚡ 6. Extensibility Hooks

Rayu-CLI integrates local development environments with runtime automation rules. Pre-configured hooks inside `~/.claude/settings.json` run automatically:
- **PreToolUse**: Rejects massive payload writes (e.g. over 800 lines) before any files are altered to prevent accidental blowouts.
- **PostToolUse**: Triggers automatic Prettier, ESLint, and incremental TypeScript typechecking updates immediately after files are edited.
- **Stop**: Bundles and compiles production code at the close of every active coding session to verify build integrity.

---

## 🧹 7. Codebase De-bloating & Legacy Command Pruning

To maintain a lean and fast CLI runtime, legacy Anthropic-specific stubs and commands that do not apply to the multi-provider, open-source nature of Rayu have been completely pruned or archived into the `un-use-code/` directory:
- **Praise & Feedback Easter Eggs**: Pruned `/good-claude` command.
- **Anthropic Subscription Management**: Pruned `/reset-limits` and `/extra-usage` commands.
- **Anthropic-Specific Account Lifecycle**: Pruned `/oauth-refresh`, as Rayu manages standard credentials across distinct API keys.

---

*This guide serves as the definitive architecture reference for new and veteran contributors to Rayu-CLI.*