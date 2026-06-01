# 9. Diagnostics & Privacy

## Diagnostics log

Rayu records runtime **bugs, issues, and vulnerabilities** to a structured,
append-only log so problems can be reviewed and fixed later:

```
<config-home>/diagnostics.jsonl      # e.g. ~/.rayu/diagnostics.jsonl
```

Each line is a JSON record:

```json
{"ts":"2026-06-01T00:12:13.711Z","kind":"bug","severity":"medium",
 "code":"rayu_config.parse_failed","message":"providers.json could not be parsed; starting from empty config",
 "context":{"error":"Expected property name..."}}
```

| Field | Meaning |
|-------|---------|
| `kind` | `bug`, `issue`, or `vulnerability` |
| `severity` | `low`, `medium`, `high`, `critical` |
| `code` | stable identifier, e.g. `openai_adapter.request_failed` |
| `message` | human-readable description |
| `context` | structured, **non-secret** details |

### Examples of what's captured

| Code | Kind | When |
|------|------|------|
| `rayu_config.parse_failed` | bug | `providers.json` is corrupt (recovers to empty) |
| `rayu_config.insecure_permissions` | vulnerability | provider file is group/world-readable |
| `openai_adapter.request_failed` | issue | a provider request failed |
| `openai_adapter.tool_args_parse_failed` | bug | a provider returned unparsable tool-call args |
| `rayu_models.fetch_failed` / `fetch_error` | issue | `GET /models` failed |
| `rayu_context.unknown_model` | issue | no context window known for a model (defaulted) |

### Controls

| Variable | Effect |
|----------|--------|
| `RAYU_DIAGNOSTICS=1` | Also echo each diagnostic to stderr (handy during debugging/tests) |
| `RAYU_DIAGNOSTICS_NO_FILE=1` | Don't write the JSONL file |

Secrets (API keys, tokens) are never written to diagnostics — providers are
referenced by id, not key value.

### Reviewing the log

```bash
cat ~/.rayu/diagnostics.jsonl | jq .          # all records
jq 'select(.kind=="vulnerability")' ~/.rayu/diagnostics.jsonl   # just vulnerabilities
```

## Privacy & network posture

Rayu is **telemetry-off by default**. Privacy levels:

- **`no-telemetry`** (default) — analytics/telemetry disabled.
- **`essential-traffic`** — *all* nonessential network traffic disabled
  (telemetry + auto-update, release notes, model-capability fetches, feature
  flags). **Automatically applied when an OpenAI-compatible provider is active**,
  so Rayu makes no calls to Anthropic when you're using NVIDIA/DeepSeek/etc.

| Variable | Effect |
|----------|--------|
| `RAYU_TELEMETRY=1` | Opt back in to default telemetry behavior |
| `DISABLE_TELEMETRY` | Force `no-telemetry` |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Force `essential-traffic` |

The only outbound calls during normal use go to the **provider endpoint you
configured** (and any MCP servers you add). Project code/secrets are not sent
anywhere else.

Next: [Troubleshooting →](./10-troubleshooting.md)
