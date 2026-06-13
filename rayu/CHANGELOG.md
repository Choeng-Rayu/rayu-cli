# Rayu-CLI Changelog

All notable user-facing changes to Rayu-CLI are documented here, newest first.

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
