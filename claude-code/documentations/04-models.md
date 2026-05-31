# 4. Models

## Selecting a model: `/model`

In a session:

```
/model
```

When an OpenAI-compatible provider is active, this opens a **searchable picker**:

- **Type to filter** — matches against both the **model id** and the **provider**
  (e.g. `llama`, `deepseek`, or `nvidia deepseek` to narrow by both).
- **↑ / ↓** move, **Enter** selects, **Esc** cancels.
- The list aggregates models from **all connected providers** (active first), so
  with many providers you can find a model fast instead of scrolling.

Selecting a model from another provider switches the active provider to match.
The choice is saved to `~/.rayu/settings.json` (`"model"`) and persists across
restarts.

You can also set a model non-interactively:

```
/model meta/llama-3.3-70b-instruct
```

or via the CLI flag at launch:

```bash
rayu --model deepseek-chat
```

## Choose a chat model

Pick instruction/chat models. Non-chat models (base, code-completion,
embedding, OCR) will fail with `404` on the chat endpoint. Examples:

| Use ✅ | Avoid ❌ |
|-------|---------|
| `meta/llama-3.3-70b-instruct` | `google/codegemma-7b` |
| `deepseek-chat`, `deepseek-reasoner` | `*-embedding`, `bge-*` |
| `deepseek-ai/deepseek-v4-pro` | `*-ocr`, `deplot` |
| `kimi-k2-*`, `qwen3-*-instruct` | `starcoder2-*` |

## The model catalog

For OpenAI-compatible providers, Rayu fetches the catalog from
`GET {baseURL}/models` and caches it (per provider) in `providers.json` under
`fetchedModels`. It refreshes in the background at startup, and after you enter a
key in `/connect`.

## Context windows

Each model's context window is **model-aware**, not a fixed 200k. Resolution
order for an OpenAI-compatible model:

1. **`RAYU_CONTEXT_TOKENS`** env var (overrides everything).
2. **Per-model config** override — `providers[].modelContextWindows["model-id"]`.
3. **Known-model table** — built-in defaults, e.g.:
   - `deepseek-v4-flash` / `deepseek-v4-pro` → 1,000,000
   - `deepseek-chat` / `deepseek-reasoner` / `deepseek-v3` → 131,072
   - `llama-3.x`, `nemotron`, `qwen3`, `gemma-2/3/4`, `mistral`/`mixtral` → 131,072
   - `kimi` / `moonshot` → 256,000
   - `gpt-4o` / `gpt-4.1` / `o3` / `o4` → 128,000
4. **Per-provider default** — `providers[].contextWindow`.
5. Otherwise falls back to 200,000 **and logs an `issue` diagnostic**
   (`rayu_context.unknown_model`) so you can see which models need a value.

Provider `/models` endpoints generally do **not** report context length, so the
table + overrides are the source of truth.

### Setting a context window explicitly

Per session (any model):

```bash
RAYU_CONTEXT_TOKENS=1000000 rayu
```

Per model, in `~/.rayu/providers.json` (under the relevant provider):

```json
{
  "id": "deepseek",
  "kind": "openai-compatible",
  "baseURL": "https://api.deepseek.com/v1",
  "modelContextWindows": { "deepseek-chat": 131072 }
}
```

Per provider default (applies to all that provider's models without a specific
value): add `"contextWindow": 200000` to the provider object.

The resolved context window drives the on-screen context indicator, auto-compact
thresholds, and token budgeting.

Next: [Configuration →](./05-configuration.md)
