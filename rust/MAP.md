# MAP — Rayu CLI to Rust

Goal: a pure Rust binary that does what `@rayu-dev/rayu-cli` does, at
byte-for-byte equivalence (ADR-005), drop-in compatible (ADR-006), with the
original kept as reference and fallback until the lift.

Source of truth for the plan: `analyze.json` (rust-anything/analyze@1, run
2026-11-19 on `/home/rayu/rayu/rayu-cli`).

## ADR index

| ADR | Title | Status |
|---|---|---|
| 001 | Whole rayu-cli code is the target | accepted |
| 002 | CLI + TUI shape, clap front door | accepted |
| 003 | Full port, engine first, TUI last | accepted |
| 004 | `src/vscode/` stays TS | accepted |
| 005 | Byte-for-byte equivalence | accepted |
| 006 | Drop-in compatibility | accepted |
| 007 | Stack and targets | accepted |
| 008 | No intermediate checkpoints | accepted |
| 009 | Recording runs in a bwrap sandbox | accepted |
| 010 | Port location | accepted |

## Shape

- 598k LOC, 1,914 source + 359 test files, 637 UI files.
- 415 units: 152 ready, 58 caution, 1 blocked, 204 keep (VS Code excepted).
- Waves: 0 = 42 units / 9.5k LOC; 1 = 3 / 1.7k; 2 = 1 / 35; 3 = 155 / 188k
  (two tangled pieces: the 129k core and telegram/remote 10.4k); 4 = 11 / 10.4k.
- One blocked unit: `rayu/src/utils/bash/` (bash analysis/specs; treated as part
  of the wave-3 tangled core rather than ported alone).

## Out of scope

- `rayu/src/vscode/` (39k LOC) — TS by ADR-004.
- Docs, shell installers (ADR-001).
- `rayu/un-use-code/` — upstream dead code, not referenced by `src/`; keep as
  reference, do not port.

## States

Each unit is `open`, `claimed by <session> <date>`, or `done` (with gate + diff
evidence). A claimed unit belongs to its session; another session picks a
different one.

## Units

