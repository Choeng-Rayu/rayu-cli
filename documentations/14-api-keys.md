# API Keys

Generate API keys to access Rayu's hosted LLM models programmatically — from your own applications, CI pipelines, agent frameworks, or any tool that speaks the OpenAI or Anthropic API format.

## Getting a Key

1. Sign in to [rayucode.com/dashboard/api-keys](https://rayucode.com/dashboard/api-keys)
2. Click **Create API Key** and give it a name
3. Copy the key immediately — it is shown only once and cannot be recovered

API keys require a **Pro plan or higher**. Free and Basic plans do not include API access.

## Base URL

```
https://gateway.rayucode.com/v1
```

All endpoints are served under this base URL. Point your SDK's `base_url` here and use your Rayu API key as the `api_key`.

## Authentication

### OpenAI-compatible (Authorization header)

```
Authorization: Bearer rayu_sk_live_...
```

### Anthropic-compatible (x-api-key header)

```
x-api-key: rayu_sk_live_...
```

Both headers are accepted on all endpoints.

## Endpoints

| Method | Path | Format | Description |
|--------|------|--------|-------------|
| POST | `/v1/chat/completions` | OpenAI | Chat completions (streaming + non-streaming) |
| POST | `/v1/messages` | Anthropic | Anthropic Messages API |
| POST | `/v1/messages/count_tokens` | Anthropic | Token counting (free, no credits charged) |
| GET | `/v1/models` | OpenAI list | Available models for your plan |
| GET | `/v1/credits` | Rayu | Credit balance and usage |

## Quick Start — OpenAI Format

### Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="rayu_sk_live_...",
    base_url="https://gateway.rayucode.com/v1"
)

response = client.chat.completions.create(
    model="deepseek-v3",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### TypeScript

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'rayu_sk_live_...',
  baseURL: 'https://gateway.rayucode.com/v1',
});

const stream = await client.chat.completions.create({
  model: 'deepseek-v3',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### curl

```bash
curl https://gateway.rayucode.com/v1/chat/completions \
  -H "Authorization: Bearer rayu_sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v3",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Quick Start — Anthropic Format

### Python

```python
import anthropic

client = anthropic.Anthropic(
    api_key="rayu_sk_live_...",
    base_url="https://gateway.rayucode.com/v1"
)

message = client.messages.create(
    model="deepseek-v3",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)
```

### Streaming (Anthropic)

```python
with client.messages.stream(
    model="deepseek-v3",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Explain quantum computing"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

## Streaming

Both formats support SSE streaming. Set `"stream": true` in the request body.

- **OpenAI format**: Emits `data: {"id":...,"choices":[{"delta":...}]}` chunks followed by `data: [DONE]`
- **Anthropic format**: Emits standard Anthropic SSE events (`message_start`, `content_block_delta`, etc.)

Streams are unbuffered — tokens arrive as soon as the model generates them. Long-running streams (several minutes for large outputs) are fully supported.

## Tools & Function Calling

### OpenAI Format

```python
response = client.chat.completions.create(
    model="deepseek-v3",
    messages=[{"role": "user", "content": "What's the weather in London?"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"]
            }
        }
    }],
    tool_choice="auto"
)
```

Tool calls are returned in `choices[0].message.tool_calls` and streamed as argument deltas.

### Anthropic Format

Tools work exactly as documented in the Anthropic API — `tools` array with `input_schema`, `tool_use` content blocks in responses, `tool_result` in follow-up messages.

## Vision (Image Input)

Models with image support accept images via base64 data URIs:

```python
response = client.chat.completions.create(
    model="claude-sonnet-4",  # must support images
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What's in this image?"},
            {"type": "image_url", "image_url": {
                "url": "data:image/png;base64,iVBOR..."
            }}
        ]
    }]
)
```

> Remote URLs (https://...) are **not supported** — use base64 data URIs only. This avoids SSRF risks and provider-dependent behavior.

## Credit Headers

Every response includes credit usage information in headers:

| Header | Description |
|--------|-------------|
| `x-rayu-credits-used` | Billable tokens consumed this period |
| `x-rayu-credits-remaining` | Tokens remaining in the period allowance |
| `x-rayu-topup-balance` | Top-up credit balance |
| `x-rayu-limit` | Total period allowance |

## Per-Key Controls

Each API key can have optional limits set in the dashboard:

- **Credit cap**: Maximum credits this key can spend per billing period
- **Model allowlist**: Restrict which models this key can access
- **Rate limit (RPM)**: Maximum requests per minute
- **Expiry date**: Key automatically stops working after this date

## Rate Limits & Errors

| Status | Reason | Retry? |
|--------|--------|--------|
| 401 | Invalid, revoked, or expired API key | No — check or regenerate your key |
| 403 | Model not available on your plan, or API access not enabled | No — upgrade plan or check model name |
| 429 | Per-key RPM limit, per-key credit cap, or plan period limit reached | Yes — after `Retry-After` seconds |
| 502 | Upstream provider temporarily unavailable | Yes — retry with exponential backoff |
| 503 | Gateway at capacity | Yes — after `Retry-After` seconds |

Error responses follow the format of the endpoint you called:
- OpenAI endpoints: `{"error": {"message": "...", "type": "...", "code": null}}`
- Anthropic endpoints: `{"type": "error", "error": {"type": "...", "message": "..."}}`

## Supported Parameters

### OpenAI `/v1/chat/completions`

| Parameter | Supported | Notes |
|-----------|-----------|-------|
| `model` | Yes | Rayu model code |
| `messages` | Yes | system, user, assistant, tool roles |
| `max_tokens` / `max_completion_tokens` | Yes | Default 4096 if omitted |
| `temperature` | Yes | |
| `top_p` | Yes | |
| `stop` | Yes | String or array |
| `stream` | Yes | |
| `stream_options.include_usage` | Yes | Final usage chunk |
| `tools` | Yes | Function calling |
| `tool_choice` | Yes | auto, none, required, specific function |
| `n` | No | Only n=1 supported |
| `logprobs` / `top_logprobs` | No | Rejected with 400 |
| `seed` | No | Rejected with 400 |
| `logit_bias` | No | Rejected with 400 |
| `frequency_penalty` / `presence_penalty` | Ignored | |
| `response_format` | Not yet | |

### Anthropic `/v1/messages`

The full Anthropic Messages API is supported, including:
- `system`, `messages`, `max_tokens`, `temperature`, `top_p`, `stop_sequences`
- `tools`, `tool_choice`, `tool_use` / `tool_result` content blocks
- `stream` with all event types
- Image content blocks (base64)
- Extended thinking (`thinking` content blocks)
- Prompt caching (`cache_control` blocks) — charged at the model's cache read/write multipliers

## Security Best Practices

- **Never expose API keys in client-side code** (browsers, mobile apps). Keys are for server-to-server use.
- **Use per-key credit caps** to limit blast radius if a key is leaked.
- **Set an expiry** for keys used in temporary environments (CI, demos).
- **Use the model allowlist** to prevent a leaked key from accessing expensive models.
- **Revoke immediately** if you suspect a key has been compromised — revocation takes effect within seconds.
- **Rotate keys periodically** as a hygiene practice.

## Model List

To see which models are available on your plan:

```bash
curl https://gateway.rayucode.com/v1/models \
  -H "Authorization: Bearer rayu_sk_live_..."
```

Returns an OpenAI-compatible model list with capabilities (`supportsReasoning`, `supportsImage`, `supportsTools`, `contextWindow`).
