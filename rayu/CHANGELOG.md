# Rayu-CLI Changelog

All notable user-facing changes to Rayu-CLI are documented here, newest first.

## 2.4.1 - 2026-10-30 (Beta)
- **Rayucode settings, account and credits, right in the editor** — a new Settings tab (sidebar gear, Command Palette, or the chat's overflow menu) covers General, Account, Integrations and About. Account shows your profile, plan and renewal date, credits, usage limits and registered devices, and a credits item in the status bar warns when your remaining allowance or daily turns drop below 10%. General settings write Rayu's real settings files, so the terminal and the editor always agree
- **Integrations moved into Settings** — connect Telegram by scanning the shared bot's QR code or pasting your own bot token, turn on Studio Remote or pair it with a QR code, and install Rayu's GitHub Actions workflows without leaving VS Code. The Telegram connect panel no longer lives in the chat
- **Rayu-hosted image and video generation** — generate images and clips on your Rayu plan with no provider key, billed in credits through the gateway; bringing your own fal.ai key still works for video
- **Per-turn credit reporting** — a "Credits: …" line after each turn, in the terminal and in VS Code, totals everything the gateway charged for that turn, including side queries and media generation
- **Platform VSIX packages** — platform builds ship a compiled engine and bundled ripgrep (the universal VSIX keeps the plain engine bundle), plus a memory watchdog that replaces an engine at its memory limit and continues the same conversation instead of starting over
- **A stricter orchestrator** — in orchestrator mode the main agent can no longer edit files or run non-read-only shell itself and must delegate to workers; changing mode warns when it would break running workers, and SendMessage is worker-only when agent teams are off
- **Shift+Tab is always bound** — cycling permission modes now works with the standard key on Windows (Meta+M remains an alias)
- **Signing out of Rayucode matches `/logout`** — the same caches are cleared, and a configured API key is kept
- **Fixed remote-gateway safety** — a plaintext (non-HTTPS) remote gateway is now refused for Rayu credentials, and gateway redirects are rejected instead of followed
- **Breaking: NVIDIA image/video backends removed** — `/generate-image` and `/image-video` now use Rayu-hosted, Vertex or fal.ai; NVIDIA text models are unaffected. In VS Code the engine now starts in the permission mode chosen in the extension, so a `permissions.defaultMode` written for the terminal no longer overrides it

## 2.2.17 - 2026-10-17 (Beta)
- **Sessions now open as editor tabs** — every RayuCode conversation opens in its own editor tab, so you can run several side by side and switch between them without interrupting a turn that is already in flight
- **The sidebar is now the agent's management hub** — it shows your session list, background tasks, MCP servers, provider setup and sign-in instead of a second copy of the chat. The conversation itself — transcript and composer — lives in the session's editor tab, so it appears in exactly one place
- **Fixed the sidebar duplicating and reloading the chat** — the sidebar could briefly render the open conversation and re-lay-out whenever you created or switched sessions; it now stays on the management view and updates in place

## 2.0.13 - 2026-09-21 (Beta)
- **RayuCode on GitHub** — you can now connect RayuCode to GitHub and put it to work on your pull requests. Install it as a GitHub App, pick the repositories you want in scope, and RayuCode reviews incoming PRs right where your team already works — leaving inline findings, summaries, and suggested fixes as review comments, no local setup required
- **Run RayuCode as a GitHub bot in your hub repo** — designate a "hub" repository and RayuCode becomes a standing bot there. It listens for new PRs and issues, responds to mentions, and can act as the central review and triage agent for the whole organization — one bot, every repo that points at the hub

## 2.0.12 - 2026-09-20 (Beta)
- **Orchestrator mode is now the default** — the CLI now ships with the orchestrator as the built-in coordination layer. Plan, build, review, and run multi-agent workflows end-to-end from a single session, with parallel/sequential/race policies, retry/fallback, and git worktree isolation all wired in by default
- **Reusable messages in VS Code** — RayuCode now supports saved, reusable prompt messages. Build a library of your most-used prompts and invoke them instantly from the IDE chat panel, with variable interpolation for project-specific context
- **Collaborator swarm migrated to orchestrator** — the standalone `/collaborator_swarm` command has been retired and its capabilities fully absorbed into the orchestrator. Domain-specialized agents (backend, frontend, mobile, security, deploy) are now orchestrated through the unified `/agent` workflow with better task routing and shared context
- **Rayu GitHub setup command restored** — `/install-github-app` now creates Rayu-branded `@rayu` and automated review workflows, defaults to securely provisioning a repository credential from the signed-in Rayu account (with manual API keys still supported), and uses trusted-actor guards plus publisher-configured Rayu GitHub App and Action endpoints

## 2.0.1 - 2026-09-14 (Beta)
- **🚀 Introducing RayuCode — our new VS Code extension!** Rayu's full AI coding agent engine is now available directly inside VS Code as [RayuCode](https://marketplace.visualstudio.com/items?itemName=RayuCode.rayucode). Same tools, same providers, same skills — now with a native IDE chat panel, diff viewer, and webview UI. One engine, two products: terminal and IDE
- **Greatly improved model support** — expanded the provider catalog with more models across Anthropic, OpenAI, Google Gemini, DeepSeek, Kimi, and OpenAI-compatible endpoints. Better model capability detection, smarter fallbacks, and more accurate context window handling
- **Pay-as-you-go billing** — introduced a new pay-as-you-go pricing model alongside subscriptions. Top up your balance and pay only for what you use — no monthly commitment required. Perfect for occasional or variable usage
- **More accurate credit charging** — completely reworked the credit calculation pipeline. Token counting now aligns precisely with provider billing (input/output/cache-read/cache-write tokens tracked separately), so you're charged exactly for what the model consumed — no more, no less
- **Subscription management overhaul** — redesigned the subscription experience from the ground up: clearer plan comparison, seamless upgrades/downgrades, prorated billing, and a unified billing dashboard in rayu-web. View usage, manage your plan, and track invoices in one place
- **Team SSO (Enterprise)** — added SAML/OIDC single-sign-on support for teams and organizations. Admins can configure Google Workspace, Okta, or any OIDC IdP so team members sign in with their existing corporate credentials — no separate Rayu accounts needed
- **Fixed streaming interruptions** — resolved an issue where long streaming responses could silently drop tokens or terminate early under high-latency network conditions
- **Fixed credit double-counting on retries** — credits are now correctly settled (not just reserved) after each request, eliminating the previous over-charge when the gateway retried a failed upstream call
- **Fixed model fallback loops** — prevented infinite fallback cycles when multiple models in the chain were unavailable; the CLI now fails fast with a clear error message
- **Fixed subscription plan change not reflecting immediately** — plan entitlements are now refreshed in real-time after a subscription change, removing the previous delay where users had to restart the session
- **Fixed memory leak in long-running sessions** — resolved a memory accumulation issue in the Ink renderer that caused slowdowns during multi-hour coding sessions
- **Fixed clipboard paste on Windows Terminal** — clipboard image paste now works correctly in Windows Terminal and conhost.exe, not just Windows Terminal with the new engine
- **Fixed slash command autocomplete ordering** — commands are now ranked by relevance and frequency instead of alphabetically, so `/model`, `/connect`, and `/help` appear first

## 1.6.0 - 2026-08-30
- Introduced the **External Agent Orchestrator** — `/agent` command and `ExternalAgent` tool to discover, launch, adopt, assign work to, and stream other agentic CLIs (Codex, Claude Code, OpenCode, and any ACP agent). Supports orchestration policies (parallel/sequential/race/retry/fallback), git worktree isolation, brokered permissions, and crash recovery
- Overhauled the **Telegram bridge** for multi-session support — list sessions with `/sessions`, switch between them with `/switch <n>`, and route prompts across processes over the new IPC layer
- Added **Telegram bridge health monitoring** with typed poll outcomes, exponential backoff, and clear connection status (connected/reconnecting/disconnected)
- Added **Telegram remote uninstall** — a typed device lifecycle operation gated by local opt-in, explicit device targeting, single-use confirmation tokens, and a concurrency lock
- Added a secure **IPC (Inter-Process Communication)** layer — Unix socket protocol with per-session token auth enabling cross-session routing and multi-session coordination
- Added the **Rayu API Key provider** (`rayu`) — authenticate with a `rayu_sk_live_…` key, with gateway validation, credential caching, and device identity registration
- Added a streamlined **first-run setup screen** — offers Rayu sign-in or API key entry, with the full provider list one keystroke away via `/connect`
- Added **per-model image capability detection** — knows which (provider, model) pairs accept images, replacing the old provider-wide boolean that caused silent image drops or lost turns
- Added **tool input repair** — automatically recovers malformed tool-argument JSON from weaker models (markdown fences, raw newlines, trailing commas, truncation)
- Added **Edit/Write tool key coercion** — transparently maps camelCase and synonym keys (e.g. `filePath` → `file_path`) so tool calls from non-Claude models work correctly
- Improved the **file state cache** — tracks full-file reads explicitly to reduce spurious "file modified since read" warnings after formatters or git operations
- Added **device identity** — a stable per-machine identifier for remote lifecycle operations, registered and heartbeated against the backend
- Rewrote the **uninstall system** — modular orchestrator with scoped manifests, install-method detection, and a detached helper that finishes cleanup after RAYU exits
- Added the active **model name in the input bar and sidebar** for better context during sessions
- Added comprehensive test coverage for external agents, Telegram, API key auth, image capabilities, tool input repair, file edit coercion, and more

## 1.5.12 - 2026-07-30
- Improved the model selection experience — better picker UX and more reliable model resolution when switching providers

## 1.5.11 - 2026-07-30
- Fixed a bug where Rayu CLI would hang/stuck when running inside the default macOS Terminal app — Enter and several modified key events were not being delivered when the `modifiers-napi` dependency was absent

## 1.5.1 - 2026-07-28
- Migrated the Telegram bridge for a more user-friendly experience — smoother pairing flow, clearer status messages, and more reliable bot re-pairing when the linked bot changes
- Improved Telegram message handling and bridge reliability for mobile/remote access

## 1.5.0 - 2026-07-25
- Migrated the Rayu-hosted provider to support many more models
- Added real-time model list updates so newly enabled models on the gateway are picked up without requiring a CLI release
- Improved provider routing and model resolution for Rayu-hosted models

## 1.4.479 - 2026-07-23
- Fixed the Ask User Question tool not working in full manage (full-control) permission mode

## 1.4.478 - 2026-07-21
- Improved the Ask User Question tool for all LLM providers
- Fixed the Gateway upstream error
- Fixed the plan credit calculation bug

## 1.4.477 - 2026-07-21
- Fixed Rayu-hosted provider gateway bugs affecting multiple concurrent requests and routing
- Hardened the internal Rayu provider path — resolved the gate issue that caused intermittent failures under load
- Improved gateway request handling and route resolution for Rayu-hosted models
- Tightened gateway logging for clearer diagnostics on hosted-provider failures

## 1.4.472 - 2026-07-09
- Fixed tool search (deferred tool loading) for Rayu third-party providers — `tool_reference`/`defer_loading` beta was wrongly enabled for `anthropic-compatible` and `openai-compatible` providers, causing deferred tools (WebFetch, TaskUpdate, WebSearch, etc.) to be called with guessed parameters and rejected by the client-side validator
- Added escape hatch: set `ENABLE_TOOL_SEARCH=true` to force-enable deferred tools on endpoints that forward the beta
- Added regression test suite for tool search provider detection (`toolSearchProvider.test.ts`)
- Cleaned up stale bug-hunter notes

## 1.4.471 - 2026-07-09
- Migrated remaining legacy Claude Code internal references and branding to Rayu across the codebase
- Fixed Kimi Code 2.7 provider compatibility in the streaming pipeline
- Ollama provider promoted to primary active provider with improved multi-key configuration support
- Fixed `update`, `uninstall`, and `install` CLI commands for cross-platform reliability

## 1.4.470 - 2026-07-09
- All supported providers now route through Rayu-hosted gateway with full multi-provider compatibility
- Improved handling of disabled providers — long-running stale provider connections are now properly cleaned up
- UI polish: refined several terminal components for better readability and consistency
- Added native context window support for Rayu-hosted models

## 1.4.466 - 2026-07-08
- Rebranded from Claude theme to Rayu branding theme with new Goose mascot identity
- Added `/banner` and `/mascot` slash commands for displaying Rayu branding in the terminal
- Introduced `LogoV2` components with animated goose mascot and configurable banner system
- Migrated legacy Claude-specific modules (feedback, grove, analytics, OAuth) to `un-use-code/` archive
- Removed Telegram payment notification listener and Claude subscription integrations
- Added mascot image encoding, Unicode rendering, and caching utilities for terminal display
- Implemented clean posture verification scripts and origin manifest for independent branding audit
- Added `anthropicCompatibleClient` for provider-agnostic Anthropic-compatible API consumption

## 1.3.462 - 2026-07-06
- Removed DeepSeek Web reverse-scraping provider
- Added cache read/write credit multipliers for usage tracking
- Improved gateway graceful shutdown and added related tests
- Updated Kiro provider to Sonnet 5
- Improved ABA/QrCode payment flow and Telegram listener reliability

## 1.3.445 - 2026-06-29
- Fixed bugs in gateway routing logic for `rayu-hosted` provider
- Added tests for gateway routing edge cases

## 1.3.444 - 2026-06-29
- Implemented prompt input color theming via `theme.ts`
- Improved thinking message display and highlighted thinking text rendering
- Added structured API error handling in `errors.ts`
- Improved context analysis and consistency checks
- Fixed renderer ghost-character edge cases in `log-update.ts`

## 1.3.443 - 2026-06-26
- Production stability improvements: entitlements, auth session, and gateway routing
- Fixed preload script and macro values for production launch
- Improved dashboard page and first-time launch flow in `rayu-web`

## 1.3.442 - 2026-06-24
- Improved interrupt message handling during streaming queries
- Added memory pressure guard to prevent OOM crashes
- Added heap limit re-exec mechanism for large sessions
- Improved curated provider model list and provider configuration

## 1.3.441 - 2026-06-24
- Refactored backend payment integration to support Bakong (KHQR) payments
- Added Telegram listener for ABA payment notifications
- Updated payment DTOs and controller for new payment flow

## 1.3.440 - 2026-06-22
- Fixed missing TypeScript type modules across SDK and component types
- Added FPS tracker, memory probe, and progress coalescing utilities
- Added interactive heap dump monitor
- Fixed copilot auth, message handling, and OpenAI adapter test coverage

## 1.3.439 - 2026-06-21
- Implemented basic subscription plan catalog and entitlements enforcement
- Added paid feature gating for image generation and video generation tools
- Added usage limits for free plan users (`rayuFeatureUsage.ts`, `paidFeatureGate.ts`)
- Refactored thinking message display in assistant responses
- Improved gateway credit limiter, entitlements cache, and admin panel in `rayu-web`

## 1.3.438 - 2026-06-17
- Added Hugging Face (`huggingface`) provider preset using Hugging Face Inference Providers endpoint (`https://router.huggingface.co/v1`) with `HF_TOKEN`
- Implemented feature rate limits, entitlements, and Copilot client authentication
- Added/updated integrations for image-editor, video-generation, and image-generation tools
- Implemented and improved Admin Dashboard features (analytics, payments, plans, users) in `rayu-web` and `rayu-backend`

## 1.3.437 - 2026-06-17
- Fixed Kiro provider thinking payload construction and context base

## 1.3.436 - 2026-06-17
- Reworked and renamed the Planning & Research subagent from "PA-AGENT" to "planner"
- Optimized parallel exploration of codebase in planner subagent (concurrent dispatch of Explore subagents)
- Improved collaborator swarm and persistent agent memory syncing/loading
- Added UI spinner and status display improvements for agent tasks

## 1.3.435 - 2026-06-17
- Published new stable CLI version with package improvements

## 1.3.434 - 2026-06-16
- Fix the bug with the kiro provider context
- Rebrand from Claude icon to Rayu draft icon
- Add `/brandmark` slash command to customize brand mark glyph and loading-spinner style

## 1.3.433 - 2026-06-15
- Implement the doubleword provider to fetch all model

## 1.3.432 - 2026-06-15
- fixed Bug of thinking

## 1.3.431 - 2026-06-15
- fix kiro context base on the original context 1M

## 1.3.430 - 2026-06-15
- The final update the rayu cli free of use.
- Added new provider with kiro provider login through api key and the kiro OAuth
- Add Rayu OAuth for preview first.

## 1.3.429 - 2026-06-14
- Added FIX thinking to all provider
- we improve the thinking to for provider and make the speed bettern 10%

## 1.3.428 - 2026-06-13
- Added the thinking status display to all agent subagents and the collaborator agent

## 1.3.427 - 2026-06-13
- Completely updated the documentation to properly reflect Rayu as an independent CLI, removing legacy Claude Code specific references
- Improved the thinking UI and status displays
- Fixed a bug with Kimi provider thinking output
- Fixed a bug causing blocked thinking through the Bedrock provider

## 1.2.25 - 2026-06-11
- Extended thinking and effort now work on any provider, not just Claude — type `ultrathink` to trigger deep reasoning on NVIDIA, Gemini, DeepSeek, and other OpenAI-compatible models
- `/effort max` is no longer labeled "Opus only" and applies to whatever model you have connected
- Added local `/ultraplan`: deep multi-agent planning that explores your codebase in parallel and produces a step-by-step plan for approval — runs entirely on your own provider
- Added local `/ultrareview`: a deep bug-hunt that gathers your branch diff and dispatches parallel review subagents to find and verify real bugs — runs entirely on your own provider
- Enabled the "ultrathink" keyword highlight and per-turn token budgets (type `+500k` or `use 2M tokens`)
- Sub-agents can now use the built-in Explore and Plan helpers for faster, deeper investigation
- "What's new" now shows Rayu's own changelog, and an "Update available" notice appears when a newer version is published to npm

## 1.2.24 - 2026-06-10
- Fixed a spurious "Interrupted by user" error that appeared when a parallel tool timed out or a sibling command failed — interruptions are now only reported when you actually cancel
- `/ide` now detects VS Code when connected through the integrated terminal
- Clipboard image paste now works on Wayland (Linux)
- Reworked `/review_detail` into an interactive diff viewer
- `/undo all` reverts every pending file change at once
- Renamed `/stickers` to `/contact_me`
