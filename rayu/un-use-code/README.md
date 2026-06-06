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
