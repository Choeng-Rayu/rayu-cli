# un-use-code

Code **removed from the active Rayu build but preserved** for reference and
possible future re-implementation.

Nothing in this directory ships. It is excluded from type-checking
(`tsconfig.json` → `"exclude": ["…","un-use-code"]`) and is never reachable from
the `src/entrypoints/cli.tsx` import graph, so `bun run build` cannot bundle it.
Most of it is Anthropic / Claude-Code-specific infrastructure that does not
belong in a bring-your-own-key, multi-provider CLI (internal telemetry, the
claude.ai OAuth login and remote-session bridge, the Anthropic feedback
endpoint, the data-training consent screen, dead staging config, and retired
Anthropic-internal commands).

## How to restore an item

1. Move the file(s) back to the original `src/` path noted in its section below.
2. Re-add any removed import / command registration (usually in
   `src/commands.ts`) or call site.
3. Verify with `bun run build && bun run typecheck:ci && bun test`.

## What's here (index)

- **Telemetry / analytics** — `services/analytics/*` (GrowthBook/Statsig gate
  original, first-party event logger + network exporter), `types/generated/events_mono/*`.
- **claude.ai auth + remote** — `services/oauth/{index,crypto,auth-code-listener}.ts`
  (browser OAuth login flow), `upstreamproxy/` (CCR MITM proxy).
- **Feedback + consent** — `commands/feedback/` + `components/Feedback.tsx`
  (Anthropic feedback endpoint), `components/grove/Grove.tsx` +
  `services/api/grove.ts` (data-training consent).
- **Chrome bridge** — `claudeInChrome/` and related.
- **Retired Anthropic-internal commands** — see `commands/` sections.

Full details for each item follow.

## claudeInChrome/

The Claude-in-Chrome bridge (Claude Code's Chrome extension integration:
`wss://bridge.claudeusercontent.com`, native messaging host, the in-chrome MCP
server). Removed from Rayu because it is Anthropic/Claude-Code branded
infrastructure. Preserved here as the reference for a future **rayu-in-chrome**
bridge. Not compiled into the build and not imported by any active source file.

## xaaIdpCommand.ts

The `rayu mcp xaa` command — XAA (Cross-App Access / SEP-990) IdP connection
setup, a Claude-org identity-provider MCP auth flow. XAA is hard-disabled in
Rayu (`isXaaEnabled()` returns false), so this command is no longer registered.
The xaa.ts / xaaIdpLogin.ts service modules remain in src/ only because the MCP
OAuth core (services/mcp/auth.ts) imports them; all their branches are dead
behind the disabled gate.

## commands/good-claude/

The `/good-claude` command — a Claude Code praise/feedback easter-egg (sent a
positive signal about a response back to Anthropic). Anthropic/Claude-Code
specific and irrelevant to Rayu; it was already a disabled stub
(`isEnabled:()=>false, isHidden:true`). Removed from the registry in
`src/commands.ts` and moved here.

## commands/oauth-refresh/

The `/oauth-refresh` command — refreshed the **Anthropic account** OAuth login
token. Rayu authenticates with each provider's own API key / OAuth (Gemini,
NVIDIA, etc.), not an Anthropic account, so this is irrelevant. Was a disabled
stub and was not imported anywhere; moved here.

## commands/reset-limits/

The `/reset-limits` command (with its `resetLimits` / `resetLimitsNonInteractive`
exports) — reset **Anthropic subscription rate-limit** state. Rayu has no
Anthropic subscription limits, so this is irrelevant. Was a disabled stub
referenced only by `src/commands.ts`; de-registered and moved here.

## commands/ — retired stub commands (Phase 2)

These were Claude-Code / Anthropic-internal commands that the rayu rebrand had
already reduced to disabled stubs (`{ isEnabled: () => false, isHidden: true,
name: 'stub' }`). They were non-functional (registered under name `stub`, hidden
and disabled), imported only by `src/commands.ts`, and not asserted by any test.
De-registered from `src/commands.ts` and moved here.

