# Rayu-CLI Changelog

All notable user-facing changes to Rayu-CLI are documented here, newest first.

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

## 1.5.16 - 2026-08-08
- Major first-launch experience overhaul — smoother onboarding, clearer setup flow, and a much friendlier "what's new" introduction for new users
- Added Custom Provider support — users can now define and connect their own provider (any OpenAI/Anthropic-compatible endpoint) directly from `/connect` without patching the CLI
- Migrated the gateway to a fully unified type system that speaks both the OpenAI Chat Completions and Anthropic Messages wire formats — every provider is now a thin transport on top of one internal IR, eliminating format-specific branches across the codebase
- Significantly improved the Telegram bridge — better message streaming, more reliable inline keyboards, and reduced dropped messages on slow networks
- Fixed Figma MCP integration — OAuth handshake, asset fetch, and image reference flows now work end-to-end without the previous stale-token and 404 edge cases
- Improved the gateway cache layer — much higher cache hit rate for repeated prompts, with tiered caching for both system prompts and tool results, noticeably reducing latency and cost
- Migrated the gateway from Go to a fully Rust implementation — lower memory footprint, faster cold start, single static binary, and a hardened async runtime for streaming under load
- Reduced wasted tokens per request — tightened system prompt assembly, deduplicated overlapping tool descriptions, and stripped redundant boilerplate from every outbound request

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
