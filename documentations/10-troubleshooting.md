# 10. Troubleshooting

First stop for any runtime problem: check the diagnostics log.

```bash
cat ~/.rayu/diagnostics.jsonl | jq .
RAYU_DIAGNOSTICS=1 rayu --print "hi"     # echo diagnostics to stderr
```

## Installation problems

### `rayu: command not found` right after installing

The `PATH` change the installer made only applies to **new** shells. Open a new
terminal, or apply it to the current one:

```bash
export PATH="$HOME/.rayu/bin:$PATH"
```

On Windows, reopen PowerShell (the user `PATH` is read at process start).

### The installer says another `rayu` is earlier on my PATH

An older `npm install -g` copy is shadowing the new install, so `rayu` keeps
launching the old one. Remove it:

```bash
npm uninstall -g @rayu-dev/rayu-cli
which -a rayu        # confirm only ~/.rayu/bin/rayu remains
```

### `npm install -g` fails (EACCES, node-gyp, sharp, prebuild)

Use the installer instead — it needs no npm, no global prefix write access and
compiles nothing:

```bash
curl -fsSL https://rayucode.com/install | bash
```

If you must use npm, point it at a prefix you own rather than using `sudo`:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g @rayu-dev/rayu-cli
```

### `checksum mismatch`

The download was corrupted or tampered with, and **nothing was installed**.
Retry; if it keeps happening on the same file, report it with the printed
expected/actual hashes.

### Behind a proxy, or on an internal mirror

```bash
export HTTPS_PROXY=http://proxy.internal:3128
export RAYU_NPM_REGISTRY=https://npm.internal/repository/npm-proxy
curl -fsSL https://rayucode.com/install | bash
```

### Alpine / musl, or no prebuilt runtime for my platform

The installer detects musl and uses a musl Node build. If none exists for your
architecture, install Node yourself and re-run:

```bash
apk add nodejs        # Alpine
curl -fsSL https://rayucode.com/install | bash
```

### Start over

```bash
curl -fsSL https://rayucode.com/install | bash -s -- --uninstall
rm -rf ~/.rayu        # also drops settings and credentials
curl -fsSL https://rayucode.com/install | bash
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

## A reasoning model replies with empty/blank output

**Cause:** reasoning models (`deepseek-reasoner`, Qwen/`gpt-oss`, o-series) spend
output tokens on hidden reasoning first. With a small `max_tokens` they can hit
the limit before producing the visible answer (`finish_reason: length`).

**Fix:** allow more output budget (the on-screen thinking confirms it's working).
OpenAI `o1`/`o3`/`o4`/`gpt-5` token/temperature params are handled automatically.

## Images aren't recognized

**Cause:** the selected model isn't a vision model — only vision models can read
images (pasted or returned by tools).

**Fix:** switch to a vision model with `/model`, e.g.
`meta/llama-3.2-11b-vision-instruct` (NVIDIA) or
`Qwen/Qwen3-VL-30B-A3B-Instruct-FP8` (Doubleword).

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