Dev / debug internals:
- `env` — print environment info
- `ctx_viz` — context visualization
- `debug-tool-call` — tool-call debugging
- `break-cache` — force prompt-cache busting
- `mock-limits` — fake rate-limits for testing
- `ant-trace` — Anthropic-internal tracing
- `perf-issue` — file an internal performance issue
- `teleport` — Anthropic-internal
- `bughunter` — Anthropic-internal bug hunting

Claude-Code / Anthropic workflow:
- `autofix-pr` — auto-fix a GitHub PR
- `issue` — file a GitHub issue (to Anthropic's repo)
- `backfill-sessions` — migrate old Claude session files
- `summary` — conversation summary (superseded in rayu by `/compact` + `/export`)
- `share` — share a conversation (needed Anthropic's hosted backend; rayu has none)
- `onboarding` — Claude Code onboarding flow

## services/analytics/growthbook.original.ts

The original GrowthBook + Statsig feature-flag / experiment-exposure client
(Anthropic internal telemetry infrastructure). It constructed a GrowthBook SDK
client, fetched remote-eval feature payloads from Anthropic's flag service over
the network, cached them in the user config, and logged experiment exposures to
the first-party event pipeline.

Rayu does not use Anthropic's feature-flag service. `src/services/analytics/growthbook.ts`
was replaced with a self-contained **neutralized stub** that preserves the exact
public API (every export + signature) — so the ~250 call sites keep compiling —
but imports no `@growthbook/growthbook` SDK, makes no network calls, starts no
timers, and returns each caller's own default for feature values (and `false`
for gates). This file is the pre-stub reference, kept for future re-implementation
of a first-party flag service if ever needed. Not compiled into the build.

## services/analytics/firstPartyEventLogger.original.ts + firstPartyEventLoggingExporter.ts

Anthropic's first-party ("1P") internal event-logging pipeline. The logger
batched internal analytics events via OpenTelemetry and the exporter shipped
them over HTTP (`axios.post` to `RAYU_EVENT_LOGGING_URL` + `/api/event_logging/batch`),
plus GrowthBook experiment-exposure events.

De-risk actions:
- `firstPartyEventLoggingExporter.ts` (the network egress) was **moved here** —
  it is no longer present in `src/` and is excluded from the build.
- `src/services/analytics/firstPartyEventLogger.ts` was replaced with a
  **neutralized stub** (no OTEL, no exporter import, no network; every export
  preserved as a no-op / disabled). `is1PEventLoggingEnabled()` now always
  returns `false`. `firstPartyEventLogger.original.ts` here is the pre-stub
  reference.

## types/generated/events_mono/growthbook/v1/growthbook_experiment_event.ts

Generated protobuf schema for GrowthBook experiment-assignment events. Used only
by the moved exporter, so it became orphaned and was **moved here**. (The
`rayu/v1/rayu_internal_event`, `claude_code/v1/claude_code_internal_event`, and
`common/v1/auth` proto schemas remain in `src/` — they are pure type/serialization
definitions with no network behavior, still referenced by the kept
`services/analytics/metadata.ts` tool-name sanitizer used across ~30 files.)

## services/oauth/{index,crypto,auth-code-listener}.ts

The claude.ai subscription OAuth login flow ("Login with Claude Pro/Max"):
- `index.ts` — `OAuthService`, the browser authorization-code (PKCE) flow
  orchestrator that opened claude.ai / console.anthropic.com to obtain a
  subscription access token.
- `crypto.ts` — PKCE code-verifier/challenge/state generation.
- `auth-code-listener.ts` — the localhost HTTP listener that captured the
  OAuth redirect callback.

Rayu keeps **BYO `ANTHROPIC_API_KEY`** (and every other provider) auth via
`/connect` and `~/.rayu/providers.json`, but does not support logging in with a
claude.ai subscription. These three modules had no remaining importers
(`OAuthService` was already unwired; `client.ts`'s `buildAuthUrl` throws
"OAuth login is not supported in Rayu"), so they were moved here.

Retained in `src/services/oauth/`: `client.ts` (its `getOrganizationUUID()` —
now returns null — and `isOAuthTokenExpired()` are still imported by other
modules; `buildAuthUrl()` throws), `types.ts`, `getOauthProfile.ts`, and the
Google/Gemini OAuth files (a different, supported provider).

## upstreamproxy/ (upstreamproxy.ts + relay.ts)

Anthropic's CCR ("Claude Code Remote") container-side MITM CONNECT proxy. Inside
a CCR session container it read `/run/ccr/session_token`, downloaded the
proxy CA, started a local CONNECT→WebSocket relay, and forced agent-subprocess
traffic (curl/gh/python) through the proxy with credential injection, allow-listing
`*.anthropic.com`. It was gated on `CLAUDE_CODE_REMOTE` and dynamically imported
from `src/entrypoints/init.ts`.

Rayu runs no CCR containers. The dynamic import in `init.ts` was removed and both
modules were **moved here**. Rayu now spawns subprocesses with the ambient
environment (`src/utils/subprocessEnv.ts`; its inert `registerUpstreamProxyEnvFn`
hook is never called).

## constants/product.ts — remote-session URLs de-pointed from claude.ai (not moved)

`src/constants/product.ts` previously hardcoded the remote-session host as
`https://claude.ai` (prod) and `https://claude-ai.staging.ant.dev` (staging).
Those constants had no external importers and were removed; `getClaudeAiBaseUrl`
was renamed to `getRemoteSessionBaseUrl` and now returns a Rayu-configured host
(`RAYU_REMOTE_SESSION_URL` → `RAYU_WEB_URL` → empty). `getRemoteSessionUrl` (used
by main/bridge/attribution/ultraplan/print) keeps its signature. The remote-session
bridge under `src/bridge/*` stays in place but is inert: it is gated on the
claude.ai OAuth login, which is disabled (see Task 7), and no longer points at
any Anthropic host.

## commands/feedback/ + components/Feedback.tsx

The `/feedback` (alias `/bug`) command and its UI. It summarized the user's
feedback with an Anthropic Haiku call, **POSTed it to
`https://api.anthropic.com/api/claude_cli_feedback`**, and opened a GitHub issue
against **`anthropics/claude-code`**. All three are Anthropic-specific and Rayu
has no feedback backend, so the command was de-registered from `src/commands.ts`
and moved here. The shared `redactSensitiveInfo()` helper it exported was
extracted to `src/utils/redactSensitiveInfo.ts` (still used by the feedback
survey's transcript-share path). Rayu users report issues at
`https://github.com/Choeng-Rayu/rayu-cli/issues` (shown in the first-run banner).

## components/grove/Grove.tsx + services/api/grove.ts

The Anthropic "Grove" data-training **consent screen** ("Help improve Claude —
allow the use of your chats and coding sessions to train and improve Anthropic
AI models", 5-year data-retention notice, links to `claude.ai/settings/...` and
`anthropic.com/legal/...`) and its API service (which GET/PATCHed
`${BASE_API_URL}/api/oauth/account/settings` and posted `grove_notice_viewed`).

It applied only to claude.ai consumer subscribers — irrelevant to a BYO-key /
multi-provider CLI, and unreachable now that the claude.ai OAuth login is
disabled. Both the interactive onboarding step (`interactiveHelpers.tsx`) and the
headless check (`cli/print.ts`) were unwired, and both modules moved here.
(`theme.ts` still defines "Grove colors" — harmless color values — and
`config.ts` keeps an inert grove cache field.)

## commands/passes/ + components/Passes/

The `/passes` command and its UI — the Anthropic "guest passes" referral upsell
(share passes / earn referral credits). It was already de-registered from
`src/commands.ts` (orphaned) and is a consumer-plan upsell irrelevant to Rayu,
so both were moved here.

Related usage-upsell gates were **hard-disabled in `src/`** (not moved, because
they're woven into the `LogoV2`/`REPL` feed): `shouldShowGuestPassesUpsell`,
`shouldShowOverageCreditUpsell`, and `shouldShowDesktopUpsellStartup` now return
`false`, so the "request more usage / buy credits / install Claude Desktop"
upsells never render. `/extra-usage` remains a disabled stub (its full
implementation is under `commands/extra-usage/`).
