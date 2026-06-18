# Rayu-CLI Changelog

All notable user-facing changes to Rayu-CLI are documented here, newest first.

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
