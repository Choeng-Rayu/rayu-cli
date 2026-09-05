# How to Use a Rayu API Key

> A step-by-step guide to creating and using a Rayu API key to access Rayu's
> hosted LLM models from the CLI, your own code, or any OpenAI/Anthropic-compatible
> client.

---

## 1. Create an API key

1. Sign in to [rayucode.com/dashboard/api-keys](https://rayucode.com/dashboard/api-keys)
2. Click **Create API Key** and give it a name (e.g. "my-cli", "ci-pipeline")
3. Copy the key immediately — it is shown only once and cannot be recovered

API keys require a **Pro plan or higher**. Free and Basic plans do not include API access.

---

## 2. Use it in Rayu-CLI

### Option A — Interactive (`/connect`)

```
/connect
```

1. Select **Rayu — hosted models (rayucode.com API key)**
2. Paste your key (`rayu_sk_live_...`)
3. Rayu validates the key, fetches your available models, and opens the model picker
4. Pick a model — you're connected

### Option B — Environment variable

```bash
export RAYU_API_KEY=rayu_sk_live_...
rayu
```

Rayu auto-imports the key on startup, fetches your models, and activates the provider.

### Option C — One-shot (headless)

```bash
RAYU_API_KEY=rayu_sk_live_... rayu --print --model deepseek-v4-pro "summarize this repo"
```

---

## 3. Use it in your own code

### Base URL

```
https://gateway.rayucode.com/v1
```

### OpenAI format (Python)

```python
from openai import OpenAI

client = OpenAI(
    api_key="rayu_sk_live_...",
    base_url="https://gateway.rayucode.com/v1"
)

response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### OpenAI format (TypeScript)

```typescript
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: 'rayu_sk_live_...',
  baseURL: 'https://gateway.rayucode.com/v1',
})

const stream = await client.chat.completions.create({
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
})

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '')
}
```

### OpenAI format (curl)

```bash
curl https://gateway.rayucode.com/v1/chat/completions \
  -H "Authorization: Bearer rayu_sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Anthropic format (Python)

```python
import anthropic

client = anthropic.Anthropic(
    api_key="rayu_sk_live_...",
    base_url="https://gateway.rayucode.com/v1"
)

message = client.messages.create(
    model="deepseek-v4-pro",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)
```

### Anthropic format (Streaming)

```python
with client.messages.stream(
    model="deepseek-v4-pro",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Explain quantum computing"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

---

## 4. See your available models

```bash
curl https://gateway.rayucode.com/v1/models \
  -H "Authorization: Bearer rayu_sk_live_..."
```

Returns an OpenAI-compatible model list:

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-pro",
      "label": "DeepSeek V4 Pro",
      "supportsReasoning": true,
      "supportsImage": false,
      "supportsTools": true,
      "contextWindow": 131072
    }
  ]
}
```

Only models available on your plan are returned. Models from disabled providers
are excluded.

---

## 5. Check your credit balance

```bash
curl https://gateway.rayucode.com/v1/credits \
  -H "Authorization: Bearer rayu_sk_live_..."
```

---

## 6. Authentication headers

| Format | Header |
|--------|--------|
| OpenAI-compatible | `Authorization: Bearer rayu_sk_live_...` |
| Anthropic-compatible | `x-api-key: rayu_sk_live_...` |

Both headers are accepted on all endpoints.

---

## 7. Per-key controls (dashboard)

In the dashboard you can set on each key:

- **Model allowlist** — restrict which models this key can access (empty = all plan models)
- **Credit cap** — maximum credits this key can spend per billing period
- **Rate limit (RPM)** — maximum requests per minute
- **Expiry date** — key automatically stops working after this date

---

## 8. Error reference

| Status | Meaning | What to do |
|--------|---------|------------|
| 401 | Invalid, revoked, or expired key | Check or regenerate your key |
| 403 | Model not available on your plan | Upgrade plan or pick a different model |
| 429 | Rate limit or credit cap reached | Wait for `Retry-After` seconds, then retry |
| 502 | Upstream provider unavailable | Retry with exponential backoff |
| 503 | Gateway at capacity | Wait for `Retry-After` seconds, then retry |

---

## 9. Security best practices

- **Never expose API keys in client-side code** (browsers, mobile apps). Keys are for server-to-server use.
- **Use per-key credit caps** to limit blast radius if a key is leaked.
- **Set an expiry** for keys used in temporary environments (CI, demos).
- **Use the model allowlist** to prevent a leaked key from accessing expensive models.
- **Revoke immediately** if you suspect a key has been compromised — revocation takes effect within seconds.
- **Rotate keys periodically** as a hygiene practice.

---

## 10. Quick reference

| | |
|---|---|
| **Base URL** | `https://gateway.rayucode.com/v1` |
| **Chat (OpenAI)** | `POST /v1/chat/completions` |
| **Chat (Anthropic)** | `POST /v1/messages` |
| **List models** | `GET /v1/models` |
| **Token count** | `POST /v1/messages/count_tokens` (free) |
| **Credits** | `GET /v1/credits` |
| **Dashboard** | rayucode.com/dashboard/api-keys |

---

## See also

- [API Keys (external)](./14-api-keys.md) — the full API key product reference
- [Providers](./03-providers.md) — connecting providers in the CLI
- [Models](./04-models.md) — the searchable `/model` picker
- [Credits & limits](./credits-and-limits.md) — plans, credits, per-model charges
