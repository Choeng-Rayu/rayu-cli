# un-use-code

Code that has been removed from the active Rayu build but preserved for future
re-implementation.

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
