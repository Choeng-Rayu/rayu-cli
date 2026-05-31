# 10. Troubleshooting

First stop for any runtime problem: check the diagnostics log.

```bash
cat ~/.rayu/diagnostics.jsonl | jq .
RAYU_DIAGNOSTICS=1 rayu --print "hi"     # echo diagnostics to stderr
```

## API Error: 404

**Cause:** the selected model isn't a chat model on that endpoint, or the model
id is wrong. Base/code/embedding/OCR models (`codegemma`, `*-embedding`,
`*-ocr`, `starcoder`, `deplot`) return 404 on `/v1/chat/completions`.

**Fix:** switch to an instruction/chat model with `/model` (e.g.
`meta/llama-3.3-70b-instruct`, `deepseek-chat`). You can also clear a bad saved
choice:

```bash
# edit ~/.rayu/settings.json and set "model" to a chat model, or:
rayu --model meta/llama-3.3-70b-instruct
```

## API Error: 401 / 403

**Cause:** missing/invalid API key for the active provider.

**Fix:** re-enter the key with `/connect`, or set the right env var
(`RAYU_OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `NVIDIA_API_KEY` …). Confirm the
active provider in `~/.rayu/providers.json` (`activeProvider`).

## API Error: 429

**Cause:** provider rate limit / quota. Not a Rayu bug — the request reached the
provider.

**Fix:** wait and retry, slow down requests, or switch provider/model.

## "API Error: Connection error."

**Cause:** the base URL is unreachable (wrong URL, offline, DNS failure, or a
local server isn't running).

**Fix:** verify the provider's `baseURL` in `providers.json`; for `local`,
confirm the server is up and the URL ends with the right path (usually `/v1`).

## "Not logged in · Please run /login"

**Cause:** no provider/key is configured for the active path.

**Fix:** run `/connect` and enter a key, or set the `RAYU_OPENAI_*` /
`ANTHROPIC_API_KEY` env vars. (Rayu is bring-your-own-key; the Anthropic OAuth
login flow is inert in this fork.)

## Wrong context window (e.g. shows 200k for a 1M model)

**Cause:** the model's context isn't in the known table and isn't configured.

**Fix:** set it — see [Models › Context windows](./04-models.md#context-windows):

```bash
RAYU_CONTEXT_TOKENS=1000000 rayu
```

or add `modelContextWindows` to the provider in `providers.json`. A
`rayu_context.unknown_model` diagnostic is logged for unknown models.

## `/model` or `/connect` doesn't open

**Cause:** when typing a slash command, sending the whole string at once can be
treated as pasted text.

**Fix:** type the command normally (key by key) and press Enter. Ensure you're at
the prompt (past the trust dialog) first.

## The model over-calls tools / loops on simple prompts

**Cause:** weaker non-Claude models receive the full tool suite + system prompt
and may call tools eagerly. In non-interactive `--print` mode without
`--permission-mode bypassPermissions`, denied tools can cause retries.

**Fix:** for `--print` tool use, add `--permission-mode bypassPermissions` (sandbox
only). Interactively, you'll get permission prompts you can decline. Prefer
stronger instruct models for agentic tasks.

## Build fails: "Could not resolve '@anthropic-ai/sdk'" (or similar)

**Cause:** incomplete/partial dependency install.

**Fix:**

```bash
rm -rf node_modules && bun install && bun run build
```

## `tsc` reports many errors but the build/run works

**Expected.** The forked source has many pre-existing type errors (implicit-any,
missing `.d.ts` for externalized optional deps). The source of truth is
`bun run build` + `bun test`, which are green; the Rayu-authored modules are
type-clean.

## Inert features

These are present but non-functional in this fork (they won't crash the CLI):
Computer Use, Claude-in-Chrome, OAuth login, bridge / remote-control / teleport,
remote managed settings, auto-update, analytics/telemetry. Use API keys
(`/connect`) instead of login.

---

Still stuck? Capture the diagnostics entry and the on-screen error:

```bash
RAYU_DIAGNOSTICS=1 rayu --print --model <your-model> "hi" 2>&1 | tail -40
tail -5 ~/.rayu/diagnostics.jsonl
```
