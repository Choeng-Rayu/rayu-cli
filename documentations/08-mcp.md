# 8. MCP (Model Context Protocol)

Rayu can connect to MCP servers to expose extra tools and resources to the
model. MCP works the same as in the upstream CLI.

## Managing servers

```bash
# stdio server (a local command)
rayu mcp add my-server -- my-command --flag arg1

# HTTP/SSE server
rayu mcp add --transport http sentry https://mcp.sentry.dev/mcp

# with headers / env
rayu mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer ..."
rayu mcp add -e API_KEY=xxx my-server -- npx my-mcp-server

# list (runs a health check)
rayu mcp list

# show one server
rayu mcp get my-server

# remove
rayu mcp remove my-server
```

`add` options include:

| Option | Meaning |
|--------|---------|
| `-s, --scope <scope>` | `local`, `user`, or `project` |
| `-t, --transport <t>` | `stdio` (default), `sse`, or `http` |
| `-e, --env <KEY=value>` | Environment variables for a stdio server |
| `-H, --header <h>` | Headers for HTTP/SSE servers |

You can also manage servers in-session with `/mcp`.

## Where MCP config lives

MCP servers are stored in the global `~/.claude.json` (project-scoped entries),
which is **shared with Claude Code**. If `RAYU_CONFIG_DIR` / `CLAUDE_CONFIG_DIR`
is set, the file lives inside that directory instead.

Project-level servers can also be declared in a `.mcp.json` file in your repo,
or loaded ad hoc with `--mcp-config`.

## Using MCP tools

Once a server is connected (`✓ Connected` in `rayu mcp list`), its tools appear
to the model namespaced as `mcp__<server>__<tool>` and can be called during a
conversation. Resources are available via the built-in `ListMcpResources` /
`ReadMcpResource` tools.

## OpenAI-compatible providers + MCP

MCP works regardless of provider. Tool schemas are translated to the active
provider's format automatically (Anthropic tools for the Anthropic path; OpenAI
`function` tools for OpenAI-compatible providers), so MCP tools are usable with
NVIDIA/DeepSeek/etc. as well as Anthropic.

Next: [Diagnostics & Privacy →](./09-diagnostics-privacy.md)