| Unit | Wave | Readiness | LOC | State |
|---|---|---|---|---|
| `rayu-action/src/` | 0 | ready | 493 | open |
| `rayu/src/commands/assistant/` | 0 | keep | 13 | open |
| `rayu/src/core/portable/` | 0 | ready | 62 | done — rust/portable-rs, gate green, 638/638 |
| `rayu/src/moreright/` | 0 | keep | 25 | open |
| `rayu/src/native-ts/file-index/` | 0 | ready | 330 | done — rust/file-index-rs, gate green, 201/201 |
| `rayu/src/native-ts/yoga-layout/` | 0 | caution | 2564 | open |
| `rayu/src/plugins/bundled/` | 0 | ready | 22 | open |
| `rayu/src/protocol/` | 0 | caution | 3236 | open |
| `rayu/src/services/contextCollapse/` | 0 | ready | 13 | open |
| `rayu/src/services/skillSearch/` | 0 | ready | 3 | open |
| `rayu/src/tools/SendUserFileTool/` | 0 | ready | 11 | open |
| `rayu/src/tools/TungstenTool/` | 0 | keep | 10 | open |
| `rayu/src/tools/VerifyPlanExecutionTool/` | 0 | ready | 7 | open |
| `rayu/src/tools/WorkflowTool/` | 0 | ready | 4 | open |
| `rayu/src/types/generated/events_mono/common/v1/` | 0 | ready | 89 | open |
| `rayu/src/types/generated/google/protobuf/` | 0 | ready | 176 | open |
| `rayu/src/vscode/host/review/` | 0 | keep | 423 | out of scope |
| `rayu/src/webBridge/client/` | 0 | caution | 1332 | open |
| `rayu/stubs/ant/claude-for-chrome-mcp/` | 0 | ready | 14 | out of scope |
| `rayu/stubs/ant/computer-use-input/` | 0 | ready | 5 | out of scope |
| `rayu/stubs/ant/computer-use-mcp/` | 0 | ready | 37 | out of scope |
| `rayu/stubs/ant/computer-use-swift/` | 0 | ready | 4 | out of scope |
| `rayu/stubs/color-diff-napi/` | 0 | ready | 13 | out of scope |
| `rayu/stubs/zod-locales/` | 0 | ready | 17 | out of scope |
| `rayu/un-use-code/chrome/` | 0 | keep | 296 | out of scope |
| `rayu/un-use-code/commands/ant-trace/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/autofix-pr/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/backfill-sessions/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/break-cache/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/bughunter/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/ctx_viz/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/debug-tool-call/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/desktop/` | 0 | keep | 31 | out of scope |
| `rayu/un-use-code/commands/env/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/fast/` | 0 | keep | 292 | out of scope |
| `rayu/un-use-code/commands/good-claude/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/install-slack-app/` | 0 | ready | 35 | out of scope |
| `rayu/un-use-code/commands/issue/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/login/` | 0 | keep | 117 | out of scope |
| `rayu/un-use-code/commands/mobile/` | 0 | keep | 283 | out of scope |
| `rayu/un-use-code/commands/mock-limits/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/oauth-refresh/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/onboarding/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/perf-issue/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/remote-env/` | 0 | keep | 21 | out of scope |
| `rayu/un-use-code/commands/remote-setup/` | 0 | keep | 371 | out of scope |
| `rayu/un-use-code/commands/reset-limits/` | 0 | ready | 4 | out of scope |
| `rayu/un-use-code/commands/share/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/summary/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/teleport/` | 0 | ready | 1 | out of scope |
| `rayu/un-use-code/commands/usage/` | 0 | keep | 14 | out of scope |
| `rayu/un-use-code/commands/voice/` | 0 | ready | 158 | out of scope |
| `rayu/un-use-code/components/Passes/` | 0 | keep | 174 | out of scope |
| `rayu/un-use-code/types/generated/events_mono/growthbook/v1/` | 0 | ready | 210 | out of scope |
| `rayu/un-use-code/upstreamproxy/` | 0 | ready | 693 | out of scope |
| `rayu/src/core/` | 1 | ready | 327 | done — rust/core-rs, gate green, 1028/1028 |
| `rayu/src/ink/layout/` | 1 | ready | 493 | open |
| `rayu/src/types/generated/events_mono/claude_code/v1/` | 1 | ready | 837 | open |
| `rayu/un-use-code/claudeInChrome/` | 1 | keep | 2114 | out of scope |
| `rayu/un-use-code/commands/extra-usage/` | 1 | keep | 165 | out of scope |
| `rayu/un-use-code/commands/passes/` | 1 | keep | 45 | out of scope |
| `rayu/un-use-code/commands/upgrade/` | 1 | keep | 52 | out of scope |
| `rayu/src/types/generated/events_mono/rayu/v1/` | 2 | ready | 35 | open |
| `rayu/un-use-code/commands/rate-limit-options/` | 2 | keep | 226 | out of scope |
| `rayu/src/QueryEngine.ts` | 3 | caution | 1261 | open |
| `rayu/src/Task.ts` | 3 | ready | 113 | open |
| `rayu/src/Tool.ts` | 3 | ready | 776 | open |
| `rayu/src/assistant/` | 3 | keep | 99 | open |
| `rayu/src/bootstrap/` | 3 | caution | 1524 | open |
| `rayu/src/bridge/` | 3 | caution | 11855 | open |
| `rayu/src/buddy/` | 3 | keep | 1250 | open |
| `rayu/src/cli/` | 3 | caution | 7676 | open |
| `rayu/src/cli/handlers/` | 3 | keep | 1445 | open |
| `rayu/src/cli/transports/` | 3 | caution | 2938 | open |
| `rayu/src/cli/uninstall/` | 3 | caution | 1624 | open |
| `rayu/src/commands.ts` | 3 | ready | 679 | open |
| `rayu/src/commands/` | 3 | keep | 5264 | open |
| `rayu/src/commands/add-dir/` | 3 | keep | 233 | open |
| `rayu/src/commands/agent/` | 3 | ready | 675 | open |
| `rayu/src/commands/agents/` | 3 | keep | 20 | open |
| `rayu/src/commands/banner/` | 3 | ready | 40 | open |
| `rayu/src/commands/billing/` | 3 | ready | 89 | open |
| `rayu/src/commands/branch/` | 3 | ready | 272 | open |
| `rayu/src/commands/brand/` | 3 | keep | 99 | open |
| `rayu/src/commands/btw/` | 3 | keep | 253 | open |
| `rayu/src/commands/clear/` | 3 | ready | 396 | open |
| `rayu/src/commands/color/` | 3 | caution | 94 | open |
| `rayu/src/commands/compact/` | 3 | ready | 278 | open |
| `rayu/src/commands/config/` | 3 | keep | 16 | open |
| `rayu/src/commands/connect/` | 3 | keep | 68 | open |
| `rayu/src/commands/contactMe/` | 3 | ready | 28 | open |
| `rayu/src/commands/context/` | 3 | keep | 379 | open |
| `rayu/src/commands/copy/` | 3 | keep | 388 | open |
| `rayu/src/commands/diff/` | 3 | keep | 16 | open |
| `rayu/src/commands/doctor/` | 3 | keep | 17 | open |
| `rayu/src/commands/effort/` | 3 | keep | 84 | open |
| `rayu/src/commands/exit/` | 3 | keep | 42 | open |
| `rayu/src/commands/export/` | 3 | keep | 58 | open |
| `rayu/src/commands/extra-usage/` | 3 | ready | 30 | open |
| `rayu/src/commands/fast/` | 3 | keep | 268 | open |
| `rayu/src/commands/feedback/` | 3 | keep | 186 | open |
| `rayu/src/commands/files/` | 3 | caution | 26 | open |
| `rayu/src/commands/heapdump/` | 3 | ready | 24 | open |
| `rayu/src/commands/help/` | 3 | keep | 19 | open |
| `rayu/src/commands/hooks/` | 3 | keep | 22 | open |
| `rayu/src/commands/ide/` | 3 | keep | 636 | open |
| `rayu/src/commands/install-github-app/` | 3 | keep | 902 | open |
| `rayu/src/commands/install-skill/` | 3 | keep | 121 | open |
| `rayu/src/commands/keep/` | 3 | ready | 18 | open |
| `rayu/src/commands/keybindings/` | 3 | ready | 60 | open |
| `rayu/src/commands/login/` | 3 | keep | 112 | open |
| `rayu/src/commands/logout/` | 3 | ready | 30 | open |
| `rayu/src/commands/mascot/` | 3 | ready | 43 | open |
| `rayu/src/commands/mcp/` | 3 | keep | 359 | open |
| `rayu/src/commands/memory/` | 3 | keep | 95 | open |
| `rayu/src/commands/model-image-generation/` | 3 | keep | 108 | open |
| `rayu/src/commands/model-subagent/` | 3 | keep | 141 | open |
| `rayu/src/commands/model-video-generation/` | 3 | keep | 108 | open |
| `rayu/src/commands/model/` | 3 | keep | 325 | open |
| `rayu/src/commands/normal/` | 3 | ready | 25 | open |
| `rayu/src/commands/orchestrator-status/` | 3 | ready | 80 | open |
| `rayu/src/commands/orchestrator/` | 3 | ready | 46 | open |
| `rayu/src/commands/output-style/` | 3 | keep | 16 | open |
| `rayu/src/commands/permissions/` | 3 | keep | 19 | open |
| `rayu/src/commands/plan/` | 3 | keep | 127 | open |
| `rayu/src/commands/plugin/` | 3 | keep | 7245 | open |
| `rayu/src/commands/pr_comments/` | 3 | ready | 40 | open |
| `rayu/src/commands/rayu-limit-options/` | 3 | keep | 246 | open |
| `rayu/src/commands/rayu-plugin/` | 3 | ready | 280 | open |
| `rayu/src/commands/reload-plugins/` | 3 | ready | 70 | open |
| `rayu/src/commands/rename/` | 3 | ready | 153 | open |
| `rayu/src/commands/resume/` | 3 | keep | 273 | open |
| `rayu/src/commands/review-detial/` | 3 | keep | 24 | open |
| `rayu/src/commands/review/` | 3 | keep | 461 | open |
| `rayu/src/commands/rewind/` | 3 | caution | 23 | open |
| `rayu/src/commands/sandbox-toggle/` | 3 | keep | 116 | open |
| `rayu/src/commands/session/` | 3 | keep | 154 | open |
| `rayu/src/commands/stats/` | 3 | keep | 15 | open |
| `rayu/src/commands/status/` | 3 | keep | 18 | open |
| `rayu/src/commands/tag/` | 3 | keep | 225 | open |
| `rayu/src/commands/tasks/` | 3 | keep | 17 | open |
| `rayu/src/commands/telegram-bot/` | 3 | keep | 966 | open |
| `rayu/src/commands/terminalSetup/` | 3 | keep | 894 | open |
| `rayu/src/commands/theme/` | 3 | keep | 65 | open |
| `rayu/src/commands/thinkback-play/` | 3 | ready | 52 | open |
| `rayu/src/commands/thinkback/` | 3 | keep | 559 | open |
| `rayu/src/commands/topup/` | 3 | keep | 379 | open |
| `rayu/src/commands/ultraplan-local/` | 3 | ready | 38 | open |
| `rayu/src/commands/ultrareview-local/` | 3 | ready | 124 | open |
| `rayu/src/commands/undo/` | 3 | ready | 26 | open |
| `rayu/src/commands/usage/` | 3 | ready | 35 | open |
| `rayu/src/commands/vim/` | 3 | ready | 41 | open |
| `rayu/src/commands/webfetch-model/` | 3 | keep | 88 | open |
| `rayu/src/components/` | 3 | keep | 25571 | open |
| `rayu/src/components/ClaudeCodeHint/` | 3 | keep | 78 | open |
| `rayu/src/components/CustomSelect/` | 3 | keep | 2783 | open |
| `rayu/src/components/DesktopUpsell/` | 3 | keep | 173 | open |
| `rayu/src/components/FeedbackSurvey/` | 3 | keep | 1293 | open |
| `rayu/src/components/HelpV2/` | 3 | keep | 290 | open |
| `rayu/src/components/HighlightedCode/` | 3 | keep | 192 | open |
| `rayu/src/components/LogoV2/` | 3 | keep | 2092 | open |
| `rayu/src/components/LspRecommendation/` | 3 | keep | 87 | open |
| `rayu/src/components/ManagedSettingsSecurityDialog/` | 3 | keep | 275 | open |
| `rayu/src/components/PromptInput/` | 3 | keep | 5032 | open |
| `rayu/src/components/Settings/` | 3 | keep | 2498 | open |
| `rayu/src/components/Spinner/` | 3 | keep | 1502 | open |
| `rayu/src/components/StructuredDiff/` | 3 | keep | 487 | open |
| `rayu/src/components/TrustDialog/` | 3 | keep | 493 | open |
| `rayu/src/components/agents/` | 3 | keep | 2962 | open |
| `rayu/src/components/agents/new-agent-creation/` | 3 | keep | 103 | open |
| `rayu/src/components/agents/new-agent-creation/wizard-steps/` | 3 | keep | 1413 | open |
| `rayu/src/components/design-system/` | 3 | keep | 2200 | open |
| `rayu/src/components/diff/` | 3 | keep | 955 | open |
| `rayu/src/components/hooks/` | 3 | keep | 1247 | open |
| `rayu/src/components/mcp/` | 3 | keep | 3570 | open |
| `rayu/src/components/mcp/utils/` | 3 | keep | 47 | open |
| `rayu/src/components/memory/` | 3 | keep | 478 | open |
| `rayu/src/components/messages/` | 3 | keep | 5581 | open |
| `rayu/src/components/messages/UserToolResultMessage/` | 3 | keep | 522 | open |
| `rayu/src/components/permissions/` | 3 | keep | 2691 | open |
| `rayu/src/components/permissions/AskUserQuestionPermissionRequest/` | 3 | keep | 2129 | open |
| `rayu/src/components/permissions/BashPermissionRequest/` | 3 | keep | 613 | open |
| `rayu/src/components/permissions/ComputerUseApproval/` | 3 | keep | 436 | open |
| `rayu/src/components/permissions/EnterPlanModePermissionRequest/` | 3 | keep | 122 | open |
| `rayu/src/components/permissions/ExitPlanModePermissionRequest/` | 3 | keep | 804 | open |
| `rayu/src/components/permissions/FileEditPermissionRequest/` | 3 | keep | 182 | open |
| `rayu/src/components/permissions/FilePermissionDialog/` | 3 | keep | 768 | open |
| `rayu/src/components/permissions/FileWritePermissionRequest/` | 3 | keep | 250 | open |
| `rayu/src/components/permissions/FilesystemPermissionRequest/` | 3 | keep | 115 | open |
| `rayu/src/components/permissions/NotebookEditPermissionRequest/` | 3 | keep | 401 | open |
| `rayu/src/components/permissions/PowerShellPermissionRequest/` | 3 | keep | 320 | open |
| `rayu/src/components/permissions/SedEditPermissionRequest/` | 3 | keep | 230 | open |
| `rayu/src/components/permissions/SkillPermissionRequest/` | 3 | keep | 369 | open |
| `rayu/src/components/permissions/WebFetchPermissionRequest/` | 3 | keep | 258 | open |
| `rayu/src/components/permissions/rules/` | 3 | keep | 2376 | open |
| `rayu/src/components/sandbox/` | 3 | keep | 699 | open |
| `rayu/src/components/shell/` | 3 | keep | 373 | open |
| `rayu/src/components/tasks/` | 3 | keep | 4022 | open |
| `rayu/src/components/teams/` | 3 | keep | 764 | open |
| `rayu/src/components/ui/` | 3 | keep | 500 | open |
| `rayu/src/components/wizard/` | 3 | keep | 326 | open |
| `rayu/src/constants/` | 3 | caution | 2657 | open |
| `rayu/src/context.ts` | 3 | ready | 166 | open |
| `rayu/src/context/` | 3 | keep | 1015 | open |
| `rayu/src/coordinator/` | 3 | ready | 275 | open |
| `rayu/src/cost-tracker.ts` | 3 | ready | 304 | open |
| `rayu/src/costHook.ts` | 3 | keep | 20 | open |
| `rayu/src/dialogLaunchers.tsx` | 3 | keep | 125 | open |
| `rayu/src/entrypoints/` | 3 | keep | 2322 | open |
| `rayu/src/entrypoints/sdk/` | 3 | ready | 247 | open |
| `rayu/src/externalAgents/` | 3 | ready | 52 | open |
| `rayu/src/externalAgents/adapters/` | 3 | ready | 63 | open |
| `rayu/src/externalAgents/adapters/acp/` | 3 | ready | 1089 | open |
| `rayu/src/externalAgents/adapters/claudeCode/` | 3 | ready | 925 | open |
| `rayu/src/externalAgents/adapters/codex/` | 3 | ready | 1244 | open |
| `rayu/src/externalAgents/adapters/opencode/` | 3 | caution | 1302 | open |
| `rayu/src/externalAgents/core/` | 3 | caution | 3178 | open |
| `rayu/src/externalAgents/orchestration/` | 3 | ready | 1018 | open |
| `rayu/src/externalAgents/permissions/` | 3 | ready | 441 | open |
| `rayu/src/externalAgents/persistence/` | 3 | ready | 972 | open |
| `rayu/src/externalAgents/recovery/` | 3 | ready | 542 | open |
| `rayu/src/externalAgents/terminal/` | 3 | ready | 559 | open |
| `rayu/src/externalAgents/transport/` | 3 | ready | 589 | open |
| `rayu/src/externalAgents/workspace/` | 3 | ready | 501 | open |
| `rayu/src/history.ts` | 3 | ready | 409 | open |
| `rayu/src/hooks/` | 3 | keep | 15971 | open |
| `rayu/src/hooks/notifs/` | 3 | keep | 1270 | open |
| `rayu/src/hooks/toolPermission/` | 3 | ready | 597 | open |
| `rayu/src/hooks/toolPermission/handlers/` | 3 | ready | 705 | open |
| `rayu/src/ink.ts` | 3 | keep | 90 | open |
| `rayu/src/ink/` | 3 | keep | 12614 | open |
| `rayu/src/ink/components/` | 3 | keep | 2159 | open |
| `rayu/src/ink/events/` | 3 | caution | 702 | open |
| `rayu/src/ink/hooks/` | 3 | keep | 615 | open |
| `rayu/src/ink/termio/` | 3 | caution | 2035 | open |
| `rayu/src/interactiveHelpers.tsx` | 3 | keep | 372 | open |
| `rayu/src/ipc/` | 3 | caution | 951 | open |
| `rayu/src/keybindings/` | 3 | keep | 2957 | open |
| `rayu/src/main.tsx` | 3 | keep | 4281 | open |
| `rayu/src/memdir/` | 3 | caution | 1640 | open |
| `rayu/src/migrations/` | 3 | ready | 678 | open |
| `rayu/src/orchestrator/` | 3 | caution | 4972 | open |
| `rayu/src/outputStyles/` | 3 | ready | 90 | open |
| `rayu/src/plugins/` | 3 | ready | 141 | open |
| `rayu/src/plugins/installers/` | 3 | caution | 1343 | open |
| `rayu/src/plugins/mcpServer/` | 3 | ready | 618 | open |
| `rayu/src/projectOnboardingState.ts` | 3 | ready | 75 | open |
| `rayu/src/query.ts` | 3 | caution | 1688 | open |
| `rayu/src/query/` | 3 | ready | 644 | open |
| `rayu/src/remote/` | 3 | caution | 1020 | open |
| `rayu/src/replLauncher.tsx` | 3 | keep | 23 | open |
| `rayu/src/runtime/` | 3 | ready | 765 | open |
| `rayu/src/schemas/` | 3 | ready | 211 | open |
| `rayu/src/screens/` | 3 | keep | 5907 | open |
| `rayu/src/server/` | 3 | ready | 321 | open |
| `rayu/src/services/` | 3 | keep | 4447 | open |
| `rayu/src/services/AgentSummary/` | 3 | caution | 158 | open |
| `rayu/src/services/MagicDocs/` | 3 | ready | 334 | open |
| `rayu/src/services/PromptSuggestion/` | 3 | caution | 1371 | open |
| `rayu/src/services/SessionMemory/` | 3 | ready | 887 | open |
| `rayu/src/services/analytics/` | 3 | caution | 1710 | open |
| `rayu/src/services/api/` | 3 | caution | 14552 | open |
| `rayu/src/services/api/copilot/` | 3 | ready | 263 | open |
| `rayu/src/services/api/gemini/` | 3 | caution | 1418 | open |
| `rayu/src/services/api/kiro/` | 3 | caution | 2178 | open |
| `rayu/src/services/api/rayuHosted/` | 3 | ready | 802 | open |
| `rayu/src/services/autoDream/` | 3 | ready | 490 | open |
| `rayu/src/services/compact/` | 3 | keep | 3738 | open |
| `rayu/src/services/extractMemories/` | 3 | ready | 701 | open |
| `rayu/src/services/lsp/` | 3 | caution | 2234 | open |
| `rayu/src/services/mcp/` | 3 | keep | 11085 | open |
| `rayu/src/services/oauth/` | 3 | caution | 2237 | open |
| `rayu/src/services/plugins/` | 3 | caution | 1468 | open |
| `rayu/src/services/policyLimits/` | 3 | ready | 609 | open |
| `rayu/src/services/rayuAuth/` | 3 | caution | 4617 | open |
| `rayu/src/services/remoteManagedSettings/` | 3 | keep | 854 | open |
| `rayu/src/services/settingsSync/` | 3 | ready | 582 | open |
| `rayu/src/services/teamMemorySync/` | 3 | caution | 2018 | open |
| `rayu/src/services/tips/` | 3 | ready | 729 | open |
| `rayu/src/services/toolUseSummary/` | 3 | ready | 99 | open |
| `rayu/src/services/tools/` | 3 | caution | 3005 | open |
| `rayu/src/setup.ts` | 3 | ready | 456 | open |
| `rayu/src/state/` | 3 | keep | 1215 | open |
| `rayu/src/tasks.ts` | 3 | caution | 40 | open |
| `rayu/src/tasks/` | 3 | ready | 685 | open |
| `rayu/src/tasks/DreamTask/` | 3 | ready | 145 | open |
| `rayu/src/tasks/ExternalAgentTask/` | 3 | ready | 252 | open |
| `rayu/src/tasks/InProcessTeammateTask/` | 3 | keep | 222 | open |
| `rayu/src/tasks/LocalAgentTask/` | 3 | keep | 720 | open |
| `rayu/src/tasks/LocalShellTask/` | 3 | keep | 606 | open |
| `rayu/src/tasks/RemoteAgentTask/` | 3 | keep | 816 | open |
| `rayu/src/telegram/` | 3 | caution | 8743 | open |
| `rayu/src/tools.ts` | 3 | ready | 419 | open |
| `rayu/src/tools/` | 3 | ready | 38 | open |
| `rayu/src/tools/AgentTool/` | 3 | keep | 6174 | open |
| `rayu/src/tools/AgentTool/built-in/` | 3 | ready | 631 | open |
| `rayu/src/tools/AgentTool/built-in/subagents/` | 3 | ready | 156 | open |
| `rayu/src/tools/AskUserQuestionTool/` | 3 | keep | 298 | open |
| `rayu/src/tools/BashTool/` | 3 | keep | 11455 | open |
| `rayu/src/tools/BriefTool/` | 3 | keep | 563 | open |
| `rayu/src/tools/ConfigTool/` | 3 | keep | 759 | open |
| `rayu/src/tools/EnterPlanModeTool/` | 3 | keep | 272 | open |
| `rayu/src/tools/EnterWorktreeTool/` | 3 | keep | 158 | open |
| `rayu/src/tools/ExitPlanModeTool/` | 3 | keep | 561 | open |
| `rayu/src/tools/ExitWorktreeTool/` | 3 | keep | 358 | open |
| `rayu/src/tools/ExternalAgentTool/` | 3 | ready | 602 | open |
| `rayu/src/tools/FileEditTool/` | 3 | keep | 2219 | open |
| `rayu/src/tools/FileReadTool/` | 3 | keep | 1654 | open |
| `rayu/src/tools/FileWriteTool/` | 3 | keep | 865 | open |
| `rayu/src/tools/GlobTool/` | 3 | keep | 258 | open |
| `rayu/src/tools/GrepTool/` | 3 | keep | 751 | open |
| `rayu/src/tools/ImageGenTool/` | 3 | keep | 1327 | open |
| `rayu/src/tools/InstallSkillTool/` | 3 | ready | 135 | open |
| `rayu/src/tools/LSPTool/` | 3 | keep | 1846 | open |
| `rayu/src/tools/ListMcpResourcesTool/` | 3 | keep | 159 | open |
| `rayu/src/tools/MCPTool/` | 3 | keep | 1065 | open |
| `rayu/src/tools/McpAuthTool/` | 3 | caution | 189 | open |
| `rayu/src/tools/NotebookEditTool/` | 3 | keep | 567 | open |
| `rayu/src/tools/OrchestrationContractTool/` | 3 | ready | 323 | open |
| `rayu/src/tools/PowerShellTool/` | 3 | keep | 8511 | open |
| `rayu/src/tools/REPLTool/` | 3 | ready | 80 | open |
| `rayu/src/tools/ReadMcpResourceTool/` | 3 | keep | 196 | open |
| `rayu/src/tools/RemoteTriggerTool/` | 3 | keep | 181 | open |
| `rayu/src/tools/ScheduleCronTool/` | 3 | keep | 500 | open |
| `rayu/src/tools/SendMessageTool/` | 3 | keep | 1103 | open |
| `rayu/src/tools/SkillTool/` | 3 | keep | 1363 | open |
| `rayu/src/tools/SleepTool/` | 3 | ready | 9 | open |
| `rayu/src/tools/SyntheticOutputTool/` | 3 | ready | 152 | open |
| `rayu/src/tools/TaskCreateTool/` | 3 | ready | 177 | open |
| `rayu/src/tools/TaskGetTool/` | 3 | ready | 136 | open |
| `rayu/src/tools/TaskListTool/` | 3 | ready | 145 | open |
| `rayu/src/tools/TaskOutputTool/` | 3 | keep | 575 | open |
| `rayu/src/tools/TaskStopTool/` | 3 | keep | 169 | open |
| `rayu/src/tools/TaskUpdateTool/` | 3 | ready | 440 | open |
| `rayu/src/tools/TeamCreateTool/` | 3 | keep | 299 | open |
| `rayu/src/tools/TeamDeleteTool/` | 3 | keep | 150 | open |
| `rayu/src/tools/TodoWriteTool/` | 3 | ready | 254 | open |
| `rayu/src/tools/ToolSearchTool/` | 3 | ready | 533 | open |
| `rayu/src/tools/VideoGenTool/` | 3 | keep | 1145 | open |
| `rayu/src/tools/WebFetchTool/` | 3 | keep | 1048 | open |
| `rayu/src/tools/WebSearchTool/` | 3 | keep | 524 | open |
| `rayu/src/tools/shared/` | 3 | keep | 1245 | open |
| `rayu/src/tools/testing/` | 3 | keep | 74 | open |
| `rayu/src/types/` | 3 | keep | 2371 | open |
| `rayu/src/utils/` | 3 | keep | 93426 | open |
| `rayu/src/utils/activity/` | 3 | ready | 157 | open |
| `rayu/src/utils/background/remote/` | 3 | ready | 301 | open |
| `rayu/src/utils/bash/` | 3 | blocked | 11383 | open |
| `rayu/src/utils/bash/specs/` | 3 | ready | 199 | open |
| `rayu/src/utils/computerUse/` | 3 | keep | 2006 | open |
| `rayu/src/utils/deepLink/` | 3 | caution | 1272 | open |
| `rayu/src/utils/dxt/` | 3 | ready | 271 | open |
| `rayu/src/utils/filePersistence/` | 3 | ready | 383 | open |
| `rayu/src/utils/git/` | 3 | caution | 1075 | open |
| `rayu/src/utils/github/` | 3 | ready | 27 | open |
| `rayu/src/utils/hooks/` | 3 | caution | 3386 | open |
| `rayu/src/utils/mcp/` | 3 | ready | 416 | open |
| `rayu/src/utils/memory/` | 3 | ready | 16 | open |
| `rayu/src/utils/messages/` | 3 | ready | 386 | open |
| `rayu/src/utils/model/` | 3 | caution | 4050 | open |
| `rayu/src/utils/nativeInstaller/` | 3 | caution | 2786 | open |
| `rayu/src/utils/permissions/` | 3 | keep | 8946 | open |
| `rayu/src/utils/plugins/` | 3 | keep | 18859 | open |
| `rayu/src/utils/powershell/` | 3 | caution | 2162 | open |
| `rayu/src/utils/processUserInput/` | 3 | keep | 1790 | open |
| `rayu/src/utils/sandbox/` | 3 | caution | 903 | open |
| `rayu/src/utils/secureStorage/` | 3 | ready | 661 | open |
| `rayu/src/utils/settings/` | 3 | caution | 4131 | open |
| `rayu/src/utils/settings/mdm/` | 3 | ready | 477 | open |
| `rayu/src/utils/shell/` | 3 | caution | 2906 | open |
| `rayu/src/utils/suggestions/` | 3 | caution | 1078 | open |
| `rayu/src/utils/swarm/` | 3 | keep | 4116 | open |
| `rayu/src/utils/swarm/backends/` | 3 | caution | 2700 | open |
| `rayu/src/utils/task/` | 3 | caution | 1226 | open |
| `rayu/src/utils/telemetry/` | 3 | caution | 3587 | open |
| `rayu/src/utils/teleport/` | 3 | caution | 851 | open |
| `rayu/src/utils/todo/` | 3 | ready | 15 | open |
| `rayu/src/utils/ultraplan/` | 3 | caution | 446 | open |
| `rayu/src/vim/` | 3 | caution | 1358 | open |
| `rayu/src/voice/` | 3 | ready | 50 | open |
| `rayu/src/vscode/host/auth/` | 3 | keep | 1067 | out of scope |
| `rayu/src/vscode/host/engine/` | 3 | keep | 1454 | out of scope |
| `rayu/src/vscode/host/models/` | 3 | keep | 691 | out of scope |
| `rayu/src/vscode/host/panel/` | 3 | keep | 8306 | out of scope |
| `rayu/src/vscode/shared/` | 3 | caution | 3725 | out of scope |
| `rayu/src/webBridge/` | 3 | ready | 805 | open |
| `rayu/scripts/` | 4 | caution | 4529 | open |
| `rayu/src/commands/bridge/` | 4 | keep | 527 | open |
| `rayu/src/commands/cost/` | 4 | ready | 42 | open |
| `rayu/src/commands/release-notes/` | 4 | ready | 52 | open |
| `rayu/src/externalAgents/adapters/stub/` | 4 | caution | 242 | open |
| `rayu/src/native-ts/color-diff/` | 4 | ready | 910 | open |
| `rayu/src/vscode/host/account/` | 4 | keep | 457 | out of scope |
| `rayu/src/vscode/host/attach/` | 4 | ready | 415 | out of scope |
| `rayu/src/vscode/host/github/` | 4 | keep | 330 | out of scope |
| `rayu/src/vscode/host/ide/` | 4 | keep | 426 | out of scope |
| `rayu/src/vscode/host/integrations/` | 4 | ready | 418 | out of scope |
| `rayu/src/vscode/host/settings/` | 4 | keep | 1229 | out of scope |
| `rayu/src/vscode/host/webBridge/` | 4 | keep | 277 | out of scope |
| `rayu/src/vscode/webview/state/` | 4 | ready | 868 | out of scope |
| `rayu/un-use-code/` | 4 | keep | 576 | out of scope |
| `rayu/un-use-code/components/` | 4 | keep | 560 | out of scope |
| `rayu/un-use-code/services/analytics/` | 4 | caution | 2161 | out of scope |
| `rayu/un-use-code/services/api/` | 4 | ready | 334 | out of scope |
| `rayu/un-use-code/services/oauth/` | 4 | ready | 381 | out of scope |
| `rayu/src/vscode/host/commands/` | 5 | keep | 582 | out of scope |
| `rayu/src/vscode/webview/` | 5 | keep | 2775 | out of scope |
| `rayu/src/vscode/webview/components/` | 5 | keep | 7988 | out of scope |
| `rayu/src/vscode/webview/settings/` | 5 | keep | 991 | out of scope |
| `rayu/un-use-code/commands/feedback/` | 5 | keep | 48 | out of scope |
| `rayu/un-use-code/commands/install-github-app/` | 5 | keep | 2323 | out of scope |
| `rayu/un-use-code/commands/logout/` | 5 | keep | 85 | out of scope |
| `rayu/un-use-code/components/grove/` | 5 | keep | 463 | out of scope |
| `rayu/src/vscode/host/` | 6 | keep | 3790 | out of scope |
| `rayu/un-use-code/commands/privacy-settings/` | 6 | keep | 68 | out of scope |
